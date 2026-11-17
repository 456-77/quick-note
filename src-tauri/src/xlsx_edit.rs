//! xlsx 单元格编辑（0.39.19 用户反馈「对于 excel 文件，添加功能：可以编辑
//! 单元格内容」）。
//!
//! 为什么不整本重写工作簿：SheetJS 社区版 `XLSX.write` 会丢掉样式/图表/图片
//! 等它不认识的结构；calamine 是只读库。这里走**外科手术**路线——zip 里只
//! 替换目标工作表 XML 中的那一个 `<c>` 元素（或插入/新建行），其余条目用
//! `raw_copy_file` 原样搬运（连压缩字节都不解压重压），用户表里的图表、
//! 条件格式、数据验证都不受影响。
//!
//! 写盘前的安全闸：用与预览同一套 `parse_xlsx_bytes`（calamine）把新字节
//! 完整解析一遍，解析失败直接报错、**绝不落盘**——宁可这次编辑失败，也不
//! 能把用户的表格写坏。校验解析顺带给出编辑后的显示值（数字格式/日期按
//! 预览同一口径渲染），前端据此立即更新单元格，不必再整本重读。
//!
//! 类型判定（与 Excel 的直接输入语义对齐）：
//! - 空串 → 清空值（保留单元格样式）
//! - 数字（允许千分位逗号）→ 数值；`13%` 仅在目标格本身是百分比格式时
//!   转成 0.13（否则当文本，避免出现「输入 13% 显示 0.13」）
//! - TRUE/FALSE → 布尔
//! - 目标格是日期/时间格式且输入可解析 → Excel 序列值（保留原样式，仍是日期）
//! - `=` 开头 → 公式（写 `<f>`，并给 workbook 打 fullCalcOnLoad，Excel 打开即算）
//! - 其余 → 内联字符串（`inlineStr`，**不动 sharedStrings**，避免改动被多个
//!   单元格共享的字符串表）
//!
//! 安全边界：共享公式的主单元格、被多格数组公式/数据表覆盖的单元格拒绝编辑
//!（替换会破坏范围内其他公式）；单格数组公式与普通公式允许改。

use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::vault::{resolve_existing, sha256_hex, vault_root};
use crate::xlsx_parse::parse_xlsx_bytes;

/// 编辑结果：新文件哈希、字节数，以及编辑后该格的显示字符串（预览口径）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxEditResult {
    pub sha256: String,
    pub size: usize,
    pub display: String,
}

/// 修改仓库内 xlsx 的一个单元格（阻塞解析/写盘在 spawn_blocking 里跑）。
#[tauri::command]
pub async fn edit_xlsx_cell(
    vault: String,
    path: String,
    sheet: String,
    row: u32,
    col: u32,
    value: String,
) -> Result<XlsxEditResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        edit_xlsx_sync(&vault, &path, &sheet, row as usize, col as usize, &value)
    })
    .await
    .map_err(|e| format!("表格编辑任务失败: {e}"))?
}

fn edit_xlsx_sync(
    vault: &str,
    path: &str,
    sheet_name: &str,
    row: usize,
    col: usize,
    value: &str,
) -> Result<XlsxEditResult, String> {
    let root = vault_root(vault)?;
    let full = resolve_existing(&root, path)?;
    let bytes = fs::read(&full).map_err(|e| format!("读取表格失败: {e}"))?;
    let edited = edit_xlsx_bytes(&bytes, sheet_name, row, col, value)?;
    write_atomic(&full, &edited.bytes)?;
    Ok(XlsxEditResult {
        sha256: edited.sha256,
        size: edited.bytes.len(),
        display: edited.display,
    })
}

struct EditedXlsx {
    bytes: Vec<u8>,
    sha256: String,
    display: String,
}

/// 编辑核心（字节进、字节出；测试与磁盘命令共用）。
fn edit_xlsx_bytes(
    bytes: &[u8],
    sheet_name: &str,
    row: usize,
    col: usize,
    value: &str,
) -> Result<EditedXlsx, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("表格编辑失败（不是有效的 xlsx）: {e}"))?;

    let workbook_xml = read_zip_entry(&mut archive, "xl/workbook.xml")?
        .ok_or("表格编辑失败：缺少 xl/workbook.xml")?;
    let rels_xml = read_zip_entry(&mut archive, "xl/_rels/workbook.xml.rels")?
        .ok_or("表格编辑失败：缺少 xl/_rels/workbook.xml.rels")?;
    let sheet_path = resolve_sheet_path(&workbook_xml, &rels_xml, sheet_name)?;
    let sheet_xml = read_zip_entry(&mut archive, &sheet_path)?
        .ok_or_else(|| format!("表格编辑失败：找不到工作表「{sheet_name}」的数据"))?;
    let styles_xml = read_zip_entry(&mut archive, "xl/styles.xml")?.unwrap_or_default();
    let date1904 = workbook_date1904(&workbook_xml);

    let scan = scan_sheet(&sheet_xml, row, col)?;
    ensure_editable(&scan, row, col)?;

    // 目标格的有效样式：单元格 s > 行 s > 列 style > 0（与 Excel 的继承口径一致）
    let cell_style = scan
        .target
        .as_ref()
        .and_then(|c| attr_u32(&c.attrs, "s"));
    let row_style = scan.target_row_style;
    let col_style = column_style(&sheet_xml, col);
    let style_idx = cell_style.or(row_style).or(col_style).unwrap_or(0);
    let fmt_code = format_code_of(&styles_xml, style_idx as usize);

    let new_value = classify_value(value, fmt_code.as_deref(), date1904);
    let cell_prefix = scan
        .target
        .as_ref()
        .map(|c| tag_prefix(&c.tag_name))
        .or_else(|| scan.row_tag_name.as_deref().map(tag_prefix))
        // 目标行不存在时从 sheetData 的命名空间前缀推导（x:sheetData → x:c）
        .or_else(|| scan.sheet_data_name.as_deref().map(tag_prefix))
        .unwrap_or("");
    let cell_xml = build_cell_xml(cell_prefix, row, col, scan.target.as_ref(), &new_value);

    // 目标格不存在 + 清空 = 无事可做（仍走校验/哈希，保证调用方拿到稳定返回）
    let changed = scan.target.is_some() || !matches!(new_value, CellValue::Empty);
    let mut new_sheet_xml = if changed {
        apply_cell_patch(&sheet_xml, &scan, row, col, &cell_xml)?
    } else {
        sheet_xml.clone()
    };

    let mut replacements: HashMap<String, Vec<u8>> = HashMap::new();
    if changed {
        // 写公式后让 Excel 打开即重算（否则只显示我们无法计算的空值）
        if matches!(new_value, CellValue::Formula(_)) {
            let patched = ensure_full_calc_on_load(&workbook_xml);
            if patched != workbook_xml {
                replacements.insert("xl/workbook.xml".into(), patched.into_bytes());
            }
        }
        new_sheet_xml.shrink_to_fit();
        replacements.insert(sheet_path, new_sheet_xml.into_bytes());
    }

    let new_bytes = rewrite_zip(&mut archive, &replacements)?;

    // 落盘前全量校验：解析失败说明我们造出了坏文件，直接放弃
    let parsed = parse_xlsx_bytes(&new_bytes)
        .map_err(|e| format!("表格编辑后校验失败，已放弃写入：{e}"))?;
    let sheet = parsed
        .iter()
        .find(|s| s.name == sheet_name)
        .ok_or("表格编辑后校验失败：找不到目标工作表")?;
    // 清空首行/首列时 calamine 的 used range 会缩（Range::from_sparse），
    // 越过新范围就按空值返回——不能用 saturating_sub 把越界错算成别的格
    let display = match (row.checked_sub(sheet.start_row), col.checked_sub(sheet.start_col)) {
        (Some(r), Some(c)) => sheet
            .rows
            .get(r)
            .and_then(|line| line.get(c))
            .cloned()
            .unwrap_or_default(),
        _ => String::new(),
    };

    Ok(EditedXlsx {
        sha256: sha256_hex(&new_bytes),
        bytes: new_bytes,
        display,
    })
}

