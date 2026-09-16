// 打印 GFM Markdown 的 lezer 语法树，用于确认节点名。
//
// 写 Live Preview 装饰层必须知道确切的节点名（StrongEmphasis？EmphasisMark？）
// 和它们的范围，靠猜会不断返工。此脚本把真实树打出来作为依据。
//
// 用法：node scripts/dump-markdown-tree.mjs [file]

import { readFileSync } from "node:fs";
import { parser, GFM } from "@lezer/markdown";

const file = process.argv[2] ?? "test-vault/features.md";
const text = readFileSync(file, "utf8");
const tree = parser.configure(GFM).parse(text);

/** 把偏移转成行列，便于和源文件对照。 */
const lineAt = (pos) => {
  const upTo = text.slice(0, pos);
  const line = upTo.split("\n").length;
  const col = pos - (upTo.lastIndexOf("\n") + 1);
  return `${line}:${col}`;
};

/** 节点文本压成单行，便于看范围是否切对了。 */
const slice = (from, to) => JSON.stringify(text.slice(from, to).replace(/\n/g, "\\n"));

function walk(node, depth) {
  const pad = "  ".repeat(depth);
  const name = node.name === node.type.name ? node.name : `${node.name}`;
  console.log(
    `${pad}${name.padEnd(22 - Math.min(depth * 2, 16))} [${lineAt(node.from)}-${lineAt(node.to)}]  ${slice(node.from, node.to)}`,
  );
  for (let child = node.firstChild; child; child = child.nextSibling) {
    walk(child, depth + 1);
  }
}

console.log(`文件: ${file}  （${text.length} 字符）\n`);
walk(tree.topNode, 0);
