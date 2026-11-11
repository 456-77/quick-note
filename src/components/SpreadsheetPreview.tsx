/**
 * Excel 预览（0.39 用户反馈「添加对 excel 表的预览支持，同时要支持筛选功能」）。
 *
 * 0.39 之前 xlsx 预览是 SheetJS `sheet_to_html` 的 HTML 注入：能看但不能筛选。
 * 现在 Worker 返回二维显示字符串（lib/xlsxWorker.ts），这里自己渲染表格：
 * - 表头每列一个筛选按钮（Excel 式）：搜索值 + 多选 + 全选/清空/清除筛选；
 * - 多列筛选叠加，筛选后显示「N / M 行」，表头粘性置顶；
 * - 大表只渲染前 600 行（「显示更多」追加），筛选仍作用于全部已解析行；
 * - 解析侧 20000 行 × 80 列截断（0.39.3 由 5000 放大——用户实测表 4999 行就撞顶），
 *   超大表给明确提示，避免百万行表拖死预览。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ParsedSheet } from "../lib/xlsxWorkerHost";

/** 每次渲染的行数（点「显示更多」翻倍追加；筛选作用于全部行）。 */
const RENDER_STEP = 600;
/** 单列筛选面板里最多列出的不同值（再多请用搜索缩小范围）。 */
const MAX_FILTER_VALUES = 500;

/** 列序号 → Excel 列名（0 → A，26 → AA）。表头为空时用它兜底显示。 */
function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function displayValue(value: string): string {
  return value === "" ? "(空白)" : value;
}

/** 某列出现过的不同值（保持排序：空值在前，其余按数字/中文习惯）。 */
function distinctValues(rows: string[][], col: number): string[] {
  const seen = new Set<string>();
  for (const row of rows) seen.add(row[col] ?? "");
  return [...seen].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, "zh-Hans-CN", { numeric: true }),
  );
}

/** 列筛选面板本体（挂载/卸载由 pop 状态控制，状态天然按列重置）。 */
function ColumnFilter({
  title,
  values,
  applied,
  onApply,
  onClose,
}: {
  title: string;
  values: string[];
  /** 已生效的值；undefined = 该列没筛选（面板初始全选）。 */
  applied?: string[];
  onApply: (values: string[] | null) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(applied ?? values),
  );
  const q = search.trim().toLowerCase();
  const matched = q ? values.filter((value) => value.toLowerCase().includes(q)) : values;
  const listed = matched.slice(0, MAX_FILTER_VALUES);
  const toggle = (value: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  const apply = () => {
    // 全选 / 空选都等价于没筛选（避免留下无意义的筛选 chips）
    if (chosen.size === 0 || chosen.size === values.length) onApply(null);
    else onApply(values.filter((value) => chosen.has(value)));
  };

  return (
    <div
      className="xlsx-filter-inner"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          // 0.39.3 用户反馈「表格筛选后，回车应该只显示筛选后的行」：搜索框有
          // 内容时按「勾选 ∩ 搜索匹配」应用——用户在搜索框打字回车，期望是把
          // 看得见的值变成筛选结果；旧的 apply() 只看勾选集（初始全选，回车
          // 等于全量原样应用=没筛），看起来就像"回车恢复成当前状态"。
          if (q) {
            const visible = values.filter((value) => chosen.has(value) && matched.includes(value));
            if (visible.length === 0 || visible.length === values.length) onApply(null);
            else onApply(visible);
          } else {
            apply();
          }
        }
      }}
    >
      <div className="xlsx-filter-title" title={title}>
        筛选：{title}
      </div>
      <input
        autoFocus
        type="text"
        className="xlsx-filter-search"
        value={search}
        spellCheck={false}
        placeholder="搜索值…（Enter 应用 · Esc 关闭）"
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="xlsx-filter-actions">
        <button
          type="button"
          onClick={() => setChosen((prev) => new Set([...prev, ...listed]))}
        >
          全选
        </button>
        <button type="button" onClick={() => setChosen(new Set())}>
          清空
        </button>
        <span className="xlsx-filter-count">
          已选 {chosen.size} / {values.length}
        </span>
      </div>
      <div className="xlsx-filter-values">
        {listed.map((value) => (
          <label key={value || "\u0000"} className="xlsx-filter-value" title={displayValue(value)}>
            <input type="checkbox" checked={chosen.has(value)} onChange={() => toggle(value)} />
            <span>{displayValue(value)}</span>
          </label>
        ))}
        {listed.length === 0 && <div className="xlsx-filter-empty">没有匹配的值</div>}
        {matched.length > listed.length && (
          <div className="xlsx-filter-empty">
            还有 {matched.length - listed.length} 个值未列出，输入搜索缩小范围
          </div>
        )}
      </div>
      <div className="xlsx-filter-foot">
        <button type="button" className="xlsx-filter-clear" onClick={() => onApply(null)}>
          清除该列筛选
        </button>
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={apply}>
          应用
        </button>
      </div>
    </div>
  );
}

