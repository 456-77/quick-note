//! xlsx 表格解析（0.39.9 用户反馈「我们后端是 rust，可以用 rust 加快表格的
//! 解析和渲染吗」）：calamine 直读磁盘文件、一次调用返回全部 sheet 的二维
//! 显示字符串——省掉 read_binary 的 base64 IPC、atob 解码与 SheetJS Worker
//! 三段（大表 1–2s → 数百 ms，Android/桌面同源可用）。
//!
//! 显示值对齐 SheetJS `format_cell` 的口径：
//! - 字符串原样；布尔 TRUE/FALSE；错误值原样（#DIV/0! 等）
//! - 整数直出；浮点 General 用最短往返表示（与 JS Number.toString 同口径），
//!   整值浮点去掉 .0
//! - 带数字格式码的单元格（日期、百分比、千分位等）按格式码渲染——calamine
//!   的 excel 格式化器不公开，这里实现常见格式子集；不认识的码回退 General/
//!   ISO，宁可朴素也不能错
//!
//! 解析窗口 20000 行 × 80 列与前端 Worker 路径一致；merges 返回**原始**区间，
//! 由前端 clampMerges 统一裁剪（单一实现，两边口径不会漂）。

use std::fs;
use std::io::Cursor;

use calamine::{Data, Dimensions, ExcelDateTime, Reader, Xlsx};
use chrono::{Datelike, NaiveDateTime, NaiveTime, Timelike};
use serde::Serialize;

use crate::vault::{resolve_existing, sha256_hex, vault_root};

/// 单表最大预览行数/列数（与 src/lib/xlsxWorker.ts 的 MAX_ROWS/MAX_COLS 一致，
/// 含表头行）。两边改一处必须同步另一处。
const MAX_ROWS: u32 = 20000;
const MAX_COLS: u32 = 80;

/// 行列下标（merge 区间端点；与前端 clampMerges 的 {s:{r,c},e:{r,c}} 对齐）。
#[derive(Serialize)]
pub struct Rc {
    pub r: u32,
    pub c: u32,
}

