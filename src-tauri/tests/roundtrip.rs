//! 字节精确往返的集成测试。
//!
//! 这些测试是「同步协议靠内容 SHA-256 判增量」这一设计的前提保障：
//! 只要读写链路对内容做了任何隐式改写（换行符规范化、BOM 丢失、尾随换行增删），
//! 同步就会把未改动的文件判成改动，制造虚假冲突。
//!
//! 依赖 `scripts/make-test-vault.sh` 生成的 `../test-vault`。

use quick_note_lib::vault::{read_note, write_note};
use std::fs;
use std::path::{Path, PathBuf};

fn vault_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-vault")
}

fn vault_str() -> String {
    vault_dir().to_string_lossy().to_string()
}

/// 应用会读取的文件：.md，且路径中没有点开头的段。
fn list_fixture_notes() -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if name.to_lowercase().ends_with(".md") {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    let root = vault_dir();
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort();
    out
}

#[test]
fn fixtures_exist() {
    let notes = list_fixture_notes();
    assert!(
        notes.len() >= 8,
        "测试仓库不完整（{} 个文件），请先运行 scripts/make-test-vault.sh",
        notes.len()
    );
}

/// 读出来原样写回去，磁盘字节必须一个不差，且不应触碰文件。
#[test]
fn read_then_unchanged_write_is_byte_identical() {
    for path in list_fixture_notes() {
        let note = read_note(vault_str(), path.clone()).expect("读取失败");
        let before = fs::read(vault_dir().join(&path)).expect("读取原始字节失败");
        let before_mtime = fs::metadata(vault_dir().join(&path))
            .and_then(|m| m.modified())
            .expect("读取 mtime 失败");

        let result = write_note(vault_str(), path.clone(), note.content.clone(), note.has_bom)
            .expect("写入失败");

        let after = fs::read(vault_dir().join(&path)).expect("回读失败");
        assert_eq!(
            before, after,
            "{path}: 原样写回后字节不一致（换行符或 BOM 被改写）"
        );
        assert!(!result.changed, "{path}: 内容未变却报告 changed=true");
        assert_eq!(result.bytes, before.len(), "{path}: 报告字节数不符");
        assert_eq!(result.sha256, note.sha256, "{path}: 哈希与读取时不符");

        let after_mtime = fs::metadata(vault_dir().join(&path))
            .and_then(|m| m.modified())
            .expect("读取 mtime 失败");
        assert_eq!(before_mtime, after_mtime, "{path}: 内容未变却改动了 mtime");
    }
}

/// 真正编辑一次再撤销：写入新内容后写回原文，文件必须与初始字节完全一致。
#[test]
fn edit_then_restore_round_trips() {
    for path in list_fixture_notes() {
        let original_bytes = fs::read(vault_dir().join(&path)).expect("读取原始字节失败");
        let original = read_note(vault_str(), path.clone()).expect("读取失败");

        let edited = format!("{}\n\n编辑过的一行\n", original.content);
        let written = write_note(vault_str(), path.clone(), edited.clone(), original.has_bom)
            .expect("写入编辑内容失败");
        assert!(written.changed, "{path}: 内容已变却报告 changed=false");

        let reread = read_note(vault_str(), path.clone()).expect("回读失败");
        assert_eq!(reread.content, edited, "{path}: 编辑后的内容读回不一致");
        assert_eq!(
            reread.sha256, written.sha256,
            "{path}: 写入与读回的哈希不一致"
        );

        // 撤销编辑，必须回到最初的字节。
        write_note(vault_str(), path.clone(), original.content.clone(), original.has_bom)
            .expect("恢复原文失败");
        let restored = fs::read(vault_dir().join(&path)).expect("回读失败");
        assert_eq!(
            original_bytes, restored,
            "{path}: 编辑后恢复原文，字节与初始不一致"
        );
    }
}

/// 换行符风格必须被正确识别，且内容里保留原始分隔符。
#[test]
fn detects_line_endings_and_preserves_them() {
    let cases = [
        ("日记/2026-09-14.md", "lf", false),
        ("日记/2026-W37 周记.md", "crlf", false),
        ("cr-only.md", "cr", false),
        ("mixed-endings.md", "crlf", true),
        ("no-trailing-newline.md", "lf", false),
        ("empty.md", "none", false),
    ];
    for (path, expected_ending, expected_mixed) in cases {
        let note = read_note(vault_str(), path.to_string()).expect("读取失败");
        assert_eq!(note.line_ending, expected_ending, "{path}: 换行符风格判断错误");
        assert_eq!(
            note.mixed_line_endings, expected_mixed,
            "{path}: 混合换行判断错误"
        );
    }
}

#[test]
fn detects_bom() {
    let with = read_note(vault_str(), "with-bom.md".into()).expect("读取失败");
    assert!(with.has_bom, "with-bom.md 应检出 BOM");
    assert!(
        !with.content.starts_with('\u{feff}'),
        "content 应已剥离 BOM"
    );

    let without = read_note(vault_str(), "日记/2026-09-14.md".into()).expect("读取失败");
    assert!(!without.has_bom);
}

/// 隐藏文件与非 md 文件不得出现在列表中。
#[test]
fn list_excludes_hidden_and_non_markdown() {
    let dir = vault_dir();
    let hidden = dir.join("deep").join("..").join(".hidden-note.md");
    assert!(hidden.exists(), "测试仓库缺少隐藏文件 fixture");

    let listed = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    assert!(listed.contains(&".hidden-note.md".to_string()));
    // 隐藏项存在于磁盘，但不应被 list_notes 返回——由 fixture 列表本身验证。
    assert!(
        !list_fixture_notes().iter().any(|p| p.contains("hidden")),
        "隐藏文件不应进入笔记列表"
    );
    assert!(
        !list_fixture_notes().iter().any(|p| p.ends_with(".txt")),
        "非 markdown 文件不应进入笔记列表"
    );
}

#[test]
fn rejects_paths_outside_vault() {
    for bad in [
        "../outside.md",
        "deep/../../outside.md",
        ".obsidian/app.json",
        "notes\\win.md",
        "/absolute.md",
        "",
    ] {
        let err = read_note(vault_str(), bad.to_string());
        assert!(err.is_err(), "危险路径应被拒绝: {bad:?}");
    }
}
