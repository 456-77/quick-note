//! 输出每个笔记文件的换行符/BOM 探测结果（JSON），供编辑器层测试消费。
//!
//! 目的：让「文件真实风格」只有 Rust 一个来源。测试脚本不再自己复刻探测逻辑，
//! 因此不会出现两边判定不一致却都"通过"的假阳性。
//!
//! 用法：cargo run --example dump-detect -- <vaultDir>

use quick_note_lib::vault::{list_entries, read_note};
use serde_json::json;

fn main() {
    let vault = std::env::args().nth(1).unwrap_or_else(|| "../test-vault".into());

    // 只关心笔记文件：目录与非 md 文件不参与换行符探测
    let notes: Vec<_> = match list_entries(vault.clone()) {
        Ok(entries) => entries
            .into_iter()
            .filter(|entry| !entry.is_dir && entry.name.to_lowercase().ends_with(".md"))
            .collect(),
        Err(e) => {
            eprintln!("列举失败: {e}");
            std::process::exit(1);
        }
    };

    let mut out = Vec::new();
    for note in notes {
        match read_note(vault.clone(), note.path.clone()) {
            Ok(content) => out.push(json!({
                "path": content.path,
                "lineEnding": content.line_ending,
                "mixedLineEndings": content.mixed_line_endings,
                "hasBom": content.has_bom,
                "sha256": content.sha256,
            })),
            Err(e) => {
                eprintln!("读取 {} 失败: {e}", note.path);
                std::process::exit(1);
            }
        }
    }

    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
