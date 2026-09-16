// 附件的命名与链接生成（纯函数，无需 DOM）。
//
// 命名规则最容易在边界上出错：没有文件名、没有扩展名、含非法字符、同一秒多个文件。
//
// 用法：node scripts/verify-attachments.mjs

import { attachmentNameFor, extensionFor, linkTextFor, timestamp } from "../src/lib/attachments.ts";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.log(`✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
};

// ---------------------------------------------------------------- 扩展名
console.log("扩展名推断\n");
check(extensionFor("shot.png", "image/png") === "png", "用文件名的扩展名");
check(extensionFor("photo.JPEG", "image/jpeg") === "jpeg", "扩展名统一转小写");
check(extensionFor("", "image/webp") === "webp", "没有文件名时按 MIME 推断");
check(extensionFor("blob", "image/png") === "png", "文件名叫 blob 时按 MIME 推断");
check(extensionFor("archive", "") === "bin", "既无扩展名也无 MIME 时兜底");
check(extensionFor("a.b.c", "text/plain") === "c", "多个点时取最后一段");
check(extensionFor("  图 像 .PNG ", "image/png") === "png", "忽略首尾空格");

// ---------------------------------------------------------------- 时间戳
console.log("\n时间戳\n");
check(
  timestamp(new Date(2026, 8, 15, 14, 30, 12)) === "20260915143012",
  "本地时间 YYYYMMDDHHmmss",
  timestamp(new Date(2026, 8, 15, 14, 30, 12)),
);
check(
  timestamp(new Date(2026, 0, 2, 3, 4, 5)) === "20260102030405",
  "个位数月/日/时/分/秒补零",
  timestamp(new Date(2026, 0, 2, 3, 4, 5)),
);

// ---------------------------------------------------------------- 文件名
console.log("\n附件文件名\n");
const at = new Date(2026, 8, 15, 14, 30, 12);
check(
  attachmentNameFor({ name: "image.png", type: "image/png" }, at) ===
    "Pasted image 20260915143012.png",
  "图片统一用 Obsidian 风格命名（与库里已有文件排在一起）",
  attachmentNameFor({ name: "image.png", type: "image/png" }, at),
);
check(
  attachmentNameFor({ name: "", type: "image/png" }, at) === "Pasted image 20260915143012.png",
  "截图没有文件名时也能命名",
);
check(
  attachmentNameFor({ name: "screenshot.png", type: "IMAGE/PNG" }, at).startsWith("Pasted image"),
  "MIME 大小写不影响判断",
);
check(
  attachmentNameFor({ name: "a.png", type: "image/png" }, at, 1) ===
    "Pasted image 20260915143012 1.png",
  "同一批的第二个文件加序号，避免同一秒重名",
  attachmentNameFor({ name: "a.png", type: "image/png" }, at, 1),
);
check(
  attachmentNameFor({ name: "报告.pdf", type: "application/pdf" }, at) === "报告.pdf",
  "非图片保留原文件名",
);
check(
  attachmentNameFor({ name: "a/b:c*.zip", type: "application/zip" }, at) === "a_b_c_.zip",
  "非法的路径分隔符与禁用字符被替换",
  attachmentNameFor({ name: "a/b:c*.zip", type: "application/zip" }, at),
);
check(
  attachmentNameFor({ name: "../../逃逸", type: "application/octet-stream" }, at) === "_.._逃逸",
  "带 ../ 的文件名被清洗：分隔符变下划线、开头的点被去掉（不产生路径穿越）",
  attachmentNameFor({ name: "../../逃逸", type: "application/octet-stream" }, at),
);
check(
  !/[/\\]/.test(attachmentNameFor({ name: "a/b\\c.png", type: "image/png" }, at)) &&
    !attachmentNameFor({ name: ".hidden.png", type: "image/png" }, at).startsWith("."),
  "生成的图片名永远不含路径分隔符、不以点开头",
  attachmentNameFor({ name: ".hidden.png", type: "image/png" }, at),
);
check(
  attachmentNameFor({ name: "", type: "application/zip" }, at).startsWith("Pasted file"),
  "非图片且无文件名时给一个兜底名",
);

// ---------------------------------------------------------------- 链接文本
console.log("\n插入的链接文本\n");
check(
  linkTextFor("attachments/Pasted image 20260915143012.png", "wiki") ===
    "![[Pasted image 20260915143012.png]]",
  "wiki 写法只用文件名（wiki 按文件名在全库解析）",
  linkTextFor("attachments/a.png", "wiki"),
);
check(
  linkTextFor("attachments/a.png", "markdown") === "![a.png](/attachments/a.png)",
  "markdown 写法用仓库根相对路径（笔记在子目录里也不会指错）",
  linkTextFor("attachments/a.png", "markdown"),
);
check(
  linkTextFor("a.png", "markdown") === "![a.png](/a.png)",
  "附件放在仓库根时路径同样正确",
);
check(
  linkTextFor("deep/nested/a.png", "wiki") === "![[a.png]]",
  "wiki 写法在嵌套目录下也只写文件名",
);

console.log(failures === 0 ? "\n附件命名与链接验证通过 ✓" : `\n共 ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
