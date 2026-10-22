/**
 * 每篇笔记的阅读位置（0.31 用户反馈：重新打开要自动定位到上次读到的地方）。
 *
 * 存本机 localStorage（「仓库 → 路径 → scrollTop」两级，同收藏的分桶方式），
 * 不进仓库、不随同步走——阅读进度是纯本机偏好。条目有上限：超过 MAX_ENTRIES
 * 按「最近写入优先」淘汰最旧的，长年使用也不会把 localStorage 撑爆。
 *
 * 纯逻辑模块：localStorage 经参数注入（`Storage` 接口），Node 测试可直接断言。
 */

const KEY = "quicknote.readprogress.v1";
const MAX_ENTRIES = 400;
/** 顶部 4px 以内视为「从头在读」，不记条目，免得整库都是零值。 */
const MIN_TOP = 4;

type ProgressDb = Record<string, Record<string, number>>;

function readDb(storage: Storage): ProgressDb {
  try {
    const raw = storage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ProgressDb) : {};
  } catch {
    return {};
  }
}

function writeDb(storage: Storage, db: ProgressDb): void {
  try {
    storage.setItem(KEY, JSON.stringify(db));
  } catch {
    // 写不进去只影响下次恢复，不打断阅读
  }
}

/** 读某篇笔记的上次阅读位置（scrollTop，px）。没记录返回 null。 */
export function loadProgress(storage: Storage, vault: string, path: string): number | null {
  const top = readDb(storage)[vault]?.[path];
  return typeof top === "number" && Number.isFinite(top) && top > MIN_TOP ? top : null;
}

/**
 * 记录一篇笔记的阅读位置。顶部附近视为无进度（删条目而不是记 0）。
 * 超过上限时按最旧先出淘汰（键序即写入序：重写一条会先删再插，等于 LRU 触碰）。
 */
export function saveProgress(storage: Storage, vault: string, path: string, top: number): void {
  if (!Number.isFinite(top) || top <= MIN_TOP) {
    deleteProgress(storage, vault, path);
    return;
  }
  const db = readDb(storage);
  const bucket = db[vault] ?? {};
  delete bucket[path];
  bucket[path] = Math.round(top);
  db[vault] = bucket;

  let count = 0;
  for (const vaultKey of Object.keys(db)) count += Object.keys(db[vaultKey]).length;
  if (count > MAX_ENTRIES) {
    outer: for (const vaultKey of Object.keys(db)) {
      for (const notePath of Object.keys(db[vaultKey])) {
        if (count <= MAX_ENTRIES) break outer;
        delete db[vaultKey][notePath];
        count -= 1;
      }
      if (Object.keys(db[vaultKey]).length === 0) delete db[vaultKey];
    }
  }
  writeDb(storage, db);
}

/** 删一条进度（文件被删除时调用；关标签**不**调——重开还要恢复）。 */
export function deleteProgress(storage: Storage, vault: string, path: string): void {
  const db = readDb(storage);
  const bucket = db[vault];
  if (!bucket || !(path in bucket)) return;
  delete bucket[path];
  if (Object.keys(bucket).length === 0) delete db[vault];
  writeDb(storage, db);
}

/** 仓库没了（删除仓库场景）清整个桶。 */
export function clearVaultProgress(storage: Storage, vault: string): void {
  const db = readDb(storage);
  if (!(vault in db)) return;
  delete db[vault];
  writeDb(storage, db);
}