export default function SpreadsheetPreview({ sheets }: { sheets: ParsedSheet[] }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = sheets[Math.min(sheetIndex, sheets.length - 1)];
  /** 生效的列筛选：列下标 → 选中的显示值（数组非空）。 */
  const [filters, setFilters] = useState<Record<number, string[]>>({});
  const [cap, setCap] = useState(RENDER_STEP);
  /** 筛选面板：列下标 + fixed 定位（相对视口）。 */
  const [pop, setPop] = useState<{
    col: number;
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  /** 表格容器：筛选 chips 打开时用它找对应列头做锚点。 */
  const bodyWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFilters({});
    setCap(RENDER_STEP);
    setPop(null);
  }, [sheetIndex]);

  // 点面板外收起；滚动预览（表格或页面）也收起——但**弹窗内部滚值列表不算**
  // （0.39 用户反馈「鼠标聚焦在弹窗上滚动滚轮，弹窗会消失」：捕获阶段的
  // scroll 事件对任何滚动元素都触发，弹窗自己的值列表滚动被误判成页面滚动）
  useEffect(() => {
    if (!pop) return;
    const onDown = (event: MouseEvent) => {
      if (popRef.current?.contains(event.target as Node)) return;
      setPop(null);
    };
    const onScroll = (event: Event) => {
      if (popRef.current?.contains(event.target as Node)) return;
      setPop(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [pop]);

  const rows = sheet?.rows ?? [];
  const header = rows[0] ?? [];
  const body = useMemo(() => rows.slice(1), [rows]);
  // 合并单元格（0.39.5 用户反馈「表头合并了多个单元格，预览只占一格」）：
  // origins = 区间左上角 → 跨行/跨列数；covered = 被覆盖格 → 跳过不渲染。
  // rowSpan 允许表头的纵向合并跨进体部（HTML 表格天然支持，覆盖格跳过即可）。
  const { mergeOrigins, mergeCovered } = useMemo(() => {
    const origins = new Map<string, { rs: number; cs: number }>();
    const covered = new Set<string>();
    for (const m of sheet?.merges ?? []) {
      origins.set(`${m.r}:${m.c}`, { rs: m.rs, cs: m.cs });
      for (let r = m.r; r < m.r + m.rs; r += 1) {
        for (let c = m.c; c < m.c + m.cs; c += 1) {
          if (r !== m.r || c !== m.c) covered.add(`${r}:${c}`);
        }
      }
    }
    return { mergeOrigins: origins, mergeCovered: covered };
  }, [sheet]);
  const mergeSpan = (r: number, c: number) => mergeOrigins.get(`${r}:${c}`);

  const filtered = useMemo(() => {
    const active = Object.entries(filters).filter(([, values]) => values.length > 0);
    if (active.length === 0) return body;
    return body.filter((row) =>
      active.every(([col, values]) => values.includes(row[Number(col)] ?? "")),
    );
  }, [body, filters]);

  const visible = filtered.slice(0, cap);
  const activeCols = Object.keys(filters)
    .map(Number)
    .filter((col) => (filters[col]?.length ?? 0) > 0)
    .sort((a, b) => a - b);
  const popValues = useMemo(() => (pop ? distinctValues(body, pop.col) : []), [pop, body]);

  if (!sheet) return null;

  const openPop = (col: number, anchor: HTMLElement) => {
    if (pop?.col === col) {
      setPop(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(320, Math.max(230, window.innerWidth - 16));
    // 0.39 用户反馈「优化弹窗出现的位置」：弹窗**中心对齐锚点中心**再夹进视口
    // （此前锚右缘对齐，靠左的列/筛选 chips 会把弹窗推到屏幕外）；筛选 chips
    // 打开时也锚到对应列头（见 onClick），不再浮在工具栏旁
    const centered = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(8, Math.min(centered, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const up = below < 240 && above > below;
    const maxHeight = Math.min(380, Math.max(170, up ? above : below));
    const top = up ? Math.max(8, rect.top - maxHeight - 6) : rect.bottom + 4;
    setPop({ col, left, top, width, maxHeight });
  };

  const headerLabel = (col: number) => header[col] || `第 ${col + 1} 列（${columnName(col)}）`;

  return (
    <div
      className="file-preview-xlsx"
      onClick={(event) => {
        // 移动端「点预览内容切药丸」：表格里的筛选/按钮属于交互，不触发
        if ((event.target as HTMLElement).closest("button, input, label")) {
          event.stopPropagation();
        }
      }}
    >
      {sheets.length > 1 && (
        <div className="file-preview-sheets" role="tablist">
          {sheets.map((item, index) => (
            <button
              key={item.name}
              type="button"
              role="tab"
              aria-selected={index === sheetIndex}
              className={`file-preview-sheet${index === sheetIndex ? " is-on" : ""}`}
              onClick={() => setSheetIndex(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div className="xlsx-toolbar">
        <span className="xlsx-toolbar-count">
          共 {body.length} 行
          {activeCols.length > 0 && (
            <>
              {" "}
              · 筛选后 <b>{filtered.length}</b> 行
            </>
          )}
        </span>
        {activeCols.map((col) => (
          <button
            key={col}
            type="button"
            className="xlsx-filter-chip"
            title={`编辑「${headerLabel(col)}」的筛选`}
            onClick={(event) => {
              // 0.39 用户反馈「优化弹窗出现的位置」：从 chips 打开也锚到对应列头。
              // 0.39.5 合并单元格后 thead 的位置下标 ≠ 列号（colSpan 占位），按
              // data-col 找；被合并盖住的列没有自己的 th，回退锚在 chip 上
              const th = bodyWrapRef.current
                ?.querySelector(`thead th[data-col="${col}"]`) as HTMLElement | null;
              const btn = (th?.querySelector(".xlsx-filter-btn") ?? th) as HTMLElement | null;
              openPop(col, btn ?? event.currentTarget);
            }}
          >
            {headerLabel(col)}:{" "}
            {filters[col].length === 1 ? displayValue(filters[col][0]) : `${filters[col].length} 个值`}
          </button>
        ))}
        {activeCols.length > 0 && (
          <button
            type="button"
            className="xlsx-filter-clear"
            title="清除全部列筛选"
            onClick={() => setFilters({})}
          >
            清除筛选
          </button>
        )}
        <span className="spacer" />
        {sheet.truncated && (
          <span
            className="xlsx-toolbar-note"
            title={`表共 ${sheet.totalRows} 行 / ${header.length} 列，只解析了前 ${rows.length} 行（0.39.3 上限 20000 行）`}
          >
            表格过大：共 {sheet.totalRows} 行，仅预览前 {rows.length - 1} 行
          </span>
        )}
        {header.length > 0 && (
          <span className="xlsx-toolbar-note" title="点击表头右侧的 ▾ 筛选此列">
            点表头 ▾ 筛选
          </span>
        )}
      </div>
      {header.length === 0 ? (
        <div className="xlsx-empty">这个工作表是空的</div>
      ) : (
        <div className="file-preview-sheet-body" ref={bodyWrapRef}>
          <table className="xlsx-table">
            <thead>
              <tr>
                {header.map((label, col) => {
                  if (mergeCovered.has(`0:${col}`)) return null;
                  const span = mergeSpan(0, col);
                  return (
                    <th
                      key={col}
                      data-col={col}
                      colSpan={span && span.cs > 1 ? span.cs : undefined}
                      rowSpan={span && span.rs > 1 ? span.rs : undefined}
                      className={filters[col]?.length ? "is-filtered" : ""}
                    >
                      <span className="xlsx-th-label" title={label}>
                        {label || `(${columnName(col)})`}
                      </span>
                      <button
                        type="button"
                        className={`xlsx-filter-btn${filters[col]?.length ? " is-on" : ""}`}
                        title={`筛选「${headerLabel(col)}」`}
                        aria-label={`筛选 ${headerLabel(col)}`}
                        onClick={(event) => openPop(col, event.currentTarget)}
                      >
                        ▾
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => {
                const rowIdx = index + 1; // rows 里的 0 基行号（含表头）
                return (
                  <tr key={index}>
                    {header.map((_label, col) => {
                      if (mergeCovered.has(`${rowIdx}:${col}`)) return null;
                      const span = mergeSpan(rowIdx, col);
                      return (
                        <td
                          key={col}
                          colSpan={span && span.cs > 1 ? span.cs : undefined}
                          rowSpan={span && span.rs > 1 ? span.rs : undefined}
                          title={row[col] ?? ""}
                        >
                          {row[col] ?? ""}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="xlsx-empty">没有符合筛选条件的行</div>
          )}
          {filtered.length > visible.length && (
            <div className="xlsx-more">
              <button type="button" onClick={() => setCap((value) => value + RENDER_STEP)}>
                显示更多（已显示 {visible.length} / {filtered.length} 行）
              </button>
            </div>
          )}
        </div>
      )}
      {pop && (
        <div
          ref={popRef}
          className="xlsx-filter-pop"
          style={{
            left: pop.left,
            top: pop.top,
            width: pop.width,
            maxHeight: pop.maxHeight,
          }}
        >
          <ColumnFilter
            key={pop.col}
            title={headerLabel(pop.col)}
            values={popValues}
            applied={filters[pop.col]}
            onApply={(values) => {
              setFilters((prev) => {
                const next = { ...prev };
                if (!values || values.length === 0) delete next[pop.col];
                else next[pop.col] = values;
                return next;
              });
              setPop(null);
            }}
            onClose={() => setPop(null)}
          />
        </div>
      )}
    </div>
  );
}