#[derive(Serialize)]
pub struct RawMerge {
    pub s: Rc,
    pub e: Rc,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSheetNative {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    /// 表里实际的行数（可能远大于 rows.length，前端截断提示用）。
    pub total_rows: usize,
    pub total_cols: usize,
    pub truncated: bool,
    pub merges: Vec<RawMerge>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxParseResult {
    pub sha256: String,
    pub size: u64,
    pub sheets: Vec<ParsedSheetNative>,
}

/// 解析仓库内一个 xlsx 文件（阻塞解析在 spawn_blocking 里跑，不占主线程）。
#[tauri::command]
pub async fn parse_xlsx(vault: String, path: String) -> Result<XlsxParseResult, String> {
    tauri::async_runtime::spawn_blocking(move || parse_xlsx_sync(&vault, &path))
        .await
        .map_err(|e| format!("表格解析任务失败: {e}"))?
}

fn parse_xlsx_sync(vault: &str, path: &str) -> Result<XlsxParseResult, String> {
    let root = vault_root(vault)?;
    let full = resolve_existing(&root, path)?;
    let bytes = fs::read(&full).map_err(|e| format!("读取表格失败: {e}"))?;
    let sheets = parse_xlsx_bytes(&bytes)?;
    Ok(XlsxParseResult {
        sha256: sha256_hex(&bytes),
        size: bytes.len() as u64,
        sheets,
    })
}

/// 解析核心（字节流 → 各 sheet 的显示行）。测试与磁盘命令共用。
fn parse_xlsx_bytes(bytes: &[u8]) -> Result<Vec<ParsedSheetNative>, String> {
    let mut workbook =
        Xlsx::new(Cursor::new(bytes)).map_err(|e| format!("表格解析失败: {e}"))?;
    // 日期换算：ExcelDateTime 自带 1900/1904 纪元标记，as_datetime 内部处理
    let names = workbook.sheet_names();
    let mut sheets = Vec::with_capacity(names.len());
    for name in names {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|e| format!("读取工作表 {name} 失败: {e}"))?;
        // Range.start/end 是 inclusive 的绝对 (row, col)；空表 start=end 或为 None
        let (dim_start, dim_end) = match (range.start(), range.end()) {
            (Some(s), Some(e)) => (s, e),
            _ => {
                sheets.push(ParsedSheetNative {
                    name,
                    rows: Vec::new(),
                    total_rows: 0,
                    total_cols: 0,
                    truncated: false,
                    merges: Vec::new(),
                });
                continue;
            }
        };
        let total_rows = (dim_end.0.saturating_sub(dim_start.0) + 1) as usize;
        let total_cols = (dim_end.1.saturating_sub(dim_start.1) + 1) as usize;
        let row_end = (dim_start.0 + MAX_ROWS - 1).min(dim_end.0);
        let col_end = (dim_start.1 + MAX_COLS - 1).min(dim_end.1);
        let truncated = total_rows > MAX_ROWS as usize || total_cols > MAX_COLS as usize;
        // 样式读不到就全部按 General 渲染（不影响字符串类内容）
        let styles = workbook.worksheet_style(&name).ok();
        let merges = workbook
            .merge_cells_by_sheet_name(&name)
            .unwrap_or_default()
            .into_iter()
            .map(|d: Dimensions| RawMerge {
                s: Rc {
                    r: d.start.0,
                    c: d.start.1,
                },
                e: Rc {
                    r: d.end.0,
                    c: d.end.1,
                },
            })
            .collect();
        let mut rows: Vec<Vec<String>> = Vec::with_capacity((row_end - dim_start.0 + 1) as usize);
        for r in dim_start.0..=row_end {
            let mut row: Vec<String> = Vec::with_capacity((col_end - dim_start.1 + 1) as usize);
            for c in dim_start.1..=col_end {
                let fmt_code = styles
                    .as_ref()
                    .and_then(|s| s.get((r, c)))
                    .and_then(|st| st.number_format.as_ref())
                    .map(|nf| nf.format_code.clone());
                row.push(render_value(range.get_value((r, c)), fmt_code.as_deref()));
            }
            rows.push(row);
        }
        sheets.push(ParsedSheetNative {
            name,
            rows,
            total_rows,
            total_cols,
            truncated,
            merges,
        });
    }
    Ok(sheets)
}

/// 单元格 → 显示字符串。fmt_code 来自 styles.xml 的数字格式码（General 的
/// 单元格通常没有显式样式 → None）。
fn render_value(cell: Option<&Data>, fmt_code: Option<&str>) -> String {
    let Some(data) = cell else {
        return String::new();
    };
    match data {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        Data::Int(i) => render_number(*i as f64, fmt_code, Some(i.to_string())),
        Data::Float(f) => render_number(*f, fmt_code, None),
        Data::DateTime(dt) => render_datetime(dt, fmt_code),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => e.to_string(),
    }
}

/// 数字渲染：有可识别的格式码（千分位/小数位/百分比）按码来，否则 General。
fn render_number(v: f64, fmt_code: Option<&str>, int_fallback: Option<String>) -> String {
    if let Some(code) = fmt_code {
        let first_section = code.split(';').next().unwrap_or(code);
        if !first_section.is_empty() && !first_section.eq_ignore_ascii_case("general") {
            if let Some(s) = render_number_code(first_section, v) {
                return s;
            }
        }
    }
    match int_fallback {
        Some(s) => s,
        None => render_general(v),
    }
}

/// General 数值：与 JS Number.toString 同口径的最短往返；整值去掉 .0。
fn render_general(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    format!("{}", v)
}

/// 日期/时间：认得格式码就按码渲染（Excel/SheetJS 同一观感），认不得回退
/// ISO 风格——纯时间只出时间，零点只出日期。
fn render_datetime(dt: &ExcelDateTime, fmt_code: Option<&str>) -> String {
    let Some(ndt) = dt.as_datetime() else {
        return String::new();
    };
    if let Some(code) = fmt_code {
        let first_section = code.split(';').next().unwrap_or(code);
        if let Some(s) = render_date_code(first_section, ndt) {
            return s;
        }
    }
    if ndt.time() == NaiveTime::MIN {
        return ndt.format("%Y-%m-%d").to_string();
    }
    ndt.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// 日期格式码的常见子集渲染（yyyy/yy、m/mm、d/dd、h/hh、s/ss、am/pm、
/// 引号字面量与普通分隔符）。不认识的 token（[Red]、条件、耗时 [h] 等）
/// 整体返回 None 交由回退——宁可朴素也不能错。
fn render_date_code(code: &str, dt: NaiveDateTime) -> Option<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = String::new();
    let mut i = 0usize;
    // m 的消歧：紧跟在 h/hh 之后（或后面隔分隔符是 s/ss）是分钟，否则月份
    let mut last_was_hour = false;
    while i < chars.len() {
        let rest: String = chars[i..].iter().collect();
        let low = rest.to_lowercase();
        if low.starts_with("yyyy") {
            out += &dt.year().to_string();
            i += 4;
            last_was_hour = false;
        } else if low.starts_with("yy") {
            out += &format!("{:02}", dt.year() % 100);
            i += 2;
            last_was_hour = false;
        } else if low.starts_with("am/pm") {
            out += &if dt.hour() < 12 { "AM" } else { "PM" };
            i += 5;
            last_was_hour = false;
        } else if low.starts_with("hh") {
            out += &format!("{:02}", dt.hour());
            i += 2;
            last_was_hour = true;
        } else if low.starts_with('h') {
            out += &dt.hour().to_string();
            i += 1;
            last_was_hour = true;
        } else if low.starts_with("ss") {
            out += &format!("{:02}", dt.second());
            i += 2;
            last_was_hour = false;
        } else if low.starts_with('s') {
            out += &dt.second().to_string();
            i += 1;
            last_was_hour = false;
        } else if low.starts_with("mm") || low.starts_with('m') {
            let count = if low.starts_with("mm") { 2 } else { 1 };
            let after: String = chars[i + count..].iter().collect::<String>().to_lowercase();
            let skip = after.chars().take_while(|ch| !ch.is_ascii_alphabetic()).count();
            let is_minute = last_was_hour || after.chars().nth(skip) == Some('s');
            let value = if is_minute { dt.minute() } else { dt.month() };
            out += &if count == 2 {
                format!("{:02}", value)
            } else {
                value.to_string()
            };
            i += count;
            last_was_hour = false;
        } else if low.starts_with("dd") {
            out += &format!("{:02}", dt.day());
            i += 2;
            last_was_hour = false;
        } else if low.starts_with('d') {
            out += &dt.day().to_string();
            i += 1;
            last_was_hour = false;
        } else if chars[i] == '"' {
            let close = rest[1..].find('"')?;
            out += &rest[1..1 + close];
            // find 给的是**字节**偏移，i 按**字符**推进——内容字符数单独数
            //（"年" 3 字节 1 字符，混用会把指针跳进下一个字面量，最终在
            // 末尾引号上 find 落空返回 None）
            i += 2 + rest[1..1 + close].chars().count();
        } else if chars[i] == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
        } else if chars[i] == '[' {
            return None;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    Some(out)
}

/// 数字格式码子集（第一段）：`0`/`#` 主格式 + 千分位逗号 + 固定小数位 + `%`。
/// 其余（颜色、条件、科学计数、文本占位）返回 None 交由 General 回退。
fn render_number_code(code: &str, v: f64) -> Option<String> {
    let low = code.to_lowercase();
    if low.contains(['[', '"', '\\', '@', 'e']) {
        return None;
    }
    let percent = low.matches('%').count();
    if percent > 1 {
        return None;
    }
    let main: String = low.chars().filter(|c| *c != '%').collect();
    let thousands = main.contains(',');
    let (int_part, dec_part) = match main.find('.') {
        Some(p) => (&main[..p], &main[p + 1..]),
        None => (main.as_str(), ""),
    };
    if int_part.contains(|c: char| c != '0' && c != '#' && c != ',') {
        return None;
    }
    if dec_part.contains(|c: char| c != '0' && c != '#' && c != ',') {
        return None;
    }
    let decimals = dec_part.chars().filter(|c| *c != ',').count();
    let val = if percent == 1 { v * 100.0 } else { v };
    let neg = val < 0.0;
    let mut s = format!("{:.*}", decimals, val.abs());
    if thousands {
        let (ip, dp) = match s.find('.') {
            Some(p) => (s[..p].to_string(), s[p..].to_string()),
            None => (s.clone(), String::new()),
        };
        let n = ip.len();
        let mut grouped = String::new();
        for (idx, ch) in ip.chars().enumerate() {
            if idx > 0 && (n - idx) % 3 == 0 {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        s = grouped + &dp;
    }
    if percent == 1 {
        s.push('%');
    }
    Some(if neg { format!("-{s}") } else { s })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_codes() {
        let dt = NaiveDateTime::parse_from_str("2025-01-21 14:05:09", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(render_date_code("yyyy-mm-dd", dt).unwrap(), "2025-01-21");
        assert_eq!(render_date_code("yyyy/m/d", dt).unwrap(), "2025/1/21");
        assert_eq!(render_date_code("yyyy\"年\"m\"月\"d\"日\"", dt).unwrap(), "2025年1月21日");
        // h:mm 的 m 是分钟；m月 的 m 是月份
        assert_eq!(render_date_code("h:mm", dt).unwrap(), "14:05");
        assert_eq!(render_date_code("hh:mm:ss", dt).unwrap(), "14:05:09");
        assert_eq!(render_date_code("m月d日", dt).unwrap(), "1月21日");
        assert_eq!(render_date_code("m/d h:mm AM/PM", dt).unwrap(), "1/21 14:05 PM");
        // 不认识的格式（耗时 [h]:mm）放弃 → None
        assert_eq!(render_date_code("[h]:mm", dt), None);
    }

    #[test]
    fn number_codes() {
        assert_eq!(render_number_code("#,##0.00", 1234.5).unwrap(), "1,234.50");
        assert_eq!(render_number_code("0%", 0.126).unwrap(), "13%");
        assert_eq!(render_number_code("0.00", 2.5).unwrap(), "2.50");
        assert_eq!(render_number_code("#,##0", 1234567.0).unwrap(), "1,234,567");
        // 负数与分段格式（分段由 render_number 取第一段；直接喂全码含 [Red] 应放弃）
        assert_eq!(render_number(-1234.5, Some("#,##0.00;[Red](#,##0.00)"), None), "-1,234.50");
        assert_eq!(render_number_code("#,##0.00;[Red](#,##0.00)", -1234.5), None);
        // 科学计数/文本占位放弃
        assert_eq!(render_number_code("0.00E+00", 1234.5), None);
        assert_eq!(render_number_code("@", 1234.5), None);
    }

    #[test]
    fn general_values() {
        assert_eq!(render_general(2.0), "2");
        assert_eq!(render_general(2.5), "2.5");
        assert_eq!(render_general(-0.25), "-0.25");
        assert_eq!(render_value(Some(&Data::Bool(true)), None), "TRUE");
        assert_eq!(render_value(Some(&Data::Int(42)), None), "42");
        assert_eq!(render_value(Some(&Data::String("文本".into())), None), "文本");
        assert_eq!(render_value(None, None), "");
    }

    /// 集成：真实 xlsx 字节流（tests/fixtures/parse-sample.xlsx，node+SheetJS
    /// 生成：字符串/日期 yyyy-mm-dd/百分比/千分位/布尔/浮点/整数/合并区）经
    /// 完整解析链路的显示值 / merges / 截断标记，期望值以 SheetJS format_cell
    /// 的输出为基准逐值比对。
    #[test]
    fn parses_fixture() {
        let res = parse_xlsx_bytes(include_bytes!("../tests/fixtures/parse-sample.xlsx"))
            .expect("解析 fixture 失败");
        assert_eq!(res.len(), 1);
        let s = &res[0];
        assert_eq!(s.name, "数据");
        assert_eq!(s.rows[0][0], "文本");
        assert_eq!(s.rows[0][1], "2025-01-21");
        assert_eq!(s.rows[0][2], "13%");
        assert_eq!(s.rows[0][3], "1,234.50");
        assert_eq!(s.rows[0][4], "TRUE");
        assert_eq!(s.rows[0][5], "2.5");
        assert_eq!(s.rows[0][6], "42");
        assert!(!s.truncated);
        assert_eq!(s.merges.len(), 1);
        assert_eq!((s.merges[0].s.r, s.merges[0].s.c), (1, 0));
        assert_eq!((s.merges[0].e.r, s.merges[0].e.c), (1, 3));
        assert_eq!(s.rows[1][0], "合并区");
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// 手动基准（大表性能看门狗）：`cargo test bench_big -- --nocapture`。
    /// fixture 不进仓库，用 scripts/make-xlsx-fixture.mjs 生成后再跑。
    #[test]
    fn bench_big() {
        let Ok(bytes) = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/big-sample.xlsx")) else {
            eprintln!("跳过：tests/fixtures/big-sample.xlsx 不存在（scripts/make-xlsx-fixture.mjs 生成）");
            return;
        };
        let bytes = bytes.as_slice();
        let t0 = std::time::Instant::now();
        let res = parse_xlsx_bytes(bytes).expect("解析失败");
        let ms = t0.elapsed().as_millis();
        let cells: usize = res[0].rows.iter().map(|r| r.len()).sum();
        println!("parse_xlsx_bytes: {ms} ms, {} sheets, {} cells", res.len(), cells);
        assert!(ms > 0);
    }
}
