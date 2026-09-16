/**
 * 待办的数据模型与纯逻辑。
 *
 * ## 待办不写进日记的 Markdown
 *
 * 存在库根目录的 `quick-daily-note.json` 里（与 Obsidian 插件共用同一份），
 * 而不是日记正文的复选框。理由不只是"与插件一致"：勾选一条待办若意味着改写用户
 * 正在编辑的笔记，就会往同步协议里塞进无谓的内容差异——而待办的**结构化状态**
 * （id、修改时间、墓碑）本来也没法用一行 Markdown 表达。
 *
 * 将来要做"笔记里的 `- [ ]` 复选框"，那是另一件事（顺带一提，M1 已经支持在笔记里
 * 直接点复选框写回源码，那条路径与本模块无关）。
 *
 * 这里只放不依赖 IO 的部分：模型、墓碑、顺延、旧数据迁移，以及**与云端的快照协议**
 * （生成、解析、条目级合并）。同步的 HTTP 与游标在 `syncEngine.ts` 里。
 */

import moment from "moment";

/** 快照格式版本。版本不匹配的快照**不参与合并**（只推不拉，等新版把它覆盖上去）。 */
export const SNAPSHOT_VERSION = 2;

/**
 * 云端待办数据的记录路径（由 `app.getVirtualFiles()` 提供给同步引擎）。
 *
 * 它**不是库内文件**：待办内容只在内存里参与同步，不往用户库里写任何东西，
 * 这个路径只作为云端记录与网页端读取的标识。库内若真有同名文件也不会被当普通
 * 文件同步——推送范围只放行 `.md`。
 *
 * 为什么不同步库内的 `quick-daily-note.json`：那份文件除了待办还混着
 * `emailAccessKey` 等配置，整份上传等于把凭据送到服务端、再经接口回到浏览器。
 */
export const TODO_SYNC_PATH = "daily-sync-todos.json";

/**
 * 墓碑保留时长。
 *
 * 删除必须留墓碑而不是物理移除：另一台设备没看到这次删除，会把这条当成
 * "云端新增"又加回来。超过这个时长则认为各设备早已同步过，可以从快照里清掉。
 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TodoItem {
  /** 稳定标识。同步按它对齐两侧的同一条。 */
  id: string;
  text: string;
  done: boolean;
  /** 本条最后修改时间（epoch ms）。合并取更新的那一侧。 */
  updatedAt: number;
  /** 墓碑标记：`true` 表示已删除，但不从数据里移除。 */
  deleted?: boolean;
}

/** 按日期分桶的待办。键是 `dateFormat` 格式化出来的日期串。 */
export type TodoMap = Record<string, TodoItem[]>;

export function newTodoId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 过滤墓碑后的条目。渲染、统计、顺延都用它，**不要直接读原数组**。
 *
 * 签名接受 `undefined` 是因为取值处常常是 `todos[date]`——直接返回空数组，
 * 少一层 `?? []`。
 */
export function liveItems(items: TodoItem[] | undefined): TodoItem[] {
  return (items ?? []).filter((item) => !item.deleted);
}

/** 未完成的条目数。 */
export function pendingCount(items: TodoItem[] | undefined): number {
  return liveItems(items).filter((item) => !item.done).length;
}

/**
 * 遗留前缀，如 `[09-07 遗留]`。
 *
 * 用 `MM-DD` 而不是完整日期：前缀是给人看的提示，写满日期会把待办文字挤没。
 * 源日期解析不出来时退回原文（宁可显示得丑，也不要显示成 `Invalid date`）。
 */
export function carryPrefix(fromDate: string, format: string): string {
  const day = moment(fromDate, format, true);
  return `[${day.isValid() ? day.format("MM-DD") : fromDate} 遗留]`;
}

/**
 * 剥掉旧的遗留前缀（可能叠加了多个），顺延时统一换成新前缀。
 *
 * 没有这一步，`A → B → C` 连着顺延两天会得到 `[09-07 遗留] [09-08 遗留] 原文`，
 * 每顺延一次前缀就长一截，最后挤掉正文。
 */
export function stripCarryPrefix(text: string): string {
  return text.replace(/^(?:\[[^\]]*遗留\]\s*)+/, "");
}

/** 该日期是否已经有顺延过来的待办（用于避免重复顺延）。 */
export function hasCarriedOver(items: TodoItem[] | undefined): boolean {
  return liveItems(items).some((item) => /^\[[^\]]*遗留\]/.test(item.text));
}

