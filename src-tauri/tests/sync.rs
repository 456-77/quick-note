//! 同步链路的集成测试：内容哈希口径、范围扫描、HTTP 通道。
//!
//! 这里**不连真后端**。桩服务器就是一个 `TcpListener`，只在 127.0.0.1 上监听：
//! 验收脚本必须能在没有网络、没有 Docker 的机器上跑完（`verify-all.sh` 的约定），
//! 而这条链路里真正需要被守住的恰恰是"字节原样进出"与"状态码不被吞掉"，
//! 这些用桩比用真服务器测得更准。
//!
//! 用**独立临时仓库**，不碰 `test-vault/`：那份 fixture 的字节基线同时也在守护测试流程本身。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use quick_note_lib::net::{http_request, HttpHeader};
use quick_note_lib::vault::{
    read_binary, read_note, sync_scan, sync_scan_attachments, write_binary, write_note,
};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ---------------------------------------------------------------- 桩服务器

#[derive(Debug, Clone)]
struct StubRequest {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl StubRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

struct StubResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl StubResponse {
    fn json(status: u16, body: &str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
        }
    }
}

/// 一次性桩服务器：按顺序对每个连接回同一个响应，并记录收到的请求。
///
/// 线程在进程退出时自然结束（测试二进制结束时不会等它），因此不需要关闭逻辑。
fn start_stub(response: StubResponse) -> (u16, Arc<Mutex<Vec<StubRequest>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("绑定桩服务器失败");
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);

    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let Some(request) = read_request(&mut stream) else {
                continue;
            };
            sink.lock().unwrap().push(request);
            let mut head = format!(
                "HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Length: {}\r\n",
                response.status,
                reason(response.status),
                response.body.len()
            );
            for (name, value) in &response.headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str("\r\n");
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&response.body);
            let _ = stream.flush();
        }
    });

    (port, seen)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Status",
    }
}

fn read_request(stream: &mut TcpStream) -> Option<StubRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        let Some(head_end) = find(&buffer, b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next()?.split(' ');
        let method = request_line.next()?.to_string();
        let target = request_line.next()?.to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                Some((name.trim().to_string(), value.trim().to_string()))
            })
            .collect();
        let length: usize = headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        let mut body = buffer[head_end + 4..].to_vec();
        while body.len() < length {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..read]);
        }
        return Some(StubRequest {
            method,
            target,
            headers,
            body,
        });
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn header(name: &str, value: &str) -> HttpHeader {
    HttpHeader {
        name: name.into(),
        value: value.into(),
    }
}

fn request(
    method: &str,
    url: String,
    headers: Vec<HttpHeader>,
    body_text: Option<String>,
    body_base64: Option<String>,
) -> Result<quick_note_lib::net::HttpResponse, String> {
    tauri::async_runtime::block_on(http_request(
        method.into(),
        url,
        headers,
        body_text,
        body_base64,
        Some(5_000),
    ))
}

// ---------------------------------------------------------------- HTTP 通道

#[test]
fn sends_method_headers_and_body_verbatim() {
    let (port, seen) = start_stub(StubResponse::json(200, "{\"code\":0,\"data\":{}}"));

    let response = request(
        "POST",
        format!("http://127.0.0.1:{port}/api/v1/sync?vault=%E6%97%A5%E8%AE%B0"),
        vec![
            header("Content-Type", "application/json"),
            header("Authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"),
        ],
        Some("{\"items\":[{\"path\":\"日记/a.md\",\"content\":\"一\\r\\n二\"}]}".into()),
        None,
    )
    .expect("请求应当成功");

    assert_eq!(response.status, 200);
    assert_eq!(
        String::from_utf8(STANDARD.decode(&response.body_base64).unwrap()).unwrap(),
        "{\"code\":0,\"data\":{}}"
    );

    let requests = seen.lock().unwrap();
    let first = requests.first().expect("桩服务器应当收到请求");
    assert_eq!(first.method, "POST");
    // 查询串原样送达（vault 名是中文，必须已 percent-encode）
    assert_eq!(first.target, "/api/v1/sync?vault=%E6%97%A5%E8%AE%B0");
    assert_eq!(first.header("authorization"), Some("Bearer eyJhbGciOiJIUzI1NiJ9.abc.def"));
    assert_eq!(first.header("content-type"), Some("application/json"));
    // 正文按 UTF-8 原样发出，CRLF 没被规范化
    assert_eq!(
        String::from_utf8(first.body.clone()).unwrap(),
        "{\"items\":[{\"path\":\"日记/a.md\",\"content\":\"一\\r\\n二\"}]}"
    );
}

