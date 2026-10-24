// 0.33.0 停点1 手测桩后端：模拟器里 10.0.2.2 访问宿主。
// 云端仓库故意带一个超长名（验证批B 云端行省略号）。
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 9490);
const CLOUD_VAULTS = [
  { name: "云仓A", version: 3 },
  { name: "云仓B", version: 1 },
  { name: "一个非常非常长的云端仓库名称用来验证移动端省略号是否正常显示2026", version: 33 },
];

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, json) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(json));
    };
    if (url.pathname === "/api/v1/auth/login") {
      send(200, { code: 0, data: { accessToken: "stub", refreshToken: "stub-r", expiresIn: 7200 } });
      return;
    }
    if (url.pathname === "/api/v1/vaults") {
      send(200, { code: 0, data: CLOUD_VAULTS });
      return;
    }
    if (url.pathname === "/api/v1/sync" && req.method === "GET") {
      send(200, { code: 0, data: { vaultVersion: 0, hasMore: false, records: [], attachments: [] } });
      return;
    }
    if (url.pathname === "/api/v1/sync" && req.method === "POST") {
      send(200, { code: 0, data: { accepted: 0, version: 0 } });
      return;
    }
    send(404, { code: 404, message: "not found" });
  });
}).listen(PORT, "0.0.0.0", () => {
  console.log(`桩后端已监听 0.0.0.0:${PORT}（模拟器内填 http://10.0.2.2:${PORT}）`);
});
