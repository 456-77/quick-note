//! 单词释义在线查询（0.25 用户反馈"单词的释义自动获取，可以利用网上的免费接口"）。
//!
//! 数据源是有道词典的公开 jsonapi（免 key、免登录，桌面与移动端同一通道）：
//!
//! ```text
//! https://dict.youdao.com/jsonapi?jsonversion=2&client=mobile
//!     &dicts={"count":2,"dicts":[["ec"],["web_trans"]]}&q={word}
//! ```
//!
//! 一次请求带两个字段：
//! - `ec`（词典正文）：`simple.word[].ukphone/usphone` 音标 + `ec.word[].trs`
//!   分词性中文释义——主来源，查不到的词（生造词/专名）整个键缺失；
//! - `web_trans`（网络释义）：`web-translation[0].trans[].value` 短语词兜底。
//!
//! 为什么走 Rust 而不是前端 fetch：WebView 的源是 `tauri.localhost`，词典接口
//! 不一定带 CORS 头（fetch 会被同源策略掐掉），而且 Android WebView 没有绕过
//! CORS 的开发后门——Rust 侧 ureq（net.rs 同一套 TLS 分层）两端通用。
//!
//! 解析与清洗是纯函数（`parse_lookup`），可与网络解耦做单测。

use serde::Serialize;

/// 查询超时。词典查询是交互路径（用户按回车在等），给短一点快速失败。
const LOOKUP_TIMEOUT_MS: u64 = 6_000;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VocabLookup {
    pub word: String,
    /// 音标（英式优先，形如 `/səˈnɑːriəʊ/`；没有则空串）。
    pub phonetic: String,
    /// 中文释义（ec 词典分词性释义按"；"连接；fallback 为网络释义前几条）。
    pub meaning: String,
    /// 释义来源（"ec" = 词典正文 / "web" = 网络释义），前端 Toast 与调试用。
    pub source: String,
}

/// 词查询参数做最小 percent-encode（unreserved 之外全部编码；空格按 RFC 3986
/// 编成 %20）。jsonapi 的 q 接受短语，编码不当会把请求打成 400。
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// 词条文件行里 `|` 是字段分隔符、` — ` 是 meta 分隔符——释义里出现会炸解析，
/// 统一替换；换行/多余空白压成单个空格（单词本.md 一行一条）。
fn sanitize_field(text: &str) -> String {
    text.replace('|', "／")
        .replace(" — ", "，")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// 从 jsonapi 响应里解析音标与释义。查到任何可用信息返回 Some；
/// 完全没有（生造词）返回 None，由调用方给"未找到在线释义"。
fn parse_lookup(word: &str, body: &str) -> Option<VocabLookup> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;

    // 音标：simple.word[0] 的英式优先（用户规范里的示例是英式），没有再取美式
    let phonetic_raw = json
        .pointer("/simple/word/0/ukphone")
        .and_then(|value| value.as_str())
        .filter(|text| !text.trim().is_empty())
        .or_else(|| {
            json.pointer("/simple/word/0/usphone")
                .and_then(|value| value.as_str())
                .filter(|text| !text.trim().is_empty())
        })
        .unwrap_or_default();
    let phonetic = if phonetic_raw.trim().is_empty() {
        String::new()
    } else {
        format!("/{}/", phonetic_raw.trim())
    };

    // ec 词典释义：ec.word[].trs[].tr[].l.i[] 的字符串项（不同词性各一条 tr）
    let mut meanings: Vec<String> = Vec::new();
    if let Some(trs) = json.pointer("/ec/word/0/trs").and_then(|value| value.as_array()) {
        for tr in trs {
            let Some(items) = tr.pointer("/tr/0/l/i").and_then(|value| value.as_array()) else {
                continue;
            };
            let line = items
                .iter()
                .filter_map(|item| item.as_str())
                .collect::<Vec<_>>()
                .join("");
            let line = sanitize_field(&line);
            if !line.is_empty() {
                meanings.push(line);
            }
        }
    }
    if !meanings.is_empty() {
        return Some(VocabLookup {
            word: word.to_string(),
            phonetic,
            meaning: meanings.join("；"),
            source: "ec".into(),
        });
    }

    // 网络释义兜底：web-translation[0].trans[].value（取前 3 条，去重）
    if let Some(trans) = json
        .pointer("/web_trans/web-translation/0/trans")
        .and_then(|value| value.as_array())
    {
        let mut values: Vec<String> = Vec::new();
        for item in trans {
            let Some(value) = item.get("value").and_then(|value| value.as_str()) else {
                continue;
            };
            let value = sanitize_field(value);
            if value.is_empty() || values.contains(&value) {
                continue;
            }
            values.push(value);
            if values.len() >= 3 {
                break;
            }
        }
        if !values.is_empty() {
            return Some(VocabLookup {
                word: word.to_string(),
                phonetic,
                meaning: values.join("；"),
                source: "web".into(),
            });
        }
    }

    None
}

