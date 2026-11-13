// 天气占位行协议的纯函数断言（0.39.9 用户反馈「新建日记速度很慢，可以先创建
// 日记，占位第二行，等后面自动填充」）。
//
// 用法：node --experimental-strip-types scripts/verify-weather-placeholder.mjs

import {
  WEATHER_PLACEHOLDER_LINE,
  insertWeatherPlaceholder,
  weatherPlaceholderRange,
  replaceWeatherPlaceholder,
  removeWeatherPlaceholder,
} from "../src/lib/weather.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// 占位行插入位置与 insertWeatherLine 同规则
check(
  insertWeatherPlaceholder("# 标题\n\n正文") === `# 标题\n${WEATHER_PLACEHOLDER_LINE}\n\n正文`,
  "占位行：无 frontmatter 插到首行后",
);
check(
  insertWeatherPlaceholder("---\ntitle: x\n---\n\n# 2026-11-13\n") ===
    `---\ntitle: x\n---\n${WEATHER_PLACEHOLDER_LINE}\n\n# 2026-11-13\n`,
  "占位行：frontmatter 之后",
);

// 范围查找：LF
{
  const text = `# 标题\n${WEATHER_PLACEHOLDER_LINE}\n正文`;
  const r = weatherPlaceholderRange(text);
  check(!!r && text.slice(r.from, r.to) === WEATHER_PLACEHOLDER_LINE, "范围：LF 整行");
}

// 范围查找：CRLF——to 应停在 \r 之前（替换时保留原分隔符）
{
  const text = `# 标题\r\n${WEATHER_PLACEHOLDER_LINE}\r\n正文`;
  const r = weatherPlaceholderRange(text);
  check(
    !!r && text.slice(r.from, r.to) === WEATHER_PLACEHOLDER_LINE && text[r.to] === "\r",
    "范围：CRLF to 停在 \\r 前",
  );
}

// 范围查找：占位行是最后一行（无换行）
{
  const text = `# 标题\n${WEATHER_PLACEHOLDER_LINE}`;
  const r = weatherPlaceholderRange(text);
  check(!!r && r.to === text.length, "范围：最后一行到文末");
}

// 替换
{
  const out = replaceWeatherPlaceholder(`# 标题\n${WEATHER_PLACEHOLDER_LINE}\n正文`, "☀️ 晴 25°C（18~27°C）");
  check(out === "# 标题\n> ☀️ 晴 25°C（18~27°C）\n正文", "替换：LF 原位换真天气");
}
{
  const out = replaceWeatherPlaceholder(`# 标题\r\n${WEATHER_PLACEHOLDER_LINE}\r\n正文`, "☀️ 晴");
  check(out === "# 标题\r\n> ☀️ 晴\r\n正文", "替换：CRLF 分隔符保留");
}
check(
  replaceWeatherPlaceholder("# 标题\n正文", "☀️ 晴") === null,
  "替换：没有占位行返回 null（用户动过就别碰）",
);

// 删除
{
  const out = removeWeatherPlaceholder(`# 标题\n${WEATHER_PLACEHOLDER_LINE}\n正文`);
  check(out === "# 标题\n正文", "删除：连同行尾换行");
}
{
  const out = removeWeatherPlaceholder(`# 标题\r\n${WEATHER_PLACEHOLDER_LINE}\r\n正文`);
  check(out === "# 标题\r\n正文", "删除：CRLF 一起删");
}
{
  const out = removeWeatherPlaceholder(`# 标题\n${WEATHER_PLACEHOLDER_LINE}`);
  check(out === "# 标题\n", "删除：最后一行");
}
check(removeWeatherPlaceholder("# 标题\n正文") === null, "删除：没有占位行返回 null");

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n天气占位行协议全部通过 ✓");