#[test]
fn binary_body_survives_round_trip() {
    // 含 NUL、0xFF、非 UTF-8 序列的字节：附件走的就是这条路
    let bytes: Vec<u8> = vec![0x00, 0xFF, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    let (port, seen) = start_stub(StubResponse {
        status: 200,
        headers: vec![("X-Attachment-Path".into(), "image/a.png".into())],
        body: bytes.clone(),
    });

    let response = request(
        "POST",
        format!("http://127.0.0.1:{port}/api/v1/sync/attachments?vault=v&path=a.png"),
        vec![header("Content-Type", "application/octet-stream")],
        None,
        Some(STANDARD.encode(&bytes)),
    )
    .expect("请求应当成功");

    assert_eq!(STANDARD.decode(&response.body_base64).unwrap(), bytes);
    let requests = seen.lock().unwrap();
    assert_eq!(requests[0].body, bytes, "上传的字节必须原样到达");
    // 响应头原样带回来（大小写保留），调用方自己按小写比对
    assert!(response
        .headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("x-attachment-path") && h.value == "image/a.png"));
}

#[test]
fn status_codes_are_returned_not_raised() {
    // 401 必须原样返回：续期逻辑要靠它判断，不能被通道吞成"网络错误"
    let (port, _seen) = start_stub(StubResponse::json(401, "{\"code\":401,\"message\":\"未登录\"}"));
    let response = request(
        "GET",
        format!("http://127.0.0.1:{port}/api/v1/sync?vault=v&since=0&limit=500"),
        Vec::new(),
        None,
        None,
    )
    .expect("401 不是传输失败");
    assert_eq!(response.status, 401);

    // 404 同理（附件不在云端是预期结果）
    let (port, _seen) = start_stub(StubResponse::json(404, "{\"code\":404}"));
    let response = request(
        "DELETE",
        format!("http://127.0.0.1:{port}/api/v1/sync/attachments?vault=v&path=a.png"),
        Vec::new(),
        None,
        None,
    )
    .expect("404 不是传输失败");
    assert_eq!(response.status, 404);
}

#[test]
fn transport_failure_is_reported_as_such() {
    // 绑定后立刻释放，拿到一个几乎肯定没人监听的端口
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    thread::sleep(Duration::from_millis(20));
    let result = request(
        "GET",
        format!("http://127.0.0.1:{port}/api/v1/sync?vault=v"),
        Vec::new(),
        None,
        None,
    );
    let message = result.expect_err("连不上应当报错");
    assert!(message.starts_with("无法连接同步服务器"), "{message}");
}

// ---------------------------------------------------------------- 扫描与口径

