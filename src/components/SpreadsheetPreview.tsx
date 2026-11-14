/**
 * Excel 预览（0.39 用户反馈「添加对 excel 表的预览支持，同时要支持筛选功能」）。
 *
 * 0.39 之前 xlsx 预览是 SheetJS `sheet_to_html` 的 HTML 注入：能看但不能筛选。
 * 现在 Worker 返回二维显示字符串（lib/xlsxWorker.ts），这里自己渲染表格：
 * - 表头每列一个筛选按钮（Excel 式）：搜索值 + 多选 + 全选/清空/清除筛选；
 * - 多列筛选叠加，筛选后显示「N / M 行」，表头粘性置顶；
 * - 行虚拟化（0.39.9 用户反馈「预览表格内存占用大，拖分界线飙到 500MB」）：
 *   2 万多个真实单元格的 DOM/样式/栅格是内存大头——只渲染视口内 ±缓冲区的
 *   行，DOM 降一个数量级，分界线拖动时的重排/重绘成本也随之消失；
 *   全量行直接可滚（不再有「显示更多」分页），筛选仍作用于全部已解析行；
 * - 解析侧 20000 行 × 80 列截断（0.39.3 由 5000 放大——用户实测表 4999 行就撞顶），
 *   超大表给明确提示，避免百万行表拖死预览。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ParsedSheet } from "../lib/xlsxWorkerHost";

/** 单列筛选面板里最多列出的不同值（再多请用搜索缩小范围）。 */
const MAX_FILTER_VALUES = 500;

/**
 * 列筛选的会话级缓存（0.39.8 用户反馈「从表格切换到别的文件然后又切换回来，
 * 原来设置的筛选条件被清空了」）：FilePreview 按激活预览条件渲染，切走即卸载，
 * 组件 state 全丢。以「cacheKey::sheet 名」为键把每列筛选记在模块级 Map，
 * 重挂载/切 sheet 时回填。只活在本会话（重启即清），键带 sheet 名所以各 sheet
 * 互不串扰，清除筛选即从缓存删除。
 */
const filterCache = new Map<string, Record<number, string[]>>();

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

/** 每个值在该列的出现次数（0.39.9 用户反馈「筛选时显示该条件下的数量」），
 *  按**未筛选的全量行**统计——与筛选值列表同一口径。 */