/**
 * 待办列表的显示顺序：**未完成排在已完成上面**（组内保持原顺序）。
 *
 * `index` 是条目在**原始数组**里的下标，点击勾选要用它回写；因此这里必须从原始
 * 数组出发再过滤，不能先过滤墓碑再取下标——那样只要删过一条待办，下标就会整体
 * 错位，勾选会改到别人头上。
 */
export function orderedTodos(
  items: TodoItem[] | undefined,
): { item: TodoItem; index: number }[] {
  return (items ?? [])
    .map((item, index) => ({ item, index }))
    .filter((row) => !row.item.deleted)
    .sort((a, b) => Number(a.item.done) - Number(b.item.done));
}

export interface CarryOverResult {
  /** 源日期的新数组：被顺延的未完成项已打上墓碑。 */
  from: TodoItem[];
  /** 目标日期的新数组：追加了顺延过来的新条目。 */
  to: TodoItem[];
  /** 实际顺延了几项。 */
  moved: number;
}

/**
 * 把源日期**未完成**的待办顺延到目标日期。
 *
 * 两条规则是刻意的（与插件一致）：
 *
 * 1. **源日期打墓碑、目标日期建新 id 的新条目**，不是把同一个 id 挪个地方。
 *    同一个 id 出现在两个日期里，合并时无法判断它属于哪一天；而打墓碑顺带
 *    解决了"重复顺延会得到两份"的问题——第二次顺延时它已经不是 live 的了。
 * 2. 目标条目一律 `done: false`：顺延过来的是"还没做完"这件事，沿用一个
 *    已完成状态没有意义（已完成项本来就不会被顺延）。
 *
 * 返回新对象而不是就地修改：调用方据此判断"有没有变化、要不要落盘"，
 * 也让这个函数能在 Node 里直接断言。
 */
export function carryOver(
  fromItems: TodoItem[] | undefined,
  toItems: TodoItem[] | undefined,
  fromDate: string,
  format: string,
  now: number,
): CarryOverResult {
  const source = (fromItems ?? []).map((item) => ({ ...item }));
  const target = (toItems ?? []).map((item) => ({ ...item }));
  const pending = source.filter((item) => !item.deleted && !item.done);

  if (pending.length === 0) return { from: source, to: target, moved: 0 };

  const prefix = carryPrefix(fromDate, format);
  for (const item of pending) {
    target.push({
      id: newTodoId(),
      text: `${prefix} ${stripCarryPrefix(item.text)}`,
      done: false,
      updatedAt: now,
    });
  }

  const movedIds = new Set(pending.map((item) => item.id));
  const from = source.map((item) =>
    movedIds.has(item.id) ? { ...item, deleted: true, updatedAt: now } : item,
  );
  return { from, to: target, moved: pending.length };
}

export interface NormalizedTodos {
  todos: TodoMap;
  /** 被补齐 id/updatedAt 或被丢弃的条目数（用于提示"已升级旧数据"）。 */
  repaired: number;
}

/**
 * 校验并补齐待办数据。
 *
 * 库内配置是**外部来源**：它由 Obsidian 插件写、可能经同步进程落到本地、也可能被
 * 手改。所以这里既不假设形状正确，也不能因为一条坏数据就让整个日历面板打不开——
 * 坏条目丢弃、缺字段补齐，并把修补数量返回给界面提示。
 *
 * `updatedAt` 的兜底值用**该侧最后一次修改时间**而不是 `now`：万一这台设备的数据
 * 其实更旧，不该因为"升级那一瞬间拿到了当前时间"而在合并时压掉别的设备。
 * 这一点照抄插件的 `migrateTodos`——它是踩过之后的结论。
 */
export function normalizeTodos(raw: unknown, fallbackAt: number): NormalizedTodos {
  const todos: TodoMap = {};
  let repaired = 0;

  if (raw === null || raw === undefined) return { todos, repaired };
  if (typeof raw !== "object" || Array.isArray(raw)) return { todos, repaired: 1 };

  for (const [date, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) {
      repaired += 1;
      continue;
    }
    const items: TodoItem[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        repaired += 1;
        continue;
      }
      const candidate = entry as Partial<TodoItem>;
      if (typeof candidate.text !== "string") {
        repaired += 1;
        continue;
      }
      const id =
        typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : newTodoId();
      const updatedAt =
        typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
          ? candidate.updatedAt
          : fallbackAt;
      if (id !== candidate.id || updatedAt !== candidate.updatedAt) repaired += 1;

      const item: TodoItem = {
        id,
        text: candidate.text,
        done: candidate.done === true,
        updatedAt,
      };
      if (candidate.deleted === true) item.deleted = true;
      items.push(item);
    }
    todos[date] = items;
  }

  return { todos, repaired };
}

