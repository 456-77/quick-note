/**
 * JSON 格式化与文本转换（0.34.6「格式化选中的 JSON」+ 0.34.13 用户反馈
 * 「添加快捷键唤起一个文本格式转换面板，可以自动将 json 数据进行格式化；
 * 若原 json 数据被转换成了字符串，能够转换回来」）。
 *
 * 纯函数、不碰 DOM，Node 里直接断言（verify-format-json.mjs）：
 * - formatJsonText：就地展开（命令面板那条旧命令），parse 失败把原错误信息带回；
 * - beautify/minify：字符串化的 JSON（可多层）**自动解包**到最深一层再展开；
 * - toJsonString / fromJsonString：任意文本 ↔ JSON 字符串字面量双向转换。
 *
 * 不强行修复（尾逗号/单引号等非标准 JSON 交还给用户手改）。
 */

export function formatJsonText(raw: string): { ok: true; text: string } | { ok: false; error: string } {
  try {
    const value = parseJsonLoose(raw).value;
    return { ok: true, text: JSON.stringify(value, null, 2) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 把「被整体转义过一层」的文本解回原样（0.39.31 用户反馈「这个 json 数据为什么
 * 无法格式化」——从日志/抓包/聊天窗口复制来的 JSON 常带一层 `\"`：文本本身是
 * JSON 字符串的**内容**，却少了外层引号，直接 parse 必然在位置 1 报错）。
 *
 * 单遍顺序扫描（不是 replace 链，`\\\"` 才能正确降一层）：认识的转义解掉，
 * 不认识的（`\d` 之类）原样保留。没有可解的转义时返回 null——避免把普通
 * 非法 JSON 也来回「修」一遍。
 */
function unescapeJsonPayload(text: string): string | null {
  if (!text.includes("\\")) return null;
  let out = "";
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "\\" || i + 1 >= text.length) {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    switch (next) {
      case '"': out += '"'; i += 1; changed = true; break;
      case "\\": out += "\\"; i += 1; changed = true; break;
      case "/": out += "/"; i += 1; changed = true; break;
      case "b": out += "\b"; i += 1; changed = true; break;
      case "f": out += "\f"; i += 1; changed = true; break;
      case "n": out += "\n"; i += 1; changed = true; break;
      case "r": out += "\r"; i += 1; changed = true; break;
      case "t": out += "\t"; i += 1; changed = true; break;
      case "u": {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          changed = true;
        } else {
          out += ch;
        }
        break;
      }
      default:
        out += ch;
    }
  }
  return changed ? out : null;
}

/**
 * 宽容解析：先按原样 parse；失败且文本里有转义序列时，逐层解转义再试
 * （最多 3 层，覆盖「JSON → 字符串 → 字符串」的层级）。仍失败抛**第一次**
 * 的原生错误——位置信息对应用户贴进来的原文，不会因为解转义而漂移。
 */
export function parseJsonLoose(text: string, maxRepairLayers = 3): { value: unknown; repaired: boolean } {
  let firstError: unknown;
  let current = text;
  for (let layer = 0; layer <= maxRepairLayers; layer += 1) {
    try {
      return { value: JSON.parse(current) as unknown, repaired: layer > 0 };
    } catch (e) {
      if (layer === 0) firstError = e;
    }
    const next = unescapeJsonPayload(current);
    if (next === null || next === current) break;
    current = next;
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError));
}