function valueCounts(rows: string[][], col: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const v = row[col] ?? "";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/** 列筛选面板本体（挂载/卸载由 pop 状态控制，状态天然按列重置）。 */
function ColumnFilter({
  title,
  values,
  counts,
  applied,
  onApply,
  onClose,
}: {
  title: string;
  values: string[];
  /** 每个值的行数（未筛选全量口径，0.39.9 用户反馈「筛选时显示该条件下的数量」）。 */
  counts?: Map<string, number>;
  /** 已生效的值；undefined = 该列没筛选（面板初始全选）。 */
  applied?: string[];
  onApply: (values: string[] | null) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(applied ?? values),
  );
  // 0.39.8 用户反馈「优化筛选，支持多值输入」：手头常有一串单号要一起筛，
  // 空格/逗号/顿号/分号（含全角）拆成多个词，值命中**任一**词即算匹配——
  // 粘一串值进来 → 列表收敛到这几个 → 回车（勾选 ∩ 搜索）直接应用。
  // 单词时与旧的子串匹配行为完全一致。
  const terms = search
    .split(/[\s,，、;；]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const matched =
    terms.length > 0
      ? values.filter((value) => {
          const lowered = value.toLowerCase();
          return terms.some((term) => lowered.includes(term));
        })
      : values;
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
          if (terms.length > 0) {
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
        placeholder="搜索值…（空格分隔可多值 · Enter 应用 · Esc 关闭）"
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
            <span className="xlsx-filter-value-text">{displayValue(value)}</span>
            {counts && (
              <span className="xlsx-filter-value-count" title={`${counts.get(value) ?? 0} 行`}>
                {counts.get(value) ?? 0}
              </span>
            )}
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

export default function SpreadsheetPreview({
  sheets,
  cacheKey,
}: {
  sheets: ParsedSheet[];
  /** 筛选缓存的键来源（FilePreview 传 `${vault}::${path}`）；缺省不缓存。 */
  cacheKey?: string;
}) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = sheets[Math.min(sheetIndex, sheets.length - 1)];
  /** 生效的列筛选：列下标 → 选中的显示值（数组非空）。初始从缓存回填——
   *  切走文件再切回来（组件重挂载）时筛选还在。 */
  const [filters, setFilters] = useState<Record<number, string[]>>(() => {
    const first = sheets[0];
    const cached = cacheKey && first ? filterCache.get(`${cacheKey}::${first.name}`) : undefined;
    return cached ? { ...cached } : {};
  });
  /** 行虚拟化状态：滚动位置 + 视口高 + 实测行高（0.39.9 内存优化）。 */
  const [scroll, setScroll] = useState({ top: 0, viewH: 600 });
  const [rowH, setRowH] = useState(0); // 0 = 未实测，用估计值兜底
  const scrollRafRef = useRef<number | undefined>(undefined);
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


  // 切 sheet / 换文件（同一实例被复用，如分屏栏）：收起面板、重置分页，
  // 筛选从该 sheet 的缓存回填（没记录过 = 空）。
  useEffect(() => {
    const target = sheets[Math.min(sheetIndex, sheets.length - 1)];
    const cached =
      cacheKey && target ? filterCache.get(`${cacheKey}::${target.name}`) : undefined;
    setFilters(cached ? { ...cached } : {});
    setPop(null);
  }, [sheetIndex, cacheKey, sheets]);

  // 换文件（cacheKey 变化）时回到第一个 sheet；分屏栏复用同一实例，不重置的话
  // sheetIndex 指着上一个文件的 sheet 序号
  useEffect(() => {
    setSheetIndex(0);
  }, [cacheKey]);

  // 筛选变化写回缓存（清除筛选 = 从缓存删除），保证切走再切回是"最后一次"的状态
  useEffect(() => {
    const target = sheets[Math.min(sheetIndex, sheets.length - 1)];
    if (!cacheKey || !target) return;
    const key = `${cacheKey}::${target.name}`;
    if (Object.keys(filters).length === 0) filterCache.delete(key);
    else filterCache.set(key, filters);
  }, [filters, sheetIndex, cacheKey, sheets]);

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
  // 0.39.7 表头行识别：「合并大标题行 + 字段名行」文件里横幅行进 thead（不吸附、
  // 无筛选钮），列头/筛选/数据全从紧挨数据的那一行开始——普通表 headerRow=0 行为不变
  const headerRow = sheet?.headerRow ?? 0;
  const bannerRows = rows.slice(0, headerRow);
  const header = rows[headerRow] ?? [];

  /**
   * 钉死的列宽（0.39.9 用户反馈「筛选后水平位置偏移」）——**挂载前同步测好**，
   * 表格第一帧就带 colgroup + fixed：0.39.9 初版是「先渲染 auto 表→读自然宽→
   * 回填 fixed」，等于每次打开把 2 万多个单元格的样式重算做**两遍**
   * （UpdateLayoutTree 2 秒，CDP Tracing 实锤；`.is-fixed td` 后代选择器一加
   * 全表样式失效），这是「加载比旧版慢很多」的真因。现在测宽在「正在加载」
   * 遮罩期间完成（canvas measureText，取样 ≤1500 行），表格只渲染一次。
   * 列宽与筛选无关 → 筛选前后列位不动。
   */
  const colWidths = useMemo(() => {
    if (!sheet || header.length === 0) return null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const family = getComputedStyle(document.body).fontFamily || "sans-serif";
    if (ctx) ctx.font = `12.5px ${family}`; // 与 .xlsx-table th,td 的字号一致
    // .xlsx-table th,td = padding 3px 9px + border 1px → 水平合计 20px
    const padX = 20;
    const cache = new Map<string, number>();
    const widthOf = (text: string): number => {
      const hit = cache.get(text);
      if (hit !== undefined) return hit;
      const w = ctx ? ctx.measureText(text).width : text.length * 6;
      cache.set(text, w);
      return w;
    };
    const widths = new Array<number>(header.length).fill(0);
    for (let c = 0; c < header.length; c += 1) {
      widths[c] = widthOf(header[c] ?? "") + 26; // 26 = ▾ 筛选按钮预算
    }
    const dataEnd = Math.min(sheet.rows.length, sheet.headerRow + 1 + 1500);
    for (let r = sheet.headerRow + 1; r < dataEnd; r += 1) {
      const row = sheet.rows[r];
      for (let c = 0; c < header.length; c += 1) {
        const w = widthOf(row[c] ?? "");
        if (w > widths[c]) widths[c] = w;
      }
    }
    return widths.map((w) => Math.min(480, Math.max(48, w + padX)));
    // header 由 sheet 派生，随 sheet 一起变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);
  const body = useMemo(() => rows.slice(headerRow + 1), [rows, headerRow]);
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

  const activeCols = Object.keys(filters)
    .map(Number)
    .filter((col) => (filters[col]?.length ?? 0) > 0)
    .sort((a, b) => a - b);
  const popValues = useMemo(() => (pop ? distinctValues(body, pop.col) : []), [pop, body]);
  const popCounts = useMemo(() => (pop ? valueCounts(body, pop.col) : undefined), [pop, body]);

  // ---- 行虚拟化：视口窗口计算（行高恒定 = nowrap 单行）----
  const rowHEstimate = rowH || 27;
  const viewH = scroll.viewH || 600;
  const overscan = 12;
  let vStart = Math.max(0, Math.floor(scroll.top / rowHEstimate) - overscan);
  // 纵向合并原点在窗口上方的，把窗口上沿扩到原点（否则窗口边会出现空洞），
  // 扩展上限 200 行防超大合并把窗口拖爆
  for (const m of sheet?.merges ?? []) {
    if (m.rs <= 1) continue;
    const originData = m.r - (headerRow + 1);
    const endData = originData + m.rs - 1;
    if (endData >= vStart && originData < vStart) {
      vStart = Math.max(0, Math.max(vStart - 200, originData));
    }
  }
  const vEnd = Math.min(filtered.length, Math.ceil((scroll.top + viewH) / rowHEstimate) + overscan);
  const rowsSlice = filtered.slice(vStart, vEnd);
  const topPad = vStart * rowHEstimate;
  const bottomPad = Math.max(0, (filtered.length - vEnd) * rowHEstimate);

  // 实测行高（首帧用估计值，挂载后按真实 tr 修正；filtered 行数变化后复测）
  useLayoutEffect(() => {
    const tr = bodyWrapRef.current?.querySelector<HTMLTableRowElement>(
      "tbody tr:not(.xlsx-vspacer)",
    );
    const h = tr?.offsetHeight ?? 0;
    if (h > 10) setRowH((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
  }, [sheet, filtered.length, rowHEstimate]);

  // 视口高随分界线拖动/窗口缩放变化
  useEffect(() => {
    const el = bodyWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setScroll((s) => (s.viewH === el.clientHeight ? s : { ...s, viewH: el.clientHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheet]);

  // 滚动：rAF 合帧更新窗口（高频 scroll 事件与拖拽同理）
  const onBodyScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (scrollRafRef.current !== undefined) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = undefined;
      setScroll((s) =>
        s.top === el.scrollTop && s.viewH === el.clientHeight ? s : { top: el.scrollTop, viewH: el.clientHeight },
      );
    });
  };

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
          // 0.39.8 用户反馈「筛选条件添加关闭按钮」：chip 拆成「条件标签（点开
          // 编辑面板）+ ×（直接清掉该列筛选）」。外壳用 span 承接胶囊样式——
          // button 里再嵌 button 不合 HTML 规范，原生解析会把它拆开。
          <span key={col} className="xlsx-filter-chip">
            <button
              type="button"
              className="xlsx-filter-chip-label"
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
            <button
              type="button"
              className="xlsx-filter-chip-x"
              aria-label={`清除「${headerLabel(col)}」的筛选`}
              title="清除该列筛选"
              onClick={(event) => {
                event.stopPropagation();
                setFilters((prev) => {
                  const next = { ...prev };
                  delete next[col];
                  return next;
                });
              }}
            >
              ×
            </button>
          </span>
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
            表格过大：共 {sheet.totalRows} 行，仅预览前 {rows.length - 1 - headerRow} 行数据
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
        <div className="file-preview-sheet-body" ref={bodyWrapRef} onScroll={onBodyScroll}>
          <table
            className={`xlsx-table${colWidths ? " is-fixed" : ""}`}
            style={
              colWidths
                ? {
                    tableLayout: "fixed",
                    // Chrome 对 width:auto 的表格**不启用 fixed 算法**（列宽照样
                    // 跟内容走，0.39.9 用户实测筛选仍偏移 + 本地复现实锤）——
                    // 必须给显式宽度，用列宽之和；min-width:100% 继续兜住
                    // 「列比容器窄」的拉伸，拉伸分配只依赖容器宽度，筛选不影响
                    width: `${colWidths.reduce((a, b) => a + b, 0)}px`,
                  }
                : undefined
            }
          >
            {colWidths && (
              <colgroup>
                {colWidths.map((w, col) => (
                  <col key={col} style={{ width: `${w}px` }} />
                ))}
              </colgroup>
            )}
            <thead>
              {bannerRows.map((bannerRow, br) => (
                <tr key={`banner-${br}`}>
                  {header.map((_label, col) => {
                    if (mergeCovered.has(`${br}:${col}`)) return null;
                    const span = mergeSpan(br, col);
                    return (
                      <th
                        key={col}
                        className="xlsx-th-banner"
                        colSpan={span && span.cs > 1 ? span.cs : undefined}
                        rowSpan={span && span.rs > 1 ? span.rs : undefined}
                      >
                        {bannerRow[col] ?? ""}
                      </th>
                    );
                  })}
                </tr>
              ))}
              <tr>
                {header.map((label, col) => {
                  if (mergeCovered.has(`${headerRow}:${col}`)) return null;
                  const span = mergeSpan(headerRow, col);
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
              {topPad > 0 && (
                <tr className="xlsx-vspacer" style={{ height: `${topPad}px` }}>
                  <td colSpan={header.length} style={{ border: 0, padding: 0 }} />
                </tr>
              )}
              {rowsSlice.map((row, i) => {
                // rows 里的 0 基绝对行号（含表头行）——mergeSpan/mergeCovered 都按
                // 绝对行号索引；顺带修正了旧版 headerRow>0 时 index+1 的偏移隐患
                const rowIdx = headerRow + 1 + vStart + i;
                return (
                  <tr key={rowIdx}>
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
              {bottomPad > 0 && (
                <tr className="xlsx-vspacer" style={{ height: `${bottomPad}px` }}>
                  <td colSpan={header.length} style={{ border: 0, padding: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="xlsx-empty">没有符合筛选条件的行</div>
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
            counts={popCounts}
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
