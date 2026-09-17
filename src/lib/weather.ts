/**
 * 天气：新建日记时把当天天气写进正文（Open-Meteo，无需 API key）。
 *
 * 自 quick-daily-note 插件移植，输出格式一致：`☀️ 晴 25°C（18~27°C）`。
 * 请求走 Rust 的 HTTP 通道（`httpRequest`）——与同步同一个理由：WebView 的源
 * 发不出跨域请求，而且这条通道已经存在，不值得再开一条。
 *
 * 拆分：WMO 代码表、URL 拼装、响应解析、文案格式化都是纯函数，Node 里可断言；
 * fetch 的 IO 部分在 `fetchWeather` 里，动态 import 以免 Node 测试环境碰到 Tauri API。
 */

/** Open-Meteo 地理编码响应（只取用到的字段）。 */
export interface GeocodingResponse {
  results?: { latitude: number; longitude: number }[];
}

export interface ForecastResponse {
  current?: { temperature_2m?: number; weather_code?: number };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
  };
}

/** WMO 天气代码 → 描述与图标（自插件原样移植）。 */
export const WMO_WEATHER: Record<number, { desc: string; icon: string }> = {
  0: { desc: "晴", icon: "☀️" },
  1: { desc: "基本晴朗", icon: "🌤️" },
  2: { desc: "多云", icon: "⛅" },
  3: { desc: "阴", icon: "☁️" },
  45: { desc: "雾", icon: "🌫️" },
  48: { desc: "雾凇", icon: "🌫️" },
  51: { desc: "毛毛雨", icon: "🌦️" },
  53: { desc: "毛毛雨", icon: "🌦️" },
  55: { desc: "毛毛雨", icon: "🌦️" },
  56: { desc: "冻毛毛雨", icon: "🌧️" },
  57: { desc: "冻毛毛雨", icon: "🌧️" },
  61: { desc: "小雨", icon: "🌧️" },
  63: { desc: "中雨", icon: "🌧️" },
  65: { desc: "大雨", icon: "🌧️" },
  66: { desc: "冻雨", icon: "🌧️" },
  67: { desc: "冻雨", icon: "🌧️" },
  71: { desc: "小雪", icon: "❄️" },
  73: { desc: "中雪", icon: "❄️" },
  75: { desc: "大雪", icon: "❄️" },
  77: { desc: "雪粒", icon: "❄️" },
  80: { desc: "阵雨", icon: "🌦️" },
  81: { desc: "阵雨", icon: "🌦️" },
  82: { desc: "强阵雨", icon: "🌧️" },
  85: { desc: "阵雪", icon: "🌨️" },
  86: { desc: "强阵雪", icon: "🌨️" },
  95: { desc: "雷暴", icon: "⛈️" },
  96: { desc: "雷暴伴冰雹", icon: "⛈️" },
  99: { desc: "雷暴伴冰雹", icon: "⛈️" },
};

export function geocodingUrl(city: string): string {
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`;
}

export function forecastUrl(latitude: number, longitude: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code` +
    `&timezone=auto&forecast_days=1`
  );
}

/** 由两段响应拼出最终文案；任一步缺数据返回 null（失败静默是刻意的，见 fetchWeather）。 */
export function formatWeather(geo: GeocodingResponse, forecast: ForecastResponse): string | null {
  const hit = geo.results?.[0];
  if (!hit) return null;
  const code = forecast.current?.weather_code;
  const w = WMO_WEATHER[code ?? -1] ?? { desc: "未知", icon: "" };
  const temp = Math.round(forecast.current?.temperature_2m ?? 0);
  const tmax = Math.round(forecast.daily?.temperature_2m_max?.[0] ?? temp);
  const tmin = Math.round(forecast.daily?.temperature_2m_min?.[0] ?? temp);
  return `${w.icon} ${w.desc} ${temp}°C（${tmin}~${tmax}°C）`;
}

/**
 * 把天气行插进日记正文：`> ☀️ 晴 25°C（18~27°C）`。
 *
 * 模板可能带 frontmatter，插到它**之后**（无 frontmatter 则第一行后）——
 * 与插件的 appendWeatherToNote 同一条规则，这里做成纯函数以便在落盘前并入内容。
 */
export function insertWeatherLine(content: string, weather: string): string {
  const lines = content.split("\n");
  let insertAt = 1;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === "---") {
        insertAt = i + 1;
        break;
      }
    }
  }
  lines.splice(insertAt, 0, `> ${weather}`);
  return lines.join("\n");
}

/**
 * 抓取某城市当天天气。任何一步失败（无网络、城市不存在、接口改版）都返回 null，
 * **不抛错**——天气是锦上添花，绝不能阻塞或打断新建日记。
 */
export async function fetchWeather(city: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const { httpRequest } = await import("./api.ts");
    const geo = await httpRequest({ method: "GET", url: geocodingUrl(city), timeoutMs });
    const geoData = JSON.parse(new TextDecoder().decode(base64ToBytes(geo.bodyBase64))) as GeocodingResponse;
    const forecast = await httpRequest({
      method: "GET",
      url: forecastUrl(geoData.results?.[0]?.latitude ?? 0, geoData.results?.[0]?.longitude ?? 0),
      timeoutMs,
    });
    const forecastData = JSON.parse(
      new TextDecoder().decode(base64ToBytes(forecast.bodyBase64)),
    ) as ForecastResponse;
    return formatWeather(geoData, forecastData);
  } catch {
    return null;
  }
}

/** base64 → 字节（与 paste.ts 的 toBase64 互为逆操作；API 响应体是 base64 携带的）。 */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