// ---------------------------------------------------------------- 单元格定位

/// 扫描结果：目标格位置 + 插入点。
struct SheetScan {
    target: Option<CellInfo>,
    /// 目标行标签名（`row` / `x:row`），用于新单元格/新行的命名空间前缀。
    row_tag_name: Option<String>,
    /// `sheetData` 标签名（没有行时从中推导前缀）。
    sheet_data_name: Option<String>,
    target_row_style: Option<u32>,
    insert: InsertPoint,
    /// 数组公式/数据表区间（0 基闭区间）——覆盖目标格就拒绝编辑。
    array_ranges: Vec<(usize, usize, usize, usize)>,
}

struct CellInfo {
    start: usize,
    end: usize,
    attrs: Vec<(String, String)>,
    tag_name: String,
    formula: Option<FormulaInfo>,
}

struct FormulaInfo {
    kind: Option<String>,
    reference: Option<String>,
}

enum InsertPoint {
    /// 目标行已存在：在该字节位置插入 `<c>`。
    InRow(usize),
    /// 目标行是 `<row .../>`：整段替换成带单元格的开放行。
    RowSelfClosing { start: usize, end: usize, tag_name: String },
    /// 目标行不存在，但后面还有行：在该位置前插入新行。
    NewRowBefore(usize),
    /// 目标行在最后一行之后：插到 `</sheetData>` 前。
    SheetDataEnd(usize),
    /// `<sheetData/>` 自闭合：整段替换。
    SheetDataSelfClosing {
        start: usize,
        end: usize,
        tag_name: String,
    },
}

