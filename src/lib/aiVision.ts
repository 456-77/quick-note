/**
 * AI 识图（0.39.23 用户反馈「逐步添加 ai 功能，现在先添加 ai 识别功能……对于预览
 * 图片添加一个 ai 识别选项，类似于普通识别，也是框选内容进行识别」）。
 *
 * 走 OpenAI 兼容的 `/chat/completions`（vision 消息体），供应商在 设置 → AI 里配
 * （Base URL / API Key / 模型名，参考 ZCode 的填法）。请求经 Rust `http_request`
 * （rustls + WebPki 根证书，见 0.37 有道查词的 TLS 教训），桌面与安卓同一条链路。
 */

import { httpRequest } from "./api.ts";
import { getSettings } from "./settings.ts";

export interface AiVisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 附加请求头（设置里每行 `Key: Value`；部分网关要求自定义头）。 */
  extraHeaders?: string;
}

/** 读取当前 AI 配置（全空时视为未配置）。 */
export function aiConfig(): AiVisionConfig {
  const s = getSettings();
  return {
    baseUrl: s.aiBaseUrl.trim(),
    apiKey: s.aiApiKey.trim(),
    model: s.aiModel.trim(),
    extraHeaders: s.aiExtraHeaders,
  };
}

/** 解析「每行 Key: Value」的附加请求头（空行/没有冒号的行忽略）。 */
export function parseExtraHeaders(raw: string | undefined): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const name = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (name === "" || value === "") continue;
    out.push({ name, value });
  }
  return out;
}

/** chat/completions 请求统一出口：URL 归一 + 附加请求头 + 状态码/错误体解析。 */
async function sendChat(cfg: AiVisionConfig, body: unknown): Promise<Record<string, unknown>> {
  const base = cfg.baseUrl.trim().replace(/\/+$/, "");
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const response = await httpRequest({
    method: "POST",
    url,
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Authorization", value: `Bearer ${cfg.apiKey.trim()}` },
      ...parseExtraHeaders(cfg.extraHeaders),
    ],
    bodyText: JSON.stringify(body),
    // AI 供应商证书链常带交叉签名根：桌面 native-tls 会拒，强制 rustls+WebPki
    tls: "webpki",
  });
  const text = response.bodyBase64 ? decodeBase64Utf8(response.bodyBase64) : "";
  if (response.status !== 200) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? detail;
    } catch {
      // 非 JSON 就原样展示
    }
    throw new Error(`HTTP ${response.status}：${detail}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("AI 返回的不是 JSON（检查 Base URL 是否指向 OpenAI 兼容接口）");
  }
}

/** 从 chat/completions 响应取正文（string 或分段数组都兼容）。 */
function contentOf(parsed: Record<string, unknown>): string {
  const message = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("")
      .trim();
  }
  return "";
}

/** 是否已配置（三个字段都齐）。 */
export function aiConfigured(): boolean {
  const cfg = aiConfig();
  return cfg.baseUrl !== "" && cfg.apiKey !== "" && cfg.model !== "";
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 默认提示词：识图场景要「如实转录 + 简要结构化」，不让模型自由发挥。 */
export const AI_VISION_PROMPT =
  "识别这张图片里的文字与关键信息：逐字转录可见文字（保留原有换行与层级），" +
  "看不清的内容不要臆测；如果是截图，补充一句它大致在展示什么。";

/**
 * 测试连接（0.39.24 用户需求「ai 添加测试连接功能」）：发一个最小的**纯文本**
 * 请求验证 Base URL / API Key / 模型三件套，成功返回模型的简短回复。
 * `cfg` 由调用方传设置页当前输入值（保证测的就是用户看到的那三个框）。
 */
export async function aiTestConnection(cfg: AiVisionConfig): Promise<string> {
  if (cfg.baseUrl.trim() === "" || cfg.apiKey.trim() === "" || cfg.model.trim() === "") {
    throw new Error("先填写 Base URL / API Key / 模型名");
  }
  const parsed = await sendChat(cfg, {
    model: cfg.model.trim(),
    max_tokens: 512,
    messages: [{ role: "user", content: "连通性测试，请回复：连接成功" }],
  });
  const reply = contentOf(parsed);
  return reply || "连接成功（模型未返回文本）";
}

/**
 * 对图片做 AI 识别，返回模型输出的文本。失败抛错（调用方展示错误文案）。
 * `mime` 用图片真实类型（裁剪后统一是 PNG）。
 *
 * 0.39.32 用户需求「对于 ai 识别文本功能，添加系统提示词设置」：设置里填了
 * 系统提示词就以 system 消息发送（可规定输出格式），用户消息只剩一句中性的
 * 任务描述；没填维持内置默认提示词。
 */
export async function aiRecognizeImage(base64: string, mime = "image/png"): Promise<string> {
  const cfg = aiConfig();
  if (!aiConfigured()) {
    throw new Error("先在 设置 → AI 配置模型供应商（Base URL / API Key / 模型名）");
  }
  const systemPrompt = getSettings().aiVisionSystemPrompt.trim();
  const userContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: systemPrompt === "" ? AI_VISION_PROMPT : "请按系统提示处理这张图片。",
    },
    { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
  ];
  const messages: Array<Record<string, unknown>> =
    systemPrompt === ""
      ? [{ role: "user", content: userContent }]
      : [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ];
  const parsed = await sendChat(cfg, {
    model: cfg.model,
    temperature: 0.1,
    messages,
  });
  const text = contentOf(parsed);
  if (text) return text;
  throw new Error("AI 没有返回识别内容（模型可能不支持图片输入）");
}

/** AI 对话的一条消息（0.39.28 用户需求「添加 ai 对话功能」）。 */
export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 多轮对话（0.39.28）：整段历史一起发（OpenAI chat/completions 天然无状态），
 * 返回模型回复文本。httpRequest 是整包缓冲，没有流式——回复一次性到位，
 * 请求期间面板显示「思考中…」。失败抛错（调用方展示）。
 */
export async function aiChat(messages: AiChatMessage[]): Promise<string> {
  if (messages.length === 0) throw new Error("还没有输入内容");
  const cfg = aiConfig();
  if (!aiConfigured()) {
    throw new Error("先在 设置 → AI 配置模型供应商（Base URL / API Key / 模型名）");
  }
  const parsed = await sendChat(cfg, { model: cfg.model, messages });
  const text = contentOf(parsed);
  if (text) return text;
  throw new Error("AI 没有返回内容（模型可能推理 token 全被消耗，试试换个模型或减少上下文）");
}