/** 解析失败的中文错误（带位置提示；JSON.parse 原生消息在 Chromium 里较友好，直接拼接）。 */
function parseJson(text: string): unknown {
  try {
    return parseJsonLoose(text).value;
  } catch (e) {
    throw new Error(`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 解包所有字符串化层：输入解析后是 string 就继续解析，直到不是字符串或
 * 上一层解析失败。返回最深一层与解开的层数（0 = 输入本来就不是字符串化 JSON）。
 */
export function unwrapJsonString(text: string, maxLayers = 8): { value: string; layers: number } {
  let current = text;
  let layers = 0;
  for (;;) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return { value: current, layers };
    }
    if (typeof parsed !== "string" || layers >= maxLayers) return { value: current, layers };
    current = parsed;
    layers += 1;
  }
}

/** 格式化（2 空格缩进）。输入是字符串化的 JSON（可多层）时自动解包到最深一层。 */
export function beautifyJson(text: string): string {
  const { value } = unwrapJsonString(text);
  return `${JSON.stringify(parseJson(value), null, 2)}\n`;
}

/** 压缩成单行。字符串化输入同样先解包。 */
export function minifyJson(text: string): string {
  const { value } = unwrapJsonString(text);
  return JSON.stringify(parseJson(value));
}

/** 把任意文本转成一个 JSON 字符串字面量（转义引号/换行；中文不转义）。 */
export function toJsonString(text: string): string {
  return JSON.stringify(text);
}

/**
 * 把 JSON 字符串字面量还原成文本。输入必须是 `"..."` 形式（解析结果是
 * string 才算）；多层字符串化一次全解开。不是字符串字面量时抛中文错误。
 */
export function fromJsonString(text: string): string {
  const { value, layers } = unwrapJsonString(text);
  if (layers === 0) {
    // 要么不是 JSON、要么是别的 JSON 值（对象/数字）——都不是「字符串还原」
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("不是 JSON 字符串字面量（应以引号包裹，如 \"…\"）");
    }
    if (typeof parsed !== "string") {
      throw new Error("内容不是字符串（是对象/数组/数字等），直接用「格式化」即可");
    }
  }
  return value;
}

// ---------------------------------------------------------------- Base64
//
// 0.39.33 用户需求「添加接 base64 码功能，能够自动识别给的内容中的源码，并解码」：
// 抓包/日志里贴来的 URL 常把业务标识（有时是整段源码）base64 塞在路径里，
// 例如 …/invoke/SFpFUk86SEZTSURTOm…TGlzdA==?docNumber=…。这里做**自动识别**：
// 整段是 base64 就整段解；否则扫描文本里所有 base64 形态的片段（URL 路径段
// 里的 / 会切分尝试），逐个解成 UTF-8 文本。
//
// 判定既要宽松（URL-safe -_、缺省 padding、日志换行）又要防误报（普通单词
// 恰好由 base64 字母表组成）：解码必须通过 UTF-8 严格解码 + 可打印比例检查，
// 且短于 12 字符的裸片段不参与（有 `=` padding 的 8 字符起）。

/** 一段识别成功的 base64。 */
export interface Base64Hit {
  /** 原文中的片段（原样，可能带 URL-safe 字符/缺省 padding）。 */
  raw: string;
  start: number;
  end: number;
  /** 解码后的 UTF-8 文本。 */
  decoded: string;
}

const BASE64_CHARS = /^[A-Za-z0-9+/_=-]+$/;
/** 候选片段：至少 8 个 base64 字符（含 padding）。URL 里的 / 由后续切段处理。 */
const BASE64_TOKEN_RE = /[A-Za-z0-9+/_=-]{8,}/g;

/** 解码结果是不是「像文本」：UTF-8 严格解码已由调用方保证，这里防控制符/乱码。 */
function looksLikeText(text: string): boolean {
  if (!text.trim()) return false;
  let bad = 0;
  let total = 0;
  for (const ch of text) {
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    const ok =
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && code !== 0x7f) ||
      code >= 0xa0;
    if (!ok) bad += 1;
  }
  // 含至少一个字母/数字/汉字/符号（emoji 也是正常文本）：纯标点/空白串
  // 没有展示价值，也更容易是误报
  return bad / total <= 0.1 && /[\p{L}\p{N}\p{So}]/u.test(text);
}

/** 尝试把一个片段按 base64（标准或 URL-safe）解成文本；不合法返回 null。 */
function tryDecodeBase64(token: string, wholeInput = false): string | null {
  if (!BASE64_CHARS.test(token)) return null;
  // `=` 只允许出现在结尾（两个以内）
  if (/=.*[^=]/.test(token) || /=.*=.*=/.test(token)) return null;
  const body = token.replace(/=+$/, "");
  if (body.length < (wholeInput ? 2 : 8)) return null;
  // 裸片段太短容易把普通单词误判；整段输入不受此限（用户明确只贴了一段），
  // 有 padding 的 8 字符起算安全
  if (!wholeInput && body.length < 12 && !token.endsWith("=")) return null;
  if (token.length % 4 === 1) return null;
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let bytes: Uint8Array;
  try {
    const binary = atob(padded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return looksLikeText(text) ? text : null;
}

/**
 * 自动识别文本中的 base64 并解码。
 *
 * 顺序：先试整段（去掉所有空白后整段都是 base64 字符，覆盖多行粘贴的
 * base64）；不行再按「非 base64 字符」切 token 扫描。URL 路径里的 / 属于
 * base64 字母表，整 token 会混进 host/path，所以整 token 解不开时再按 /
 * 切段逐个试（`…/invoke/<base64>?x=y` 命中 `/` 后的那段）。
 * 相邻/重叠的命中只保留最外层。
 */
export function findBase64InText(text: string): Base64Hit[] {
  const hits: Base64Hit[] = [];
  const whole = text.trim();
  const compact = whole.replace(/\s+/g, "");
  if (compact.length >= 8 && BASE64_CHARS.test(compact)) {
    const decoded = tryDecodeBase64(compact, true);
    if (decoded !== null) {
      hits.push({ raw: whole, start: text.indexOf(whole), end: text.indexOf(whole) + whole.length, decoded });
      return hits;
    }
  }
  BASE64_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_TOKEN_RE.exec(text))) {
    const token = match[0];
    const attempts: string[] = [token];
    // URL 场景：/ 是 base64 字符但更像路径分隔符，整段解不开就按 / 切
    if (token.includes("/")) {
      for (const piece of token.split("/")) if (piece && piece !== token) attempts.push(piece);
    }
    let raw = "";
    let decoded: string | null = null;
    for (const attempt of attempts) {
      decoded = tryDecodeBase64(attempt);
      if (decoded !== null) {
        raw = attempt;
        break;
      }
    }
    if (decoded === null || !raw) continue;
    const start = text.indexOf(raw, match.index);
    if (start < 0) continue;
    if (hits.some((hit) => start >= hit.start && start + raw.length <= hit.end)) continue;
    hits.push({ raw, start, end: start + raw.length, decoded });
  }
  return hits;
}

/** 自动识别并解码；识别不到抛中文错误（面板上直接展示）。 */
export function decodeBase64Auto(text: string): string {
  const hits = findBase64InText(text);
  if (hits.length === 0) {
    throw new Error("没有识别到可解码的 base64（支持整段 base64、URL/日志里夹带的 base64 片段）");
  }
  if (hits.length === 1) return hits[0].decoded;
  return hits.map((hit, index) => `— 第 ${index + 1} 段 —\n${hit.decoded}`).join("\n\n");
}

/**
 * 显式解码（0.39.35 转码弹窗用）：先按「整段 base64」解（不受自动识别的
 * 最短长度限制——用户已经明确点了「解码」，`YQ==` 这种短串也该解出来），
 * 不成再退回按片段自动识别。
 */
export function decodeBase64Text(text: string): string {
  const compact = text.trim().replace(/\s+/g, "");
  if (compact) {
    const whole = tryDecodeBase64(compact, true);
    if (whole !== null) return whole;
  }
  return decodeBase64Auto(text);
}

/**
 * 文本 → Base64（0.39.35 用户需求「创建一个快捷键触发弹窗，专门用来处理
 * 转码和解码」）。按 UTF-8 编码（中文/emoji 正确），标准字母表带 padding；
 * 解码侧自动兼容 URL-safe 与缺省 padding。
 */
export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // 分块拼接，避免超长文本一次性展开成超大参数列表（String.fromCharCode.apply）
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
