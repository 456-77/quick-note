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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ParsedSheet } from "../lib/xlsxWorkerHost";
import { isMobile } from "../lib/platform";
import PreviewScrollbar from "./PreviewScrollbar";

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
/**
 * 上次停留的 sheet（0.39.31 用户反馈「切标签页时，原来 excel 预览文件要保持
 * 之前打开 sheet 页」）：筛选有 filterCache，sheet 页此前每次重挂载都回第一个。
 * 按「cacheKey（仓库::路径）→ sheet 名」记最后一个，重挂载时按名字找回
 * （不用下标：工作簿改动后 sheet 顺序/数量可能变）。
 */
const sheetCache = new Map<string, string>();

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
  scope,
  onScopeChange,
}: {
  title: string;
  values: string[];
  /** 每个值的行数（未筛选全量口径，0.39.9 用户反馈「筛选时显示该条件下的数量」）。 */
  counts?: Map<string, number>;
  /** 已生效的值；undefined = 该列没筛选（面板初始全选）。 */
  applied?: string[];
  onApply: (values: string[] | null) => void;
  onClose: () => void;
  /** 计数口径（0.39.12 反馈「已经设置了一个筛选条件，面板里显示的数量是所有的，
   * 而不是继承上一个搜索条件」）：inherit=只统计已过其他列筛选的行；global=全量。 */
  scope: "inherit" | "global";
  onScopeChange: (scope: "inherit" | "global") => void;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(applied ?? values),
  );
  // 0.39.12 用户反馈「右键筛选条件行改成出现弹窗供选择，复制当前行或者复制
  // 所有选中行」：值行右键自绘菜单（原来弹的是浏览器原生菜单）
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; value: string } | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  // 点外/Esc 收起。Esc 用捕获阶段拦在本面板自己的 Esc（关闭整个弹窗）之前：
  // 菜单开着时 Esc 只收菜单
  useEffect(() => {
    if (!rowMenu) return;
    const onDown = (event: MouseEvent) => {
      if (rowMenuRef.current?.contains(event.target as Node)) return;
      setRowMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setRowMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [rowMenu]);
  const copyRows = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      window.dispatchEvent(new CustomEvent("qn-notice", { detail: { message: label } }));
    });
  };
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
        <span className="spacer" />
        {/* 0.39.12 反馈：计数口径（继承=按已过其他列筛选的行统计，全局=全量） */}
        <span className="xlsx-filter-scope" role="group" aria-label="计数口径">
          <button
            type="button"
            className={scope === "inherit" ? "is-on" : ""}
            title="值列表与行数只统计已通过其他列筛选的行（在当前结果里再筛）"
            onClick={() => onScopeChange("inherit")}
          >
            继承
          </button>
          <button
            type="button"
            className={scope === "global" ? "is-on" : ""}
            title="值列表与行数按全表统计（不看其他列的筛选）"
            onClick={() => onScopeChange("global")}
          >
            全局
          </button>
        </span>
      </div>
      <div className="xlsx-filter-values">
        {listed.map((value) => (
          <label
            key={value || "\u0000"}
            className="xlsx-filter-value"
            title={displayValue(value)}
            onContextMenu={(event) => {
              // 0.39.12：右键值行弹自绘菜单（浏览器原生菜单被拦掉）
              event.preventDefault();
              event.stopPropagation();
              setRowMenu({ x: event.clientX, y: event.clientY, value });
            }}
          >
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
      {rowMenu && (
        <>
          <div
            className="menu-backdrop"
            onClick={() => setRowMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setRowMenu(null);
            }}
          />
          <div
            className="context-menu"
            ref={rowMenuRef}
            style={{
              left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 216)),
              top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - 96)),
            }}
          >
            <button
              type="button"
              onClick={() => {
                copyRows(rowMenu.value, "已复制当前行");
                setRowMenu(null);
              }}
            >
              复制当前行
            </button>
            <button
              type="button"
              disabled={chosen.size === 0}
              onClick={() => {
                // 选中行按值列表原序、每行一条（长值换行粘贴最可读）
                const text = values.filter((value) => chosen.has(value)).join("\n");
                copyRows(text, `已复制所有选中行（${chosen.size} 行）`);
                setRowMenu(null);
              }}
            >
              复制所有选中行{chosen.size > 0 ? `（${chosen.size} 行）` : ""}
            </button>
          </div>
        </>
      )}
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
  editable = false,
  onEditCell,
}: {
  sheets: ParsedSheet[];
  /** 筛选缓存的键来源（FilePreview 传 `${vault}::${path}`）；缺省不缓存。 */
  cacheKey?: string;
  /**
   * 是否可以编辑单元格（0.39.19 用户反馈「对于 excel 文件，添加功能：可以
   * 编辑单元格内容」）。只对 xlsx/xlsm 开放：老式 .xls 是二进制 OLE，
   * 我们的外科手术式写入只认 zip+XML。
   */
  editable?: boolean;
  /**
   * 提交单元格编辑：sheet 名 + **相对解析窗口**的行列下标 + 用户输入原文。
   * 绝对坐标换算（+ startRow/startCol）与落盘由 FilePreview 负责；失败时
   * reject，本组件保留编辑框并提示，不吞掉用户输入。
   */
  onEditCell?: (
    sheetName: string,
    rowIndex: number,
    col: number,
    value: string,
  ) => Promise<void>;
}) {
  const [sheetIndex, setSheetIndex] = useState(() => {
    const cached = cacheKey ? sheetCache.get(cacheKey) : undefined;
    const found = cached ? sheets.findIndex((item) => item.name === cached) : -1;
    return found >= 0 ? found : 0;
  });
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
  /** 筛选 chip 右键菜单（0.39.12 用户反馈「复制当前/全部筛选条件」）。 */
  const [copyMenu, setCopyMenu] = useState<{ x: number; y: number; col: number } | null>(null);
  /** 数据格右键菜单（0.39.16 用户反馈「右键数据框时，弹出弹窗，可以选择复制
      当前数据框内容」）：复制单元格 / 复制整行（TSV，可直接粘回 Excel）。
      0.39.19 加「编辑单元格」（移动端长按也能进编辑）。 */
  const [cellMenu, setCellMenu] = useState<{
    x: number;
    y: number;
    text: string;
    rowText: string;
    row: number;
    col: number;
  } | null>(null);
  /** 单元格编辑（0.39.19）：选中格 + 正在编辑的格。行号用 sheet.rows 的
   *  相对下标（跨表时由 FilePreview 加 startRow/startCol 换绝对坐标）。 */
  const [sel, setSel] = useState<{ row: number; col: number } | null>(null);
  const [edit, setEdit] = useState<{
    row: number;
    col: number;
    value: string;
    /** 进入编辑时的原值（跳过未改动提交用；value 随输入实时变，不能当基准） */
    original: string;
    saving: boolean;
  } | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  /** Enter 与 blur 会同时触发提交——用一个同步闸挡住第二次。 */
  const editSavingRef = useRef(false);
  /** Esc 取消后即使有迟到的 blur 也不许提交。 */
  const editCancelledRef = useRef(false);
  /** 编辑代际：慢速保存返回时若用户已开始编辑下一格，不能把新编辑器关掉。 */
  const editTokenRef = useRef(0);
  /** 程序化移动选中格后待聚焦的目标（目标行可能还没渲染出来，等滚动后的重渲）。 */
  const pendingFocusRef = useRef<{ row: number; col: number } | null>(null);
  const canEdit = editable && !!onEditCell;
  /** 筛选面板计数口径（0.39.12 反馈「面板里显示的数量是所有的，而不是继承上一个
   *  搜索条件」+「添加一个选项设置是全局还是继承」）：默认继承=按已过其他列筛选
   *  的行统计值列表与行数；选择持久化。 */
  const [countScope, setCountScope] = useState<"inherit" | "global">(() => {
    try {
      return localStorage.getItem("quicknote.ui.filterCountScope") === "global" ? "global" : "inherit";
    } catch {
      return "inherit";
    }
  });
  const changeCountScope = useCallback((scope: "inherit" | "global") => {
    setCountScope(scope);
    try {
      localStorage.setItem("quicknote.ui.filterCountScope", scope);
    } catch {
      // 存不进只影响下次启动，本次会话照常生效
    }
  }, []);

  /** 列宽缓存（0.39.19）：编辑单元格会换掉 sheet 对象，但尺寸/表头没变时
   *  没必要把 1500 行 × 80 列重新 measureText 一遍（每次保存后重测会明显卡）。 */
  const widthCacheRef = useRef<{ key: string; widths: number[] | null } | null>(null);

  // ---- 单元格编辑（0.39.19）----
  const beginEdit = useCallback(
    (rowIndex: number, col: number) => {
      if (!canEdit) return;
      const current = sheets[Math.min(sheetIndex, sheets.length - 1)];
      if (!current) return;
      editSavingRef.current = false;
      editCancelledRef.current = false;
      editTokenRef.current += 1;
      setSel({ row: rowIndex, col });
      const original = current.rows[rowIndex]?.[col] ?? "";
      setEdit({
        row: rowIndex,
        col,
        value: original,
        original,
        saving: false,
      });
    },
    [canEdit, sheets, sheetIndex],
  );

  const cancelEdit = useCallback(() => {
    editCancelledRef.current = true;
    editSavingRef.current = false;
    editTokenRef.current += 1;
    setEdit(null);
  }, []);

  const commitEdit = useCallback(
    async (explicitValue?: string): Promise<boolean> => {
      if (editCancelledRef.current) {
        editCancelledRef.current = false;
        return false;
      }
      if (!edit || !onEditCell || editSavingRef.current) return false;
      const current = sheets[Math.min(sheetIndex, sheets.length - 1)];
      if (!current) return false;
      // 以**输入框 DOM 值**为准（调用方从 blur/Enter 的 currentTarget 传入）：
      // 中文输入法/极快的输入序列里 React state 可能还没跟上，用 state 会提交
      // 上一帧的旧值（用户实锤「编辑完切格后显示空白」——提交了空串）
      const text = explicitValue ?? edit.value;
      const token = editTokenRef.current;
      editSavingRef.current = true;
      setEdit((prev) => (prev ? { ...prev, value: text, saving: true } : prev));
      try {
        await onEditCell(current.name, edit.row, edit.col, text);
        // 保存成功：闸保持关闭到下一次 beginEdit——输入框卸载时若浏览器补发
        // blur（部分 WebView 会），不能再把同一格提交一遍
        if (editTokenRef.current === token) setEdit(null);
        return true;
      } catch (err) {
        // 写盘失败：保留编辑框和输入，用户可修正/重试或复制走
        editSavingRef.current = false;
        if (editTokenRef.current === token) {
          setEdit((prev) => (prev ? { ...prev, saving: false } : prev));
        }
        const message = err instanceof Error ? err.message : String(err);
        window.dispatchEvent(
          new CustomEvent("qn-notice", {
            detail: { message: `单元格保存失败：${message}` },
          }),
        );
        return false;
      }
    },
    [edit, sheets, sheetIndex, onEditCell],
  );

  const editingCellKey = edit ? `${edit.row}:${edit.col}` : "";
  useEffect(() => {
    if (!edit) return;
    const input = editInputRef.current;
    if (!input) return;
    // 双击/长按进入编辑：全选让「直接输入替换」成为默认动作（Excel 双击是
    // 光标进格，但预览场景里覆盖旧值更常见）
    input.focus({ preventScroll: true });
    input.select();
    // 只在换格时聚焦；saving 状态变化不重新聚焦
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingCellKey]);

  /** 编辑框键盘：Enter 下移 / Tab 右移（Shift 反向）；保存成功后把选中格移到
   *  相邻单元格**并直接进入编辑态**（0.39.20 用户反馈「回车以及tab后要能够直接
   *  编辑，而不是得双击后编辑」），失败则留在原格（输入不丢）。Esc 取消且
   *  stopPropagation。**必须 stopPropagation**：输入框在 td 里，Enter 继续冒泡
   *  会命中 td 的 onKeyDown（又开一次编辑），把刚提交的编辑框重开成旧值——
   *  0.39.19 冒烟实锤（保存成功但输入框不关、显示旧值）。 */
  const handleEditorKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 中文输入法组词中的 Enter 是「选词/上屏」，不能当提交（否则上屏即保存并跳格）
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      const current = edit;
      const dRow = event.key === "Enter" ? (event.shiftKey ? -1 : 1) : 0;
      const dCol = event.key === "Tab" ? (event.shiftKey ? -1 : 1) : 0;
      const text = event.currentTarget.value;
      // 值没改（Tab/Enter 穿格）不写盘：省一次原子写 + 云端版本号不做无谓推进。
      // 基准是**进入编辑时的原值**（original），不能比 edit.value——受控输入里
      // 它随打字实时变，永远等于 text，比了等于永远跳过提交
      const after = current && text === current.original
        ? Promise.resolve(true)
        : commitEdit(text);
      void after.then((ok) => {
        if (!ok || !current) return;
        // 表头格没有「选中态」：Enter 落到首条数据；Tab 只提交不移动
        if (current.row === headerRow) {
          if (dRow > 0) moveSelection(current.row, current.col, 1, 0, { thenEdit: true });
        } else {
          moveSelection(current.row, current.col, dRow, dCol, { thenEdit: true });
        }
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  };

  /** 单元格编辑框（表头/数据格共用；样式按宿主 th/td 区分）。 */
  const renderEditor = () => {
    if (!edit) return null;
    return (
      <input
        ref={editInputRef}
        className="xlsx-cell-input"
        value={edit.value}
        readOnly={edit.saving}
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(event) =>
          setEdit((prev) => (prev ? { ...prev, value: event.target.value } : prev))
        }
        onKeyDown={handleEditorKey}
        onBlur={(event) => {
          // 值没改不提交：Tab/Enter 穿格走 thenEdit 换格时，旧输入框卸载的 blur
          // 不能再把同一份原值写一遍（落盘去重+省一次 IPC）
          const value = event.currentTarget.value;
          if (value === edit?.original) return;
          void commitEdit(value);
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      />
    );
  };


  // 切 sheet / 换文件（同一实例被复用，如分屏栏）：收起面板、重置分页，
  // 筛选从该 sheet 的缓存回填（没记录过 = 空）。
  useEffect(() => {
    const target = sheets[Math.min(sheetIndex, sheets.length - 1)];
    const cached =
      cacheKey && target ? filterCache.get(`${cacheKey}::${target.name}`) : undefined;
    setFilters(cached ? { ...cached } : {});
    setPop(null);
    setCopyMenu(null);
  }, [sheetIndex, cacheKey, sheets]);

  // 编辑框只随「切表/换文件」收掉——不能跟着 sheets 一起收：保存成功后
  // watcher 的静默重读会在 ~1s 后换掉 sheets，用户此刻若已在编辑下一格，
  // 会被无端清空输入。
  useEffect(() => {
    setEdit(null);
    setSel(null);
    editSavingRef.current = false;
    editCancelledRef.current = true;
    editTokenRef.current += 1;
  }, [sheetIndex, cacheKey]);

  // 换文件（cacheKey 变化）时恢复该文件上次停留的 sheet；没有记录才回第一个
  // （0.39.31：此前一律 setSheetIndex(0)，切标签回来就丢 sheet）
  useEffect(() => {
    const cached = cacheKey ? sheetCache.get(cacheKey) : undefined;
    const found = cached ? sheets.findIndex((item) => item.name === cached) : -1;
    setSheetIndex(found >= 0 ? found : 0);
  }, [cacheKey, sheets]);

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

  // 右键复制菜单：点外/Esc 收起。Esc 用捕获阶段先于 FilePreview 的 window 监听
  // 并 preventDefault——否则按 Esc 会在收菜单的同时把预览标签连带关掉
  //（0.39.8「Esc 关弹窗连带关预览」同一条坑，新增浮层要自己拦住）
  useEffect(() => {
    if (!copyMenu && !cellMenu) return;
    const close = () => {
      setCopyMenu(null);
      setCellMenu(null);
    };
    const onDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest?.(".context-menu")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [copyMenu, cellMenu]);

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
    // 编辑单元格后 sheet 对象会换新，但尺寸/表头没变时直接复用上次测宽结果
    //（0.39.19：每次保存都重测 1500 行会让编辑明显卡顿；表头文字变了才重测）
    const widthKey = `${sheet.name}\u0000${sheet.rows.length}\u0000${
      sheet.rows[0]?.length ?? 0
    }\u0000${sheet.headerRow}\u0000${header.join("\u0001")}`;
    const cachedWidths = widthCacheRef.current;
    if (cachedWidths && cachedWidths.key === widthKey) return cachedWidths.widths;
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
    const result = widths.map((w) => Math.min(480, Math.max(48, w + padX)));
    widthCacheRef.current = { key: widthKey, widths: result };
    return result;
    // header 由 sheet 派生，随 sheet 一起变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, header]);
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

  /**
   * 筛选后行对象 → body 下标（0.39.19 用户实锤：有筛选时 `vStart + i` 是
   * **筛选后位置**，不是 `sheet.rows` 的绝对行号——双击读取/保存/选区/合并
   * 定位全落到错误行：编辑器显示别的行内容、保存写到别处、Tab/Enter 移动后
   * 没有任何单元格被选中）。行对象来自 `body`，用引用相等建映射；无筛选时
   * `filtered === body`，直接走 `vStart + i` 不建表。
   */
  const bodyIndexMap = useMemo(() => {
    if (filtered === body) return null;
    const map = new Map<string[], number>();
    body.forEach((row, index) => map.set(row, index));
    return map;
  }, [body, filtered]);

  const activeCols = Object.keys(filters)
    .map(Number)
    .filter((col) => (filters[col]?.length ?? 0) > 0)
    .sort((a, b) => a - b);
  // 继承口径的统计基数：已通过**其他列**筛选的行（不含本列自身——面板正在编辑
  // 本列的勾选，基数得给出本列的完整分布）。没有其他筛选时与全量一致。
  const popInheritBase = useMemo(() => {
    if (!pop) return body;
    const others = Object.entries(filters).filter(
      ([col, values]) => values.length > 0 && Number(col) !== pop.col,
    );
    if (others.length === 0) return body;
    return body.filter((row) =>
      others.every(([col, values]) => values.includes(row[Number(col)] ?? "")),
    );
  }, [pop, body, filters]);
  const countBase = countScope === "inherit" ? popInheritBase : body;
  const popValues = useMemo(
    () => (pop ? distinctValues(countBase, pop.col) : []),
    [pop, countBase],
  );
  const popCounts = useMemo(
    () => (pop ? valueCounts(countBase, pop.col) : undefined),
    [pop, countBase],
  );

  /**
   * 程序化移动选中格（0.39.19 用户反馈「tab键切换到同行右侧单元格，enter键
   * 切换到同列下面的单元格」）。行号用 sheet.rows 的下标；有筛选时在**可见行**
   * 里移动（被筛掉的行不该被 Tab 经过）。Tab 越过最后一列 → 下一行第一列；
   * Shift+Tab 反向；Enter/Shift+Enter 上下移。
   * 0.39.20 用户反馈「表格中回车以及tab后要能够直接编辑，而不是得双击后编辑」：
   * opts.thenEdit 落点直接进编辑态（编辑链免双击；虚拟化窗口外的落点由滚动
   * 重渲后自动带出编辑框）。
   */
  function moveSelection(
    fromRow: number,
    fromCol: number,
    dRow: number,
    dCol: number,
    opts: { thenEdit?: boolean } = {},
  ) {
    if (!sheet || header.length === 0 || filtered.length === 0) return;
    const dataIndex = fromRow - headerRow - 1;
    const currentRow = dataIndex >= 0 ? body[dataIndex] : undefined;
    // 表头行 = 「第 -1 行」，Enter 下行自然落到第一条数据
    let visiblePos =
      fromRow <= headerRow ? -1 : currentRow ? filtered.indexOf(currentRow) : -1;
    if (visiblePos < 0 && fromRow > headerRow) {
      visiblePos = Math.max(0, Math.min(dataIndex, filtered.length - 1));
    }
    let targetPos = visiblePos;
    let targetCol = fromCol;
    if (dCol !== 0) {
      targetCol += dCol;
      if (targetCol < 0) {
        targetCol = header.length - 1;
        targetPos -= 1;
      } else if (targetCol >= header.length) {
        targetCol = 0;
        targetPos += 1;
      }
    }
    if (dRow !== 0) targetPos += dRow;
    targetPos = Math.max(0, Math.min(filtered.length - 1, targetPos));
    const targetRow = filtered[targetPos];
    if (!targetRow) return;
    const targetData = body.indexOf(targetRow);
    if (targetData < 0) return;
    const rowIdx = headerRow + 1 + targetData;
    setSel({ row: rowIdx, col: targetCol });
    // thenEdit 落点直接进编辑：**不能**再排 td 聚焦——pendingFocus 的 effect 会
    // 把焦点从刚挂载的编辑输入框抢走，触发 blur 提交把编辑框秒关（0.39.20 批测
    // 实锤）。对齐交给编辑框挂载 effect 的 focus({preventScroll})，粗对齐靠上面的
    // scrollRowIntoView。落点被夹取回**原格**（末行 Enter / 筛选只剩一行）时不进
    // 编辑——原格重开编辑器会让单元格停在编辑态、显示值不更新，体验是「Enter
    // 关不掉」；此时走普通选中聚焦收尾
    if (opts.thenEdit && (rowIdx !== fromRow || targetCol !== fromCol)) {
      beginEdit(rowIdx, targetCol);
    } else {
      pendingFocusRef.current = { row: rowIdx, col: targetCol };
    }
    scrollRowIntoView(targetPos);
  }

  /** 按估算行高把目标行大致滚进视口；精确对齐由聚焦 effect 再做一次。 */
  function scrollRowIntoView(visiblePosition: number) {
    const wrap = bodyWrapRef.current;
    if (!wrap) return;
    const headerH =
      (wrap.querySelector("thead") as HTMLElement | null)?.offsetHeight ?? 0;
    const estimate = rowH || 27;
    const rowTop = headerH + visiblePosition * estimate;
    const rowBottom = rowTop + estimate;
    if (rowTop < wrap.scrollTop + headerH) {
      wrap.scrollTop = Math.max(0, rowTop - headerH - estimate);
    } else if (rowBottom > wrap.scrollTop + wrap.clientHeight) {
      wrap.scrollTop = rowBottom - wrap.clientHeight + estimate;
    }
  }

  // 移动后的目标格可能刚被虚拟化窗口纳入（滚动触发的 rAF 重渲之后才存在），
  // 等它出现再聚焦，并做一次像素级对齐（表头是 sticky 的，scrollIntoView 会盖住）
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    const wrap = bodyWrapRef.current;
    if (!wrap) return;
    const td = wrap.querySelector<HTMLElement>(
      `td[data-row="${pending.row}"][data-col="${pending.col}"]`,
    );
    if (!td) return;
    pendingFocusRef.current = null;
    td.focus({ preventScroll: true });
    const headerH =
      (wrap.querySelector("thead") as HTMLElement | null)?.offsetHeight ?? 0;
    const wrapRect = wrap.getBoundingClientRect();
    const rect = td.getBoundingClientRect();
    if (rect.top < wrapRect.top + headerH) {
      wrap.scrollTop -= wrapRect.top + headerH - rect.top + 2;
    } else if (rect.bottom > wrapRect.bottom) {
      wrap.scrollTop += rect.bottom - wrapRect.bottom + 2;
    }
    if (rect.left < wrapRect.left) {
      wrap.scrollLeft -= wrapRect.left - rect.left + 2;
    } else if (rect.right > wrapRect.right) {
      wrap.scrollLeft += rect.right - wrapRect.right + 2;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroll.top, sel, filtered]);

  // ---- 行虚拟化：视口窗口计算（行高恒定 = nowrap 单行）----
  const rowHEstimate = rowH || 27;
  const viewH = scroll.viewH || 600;
  const overscan = 12;
  let vStart = Math.max(0, Math.floor(scroll.top / rowHEstimate) - overscan);
  // 纵向合并原点在窗口上方的，把窗口上沿扩到原点（否则窗口边会出现空洞），
  // 扩展上限 200 行防超大合并把窗口拖爆。注意 vStart 是「可见行位置」，
  // 与合并区间的绝对行号只在无筛选时同一坐标系——有筛选时不做这段扩展
  if (!bodyIndexMap) {
    for (const m of sheet?.merges ?? []) {
      if (m.rs <= 1) continue;
      const originData = m.r - (headerRow + 1);
      const endData = originData + m.rs - 1;
      if (endData >= vStart && originData < vStart) {
        vStart = Math.max(0, Math.max(vStart - 200, originData));
      }
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

  /** 一列筛选条件的人话文本（右键复制用，0.39.12）：`列名: 值1、值2`。 */
  const filterConditionText = (col: number) =>
    `${headerLabel(col)}: ${(filters[col] ?? []).map(displayValue).join("、")}`;

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
              onClick={() => {
                setSheetIndex(index);
                // 记下这次停留的 sheet 名，切走/切标签回来时按名恢复（0.39.31）
                if (cacheKey) sheetCache.set(cacheKey, item.name);
              }}
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
                // 0.39.12 用户反馈「点击上面的筛选条件标签，为什么弹窗会出现在左边」：
                // 宽表横向滚动后列头滚出视口（rect 在屏幕外），openPop 的夹取只会把
                // 弹窗钉在屏幕左缘——列头此刻不可见就改锚点击的 chip 本身（弹窗跟着
                // 手边的东西走，不跟着看不见的列头走）
                let anchor: HTMLElement = event.currentTarget;
                if (btn) {
                  const r = btn.getBoundingClientRect();
                  if (r.width > 0 && r.right > 0 && r.left < window.innerWidth) anchor = btn;
                }
                openPop(col, anchor);
              }}
              onContextMenu={(event) => {
                // 0.39.12 用户反馈：右键 chip 复制筛选条件（当前列 / 全部列）
                event.preventDefault();
                event.stopPropagation();
                setPop(null);
                setCopyMenu({ x: event.clientX, y: event.clientY, col });
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
        {edit?.saving && <span className="xlsx-toolbar-note">保存中…</span>}
        {header.length > 0 && (
          <span
            className="xlsx-toolbar-note"
            title={
              canEdit
                ? "双击单元格编辑；Enter/Tab 落点直接进编辑（Shift 反向），Esc 取消；选中格上 Enter 编辑当前格、Tab 右移并编辑。点击表头右侧的 ▾ 筛选此列"
                : "点击表头右侧的 ▾ 筛选此列"
            }
          >
            {canEdit ? "双击编辑 · Enter/Tab 直接编辑 · 点表头 ▾ 筛选" : "点表头 ▾ 筛选"}
          </span>
        )}
      </div>
      {header.length === 0 ? (
        <div className="xlsx-empty">这个工作表是空的</div>
      ) : (
        <div className="file-preview-sheet-wrap">
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
                      {edit?.row === headerRow && edit?.col === col ? (
                        renderEditor()
                      ) : (
                        <span
                          className="xlsx-th-label"
                          title={
                            canEdit
                              ? `${label || `(${columnName(col)})`}（双击编辑）`
                              : label
                          }
                          onDoubleClick={
                            canEdit
                              ? (event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  beginEdit(headerRow, col);
                                }
                              : undefined
                          }
                        >
                          {label || `(${columnName(col)})`}
                        </span>
                      )}
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
                // rows 里的 0 基绝对行号（含表头行）——mergeSpan/mergeCovered、
                // 编辑读写、data-row 都按它索引。筛选后必须用 body 下标映射：
                // vStart+i 只是「筛选后第几行」，不是原表行号（0.39.19 修复）
                const rowIdx =
                  headerRow + 1 + (bodyIndexMap?.get(row) ?? vStart + i);
                return (
                  <tr key={rowIdx}>
                    {header.map((_label, col) => {
                      if (mergeCovered.has(`${rowIdx}:${col}`)) return null;
                      const span = mergeSpan(rowIdx, col);
                      const isEditingCell = edit?.row === rowIdx && edit?.col === col;
                      const isSelectedCell = sel?.row === rowIdx && sel?.col === col;
                      return (
                        <td
                          key={col}
                          data-col={col}
                          data-row={rowIdx}
                          colSpan={span && span.cs > 1 ? span.cs : undefined}
                          rowSpan={span && span.rs > 1 ? span.rs : undefined}
                          className={
                            [
                              isEditingCell ? "is-editing" : "",
                              isSelectedCell ? "is-selected" : "",
                            ]
                              .filter(Boolean)
                              .join(" ") || undefined
                          }
                          title={row[col] ?? ""}
                          tabIndex={canEdit ? -1 : undefined}
                          onClick={
                            canEdit
                              ? (event) => {
                                  const already = isSelectedCell;
                                  setSel({ row: rowIdx, col });
                                  event.currentTarget.focus({ preventScroll: true });
                                  // 移动端没有双击语义（双击会触发缩放）：第一次点选
                                  // 中、再点同一格进入编辑
                                  if (already && isMobile()) beginEdit(rowIdx, col);
                                }
                              : undefined
                          }
                          onDoubleClick={
                            canEdit
                              ? (event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  beginEdit(rowIdx, col);
                                }
                              : undefined
                          }
                          onKeyDown={
                            canEdit
                              ? (event) => {
                                  // 编辑框的按键自己处理（且已 stopPropagation）；
                                  // 这里再防一层，避免任何输入控件的事件漏上来
                                  if ((event.target as HTMLElement).tagName === "INPUT") return;
                                  // 0.39.19：选中格上 Enter 下移 / Tab 右移（Excel 口径）；
                                  // 0.39.20 用户反馈「回车以及tab后要能够直接编辑，而不是
                                  // 得双击后编辑」——落点直接进编辑态（Enter 在原格开编辑，
                                  // Tab 移到右侧格开编辑；Shift 反向），F2（或双击）不变
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    if (event.shiftKey) {
                                      moveSelection(rowIdx, col, -1, 0, { thenEdit: true });
                                    } else {
                                      beginEdit(rowIdx, col);
                                    }
                                  } else if (event.key === "Tab") {
                                    event.preventDefault();
                                    moveSelection(rowIdx, col, 0, event.shiftKey ? -1 : 1, {
                                      thenEdit: true,
                                    });
                                  } else if (event.key === "F2") {
                                    event.preventDefault();
                                    beginEdit(rowIdx, col);
                                  } else if (event.key === "Escape") {
                                    setSel(null);
                                  }
                                }
                              : undefined
                          }
                          onContextMenu={(event) => {
                            // 0.39.16 用户反馈「右键数据框时，弹出弹窗，可以选择
                            // 复制当前数据框内容」——拦掉浏览器原生菜单，弹自绘
                            // 复制菜单（单元格 / 整行 TSV）。0.39.19 加编辑入口。
                            event.preventDefault();
                            event.stopPropagation();
                            setCopyMenu(null);
                            setCellMenu({
                              x: event.clientX,
                              y: event.clientY,
                              text: row[col] ?? "",
                              rowText: row.join("\t"),
                              row: rowIdx,
                              col,
                            });
                          }}
                        >
                          {isEditingCell ? renderEditor() : (row[col] ?? "")}
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
          {/* 0.39.17 用户反馈「滚轮不要占用空间，悬浮在空隙上」：xlsx 主滚动
              容器的悬浮滚动条（原生条隐藏，见 styles.css） */}
          <PreviewScrollbar targetRef={bodyWrapRef} visible={!isMobile()} />
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
            scope={countScope}
            onScopeChange={changeCountScope}
          />
        </div>
      )}
      {copyMenu && (
        <>
          <div
            className="menu-backdrop"
            onClick={() => setCopyMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setCopyMenu(null);
            }}
          />
          <div
            className="context-menu"
            style={{
              // 右键点开：贴光标，简单夹进视口（菜单两行高，宽约 200px）
              left: Math.max(8, Math.min(copyMenu.x, window.innerWidth - 216)),
              top: Math.max(8, Math.min(copyMenu.y, window.innerHeight - 96)),
            }}
          >
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(filterConditionText(copyMenu.col)).then(() => {
                  window.dispatchEvent(
                    new CustomEvent("qn-notice", { detail: { message: "已复制当前筛选条件" } }),
                  );
                });
                setCopyMenu(null);
              }}
            >
              复制当前筛选条件
            </button>
            <button
              type="button"
              onClick={() => {
                const text = activeCols.map(filterConditionText).join("\n");
                void navigator.clipboard.writeText(text).then(() => {
                  window.dispatchEvent(
                    new CustomEvent("qn-notice", {
                      detail: { message: `已复制全部筛选条件（${activeCols.length} 列）` },
                    }),
                  );
                });
                setCopyMenu(null);
              }}
            >
              复制所有筛选条件{activeCols.length > 1 ? `（${activeCols.length} 列）` : ""}
            </button>
          </div>
        </>
      )}
      {cellMenu && (
        <>
          <div
            className="menu-backdrop"
            onClick={() => setCellMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setCellMenu(null);
            }}
          />
          <div
            className="context-menu"
            style={{
              left: Math.max(8, Math.min(cellMenu.x, window.innerWidth - 236)),
              top: Math.max(8, Math.min(cellMenu.y, window.innerHeight - 160)),
            }}
          >
            {canEdit && (
              <button
                type="button"
                onClick={() => {
                  const target = { row: cellMenu.row, col: cellMenu.col };
                  setCellMenu(null);
                  beginEdit(target.row, target.col);
                }}
              >
                编辑单元格
              </button>
            )}
            <button
              type="button"
              title={cellMenu.text ? cellMenu.text.slice(0, 120) : "（空单元格）"}
              onClick={() => {
                void navigator.clipboard.writeText(cellMenu.text).then(() => {
                  window.dispatchEvent(
                    new CustomEvent("qn-notice", {
                      detail: {
                        message: cellMenu.text ? "已复制当前单元格内容" : "当前单元格为空，已复制空内容",
                      },
                    }),
                  );
                });
                setCellMenu(null);
              }}
            >
              复制当前单元格
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(cellMenu.rowText).then(() => {
                  window.dispatchEvent(
                    new CustomEvent("qn-notice", {
                      detail: { message: "已复制整行（制表符分隔，可直接粘进 Excel）" },
                    }),
                  );
                });
                setCellMenu(null);
              }}
            >
              复制整行（制表符）
            </button>
          </div>
        </>
      )}
    </div>
  );
}