/// 独立的临时仓库（带 pid 与 tag，避免并行执行时互相干扰）。
fn temp_vault(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("quicknote-sync-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("日记")).unwrap();
    fs::create_dir_all(dir.join("其他")).unwrap();
    dir
}

fn write_bytes(vault: &PathBuf, rel: &str, bytes: &[u8]) {
    let path = vault.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn scan(vault: &PathBuf, scope: &str, folder: &str) -> quick_note_lib::vault::SyncScanResult {
    let result = tauri::async_runtime::block_on(sync_scan(
        vault.to_string_lossy().to_string(),
        scope.into(),
        folder.into(),
    ));
    result.expect("扫描应当成功")
}

/// 同步口径：**BOM 不进哈希，换行符原样进哈希**。
///
/// 这条断言是 M3 的阻断项。口径来自 Obsidian 自己的实现
/// （`Vault.prototype.read` = `fs.readFile(path, "utf8")` 后剥掉开头的 U+FEFF），
/// 一旦这里变了，带 BOM 或 CRLF 的文件会在两侧反复被判成"已改动"。
#[test]
fn sync_hash_drops_bom_but_keeps_line_endings() {
    let vault = temp_vault("hash");
    let text = "# 标题\n正文\n";

    write_bytes(&vault, "日记/plain.md", text.as_bytes());
    // 同样的文本 + BOM：同步哈希必须与上面**相同**
    let mut with_bom = vec![0xEF, 0xBB, 0xBF];
    with_bom.extend_from_slice(text.as_bytes());
    write_bytes(&vault, "日记/with-bom.md", &with_bom);
    // CRLF：哈希必须与上面**不同**（双方都不规范化换行符）
    write_bytes(&vault, "日记/crlf.md", text.replace('\n', "\r\n").as_bytes());

    let result = scan(&vault, "vault", "");
    let hash_of = |name: &str| {
        result
            .files
            .iter()
            .find(|file| file.path == format!("日记/{name}"))
            .unwrap_or_else(|| panic!("扫描结果里应当有 {name}"))
            .sync_sha256
            .clone()
    };

    assert_eq!(
        hash_of("plain.md"),
        hash_of("with-bom.md"),
        "BOM 不参与同步哈希（与 Obsidian 的 vault.read 一致）"
    );
    assert_ne!(
        hash_of("plain.md"),
        hash_of("crlf.md"),
        "换行符参与哈希：CRLF 与 LF 是不同的内容"
    );

    // has_bom 仍然如实报告（写回时要补回去）
    let bom_entry = result
        .files
        .iter()
        .find(|file| file.path == "日记/with-bom.md")
        .unwrap();
    assert!(bom_entry.has_bom);

    // 与 read_note 报的哈希一致：推送时读一遍就能直接拿到要用的哈希
    let note = read_note(vault.to_string_lossy().to_string(), "日记/with-bom.md".into()).unwrap();
    assert_eq!(note.sync_sha256, hash_of("with-bom.md"));
    assert_ne!(
        note.sha256, note.sync_sha256,
        "带 BOM 时，原始字节哈希与同步哈希本来就该不同"
    );

    let _ = fs::remove_dir_all(&vault);
}

/// 写回原内容后同步哈希不变——"保存一次就让所有文件变成待推送"是必须避免的失败模式。
#[test]
fn round_trip_keeps_sync_hash_stable() {
    let vault = temp_vault("stable");
    let cases: Vec<(String, &[u8])> = vec![
        ("日记/lf.md".into(), b"# a\nb\n".as_slice()),
        ("日记/crlf.md".into(), b"# a\r\nb\r\n".as_slice()),
        ("日记/cr.md".into(), b"# a\rb\r".as_slice()),
        ("日记/mixed.md".into(), b"# a\r\nb\nc\r".as_slice()),
        ("日记/no-trailing.md".into(), b"# a\nb".as_slice()),
        ("日记/with-bom.md".into(), b"\xEF\xBB\xBF# a\nb\n".as_slice()),
    ];
    for (rel, bytes) in &cases {
        write_bytes(&vault, rel, bytes);
    }

    let before = scan(&vault, "vault", "");
    assert_eq!(before.files.len(), cases.len());

    // 逐篇"读出来再原样写回"（正是自动保存会做的事）
    for (rel, _) in &cases {
        let note = read_note(vault.to_string_lossy().to_string(), rel.clone()).unwrap();
        let result = write_note(
            vault.to_string_lossy().to_string(),
            rel.clone(),
            note.content.clone(),
            note.has_bom,
        )
        .unwrap();
        assert!(!result.changed, "{rel} 内容没变，不该触碰文件");
    }

    let after = scan(&vault, "vault", "");
    assert_eq!(
        before
            .files
            .iter()
            .map(|f| (&f.path, &f.sync_sha256))
            .collect::<Vec<_>>(),
        after
            .files
            .iter()
            .map(|f| (&f.path, &f.sync_sha256))
            .collect::<Vec<_>>(),
        "读→写往返之后同步哈希必须逐个不变"
    );

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn scan_filters_scope_and_reports_unreadable_files() {
    let vault = temp_vault("scope");
    write_bytes(&vault, "日记/in.md", b"a\n");
    write_bytes(&vault, "其他/out.md", b"b\n");
    write_bytes(&vault, "日记/notes.MD", b"c\n"); // 后缀大小写不匹配（服务端会整批拒绝）
    write_bytes(&vault, "日记/other.txt", b"d\n");
    write_bytes(&vault, "日记/.hidden.md", b"e\n"); // 点开头：连列举都跳过
    write_bytes(&vault, "日记/broken.md", &[0x23, 0x20, 0xFF, 0xFE, 0x0A]); // 非法 UTF-8

    let scoped = scan(&vault, "folder", "日记");
    let paths: Vec<&str> = scoped.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["日记/in.md"]);
    assert_eq!(
        scoped.skipped.len(),
        1,
        "非法 UTF-8 的文件要如实报告，而不是静默放过"
    );
    assert_eq!(scoped.skipped[0].path, "日记/broken.md");
    assert!(
        scoped.skipped[0].reason.contains("UTF-8"),
        "{}",
        scoped.skipped[0].reason
    );

    // 整个库的范围：日记之外也进来，但 .txt / .MD / 点开头仍然出不去
    let all = scan(&vault, "vault", "日记");
    let mut paths: Vec<&str> = all.files.iter().map(|f| f.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, vec!["其他/out.md", "日记/in.md"]);

    let _ = fs::remove_dir_all(&vault);
}

// ---------------------------------------------------------------- 附件引用扫描

fn scan_attachments(
    vault: &PathBuf,
    scope: &str,
    folder: &str,
) -> quick_note_lib::vault::AttachmentScanResult {
    let result = tauri::async_runtime::block_on(sync_scan_attachments(
        vault.to_string_lossy().to_string(),
        scope.into(),
        folder.into(),
    ));
    result.expect("附件扫描应当成功")
}

fn binary(vault: &PathBuf, rel: &str) -> quick_note_lib::vault::BinaryContent {
    read_binary(vault.to_string_lossy().to_string(), rel.into()).expect("读取附件应当成功")
}

/// 附件扫描是"从云端把图拉下来"唯一的入口：本地缺的图只会表现为"引用得到名字、
/// 找不到文件"。这条链路的判定错了，图片就永远下不来。
#[test]
fn attachment_scan_resolves_references_and_reports_missing() {
    let vault = temp_vault("att");

    // 附件躺在日记目录之外（常见：库根的 attachments/）。注意"丢失.pdf"**不创建**：
    // 它就是"被引用但本地没有"的那个。
    write_bytes(&vault, "attachments/被引用.png", b"PNGDATA");
    write_bytes(&vault, "attachments/没人引用.png", b"ORPHAN");

    // 日记引用了三种：能解析到文件、解析不到（本地缺图）、还有行内代码里的示例（不算）
    write_bytes(
        &vault,
        "日记/2026-09-15.md",
        concat!(
            "# 日记\n",
            "![[被引用.png|300]]\n",
            "![[丢失.pdf]]\n",
            "![](attachments/被引用.png)\n",   // 同一张图的另一种写法：去重
            "写成 `![[示例.png]]` 的不算引用\n",
            "```md\n![[围栏里.png]]\n```\n",
        )
        .as_bytes(),
    );

    let result = scan_attachments(&vault, "folder", "日记");

    let paths: Vec<&str> = result.referenced.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["attachments/被引用.png"],
        "同一张图的两种写法只算一次；孤儿附件与围栏/行内代码里的名字不出现"
    );

    let missing: Vec<&str> = result.missing.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(missing, vec!["丢失.pdf"], "本地缺的附件按名字上报");
    assert_eq!(result.missing[0].from, "日记/2026-09-15.md", "带上引用它的日记路径（服务端解析同名文件时同目录优先）");

    let _ = fs::remove_dir_all(&vault);
}

/// 点开头的路径段与白名单之外的扩展名，无论引用与否都不进结果。
///
/// .trash 里的同名文件**不能**把引用满足掉：那会导致"从云端把已删除的图拉回来"，
/// 而这里期望它被当成 missing（云端有就取回，没有就静默跳过——与插件一致）。
#[test]
fn attachment_scan_ignores_hidden_and_unsupported() {
    let vault = temp_vault("att2");
    write_bytes(&vault, ".trash/被引用.png", b"X");
    write_bytes(&vault, "attachments/图.svg", b"<svg/>");
    write_bytes(&vault, "日记/a.md", "![[被引用.png]]\n![[图.svg]]\n".as_bytes());

    let result = scan_attachments(&vault, "vault", "");
    assert!(result.referenced.is_empty(), "点开头目录里的文件不能被引用到");
    assert_eq!(
        result.missing.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
        vec!["被引用.png"],
        ".trash 里的同名文件不算数；svg 被白名单挡掉，刻意不同步"
    );

    let _ = fs::remove_dir_all(&vault);
}

/// write_binary 是"把云端那份原样落回来"：路径由服务端指定、允许覆盖、逐级建目录。
#[test]
fn write_binary_overwrites_at_exact_path() {
    use quick_note_lib::vault::BinaryWriteResult;

    let vault = temp_vault("bin");
    write_bytes(&vault, "attachments/old.png", b"OLD");

    let bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF];
    let result: BinaryWriteResult = write_binary(
        vault.to_string_lossy().to_string(),
        "attachments/deep/new.png".into(),
        STANDARD.encode(&bytes),
    )
    .expect("写入应当成功");
    assert_eq!(result.path, "attachments/deep/new.png");
    assert_eq!(fs::read(vault.join("attachments/deep/new.png")).unwrap(), bytes);

    // 同路径覆盖（不追加序号——那是 write_attachment 的行为）
    let again = write_binary(
        vault.to_string_lossy().to_string(),
        "attachments/old.png".into(),
        STANDARD.encode(b"NEW"),
    )
    .unwrap();
    assert_eq!(fs::read(vault.join("attachments/old.png")).unwrap(), b"NEW");
    assert_ne!(again.sha256, result.sha256);

    // read_binary 原样带回（含非 UTF-8 字节）
    let loaded = binary(&vault, "attachments/old.png");
    assert_eq!(STANDARD.decode(&loaded.base64).unwrap(), b"NEW");
    assert_eq!(loaded.sha256, again.sha256);

    // 路径校验照常生效
    let error = write_binary(
        vault.to_string_lossy().to_string(),
        "../逃逸.png".into(),
        STANDARD.encode(b"x"),
    );
    assert!(error.is_err());

    let _ = fs::remove_dir_all(&vault);
}
