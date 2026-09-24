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
const notes = notesFile
  ? fs.readFileSync(notesFile, "utf8").trim()
  : `Release v${version}`;

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