/// 在线查询单词释义。查不到（非传输错误的"确实没有"）返回 Err("未找到在线释义")，
/// 前端据此给出「手动填写释义」入口而不是把用户堵死。
#[tauri::command]
pub async fn vocab_lookup(word: String) -> Result<VocabLookup, String> {
    let cleaned = word.trim().to_string();
    if cleaned.is_empty() {
        return Err("单词为空".into());
    }
    tauri::async_runtime::spawn_blocking(move || lookup_blocking(&cleaned))
        .await
        .map_err(|e| format!("查询任务中断：{e}"))?
}

fn lookup_blocking(word: &str) -> Result<VocabLookup, String> {
    let url = format!(
        "https://dict.youdao.com/jsonapi?jsonversion=2&client=mobile&dicts=%7B%22count%22%3A2%2C%22dicts%22%3A%5B%5B%22ec%22%5D%2C%5B%22web_trans%22%5D%5D%7D&q={}",
        percent_encode(word)
    );
    let request = ureq::http::Request::builder()
        .method("GET")
        .uri(&url)
        .header("User-Agent", "quick-note")
        .body(Vec::new())
        .map_err(|e| format!("请求构造失败: {e}"))?;
    let mut response = crate::net::build_agent_with_tls(Some(LOOKUP_TIMEOUT_MS), crate::net::TlsChoice::RustlsWebPki)
        .run(request)
        .map_err(|e| format!("词典服务连接失败（{e}）"))?;
    if !response.status().is_success() {
        return Err(format!("词典服务返回 {}", response.status().as_u16()));
    }
    let body = response
        .body_mut()
        .read_to_string()
        .map_err(|e| format!("读取词典响应失败: {e}"))?;
    parse_lookup(word, &body).ok_or_else(|| "未找到在线释义".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCENARIO_JSON: &str = r#"{"input":"scenario","meta":{"input":"scenario","guessLanguage":"eng","isHasSimpleDict":"1","le":"en","lang":"eng","dicts":["meta","simple","ec"]},"le":"en","simple":{"query":"scenario","word":[{"usphone":"səˈnærioʊ","ukphone":"səˈnɑːriəʊ","ukspeech":"scenario&type=1","return-phrase":"scenario","usspeech":"scenario&type=2"}]},"lang":"eng","ec":{"exam_type":["CET6","考研","商务英语"],"source":{"name":"有道词典","url":"https://dict.youdao.com"},"word":[{"usphone":"səˈnærioʊ","ukphone":"səˈnɑːriəʊ","trs":[{"tr":[{"l":{"i":["n. 设想，可能发生的情况 ；（电影、戏剧等的）剧情梗概；（艺术或文学作品中的）场景"]}}]}],"wfs":[{"wf":{"name":"复数","value":"scenarios"}}],"return-phrase":{"l":{"i":"scenario"}},"usspeech":"scenario&type=2"}]}}"#;

    const SCATTER_JSON: &str = r#"{"web_trans":{"web-translation":[{"@same":"true","key":"Scatter","key-speech":"Scatter","trans":[{"summary":{"line":["x"]},"cls":{"cl":["科技"]},"value":"分散","support":1758,"url":""},{"value":"散点图","support":862},{"value":"散射","support":500}]}]},"input":"scatter","meta":{},"le":"en","simple":{"query":"scatter","word":[{"usphone":"ˈskætər","ukphone":"ˈskætə(r)"}]},"lang":"eng","ec":{"word":[{"trs":[{"tr":[{"l":{"i":["v. 撒，播撒；（使）散开"]}}]},{"tr":[{"l":{"i":["n. 零星散布的东西"]}}]}]}]}}"#;

    const UNKNOWN_JSON: &str =
        r#"{"input":"asdfghjkl","meta":{"input":"asdfghjkl","guessLanguage":"eng","isHasSimpleDict":"0","le":"en","lang":"eng","dicts":["meta"]},"le":"en","lang":"eng"}"#;

    const WEB_ONLY_JSON: &str = r#"{"web_trans":{"web-translation":[{"key":"Frobnicate","trans":[{"value":"混淆"},{"value":"弄乱"}]}]}}"#;

    #[test]
    fn parses_phonetic_and_meanings_from_ec() {
        let result = parse_lookup("scenario", SCENARIO_JSON).expect("应当解析出结果");
        assert_eq!(result.phonetic, "/səˈnɑːriəʊ/");
        assert_eq!(result.source, "ec");
        assert!(result.meaning.starts_with("n. 设想"), "{}", result.meaning);
        assert!(!result.meaning.contains('|'));
    }

    #[test]
    fn joins_multiple_pos_senses() {
        let result = parse_lookup("scatter", SCATTER_JSON).expect("应当解析出结果");
        assert!(result.meaning.contains("v. 撒"), "{}", result.meaning);
        assert!(result.meaning.contains("n. 零星"), "{}", result.meaning);
        assert!(result.meaning.contains('；'));
    }

    #[test]
    fn unknown_word_yields_none() {
        assert!(parse_lookup("asdfghjkl", UNKNOWN_JSON).is_none());
    }

    #[test]
    fn falls_back_to_web_translations() {
        let result = parse_lookup("frobnicate", WEB_ONLY_JSON).expect("应当解析出结果");
        assert_eq!(result.source, "web");
        assert_eq!(result.meaning, "混淆；弄乱");
        assert!(result.phonetic.is_empty());
    }

    #[test]
    fn sanitizes_pipe_and_meta_separator() {
        assert_eq!(sanitize_field("a | b — c"), "a ／ b，c");
        assert_eq!(sanitize_field("多行\n释义\t文本"), "多行 释义 文本");
    }

    #[test]
    fn encodes_query_words() {
        assert_eq!(percent_encode("look forward to"), "look%20forward%20to");
        assert_eq!(percent_encode("café"), "caf%C3%A9");
        assert_eq!(percent_encode("a-b_c.d~e"), "a-b_c.d~e");
    }

    /// 手动验证：`cargo test --lib vocab::tests::live_lookup_reaches_youdao -- --ignored`
    /// 依赖外网，不进常规测试；它守住的是"免 key 词典通道可用"这个前提。
    #[test]
    #[ignore = "需要外网"]
    fn live_lookup_reaches_youdao() {
        match lookup_blocking("scenario") {
            Ok(result) => {
                println!("phonetic: {}", result.phonetic);
                println!("meaning: {}", result.meaning);
                println!("source: {}", result.source);
                assert!(!result.meaning.is_empty(), "scenario 应当有释义");
            }
            Err(e) => panic!("在线查询失败：{e}"),
        }
    }
}