// ---------------------------------------------------------------- 云端快照协议

/** 云端待办快照的格式（与插件、网页端共用）。 */
export interface TodoSnapshot {
  version: number;
  /** 整份快照的生成时间（ISO），用于两个方向判断谁更早。 */
  updatedAt: string;
  todos: TodoMap;
}

/**
 * 生成云端快照字符串。
 *
 * 三条规则都是为了"内容稳定"——快照的哈希就是推送与否的依据，
 * 每次生成都抖动会让本机每轮都推、并压掉别的设备：
 *
 * - 丢弃过期墓碑（保留期见 {@link TOMBSTONE_TTL_MS}），避免快照无限膨胀；
 * - 同一日期内按 `updatedAt` 升序（新建的排后面），两侧顺序一致、渲染稳定；
 * - 只含墓碑的日期整条丢掉。
 *
 * `updatedAt` 由调用方传"待办最后修改时间"，**不要传当前时间**。
 */
export function buildSnapshot(
  todos: TodoMap,
  updatedAt: number,
  now: number = Date.now(),
): string {
  const cleaned: TodoMap = {};
  for (const [date, items] of Object.entries(todos)) {
    const kept = items
      .filter((item) => !item.deleted || now - item.updatedAt <= TOMBSTONE_TTL_MS)
      .slice()
      .sort((a, b) => a.updatedAt - b.updatedAt);
    if (kept.length > 0) cleaned[date] = kept;
  }
  const snapshot: TodoSnapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date(updatedAt).toISOString(),
    todos: cleaned,
  };
  return JSON.stringify(snapshot, null, 2);
}

/** 解析云端快照；格式不符或版本不是当前版本时返回 null（调用方据此跳过合并）。 */
export function parseSnapshot(content: string): TodoSnapshot | null {
  try {
    const parsed = JSON.parse(content) as TodoSnapshot;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    if (!parsed.todos || typeof parsed.todos !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface MergeResult {
  todos: TodoMap;
  /** 合并结果是否与本地不同（不同才需要回推云端）。 */
  changed: boolean;
}

/**
 * 条目级双向合并。
 *
 * 规则（按 `id` 对齐）：
 * - 两侧都有 → 取 `updatedAt` 更大的一侧（**含它的日期归属与删除标记**）；
 * - 只有一侧有 → 直接保留（新增）；
 * - 结果里过滤掉墓碑，只含墓碑的日期整个丢掉。
 *
 * "同一条被两边同时改"时后改的赢——文本不做逐字合并，但不会变成两条重复项。
 * 这正是待办条目一定要有 `id` 与 `updatedAt` 的原因：没有 id 就只能整表覆盖，
 * 一边加一条、另一边勾一条就会互相冲掉。
 */
export function mergeTodos(local: TodoMap, remote: TodoMap): MergeResult {
  const localIndex = indexById(local);
  const remoteIndex = indexById(remote);
  const ids = new Set<string>([...localIndex.keys(), ...remoteIndex.keys()]);

  const merged: TodoMap = {};
  let changed = false;

  for (const id of ids) {
    const l = localIndex.get(id);
    const r = remoteIndex.get(id);
    let picked: { item: TodoItem; date: string };
    if (l && r) {
      picked = r.item.updatedAt > l.item.updatedAt ? r : l;
    } else {
      picked = (l ?? r) as { item: TodoItem; date: string };
    }

    // 与本地不一致就算有变化（本侧没有、或选中的不是本侧那份、或日期被改到别处）
    if (!l || l.item !== picked.item || l.date !== picked.date) changed = true;

    if (picked.item.deleted) {
      // 墓碑不进结果（保留在各自本地，供下次比较）
      continue;
    }
    (merged[picked.date] ??= []).push(picked.item);
  }

  // 统一排序：同一日期内按 updatedAt 升序，两侧得到一致顺序
  for (const items of Object.values(merged)) {
    items.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  return { todos: merged, changed };
}

/** 展平成 id -> { item, date }，重复 id 时保留 `updatedAt` 更新的那条。 */
function indexById(todos: TodoMap): Map<string, { item: TodoItem; date: string }> {
  const map = new Map<string, { item: TodoItem; date: string }>();
  for (const [date, items] of Object.entries(todos)) {
    for (const item of items ?? []) {
      if (!item || typeof item.id !== "string") continue;
      const existing = map.get(item.id);
      if (!existing || item.updatedAt > existing.item.updatedAt) {
        map.set(item.id, { item, date });
      }
    }
  }
  return map;
}
