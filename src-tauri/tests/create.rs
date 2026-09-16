//! 新建 / 重命名 / 删除，以及库内配置文件可选读取的行为测试。
//!
//! 刻意用**独立的临时仓库**，不去碰 `test-vault/`——否则会往 fixture 里塞文件，
//! 让字节精确基线的比对失败（那条基线同时也在守护测试流程本身）。

use quick_note_lib::vault::{
    create_folder, create_note, delete_entry, list_entries, read_note_optional, rename_entry,
};
use std::fs;
use std::path::PathBuf;

/// 每个测试用独占的临时仓库（带 pid，避免并行执行时互相干扰）。
fn temp_vault(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("quicknote-create-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("创建临时仓库失败");
    dir
}

fn vault_str(dir: &PathBuf) -> String {
    dir.to_string_lossy().to_string()
}

#[test]
fn creates_empty_note_and_appends_extension() {
    let vault = temp_vault("basic");
    let relative = create_note(vault_str(&vault), String::new(), "会议记录".into()).unwrap();
    assert_eq!(relative, "会议记录.md");
    let path = vault.join(&relative);
    assert!(path.is_file(), "笔记文件应当被创建");
    assert_eq!(fs::metadata(&path).unwrap().len(), 0, "新笔记应当是空文件");

    // 已带扩展名时不重复追加
    let with_ext = create_note(vault_str(&vault), String::new(), "带扩展名.md".into()).unwrap();
    assert_eq!(with_ext, "带扩展名.md");
    assert!(!vault.join("带扩展名.md.md").exists());

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn duplicate_name_gets_numbered_and_never_overwrites() {
    let vault = temp_vault("duplicate");
    let first = create_note(vault_str(&vault), String::new(), "记录".into()).unwrap();
    fs::write(vault.join(&first), "原有内容").unwrap();

    let second = create_note(vault_str(&vault), String::new(), "记录".into()).unwrap();
    assert_eq!(second, "记录 1.md");
    let third = create_note(vault_str(&vault), String::new(), "记录".into()).unwrap();
    assert_eq!(third, "记录 2.md");

    assert_eq!(
        fs::read_to_string(vault.join(&first)).unwrap(),
        "原有内容",
        "已有笔记的内容绝不能被覆盖"
    );

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn creates_note_in_subfolder_creating_directories() {
    let vault = temp_vault("subfolder");
    let relative = create_note(vault_str(&vault), String::new(), "项目/周报".into()).unwrap();
    assert_eq!(relative, "项目/周报.md");
    assert!(vault.join("项目").is_dir(), "中间目录应当被自动创建");

    // 也可以显式指定上级目录
    let in_folder = create_note(vault_str(&vault), "项目".into(), "月报".into()).unwrap();
    assert_eq!(in_folder, "项目/月报.md");

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn rejects_dangerous_or_invalid_names() {
    let vault = temp_vault("invalid");
    let cases = [
        ("", "空名称"),
        ("   ", "全空格"),
        (".隐藏", "隐藏文件名"),
        (".git/配置", "隐藏目录"),
        ("../越界", "越界"),
        ("项目/../../越界", "带 .. 的越界"),
        ("a:b", "含冒号"),
        ("a?b", "含问号"),
        ("项目//名称", "空路径段"),
    ];
    for (name, label) in cases {
        let result = create_note(vault_str(&vault), String::new(), name.into());
        assert!(result.is_err(), "{label} 应当被拒绝: {name:?}");
    }

    // 越界尝试不应在仓库外留下任何东西
    assert!(!vault.parent().unwrap().join("越界.md").exists());

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn listing_includes_empty_folders_and_non_markdown_files() {
    let vault = temp_vault("listing");
    fs::create_dir_all(vault.join("空目录")).unwrap();
    fs::create_dir_all(vault.join("有内容").join("更深")).unwrap();
    fs::write(vault.join("有内容").join("笔记.md"), "# 笔记").unwrap();
    fs::write(vault.join("附件.png"), b"not really a png").unwrap();
    fs::create_dir_all(vault.join(".obsidian")).unwrap();
    fs::write(vault.join(".hidden.md"), "# 隐藏").unwrap();

    let entries = list_entries(vault_str(&vault)).unwrap();
    let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();

    // 这是本次修复的核心：空目录必须出现在列表里，否则界面上完全看不到它
    assert!(paths.contains(&"空目录"), "空目录必须被列出: {paths:?}");
    assert!(
        entries.iter().any(|entry| entry.path == "空目录" && entry.is_dir),
        "空目录条目的 is_dir 必须为 true"
    );
    assert!(paths.contains(&"有内容"), "有内容的目录要列出");
    assert!(paths.contains(&"有内容/更深"), "嵌套的空目录也要列出");
    assert!(paths.contains(&"有内容/笔记.md"), "笔记要列出");
    assert!(
        entries
            .iter()
            .any(|entry| entry.path == "附件.png" && !entry.is_dir),
        "非 md 文件也要列出（界面上以弱化样式显示）"
    );

    // 隐藏项仍然排除
    assert!(!paths.iter().any(|path| path.starts_with('.')), "隐藏路径不应出现: {paths:?}");

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn creates_folder_and_numbers_duplicates() {
    let vault = temp_vault("folder");
    let first = create_folder(vault_str(&vault), String::new(), "素材".into()).unwrap();
    assert_eq!(first, "素材");
    assert!(vault.join("素材").is_dir());

    let second = create_folder(vault_str(&vault), String::new(), "素材".into()).unwrap();
    assert_eq!(second, "素材 1");

    let nested = create_folder(vault_str(&vault), "素材".into(), "图片".into()).unwrap();
    assert_eq!(nested, "素材/图片");
    assert!(vault.join("素材").join("图片").is_dir());

    assert!(
        create_folder(vault_str(&vault), String::new(), "日记.md".into()).is_err(),
        "文件夹名不该以 .md 结尾"
    );

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn renames_note_and_updates_wiki_references() {
    let vault = temp_vault("rename");
    fs::write(vault.join("旧名.md"), "# 旧名").unwrap();
    fs::write(
        vault.join("引用者.md"),
        "链接 [[旧名]] 与 [[旧名|别名]]，嵌入 ![[旧名#小节]]，还有一个 [[别的]]。\n",
    )
    .unwrap();
    fs::write(vault.join("无关.md"), "这里提到旧名但不是链接。\n").unwrap();

    let result = rename_entry(vault_str(&vault), "旧名.md".into(), "新名".into()).unwrap();
    assert_eq!(result.path, "新名.md", "缺 .md 自动补");
    assert!(vault.join("新名.md").is_file(), "文件已改名");
    assert!(!vault.join("旧名.md").exists(), "旧文件不存在了");
    assert_eq!(fs::read_to_string(vault.join("新名.md")).unwrap(), "# 旧名", "内容不变");

    assert_eq!(result.updated, vec!["引用者.md"], "只改动真正含引用的笔记");
    let updated = fs::read_to_string(vault.join("引用者.md")).unwrap();
    assert!(updated.contains("[[新名]]"), "裸引用被更新: {updated}");
    assert!(updated.contains("[[新名|别名]]"), "带别名的引用被更新");
    assert!(updated.contains("![[新名#小节]]"), "带小节的嵌入被更新");
    assert!(updated.contains("[[别的]]"), "无关引用保持原样");
    assert_eq!(
        fs::read_to_string(vault.join("无关.md")).unwrap(),
        "这里提到旧名但不是链接。\n",
        "只是在正文里提到名字的笔记不应被改动"
    );

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn rename_refuses_existing_name_and_path_changes() {
    let vault = temp_vault("rename-conflict");
    fs::write(vault.join("甲.md"), "甲").unwrap();
    fs::write(vault.join("乙.md"), "乙").unwrap();

    assert!(
        rename_entry(vault_str(&vault), "甲.md".into(), "乙".into()).is_err(),
        "目标已存在时应当报错，而不是覆盖或加序号"
    );
    assert_eq!(fs::read_to_string(vault.join("乙.md")).unwrap(), "乙", "已有文件未被覆盖");

    assert!(
        rename_entry(vault_str(&vault), "甲.md".into(), "子目录/甲".into()).is_err(),
        "重命名不支持改变位置"
    );
    assert!(vault.join("甲.md").exists(), "报错后原文件仍在");

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn rename_directory_keeps_contents() {
    let vault = temp_vault("rename-dir");
    fs::create_dir_all(vault.join("旧目录")).unwrap();
    fs::write(vault.join("旧目录").join("笔记.md"), "# 内容").unwrap();

    let result = rename_entry(vault_str(&vault), "旧目录".into(), "新目录".into()).unwrap();
    assert_eq!(result.path, "新目录");
    assert!(vault.join("新目录").join("笔记.md").is_file(), "目录内容随之移动");
    assert!(!vault.join("旧目录").exists());

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn delete_moves_to_trash_and_stays_recoverable() {
    let vault = temp_vault("delete");
    fs::write(vault.join("待删除.md"), "# 重要内容").unwrap();

    let trashed = delete_entry(vault_str(&vault), "待删除.md".into()).unwrap();
    assert_eq!(trashed, ".trash/待删除.md");
    assert!(!vault.join("待删除.md").exists(), "原位置不再有该文件");
    assert_eq!(
        fs::read_to_string(vault.join(".trash").join("待删除.md")).unwrap(),
        "# 重要内容",
        "内容进了回收目录，可以找回——删笔记绝不能是不可逆的"
    );

    // 回收目录属于隐藏路径，不应出现在列表里
    let entries = list_entries(vault_str(&vault)).unwrap();
    assert!(
        !entries.iter().any(|entry| entry.path.starts_with(".trash")),
        "回收目录不应出现在仓库列表中"
    );

    // 同名文件再次删除时不覆盖回收目录里已有的备份
    fs::write(vault.join("待删除.md"), "第二次").unwrap();
    let second = delete_entry(vault_str(&vault), "待删除.md".into()).unwrap();
    assert_eq!(second, ".trash/待删除 1.md");
    assert_eq!(
        fs::read_to_string(vault.join(".trash").join("待删除.md")).unwrap(),
        "# 重要内容",
        "第一次删除的备份未被覆盖"
    );

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn optional_read_distinguishes_missing_file_from_error() {
    let vault = temp_vault("optional-read");

    // 不存在 → None。库内配置（quick-daily-note.json）是可有可无的文件，
    // 「没配置」必须能和「读不出来」区分开。
    assert!(
        read_note_optional(vault_str(&vault), "quick-daily-note.json".into())
            .unwrap()
            .is_none()
    );

    fs::write(vault.join("quick-daily-note.json"), r#"{"folder":"日记"}"#).unwrap();
    let read = read_note_optional(vault_str(&vault), "quick-daily-note.json".into())
        .unwrap()
        .expect("文件存在时应当读到内容");
    assert_eq!(read.content, r#"{"folder":"日记"}"#);

    // 「可选」不意味着放松路径校验：隐藏路径与越界依然被拒绝
    assert!(read_note_optional(vault_str(&vault), ".obsidian/app.json".into()).is_err());
    assert!(read_note_optional(vault_str(&vault), "../outside.md".into()).is_err());

    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn delete_directory_moves_whole_tree_to_trash() {
    let vault = temp_vault("delete-dir");
    fs::create_dir_all(vault.join("待删目录").join("子目录")).unwrap();
    fs::write(vault.join("待删目录").join("子目录").join("a.md"), "a").unwrap();

    delete_entry(vault_str(&vault), "待删目录".into()).unwrap();
    assert!(!vault.join("待删目录").exists());
    assert!(
        vault.join(".trash").join("待删目录").join("子目录").join("a.md").is_file(),
        "整棵目录树都进了回收目录"
    );

    let _ = fs::remove_dir_all(&vault);
}