fn scan_sheet(xml: &str, row: usize, col: usize) -> Result<SheetScan, String> {
    let mut pos = 0usize;
    let mut sheet_data: Option<(String, bool)> = None;
    let mut sheet_data_close: Option<usize> = None;
    let mut last_row_no: Option<usize> = None;
    let mut cur_row_no: Option<usize> = None;
    let mut target_row_name: Option<String> = None;
    let mut target_row_style: Option<u32> = None;
    let mut cell_last_col: Option<usize> = None;
    let mut target_row_seen = false;
    let mut target_row_insert: Option<usize> = None;
    let mut target_row_self_closing: Option<(usize, usize, String)> = None;
    let mut new_row_before: Option<usize> = None;
    let mut target_cell: Option<CellInfo> = None;
    let mut cur_cell: Option<CurCell> = None;
    let mut array_ranges: Vec<(usize, usize, usize, usize)> = Vec::new();

    struct CurCell {
        start: usize,
        col: usize,
        attrs: Vec<(String, String)>,
        tag_name: String,
        formula: Option<FormulaInfo>,
    }

    while let Some(tag) = next_tag(xml, pos) {
        pos = tag.end;
        let local = tag.local().to_string();
        if tag.closing {
            match local.as_str() {
                "row" => {
                    if cur_row_no == Some(row) && target_row_insert.is_none() {
                        target_row_insert = Some(tag.start);
                    }
                    cur_row_no = None;
                    cell_last_col = None;
                }
                "c" => {
                    if let Some(open) = cur_cell.take() {
                        if cur_row_no == Some(row) && open.col == col {
                            target_cell = Some(CellInfo {
                                start: open.start,
                                end: tag.end,
                                attrs: open.attrs,
                                tag_name: open.tag_name,
                                formula: open.formula,
                            });
                        }
                    }
                }
                "sheetData" => {
                    sheet_data_close = Some(tag.start);
                }
                _ => {}
            }
            continue;
        }
        match local.as_str() {
            "sheetData" => {
                sheet_data = Some((tag.name.clone(), tag.self_closing));
            }
            "row" => {
                let no = tag
                    .attr("r")
                    .and_then(|v| v.parse::<usize>().ok())
                    .map(|n| n.saturating_sub(1))
                    .or_else(|| last_row_no.map(|n| n + 1))
                    .unwrap_or(0);
                last_row_no = Some(no);
                cell_last_col = None;
                if !target_row_seen {
                    if no > row && new_row_before.is_none() && sheet_data.is_some() {
                        new_row_before = Some(tag.start);
                    }
                    if no == row {
                        target_row_seen = true;
                        target_row_name = Some(tag.name.clone());
                        target_row_style = attr_u32(&tag.attrs, "s");
                        if tag.self_closing {
                            target_row_self_closing =
                                Some((tag.start, tag.end, tag.name.clone()));
                        } else {
                            cur_row_no = Some(no);
                        }
                    }
                }
            }
            "c" => {
                if cur_row_no == Some(row) {
                    let cno = tag
                        .attr("r")
                        .and_then(parse_cell_ref)
                        .map(|(_, c)| c)
                        .or_else(|| cell_last_col.map(|c| c + 1))
                        .unwrap_or(0);
                    cell_last_col = Some(cno);
                    if cno > col && target_row_insert.is_none() {
                        target_row_insert = Some(tag.start);
                    }
                    if cno == col && target_cell.is_none() && cur_cell.is_none() {
                        if tag.self_closing {
                            target_cell = Some(CellInfo {
                                start: tag.start,
                                end: tag.end,
                                attrs: tag.attrs.clone(),
                                tag_name: tag.name.clone(),
                                formula: None,
                            });
                        } else {
                            cur_cell = Some(CurCell {
                                start: tag.start,
                                col: cno,
                                attrs: tag.attrs.clone(),
                                tag_name: tag.name.clone(),
                                formula: None,
                            });
                        }
                    }
                }
            }
            "f" => {
                if let Some(open) = cur_cell.as_mut() {
                    let ftype = tag.attr("t").map(str::to_string);
                    let fref = tag.attr("ref").map(str::to_string);
                    if let Some(reference) = &fref {
                        if matches!(ftype.as_deref(), Some("array") | Some("dataTable")) {
                            if let Some(range) = parse_range(reference) {
                                array_ranges.push(range);
                            }
                        }
                    }
                    if open.formula.is_none() {
                        open.formula = Some(FormulaInfo {
                            kind: ftype,
                            reference: fref,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    let insert = if let Some((start, end, tag_name)) = target_row_self_closing {
        InsertPoint::RowSelfClosing {
            start,
            end,
            tag_name,
        }
    } else if target_row_seen {
        InsertPoint::InRow(
            target_row_insert.ok_or("工作表结构异常（目标行缺少结束标签）")?,
        )
    } else if let Some(at) = new_row_before {
        InsertPoint::NewRowBefore(at)
    } else if let Some((tag_name, self_closing)) = sheet_data.clone() {
        if self_closing {
            // 定位 `<sheetData .../>` 的起止：再扫一遍找它的位置
            let tag = find_tag(xml, &tag_name, "sheetData")?
                .ok_or("工作表结构异常（找不到 sheetData）")?;
            InsertPoint::SheetDataSelfClosing {
                start: tag.start,
                end: tag.end,
                tag_name,
            }
        } else {
            InsertPoint::SheetDataEnd(
                sheet_data_close.ok_or("工作表结构异常（缺少 sheetData 结束标签）")?,
            )
        }
    } else {
        return Err("工作表结构异常（缺少 sheetData）".into());
    };

    Ok(SheetScan {
        target: target_cell,
        row_tag_name: target_row_name,
        sheet_data_name: sheet_data.as_ref().map(|(name, _)| name.clone()),
        target_row_style,
        insert,
        array_ranges,
    })
}

/// 共享公式主格 / 多格数组公式覆盖 → 拒绝（替换会破坏范围内的其他公式）。
fn ensure_editable(scan: &SheetScan, row: usize, col: usize) -> Result<(), String> {
    if let Some(info) = &scan.target {
        if let Some(formula) = &info.formula {
            if formula.kind.as_deref() == Some("shared") && formula.reference.is_some() {
                return Err("该单元格是共享公式的主单元格，暂不支持在预览中编辑".into());
            }
        }
    }
    for (r1, c1, r2, c2) in &scan.array_ranges {
        if row >= *r1 && row <= *r2 && col >= *c1 && col <= *c2 {
            // 单格数组公式只影响本格，可以整格替换
            if !(r1 == r2 && c1 == c2) {
                return Err("该单元格属于数组公式/数据表范围，暂不支持在预览中编辑".into());
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- 值类型判定

enum CellValue {
    Empty,
    Text(String),
    Number(f64),
    Bool(bool),
    Formula(String),
}

fn classify_value(value: &str, fmt_code: Option<&str>, date1904: bool) -> CellValue {
    if value.is_empty() {
        return CellValue::Empty;
    }
    let trimmed = value.trim();
    // Excel 的单引号前缀 = 强制文本（不写进单元格）
    if let Some(rest) = trimmed.strip_prefix('\'') {
        return CellValue::Text(rest.to_string());
    }
    let text_format = fmt_code.map(format_is_text).unwrap_or(false);
    if text_format {
        return CellValue::Text(value.to_string());
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return CellValue::Bool(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return CellValue::Bool(false);
    }
    if let Some(formula) = trimmed.strip_prefix('=') {
        if !formula.trim().is_empty() {
            return CellValue::Formula(formula.to_string());
        }
    }
    if let Some((number, percent)) = parse_number(trimmed) {
        let percent_format = fmt_code.map(format_is_percent).unwrap_or(false);
        // 「13%」在非百分比格式的格子里当文本保留原样；在百分比格子里转 0.13
        if !percent || percent_format {
            return CellValue::Number(number);
        }
        return CellValue::Text(value.to_string());
    }
    if fmt_code.map(format_is_date).unwrap_or(false) {
        if let Some(dt) = parse_date_input(trimmed) {
            return CellValue::Number(match dt {
                ParsedDate::DateTime(ndt) => excel_serial(ndt, date1904),
                ParsedDate::Time(time) => {
                    time.num_seconds_from_midnight() as f64 / 86_400.0
                }
            });
        }
    }
    CellValue::Text(value.to_string())
}

fn parse_number(text: &str) -> Option<(f64, bool)> {
    let mut body = text;
    if body.is_empty() {
        return None;
    }
    let percent = body.ends_with('%');
    if percent {
        body = body[..body.len() - 1].trim_end();
    }
    if body.is_empty() {
        return None;
    }
    // 千分位：只接受规范分组（1,234 / 1,234,567.8），否则当文本
    let (sign, body) = if let Some(rest) = body.strip_prefix('-') {
        ("-", rest)
    } else if let Some(rest) = body.strip_prefix('+') {
        ("", rest)
    } else {
        ("", body)
    };
    let cleaned = if body.contains(',') {
        let int_part = body
            .split(['.', 'e', 'E'])
            .next()
            .unwrap_or(body);
        let mut groups = int_part.split(',');
        let first = groups.next().unwrap_or("");
        if first.is_empty()
            || first.len() > 3
            || !first.chars().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        for group in groups {
            if group.len() != 3 || !group.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
        }
        body.replace(',', "")
    } else {
        body.to_string()
    };
    let number: f64 = format!("{sign}{cleaned}").parse().ok()?;
    if !number.is_finite() {
        return None;
    }
    Some((if percent { number / 100.0 } else { number }, percent))
}

enum ParsedDate {
    DateTime(NaiveDateTime),
    Time(NaiveTime),
}

fn parse_date_input(text: &str) -> Option<ParsedDate> {
    let text = text.trim();
    let datetime_formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%Y年%m月%d日",
    ];
    for fmt in datetime_formats {
        if let Ok(dt) = NaiveDateTime::parse_from_str(text, fmt) {
            return Some(ParsedDate::DateTime(dt));
        }
    }
    for fmt in ["%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日"] {
        if let Ok(date) = NaiveDate::parse_from_str(text, fmt) {
            return Some(ParsedDate::DateTime(date.and_hms_opt(0, 0, 0)?));
        }
    }
    for fmt in ["%H:%M:%S", "%H:%M"] {
        if let Ok(time) = NaiveTime::parse_from_str(text, fmt) {
            return Some(ParsedDate::Time(time));
        }
    }
    None
}

/// Excel 序列值。1900 系统用 1899-12-30 起算（抵消 Excel 的 1900 闰年 bug）；
/// 1904 系统从 1904-01-01 起算（serial 0 = 当天）。
fn excel_serial(dt: NaiveDateTime, date1904: bool) -> f64 {
    let epoch = if date1904 {
        NaiveDate::from_ymd_opt(1904, 1, 1).unwrap()
    } else if dt.date() < NaiveDate::from_ymd_opt(1900, 3, 1).unwrap() {
        // 1900-01-01..1900-02-28 是 Excel 闰年 bug 之前的区段
        NaiveDate::from_ymd_opt(1899, 12, 31).unwrap()
    } else {
        NaiveDate::from_ymd_opt(1899, 12, 30).unwrap()
    };
    let days = (dt.date() - epoch).num_days() as f64;
    let seconds = dt.time().num_seconds_from_midnight() as f64;
    days + seconds / 86_400.0
}

// ---------------------------------------------------------------- 格式码

/// 首段格式码里「可见」的 token：去掉引号字面量、反斜杠转义、`_`/`*` 占位，
/// 保留 `[h]` 这类耗时 token，丢弃 `[Red]`/`[>=100]` 颜色与条件。
fn visible_format_chars(code: &str) -> String {
    let first = code.split(';').next().unwrap_or(code);
    let mut out = String::new();
    let mut chars = first.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                for inner in chars.by_ref() {
                    if inner == '"' {
                        break;
                    }
                }
            }
            '\\' => {
                chars.next();
            }
            '_' | '*' => {
                chars.next();
            }
            '[' => {
                let mut inner = String::new();
                for token in chars.by_ref() {
                    if token == ']' {
                        break;
                    }
                    inner.push(token);
                }
                let low = inner.to_ascii_lowercase();
                if !low.is_empty() && low.chars().all(|c| matches!(c, 'h' | 'm' | 's')) {
                    out.push_str(&low);
                }
            }
            _ => out.push(ch),
        }
    }
    out
}

fn format_is_date(code: &str) -> bool {
    let visible = visible_format_chars(code).to_ascii_lowercase();
    if visible.contains("general") {
        return false;
    }
    visible
        .chars()
        .any(|c| matches!(c, 'y' | 'd' | 'h' | 's' | 'm'))
}

fn format_is_percent(code: &str) -> bool {
    visible_format_chars(code).contains('%')
}

fn format_is_text(code: &str) -> bool {
    visible_format_chars(code).contains('@')
}

/// 内置数字格式码（只需要「是不是日期/百分比/文本」这几个判断，不追求显示
/// 完全一致——显示值由校验解析（calamine）给出）。
fn builtin_format_code(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "yyyy-mm-dd",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "yyyy-mm-dd h:mm",
        // 东亚日期内置格式
        27..=36 | 50..=58 => "yyyy-mm-dd",
        37..=40 | 41..=44 => "#,##0",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

/// 单元格样式索引 → 数字格式码。cellXfs 的第 s 个 `<xf>` 的 numFmtId 决定；
/// 自定义格式（numFmtId >= 164）在 `<numFmts>` 里查 formatCode。
fn format_code_of(styles_xml: &str, style_idx: usize) -> Option<String> {
    if styles_xml.is_empty() {
        return None;
    }
    let mut custom: HashMap<u32, String> = HashMap::new();
    let mut pos = 0usize;
    while let Some(tag) = next_tag(styles_xml, pos) {
        pos = tag.end;
        if tag.closing {
            continue;
        }
        if tag.local() == "numFmt" {
            if let (Some(id), Some(code)) = (
                tag.attr("numFmtId").and_then(|v| v.parse::<u32>().ok()),
                tag.attr("formatCode"),
            ) {
                custom.insert(id, code.to_string());
            }
        }
    }

    let mut num_fmt_id = 0u32;
    let mut in_cell_xfs = false;
    let mut index = 0usize;
    let mut found = false;
    pos = 0;
    while let Some(tag) = next_tag(styles_xml, pos) {
        pos = tag.end;
        let local = tag.local();
        if tag.closing {
            if local == "cellXfs" {
                in_cell_xfs = false;
            }
            continue;
        }
        if local == "cellXfs" {
            in_cell_xfs = true;
            continue;
        }
        if in_cell_xfs && local == "xf" {
            if index == style_idx {
                num_fmt_id = tag
                    .attr("numFmtId")
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(0);
                found = true;
                break;
            }
            index += 1;
        }
    }
    if !found {
        // 样式索引越界（文件不规范）：按 General 处理，类型判定走文本/数字
        return None;
    }
    if let Some(code) = custom.get(&num_fmt_id) {
        return Some(code.clone());
    }
    builtin_format_code(num_fmt_id).map(str::to_string)
}

/// 列默认样式（`<cols><col min max style>`，1 基闭区间）。
fn column_style(xml: &str, col: usize) -> Option<u32> {
    let mut pos = 0usize;
    let mut in_cols = false;
    while let Some(tag) = next_tag(xml, pos) {
        pos = tag.end;
        let local = tag.local();
        if tag.closing {
            if local == "cols" {
                in_cols = false;
            }
            continue;
        }
        if local == "cols" {
            in_cols = true;
            continue;
        }
        if in_cols && local == "col" {
            let min = tag.attr("min").and_then(|v| v.parse::<usize>().ok());
            let max = tag.attr("max").and_then(|v| v.parse::<usize>().ok());
            if let (Some(min), Some(max)) = (min, max) {
                if col + 1 >= min && col + 1 <= max {
                    return tag.attr("style").and_then(|v| v.parse::<u32>().ok());
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------- XML 生成/修补

fn build_cell_xml(
    prefix: &str,
    row: usize,
    col: usize,
    existing: Option<&CellInfo>,
    value: &CellValue,
) -> String {
    let tag = cell_tag(prefix);
    let reference = format!("{}{}", column_letters(col), row + 1);
    let mut out = format!("<{tag} r=\"{reference}\"");
    if let Some(info) = existing {
        for (name, val) in &info.attrs {
            if name == "r" || name == "t" {
                continue;
            }
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            out.push_str(&escape_xml_attr(val));
            out.push('"');
        }
    }
    let close = |out: &mut String| {
        out.push_str("</");
        out.push_str(&tag);
        out.push('>');
    };
    match value {
        CellValue::Empty => {
            out.push_str("/>");
        }
        CellValue::Text(text) => {
            out.push_str(" t=\"inlineStr\"><is><t xml:space=\"preserve\">");
            out.push_str(&escape_xml_text(text));
            out.push_str("</t></is>");
            close(&mut out);
        }
        CellValue::Number(number) => {
            out.push_str("><v>");
            out.push_str(&format_number(*number));
            out.push_str("</v>");
            close(&mut out);
        }
        CellValue::Bool(boolean) => {
            out.push_str(if *boolean {
                " t=\"b\"><v>1</v>"
            } else {
                " t=\"b\"><v>0</v>"
            });
            close(&mut out);
        }
        CellValue::Formula(formula) => {
            out.push_str("><f>");
            out.push_str(&escape_xml_text(formula));
            out.push_str("</f>");
            close(&mut out);
        }
    }
    out
}

fn cell_tag(prefix: &str) -> String {
    if prefix.is_empty() {
        "c".to_string()
    } else {
        format!("{prefix}:c")
    }
}

fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 9e15 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

fn apply_cell_patch(
    xml: &str,
    scan: &SheetScan,
    row: usize,
    _col: usize,
    cell_xml: &str,
) -> Result<String, String> {
    if let Some(target) = &scan.target {
        return Ok(splice(xml, target.start, target.end, cell_xml));
    }
    match &scan.insert {
        InsertPoint::InRow(at) => Ok(splice(xml, *at, *at, cell_xml)),
        InsertPoint::RowSelfClosing {
            start,
            end,
            tag_name,
        } => {
            let raw = &xml[*start..*end];
            let open = raw
                .trim_end()
                .strip_suffix("/>")
                .unwrap_or(raw.trim_end());
            Ok(splice(
                xml,
                *start,
                *end,
                &format!("{open}>{cell_xml}</{tag_name}>"),
            ))
        }
        InsertPoint::NewRowBefore(at) => {
            let row_name = scan
                .row_tag_name
                .clone()
                .or_else(|| {
                    scan.sheet_data_name
                        .as_deref()
                        .map(|name| tag_with_local(name, "row"))
                })
                .unwrap_or_else(|| "row".to_string());
            let row_xml = format!(
                "<{row_name} r=\"{}\">{cell_xml}</{row_name}>",
                row + 1
            );
            Ok(splice(xml, *at, *at, &row_xml))
        }
        InsertPoint::SheetDataEnd(at) => {
            let row_name = scan
                .row_tag_name
                .clone()
                .or_else(|| {
                    scan.sheet_data_name
                        .as_deref()
                        .map(|name| tag_with_local(name, "row"))
                })
                .unwrap_or_else(|| "row".to_string());
            let row_xml = format!(
                "<{row_name} r=\"{}\">{cell_xml}</{row_name}>",
                row + 1
            );
            Ok(splice(xml, *at, *at, &row_xml))
        }
        InsertPoint::SheetDataSelfClosing {
            start,
            end,
            tag_name,
        } => {
            let raw = &xml[*start..*end];
            let open = raw
                .trim_end()
                .strip_suffix("/>")
                .unwrap_or(raw.trim_end());
            let row_name = tag_with_local(tag_name, "row");
            let row_xml = format!(
                "{open}><{row_name} r=\"{}\">{cell_xml}</{row_name}></{tag_name}>",
                row + 1
            );
            Ok(splice(xml, *start, *end, &row_xml))
        }
    }
}

fn splice(xml: &str, start: usize, end: usize, replacement: &str) -> String {
    let mut out = String::with_capacity(xml.len() + replacement.len());
    out.push_str(&xml[..start]);
    out.push_str(replacement);
    out.push_str(&xml[end..]);
    out
}

/// 给 workbook.xml 的 `<calcPr>` 打 fullCalcOnLoad="1"（写公式后 Excel 打开重算）。
fn ensure_full_calc_on_load(workbook_xml: &str) -> String {
    // CT_Workbook 是 sequence：calcPr 必须排在 sheets/definedNames 之后、oleSize/
    // pivotCaches/extLst 等之前。没有 calcPr 时插到「后面的兄弟」前面，而不是
    // 一律塞在 </workbook> 前（extLst 在场时顺序非法，Excel 可能报修复）。
    const AFTER_CALC_PR: &[&str] = &[
        "oleSize",
        "customWorkbookViews",
        "pivotCaches",
        "smartTagPr",
        "smartTagTypes",
        "webPublishing",
        "fileRecoveryPr",
        "webPublishObjects",
        "extLst",
    ];
    let mut pos = 0usize;
    let mut closing_workbook: Option<Tag> = None;
    while let Some(tag) = next_tag(workbook_xml, pos) {
        pos = tag.end;
        if tag.closing {
            if tag.local() == "workbook" {
                closing_workbook = Some(tag);
            }
            continue;
        }
        if tag.local() == "calcPr" {
            if let Some(value) = tag.attr("fullCalcOnLoad") {
                // 已经是 1/true 就不动；写成 0/false 的要翻过来（否则写了公式
                // 打开也不重算）
                if value == "1" || value.eq_ignore_ascii_case("true") {
                    return workbook_xml.to_string();
                }
            }
            let mut attrs = tag.attrs.clone();
            match attrs.iter_mut().find(|(name, _)| name == "fullCalcOnLoad") {
                Some(pair) => pair.1 = "1".to_string(),
                None => attrs.push(("fullCalcOnLoad".to_string(), "1".to_string())),
            }
            let patched = render_tag(&tag.name, &attrs, tag.self_closing);
            return splice(workbook_xml, tag.start, tag.end, &patched);
        }
        if AFTER_CALC_PR.contains(&tag.local()) {
            let calc_pr = tag_with_local(&tag.name, "calcPr");
            return splice(
                workbook_xml,
                tag.start,
                tag.start,
                &format!("<{calc_pr} fullCalcOnLoad=\"1\"/>"),
            );
        }
    }
    if let Some(tag) = closing_workbook {
        let calc_pr = tag_with_local(&tag.name, "calcPr");
        return splice(
            workbook_xml,
            tag.start,
            tag.start,
            &format!("<{calc_pr} fullCalcOnLoad=\"1\"/>"),
        );
    }
    workbook_xml.to_string()
}

// ---------------------------------------------------------------- zip / 文件

fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<String>, String> {
    match archive.by_name(name) {
        Ok(mut file) => {
            let mut text = String::new();
            file.read_to_string(&mut text)
                .map_err(|e| format!("读取 {name} 失败: {e}"))?;
            Ok(Some(text))
        }
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(err) => Err(format!("读取 {name} 失败: {err}")),
    }
}

/// 只重写被改动的条目，其余用 raw_copy_file 原样搬运（压缩字节都不变）。
fn rewrite_zip(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    replacements: &HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("读取表格条目失败: {e}"))?;
        let name = entry
            .name()
            .map_err(|e| format!("读取表格条目名失败: {e}"))?
            .to_string();
        if let Some(data) = replacements.get(&name) {
            let mut options = SimpleFileOptions::default().compression_method(entry.compression());
            if let Some(modified) = entry.last_modified() {
                options = options.last_modified_time(modified);
            }
            writer
                .start_file(&name, options)
                .map_err(|e| format!("写入表格条目 {name} 失败: {e}"))?;
            writer
                .write_all(data)
                .map_err(|e| format!("写入表格条目 {name} 失败: {e}"))?;
        } else {
            writer
                .raw_copy_file(entry)
                .map_err(|e| format!("复制表格条目 {name} 失败: {e}"))?;
        }
    }
    let cursor = writer
        .finish()
        .map_err(|e| format!("生成表格失败: {e}"))?;
    Ok(cursor.into_inner())
}

/// 同目录临时文件 + rename：写一半崩溃/磁盘满不会把原表弄坏。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("无法确定表格所在目录")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".qn-edit-{}-{stamp}.tmp", std::process::id()));
    fs::write(&tmp, bytes).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("写入表格失败：{e}")
    })?;
    let mut last_err = String::new();
    for attempt in 0..4 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = err.to_string();
                if attempt < 3 {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
            }
        }
    }
    let _ = fs::remove_file(&tmp);
    Err(format!(
        "写入表格失败：{last_err}（文件可能正被 Excel/WPS 占用，或设为只读；请处理后重试）"
    ))
}

// ---------------------------------------------------------------- 工作簿元数据

fn resolve_sheet_path(
    workbook_xml: &str,
    rels_xml: &str,
    sheet_name: &str,
) -> Result<String, String> {
    let mut rel_id: Option<String> = None;
    let mut pos = 0usize;
    while let Some(tag) = next_tag(workbook_xml, pos) {
        pos = tag.end;
        if tag.closing || tag.local() != "sheet" {
            continue;
        }
        if tag.attr("name") == Some(sheet_name) {
            rel_id = tag.attr_local("id").map(str::to_string);
            break;
        }
    }
    let rel_id = rel_id.ok_or_else(|| format!("表格编辑失败：找不到工作表「{sheet_name}」"))?;

    pos = 0;
    while let Some(tag) = next_tag(rels_xml, pos) {
        pos = tag.end;
        if tag.closing || tag.local() != "Relationship" {
            continue;
        }
        let id = tag.attr("Id").or_else(|| tag.attr("id"));
        if id != Some(rel_id.as_str()) {
            continue;
        }
        let kind = tag.attr("Type").unwrap_or("");
        if !kind.ends_with("/worksheet") {
            return Err("该工作表不是普通数据表（图表页/对话框页），暂不支持编辑".into());
        }
        let target = tag
            .attr("Target")
            .ok_or("表格编辑失败：工作表关系缺少 Target")?;
        return Ok(resolve_zip_target(target));
    }
    Err(format!(
        "表格编辑失败：找不到工作表「{sheet_name}」的关系定义"
    ))
}

fn resolve_zip_target(target: &str) -> String {
    let target = target.replace('\\', "/");
    let joined = if let Some(stripped) = target.strip_prefix('/') {
        stripped.to_string()
    } else {
        format!("xl/{target}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn workbook_date1904(workbook_xml: &str) -> bool {
    let mut pos = 0usize;
    while let Some(tag) = next_tag(workbook_xml, pos) {
        pos = tag.end;
        if tag.closing || tag.local() != "workbookPr" {
            continue;
        }
        if let Some(value) = tag.attr("date1904") {
            return value == "1" || value.eq_ignore_ascii_case("true");
        }
    }
    false
}

// ---------------------------------------------------------------- 极简 XML 扫描

#[derive(Clone)]
struct Tag {
    name: String,
    attrs: Vec<(String, String)>,
    start: usize,
    end: usize,
    self_closing: bool,
    closing: bool,
}

impl Tag {
    fn local(&self) -> &str {
        match self.name.rsplit_once(':') {
            Some((_, local)) => local,
            None => &self.name,
        }
    }

    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// 按局部名取属性（`r:id` / `id` 都能命中，`sheetId` 不会）。
    fn attr_local(&self, local: &str) -> Option<&str> {
        self.attrs.iter().find_map(|(key, value)| {
            let key_local = match key.rsplit_once(':') {
                Some((_, suffix)) => suffix,
                None => key.as_str(),
            };
            (key_local == local).then_some(value.as_str())
        })
    }
}

fn attr_u32(attrs: &[(String, String)], name: &str) -> Option<u32> {
    attrs
        .iter()
        .find(|(key, _)| key == name)
        .and_then(|(_, value)| value.parse().ok())
}

fn tag_prefix(name: &str) -> &str {
    match name.rsplit_once(':') {
        Some((prefix, _)) => prefix,
        None => "",
    }
}

fn tag_with_local(name: &str, local: &str) -> String {
    match name.rsplit_once(':') {
        Some((prefix, _)) => format!("{prefix}:{local}"),
        None => local.to_string(),
    }
}

fn next_tag(xml: &str, from: usize) -> Option<Tag> {
    let bytes = xml.as_bytes();
    let mut i = from.min(bytes.len());
    loop {
        while i < bytes.len() && bytes[i] != b'<' {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let start = i;
        let rest = &xml[i..];
        if rest.starts_with("<!--") {
            i = rest[4..]
                .find("-->")
                .map(|offset| i + 4 + offset + 3)
                .unwrap_or(bytes.len());
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            i = rest[9..]
                .find("]]>")
                .map(|offset| i + 9 + offset + 3)
                .unwrap_or(bytes.len());
            continue;
        }
        if rest.starts_with("<?") {
            i = rest[2..]
                .find("?>")
                .map(|offset| i + 2 + offset + 2)
                .unwrap_or(bytes.len());
            continue;
        }
        if rest.starts_with("<!") {
            i = rest[2..]
                .find('>')
                .map(|offset| i + 2 + offset + 1)
                .unwrap_or(bytes.len());
            continue;
        }
        i += 1;
        let closing = i < bytes.len() && bytes[i] == b'/';
        if closing {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len() {
            let byte = bytes[i];
            if byte.is_ascii_whitespace() || byte == b'>' || byte == b'/' {
                break;
            }
            i += 1;
        }
        let name = xml[name_start..i].to_string();
        if name.is_empty() {
            // 游离的 '<'（非法 XML）：跳过继续找
            i = (start + 1).max(name_start);
            continue;
        }
        let mut attrs: Vec<(String, String)> = Vec::new();
        let mut self_closing = false;
        loop {
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= bytes.len() {
                break;
            }
            if bytes[i] == b'>' {
                i += 1;
                break;
            }
            if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'>' {
                self_closing = true;
                i += 2;
                break;
            }
            let attr_start = i;
            while i < bytes.len() {
                let byte = bytes[i];
                if byte.is_ascii_whitespace()
                    || byte == b'='
                    || byte == b'>'
                    || byte == b'/'
                {
                    break;
                }
                i += 1;
            }
            let attr_name = xml[attr_start..i].to_string();
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            let mut attr_value = String::new();
            if i < bytes.len() && bytes[i] == b'=' {
                i += 1;
                while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                    i += 1;
                }
                if i < bytes.len() && (bytes[i] == b'"' || bytes[i] == b'\'') {
                    let quote = bytes[i];
                    i += 1;
                    let value_start = i;
                    while i < bytes.len() && bytes[i] != quote {
                        i += 1;
                    }
                    attr_value = decode_entities(&xml[value_start..i]);
                    if i < bytes.len() {
                        i += 1;
                    }
                }
            }
            if !attr_name.is_empty() {
                attrs.push((attr_name, attr_value));
            }
        }
        return Some(Tag {
            name,
            attrs,
            start,
            end: i,
            self_closing,
            closing,
        });
    }
}

fn find_tag(xml: &str, name: &str, local: &str) -> Result<Option<Tag>, String> {
    let mut pos = 0usize;
    while let Some(tag) = next_tag(xml, pos) {
        pos = tag.end;
        if !tag.closing && tag.local() == local && (name.is_empty() || tag.name == name) {
            return Ok(Some(tag));
        }
    }
    Ok(None)
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        rest = &rest[index..];
        let entity_end = rest.find(';').filter(|end| *end <= 12);
        let Some(end) = entity_end else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => {
                if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else if let Some(dec) = entity.strip_prefix('#') {
                    dec.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        if let Some(ch) = decoded {
            out.push(ch);
            rest = &rest[end + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

fn escape_xml_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            // XML 1.0 不允许的控制字符（0x00-0x08/0x0B/0x0C/0x0E-0x1F）写进去会
            // 让整个 sheet 解不开——替换成 U+FFFD
            '\u{0000}'..='\u{0008}' | '\u{000B}' | '\u{000C}' | '\u{000E}'..='\u{001F}' => {
                out.push('\u{FFFD}');
            }
            _ => out.push(ch),
        }
    }
    out
}

fn escape_xml_attr(text: &str) -> String {
    let mut out = escape_xml_text(text);
    out = out.replace('"', "&quot;");
    out = out.replace('\'', "&apos;");
    out
}

/// 按解析出的属性重排一个开标签（用于 calcPr 补/翻属性）。
fn render_tag(name: &str, attrs: &[(String, String)], self_closing: bool) -> String {
    let mut out = format!("<{name}");
    for (key, value) in attrs {
        out.push(' ');
        out.push_str(key);
        out.push_str("=\"");
        out.push_str(&escape_xml_attr(value));
        out.push('"');
    }
    out.push_str(if self_closing { "/>" } else { ">" });
    out
}

// ---------------------------------------------------------------- 单元格引用

fn parse_cell_ref(reference: &str) -> Option<(usize, usize)> {
    let bytes = reference.trim().as_bytes();
    let mut index = 0usize;
    let mut col = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'$' {
            index += 1;
            continue;
        }
        if byte.is_ascii_alphabetic() {
            col = col.checked_mul(26)?.checked_add((byte.to_ascii_uppercase() - b'A' + 1) as usize)?;
            if col > 1_000_000 {
                return None;
            }
            index += 1;
        } else {
            break;
        }
    }
    if col == 0 {
        return None;
    }
    let mut row = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'$' {
            index += 1;
            continue;
        }
        if !byte.is_ascii_digit() {
            return None;
        }
        row = row.checked_mul(10)?.checked_add((byte - b'0') as usize)?;
        index += 1;
    }
    if row == 0 {
        return None;
    }
    Some((row - 1, col - 1))
}

fn parse_range(reference: &str) -> Option<(usize, usize, usize, usize)> {
    let (start, end) = match reference.split_once(':') {
        Some((start, end)) => (start, end),
        None => (reference, reference),
    };
    let (r1, c1) = parse_cell_ref(start)?;
    let (r2, c2) = parse_cell_ref(end)?;
    Some((r1.min(r2), c1.min(c2), r1.max(r2), c1.max(c2)))
}

fn column_letters(index: usize) -> String {
    let mut n = index + 1;
    let mut out: Vec<u8> = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push(b'A' + rem as u8);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ---------------------------------------------------------------- 测试

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> &'static [u8] {
        include_bytes!("../tests/fixtures/parse-sample.xlsx")
    }

    fn read_entry(bytes: &[u8], name: &str) -> String {
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut file = archive.by_name(name).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        text
    }

    #[test]
    fn edits_existing_text_cell() {
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 0, "新文本").unwrap();
        let parsed = parse_xlsx_bytes(&edited.bytes).unwrap();
        assert_eq!(parsed[0].rows[0][0], "新文本");
        assert_eq!(edited.display, "新文本");
    }

    #[test]
    fn edits_number_cell() {
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 5, "3.75").unwrap();
        let parsed = parse_xlsx_bytes(&edited.bytes).unwrap();
        assert_eq!(parsed[0].rows[0][5], "3.75");
        assert_eq!(edited.display, "3.75");
    }

    #[test]
    fn edits_date_cell_keeps_date_type() {
        // B1 是 numFmtId=60 (yyyy-mm-dd) 的日期格
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 1, "2025/2/3").unwrap();
        let parsed = parse_xlsx_bytes(&edited.bytes).unwrap();
        assert_eq!(parsed[0].rows[0][1], "2025-02-03");
        let sheet = read_entry(&edited.bytes, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<c r=\"B1\" s=\"1\"><v>45691</v></c>"), "{sheet}");
    }

    #[test]
    fn percent_input_only_divides_in_percent_cell() {
        // C1 是 0% 格式：13% → 0.13，显示 13%
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 2, "13%").unwrap();
        assert_eq!(edited.display, "13%");
        // F1 是 General：13% 保留为文本（否则会显示 0.13）
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 5, "13%").unwrap();
        assert_eq!(edited.display, "13%");
    }

    #[test]
    fn clears_cell_and_inserts_new_cell() {
        // A2（合并区原点）清空
        let edited = edit_xlsx_bytes(fixture(), "数据", 1, 0, "").unwrap();
        assert_eq!(edited.display, "");
        assert!(parse_xlsx_bytes(&edited.bytes).is_ok());
        // F2 原本不存在：插入新格
        let edited = edit_xlsx_bytes(fixture(), "数据", 1, 5, "插入值").unwrap();
        let parsed = parse_xlsx_bytes(&edited.bytes).unwrap();
        assert_eq!(parsed[0].rows[1][5], "插入值");
    }

    #[test]
    fn inserts_new_row() {
        let edited = edit_xlsx_bytes(fixture(), "数据", 2, 0, "新行").unwrap();
        let parsed = parse_xlsx_bytes(&edited.bytes).unwrap();
        assert_eq!(parsed[0].rows[2][0], "新行");
        let sheet = read_entry(&edited.bytes, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<row r=\"3\"><c r=\"A3\" t=\"inlineStr\">"), "{sheet}");
    }

    #[test]
    fn formula_write_sets_calc_pr() {
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 0, "=SUM(F1:G1)").unwrap();
        let sheet = read_entry(&edited.bytes, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<f>SUM(F1:G1)</f>"), "{sheet}");
        let workbook = read_entry(&edited.bytes, "xl/workbook.xml");
        assert!(workbook.contains("fullCalcOnLoad=\"1\""), "{workbook}");
        // 没有缓存值，预览显示为空（Excel 打开后重算）
        assert_eq!(edited.display, "");
    }

    #[test]
    fn keeps_unrelated_entries_and_prefixes() {
        let edited = edit_xlsx_bytes(fixture(), "数据", 0, 0, "x").unwrap();
        // metadata/styles 等条目原样还在
        assert!(read_entry(&edited.bytes, "xl/metadata.xml").contains("metadata"));
        assert!(read_entry(&edited.bytes, "xl/theme/theme1.xml").contains("theme"));
        // 命名空间前缀的 sheet 也能改
        let xml = r#"<?xml version="1.0"?><x:worksheet xmlns:x="urn:x"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>"#;
        let scan = scan_sheet(xml, 0, 0).unwrap();
        assert!(scan.target.is_some());
        let patch = build_cell_xml(tag_prefix(&scan.target.as_ref().unwrap().tag_name), 0, 0, scan.target.as_ref(), &CellValue::Text("新".into()));
        let out = apply_cell_patch(xml, &scan, 0, 0, &patch).unwrap();
        assert!(out.contains("<x:c r=\"A1\" t=\"inlineStr\"><is><t xml:space=\"preserve\">新</t></is></x:c>"), "{out}");
    }

    #[test]
    fn scan_insert_positions() {
        // 行内插入：行里已有 A1/C1，目标 B1 → 插在 C1 前
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row></sheetData></worksheet>"#;
        let scan = scan_sheet(xml, 0, 1).unwrap();
        assert!(scan.target.is_none());
        let cell = build_cell_xml("", 0, 1, None, &CellValue::Number(2.0));
        let out = apply_cell_patch(xml, &scan, 0, 1, &cell).unwrap();
        assert!(out.contains(r#"<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1">"#), "{out}");

        // 行不存在且后面有行：插在 row r=3 前
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3"><c r="A3"><v>3</v></c></row></sheetData></worksheet>"#;
        let scan = scan_sheet(xml, 1, 0).unwrap();
        let cell = build_cell_xml("", 1, 0, None, &CellValue::Number(2.0));
        let out = apply_cell_patch(xml, &scan, 1, 0, &cell).unwrap();
        assert!(out.contains(r#"</row><row r="2"><c r="A2"><v>2</v></c></row><row r="3">"#), "{out}");

        // 自闭合行
        let xml = r#"<worksheet><sheetData><row r="1"/></sheetData></worksheet>"#;
        let scan = scan_sheet(xml, 0, 0).unwrap();
        let cell = build_cell_xml("", 0, 0, None, &CellValue::Text("a".into()));
        let out = apply_cell_patch(xml, &scan, 0, 0, &cell).unwrap();
        assert!(out.contains(r#"<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">a</t></is></c></row>"#), "{out}");

        // 空 sheetData（自闭合）
        let xml = r#"<worksheet><sheetData/></worksheet>"#;
        let scan = scan_sheet(xml, 0, 0).unwrap();
        let cell = build_cell_xml("", 0, 0, None, &CellValue::Number(1.0));
        let out = apply_cell_patch(xml, &scan, 0, 0, &cell).unwrap();
        assert!(out.contains(r#"<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>"#), "{out}");

        // 命名空间前缀：目标行不存在时，新行/新格都要带前缀
        let xml = r#"<x:worksheet xmlns:x="urn:x"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>"#;
        let scan = scan_sheet(xml, 2, 0).unwrap();
        let prefix = tag_prefix(scan.sheet_data_name.as_deref().unwrap());
        let cell = build_cell_xml(prefix, 2, 0, None, &CellValue::Number(3.0));
        let out = apply_cell_patch(xml, &scan, 2, 0, &cell).unwrap();
        assert!(
            out.contains(r#"<x:row r="3"><x:c r="A3"><v>3</v></x:c></x:row>"#),
            "{out}"
        );
    }

    #[test]
    fn rejects_shared_master_and_array_ranges() {
        let xml = r#"<worksheet><sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A3" si="0">A1*2</f><v>1</v></c><c r="B1"><f t="array" ref="B1:C2">SUM(D1:D2)</f><v>2</v></c></row></sheetData></worksheet>"#;
        let scan = scan_sheet(xml, 0, 0).unwrap();
        assert!(ensure_editable(&scan, 0, 0).is_err());
        let scan = scan_sheet(xml, 0, 0).unwrap();
        assert!(ensure_editable(&scan, 0, 2).is_err());
        // 数组公式区间外的格可以编辑
        let scan = scan_sheet(xml, 1, 3).unwrap();
        assert!(ensure_editable(&scan, 1, 3).is_ok());
    }

    #[test]
    fn classify_values() {
        assert!(matches!(classify_value("", None, false), CellValue::Empty));
        assert!(matches!(classify_value("  ", None, false), CellValue::Text(_)));
        assert!(matches!(classify_value("12", None, false), CellValue::Number(n) if n == 12.0));
        assert!(matches!(classify_value("1,234.5", None, false), CellValue::Number(n) if n == 1234.5));
        assert!(matches!(classify_value("TRUE", None, false), CellValue::Bool(true)));
        assert!(matches!(classify_value("=SUM(A1:A2)", None, false), CellValue::Formula(f) if f == "SUM(A1:A2)"));
        assert!(matches!(classify_value("'00123", None, false), CellValue::Text(t) if t == "00123"));
        // 文本格式强制文本
        assert!(matches!(classify_value("123", Some("@"), false), CellValue::Text(t) if t == "123"));
        // 日期格式 + 日期输入 → 序列值（2025-01-21 = 45678）
        assert!(matches!(classify_value("2025-01-21", Some("yyyy-mm-dd"), false), CellValue::Number(n) if n == 45678.0));
        // General 格式 + 日期输入 → 文本
        assert!(matches!(classify_value("2025-01-21", Some("General"), false), CellValue::Text(_)));
        // 纯时间 → 一天的比例
        assert!(matches!(classify_value("12:00", Some("h:mm"), false), CellValue::Number(n) if (n - 0.5).abs() < 1e-9));
        // 1900 闰年 bug 之前的日期（1900-01-01 = 序列 1）
        assert!(matches!(classify_value("1900-01-01", Some("yyyy-mm-dd"), false), CellValue::Number(n) if n == 1.0));
        // 1904 日期系统：1904-01-01 = 序列 0
        assert!(matches!(classify_value("1904-01-01", Some("yyyy-mm-dd"), true), CellValue::Number(n) if n == 0.0));
        assert!(matches!(classify_value("1904-01-02", Some("yyyy-mm-dd"), true), CellValue::Number(n) if n == 1.0));
    }

    #[test]
    fn format_kind_detection() {
        assert!(format_is_date("yyyy-mm-dd"));
        assert!(format_is_date("[h]:mm:ss"));
        assert!(!format_is_date("General"));
        assert!(!format_is_date("#,##0.00"));
        assert!(!format_is_date("0.00E+00"));
        assert!(!format_is_date("\"kg\"0.00"));
        assert!(!format_is_date("[Red]0.00"));
        assert!(format_is_percent("0.00%"));
        assert!(!format_is_percent("\"100%\"0"));
        assert!(format_is_text("@"));
    }

    #[test]
    fn writes_to_disk_atomically() {
        let dir = std::env::temp_dir().join(format!(
            "qn-xlsx-edit-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("测试表.xlsx");
        std::fs::write(&file, fixture()).unwrap();
        let result = edit_xlsx_sync(
            dir.to_str().unwrap(),
            "测试表.xlsx",
            "数据",
            0,
            0,
            "落盘值",
        )
        .unwrap();
        let bytes = std::fs::read(&file).unwrap();
        assert_eq!(sha256_hex(&bytes), result.sha256);
        let parsed = parse_xlsx_bytes(&bytes).unwrap();
        assert_eq!(parsed[0].rows[0][0], "落盘值");
        // 临时文件不应残留
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".qn-edit-"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn calc_pr_inserted_before_ext_lst() {
        let xml = r#"<workbook><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets><extLst><ext/></extLst></workbook>"#;
        let out = ensure_full_calc_on_load(xml);
        assert!(
            out.contains(r#"<calcPr fullCalcOnLoad="1"/><extLst>"#),
            "{out}"
        );
        let already = r#"<workbook><sheets/><calcPr fullCalcOnLoad="1"/></workbook>"#;
        assert_eq!(ensure_full_calc_on_load(already), already);
        let with_calc = r#"<workbook><sheets/><calcPr calcId="1"/></workbook>"#;
        assert!(ensure_full_calc_on_load(with_calc).contains("calcPr calcId=\"1\" fullCalcOnLoad=\"1\"/>"));
        // 已有 fullCalcOnLoad="0" → 翻成 1
        let zero = r#"<workbook><sheets/><calcPr calcId="1" fullCalcOnLoad="0"/></workbook>"#;
        let flipped = ensure_full_calc_on_load(zero);
        assert!(flipped.contains("fullCalcOnLoad=\"1\""), "{flipped}");
        assert!(!flipped.contains("fullCalcOnLoad=\"0\""), "{flipped}");
    }

    #[test]
    fn cell_reference_roundtrip() {
        assert_eq!(parse_cell_ref("A1"), Some((0, 0)));
        assert_eq!(parse_cell_ref("$B$12"), Some((11, 1)));
        assert_eq!(parse_cell_ref("AA3"), Some((2, 26)));
        assert_eq!(column_letters(0), "A");
        assert_eq!(column_letters(25), "Z");
        assert_eq!(column_letters(26), "AA");
        assert_eq!(parse_range("$A$1:B2"), Some((0, 0, 1, 1)));
    }

    #[test]
    fn style_lookup() {
        let styles = r#"<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.000"/></numFmts><cellStyleXfs><xf numFmtId="0"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>"#;
        assert_eq!(format_code_of(styles, 0).as_deref(), Some("General"));
        assert_eq!(format_code_of(styles, 1).as_deref(), Some("0.000"));
        assert_eq!(format_code_of(styles, 2).as_deref(), Some("yyyy-mm-dd"));
    }
}
