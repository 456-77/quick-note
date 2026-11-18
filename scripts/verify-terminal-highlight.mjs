// 0.39.22 文本文件高亮（sh / env）纯函数断言：关键字/变量/字符串/注释/键值
// 区间不重叠、顺序合法、常见写法都覆盖到。跑法：node --experimental-strip-types。
import { shellSpans, envSpans } from "../src/lib/terminalHighlight.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

const kindAt = (spans, text, offset, needle) => {
  const at = offset + text.indexOf(needle);
  const hit = spans.find((span) => span.from <= at && at < span.to);
  return hit?.kind ?? null;
};

// ---------------- shell ----------------
{
  const line = "export PATH=$HOME/bin  # 注释里的 # 不算字符串";
  const spans = shellSpans(line, 100);
  check(spans.every((span) => span.from >= 100 && span.to <= 100 + line.length), "区间落在行内（带偏移）");
  check(kindAt(spans, line, 100, "export") === "keyword", "export 识别为关键字");
  check(kindAt(spans, line, 100, "$HOME") === "var", "变量 $HOME");
  check(kindAt(spans, line, 100, "注释里的") === "comment", "行尾 # 注释");
  const sorted = spans.every((span, i) => i === 0 || spans[i - 1].to <= span.from);
  check(sorted, "区间升序且互不重叠", JSON.stringify(spans));

  const quoted = 'echo "hello # not comment"';
  const qSpans = shellSpans(quoted, 0);
  check(kindAt(qSpans, quoted, 0, "hello # not comment") === "string", "引号内 # 不是注释");
  check(!qSpans.some((span) => span.kind === "comment"), "引号内无注释区间");

  const braced = 'x=${y##*/}; if [ -n "$x" ]; then echo ok; fi';
  const bSpans = shellSpans(braced, 0);
  check(kindAt(bSpans, braced, 0, "${y##*/}") === "var", "花括号变量含 ## 不被误判注释");
  check(kindAt(bSpans, braced, 0, "if") === "keyword", "if 关键字");
  check(kindAt(bSpans, braced, 0, "then") === "keyword", "then 关键字");
  check(!bSpans.some((span) => span.kind === "comment"), "无注释误判");

  const shebang = "#!/bin/bash";
  check(kindAt(shellSpans(shebang, 0), shebang, 0, "/bin/bash") === "comment", "shebang 整行注释色");
}

// ---------------- env ----------------
{
  const line = '  HFINS_VERSION="1.9"   # 版本';
  const spans = envSpans(line, 0);
  check(kindAt(spans, line, 0, "HFINS_VERSION") === "key", "键名着色");
  check(kindAt(spans, line, 0, '"1.9"') === "string", "带引号的值 = 字符串");
  check(kindAt(spans, line, 0, "# 版本") === "comment", "行尾注释");

  const exported = "export SPRING_DATASOURCE_URL=jdbc:oracle:thin:@1.2.3.4:1521/X";
  const eSpans = envSpans(exported, 0);
  check(kindAt(eSpans, exported, 0, "export") === "keyword", "export 关键字");
  check(kindAt(eSpans, exported, 0, "SPRING_DATASOURCE_URL") === "key", "带下划线键名");
  check(kindAt(eSpans, exported, 0, "jdbc:oracle") === "atom", "未加引号的值 = atom（含冒号不误判注释）");

  const plain = "# 只有注释";
  check(kindAt(envSpans(plain, 0), plain, 0, "只有注释") === "comment", "整行注释");
  check(envSpans("普通说明文字行", 0).length === 0, "非键值行不硬上色");
}

console.log(failures === 0 ? "\nsh/env 高亮断言全部通过 ✓" : `\n失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
