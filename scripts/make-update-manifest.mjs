// 生成应用内更新（Tauri updater）所需的 latest.json。
//
// 用法：node scripts/make-update-manifest.mjs <版本号> [notes文件]
// 前置：`npm run tauri build` 已跑完且 tauri.conf.json 开了 createUpdaterArtifacts
// （构建时需 TAURI_SIGNING_PRIVATE_KEY_PATH 指向签名私钥）。
// 产出：仓库根目录 latest.json —— 连同安装包与 .sig 一起上传到 GitHub Release。
//
// notes 文件（可选）：新版本介绍文本，写入 manifest 的 notes 字段——应用发现
// 新版本时会把这个内容展示在更新弹窗里。省略时退回 "Release vX.Y.Z"。
//
// 脱敏（0.35.2 用户反馈「每次更新的时候那些提示信息要进行脱敏」）：notes 会
// 展示在所有设备的更新弹窗里且 Release 页公开，示例里出现真实笔记名/项目名
// 就是泄露。本脚本读取 **不入库** 的 scripts/sensitive-words.local.txt（一行一个
// 词，见 scripts/sensitive-words.local.example.txt），把命中的词替换成「□□□」；
// 文件不存在则只提醒。词表写本地是有意的——把敏感词本身提交进公开仓库等于
// 换个地方泄露。
//
// 注意：GitHub 会把附件文件名里的空格换成点号，latest.json 的 url 必须用
// 换算后的名字（Quick.Note_x.y.z_x64-setup.exe）。

import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("用法: node scripts/make-update-manifest.mjs <版本号> [notes文件]");
  process.exit(1);
}

const dir = "src-tauri/target/release/bundle/nsis";
const exeName = `Quick Note_${version}_x64-setup.exe`;
const assetName = exeName.replaceAll(" ", ".");
const sigPath = `${dir}/${exeName}.sig`;
if (!fs.existsSync(sigPath)) {
  console.error(`找不到签名文件 ${sigPath}——确认构建开了 createUpdaterArtifacts`);
  process.exit(1);
}

const notesFile = process.argv[3];
let notes = notesFile
  ? fs.readFileSync(notesFile, "utf8").trim()
  : `Release v${version}`;

// 脱敏：命中本地词表的词整段替换成「□□□」（词表本身不入库，见文件头注释）
const wordlistPath = "scripts/sensitive-words.local.txt";
if (fs.existsSync(wordlistPath)) {
  const words = fs
    .readFileSync(wordlistPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  let hits = 0;
  for (const word of words) {
    while (notes.includes(word)) {
      notes = notes.replace(word, "□□□");
      hits += 1;
    }
  }
  if (hits > 0) console.log(`脱敏：notes 里替换了 ${hits} 处词表命中（提交前请肉眼再过一遍）`);
} else {
  console.log("提醒：没有 scripts/sensitive-words.local.txt 词表，notes 未做自动脱敏——发布前请人工确认无真实笔记名/项目名");
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/456-77/quick-note/releases/download/v${version}/${assetName}`,
    },
  },
};

fs.writeFileSync("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json 已生成（v${version}，附件 ${assetName}，notes ${notes.length} 字）`);
