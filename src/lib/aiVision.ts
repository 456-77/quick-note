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
}

/** 读取当前 AI 配置（全空时视为未配置）。 */
export function aiConfig(): AiVisionConfig {
  const s = getSettings();
  return {
    baseUrl: s.aiBaseUrl.trim(),
    apiKey: s.aiApiKey.trim(),
    model: s.aiModel.trim(),
  };
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
 * 对图片做 AI 识别，返回模型输出的文本。失败抛错（调用方展示错误文案）。
 * `mime` 用图片真实类型（裁剪后统一是 PNG）。
 */
export async function aiRecognizeImage(base64: string, mime = "image/png"): Promise<string> {
  const cfg = aiConfig();
  if (!aiConfigured()) {
    throw new Error("先在 设置 → AI 配置模型供应商（Base URL / API Key / 模型名）");
  }
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const url = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: AI_VISION_PROMPT },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
  };
  const response = await httpRequest({
    method: "POST",
    url,
    headers: [
      { name: "Content-Type", value: "application/json" },
      { name: "Authorization", value: `Bearer ${cfg.apiKey}` },
    ],
    bodyText: JSON.stringify(body),
  });
  const text = response.bodyBase64 ? decodeBase64Utf8(response.bodyBase64) : "";
  if (response.status !== 200) {
    // 供应商错误体一般是 {"error":{"message":"..."}}；截一小段便于排查
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? detail;
    } catch {
      // 非 JSON 就原样展示
    }
    throw new Error(`AI 请求失败（HTTP ${response.status}）：${detail}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("AI 返回的不是 JSON（检查 Base URL 是否指向 OpenAI 兼容接口）");
  }
  const message = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof message === "string") return message;
  // 少数供应商把 content 给成 [{type:"text",text:"…"}] 的分段数组
  if (Array.isArray(message)) {
    const joined = message
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  throw new Error("AI 没有返回识别内容（模型可能不支持图片输入）");
}
