#!/usr/bin/env bash
# 生成用于验证「字节精确往返」的测试仓库。
#
# 覆盖的边界：LF / CRLF / CR / 混合换行 / 无尾随换行 / UTF-8 BOM / 中文 /
# GFM 表格与任务列表 / 围栏代码 / 原始 HTML / 嵌套目录 / 应被跳过的隐藏与非 md 文件。
set -euo pipefail

VAULT="${1:-test-vault}"

rm -rf "$VAULT"
mkdir -p "$VAULT/日记" "$VAULT/deep/nested/folder" "$VAULT/.obsidian" "$VAULT/attachments" "$VAULT/模板"

# 1. LF + 中文 + 尾随换行
printf '# 2026-09-14 日记\n\n今天把 Quick Note 的骨架搭起来了。\n\n- 打开仓库\n- 编辑\n- 保存\n' \
  > "$VAULT/日记/2026-09-14.md"

# 2. CRLF（模拟 Windows 上被其他工具写过的文件）
printf '# 2026-W37 周记\r\n\r\n本周总结：\r\n\r\n- 完成了 M0\r\n- 下一周做 M1\r\n' \
  > "$VAULT/日记/2026-W37 周记.md"

# 3. 无尾随换行
printf '# 无尾随换行\n\n这一行后面没有换行符。' \
  > "$VAULT/no-trailing-newline.md"

# 4. UTF-8 BOM
printf '\xEF\xBB\xBF# 带 BOM 的文件\n\nBOM 必须在写回时保留。\n' \
  > "$VAULT/with-bom.md"

# 5. 混合换行（CRLF 与 LF 混用）
printf '# 混合换行\r\n\n第二行用 LF\r\n第三行用 CRLF\n' \
  > "$VAULT/mixed-endings.md"

# 6. 仅 CR（老式 Mac 换行）
printf '# 仅 CR 换行\r第二行\r' \
  > "$VAULT/cr-only.md"

# 7. 空文件
: > "$VAULT/empty.md"

# 8. GFM 表格、任务列表、围栏代码、行内代码、原始 HTML、Mermaid
cat > "$VAULT/features.md" <<'EOF'
# 语法覆盖

行内 `code` 与**粗体**、*斜体*、~~删除线~~。

## 列表与分割线

- [ ] 未完成任务
- [x] 已完成任务
- 普通项目一
- 普通项目二

---

| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| **粗体** | `code` | [链接](https://example.com) |
| ~~删除~~ | 普通 | 1 |

```ts
const answer: number = 42;
```

```mermaid
graph TD
  A[开始] --> B[结束]
```

### 无效图表（验证渲染失败不会破坏编辑器）

```mermaid
invalid diagram definition
```

<div class="raw-html">
手写 HTML 会被清洗后渲染；文件里的原文不受影响。
</div>

链接：[示例](https://example.com)
图片：![图](attachments/pic.png)
远程图：![远程图](https://example.com/remote.png)
缺图：![缺图](attachments/missing.png)

### wiki 语法（Obsidian 默认写法）

Wiki 嵌入：![[pic.png]]

带宽度：![[pic.png|80]]

带说明：![[pic.png|示意图]]

Wiki 链接：[[某笔记]] 与 [[某笔记|别名]]

笔记嵌入（整篇）：![[嵌入目标]]

笔记嵌入（小节）：![[嵌入目标#小节甲]]

笔记嵌入（块）：![[嵌入目标#^blockid]]

嵌入不存在的笔记：![[并不存在的笔记]]

行内代码里不算语法：`![[pic.png]]` 与 `` `[[x]]` ``

### 额外语法

行内公式：$E = mc^2$ 与 $a^2 + b^2 = c^2$，价格 $100 不该被当成公式。

高亮：==这是高亮== 与普通文字。

注释：%%这是注释应当隐藏%% 后面的文字仍然可见。

行内 HTML：<font color="#c00">红色文字</font> 与 <mark>标记文字</mark>，换行<br/>之后继续。

块级 HTML：

<div class="raw-html">
块级 HTML 会被清洗后渲染。
</div>

含脚本的 HTML（脚本必须被清洗掉）：

<div id="danger">安全内容<script>window.__pwned = true;</script></div>

### 链接、标题与 callout

裸链接：访问 https://example.com/bare 查看详情，另一个是 http://example.com/plain 。

引用式链接：[示例文字][ref] 与普通链接 [外链](https://example.com/normal) 。

Setext 一级标题
===============

Setext 二级标题
---------------

> [!note] 提示标题
> 这是 callout 正文，含 **粗体**。
> 第二行。

> [!warning]
> 没写标题时用默认标题。

### 标签

正文里的 #标签、#嵌套/标签 与 #a1 都算标签，而 # 开头加空格的标题不算。

> 引用块
EOF

# 9. 嵌套目录
printf '# 深层笔记\n\n嵌套目录里的文件。\n' > "$VAULT/deep/nested/folder/note.md"

# 10. 应被跳过的：隐藏目录、隐藏文件、非 md
printf '{"app":true}\n' > "$VAULT/.obsidian/app.json"
printf '# 隐藏文件\n' > "$VAULT/.hidden-note.md"
printf 'not markdown\n' > "$VAULT/notes.txt"

# 11. 一张真实图片，用于验证 asset 协议真能加载库内文件（借脚手架自带的图标）
ICON="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/icons/32x32.png"
if [ -f "$ICON" ]; then
  cp "$ICON" "$VAULT/attachments/pic.png"
else
  echo "警告：找不到 $ICON，attachments/pic.png 未生成（图片加载测试会退化）" >&2
fi

# 12. 内容嵌入（transclusion）的目标笔记
cat > "$VAULT/嵌入目标.md" <<'EOF'
# 嵌入目标

这是被嵌入笔记的开头段落，应当出现在嵌入结果里。

## 小节甲

小节甲的内容，内含一张 wiki 图片：![[pic.png|120]]

## 小节乙

小节乙的内容，不应出现在「只嵌入小节甲」的结果里。

### 小节乙的子节

子节内容：更深的标题不应截断小节。

| 表头 | 值 |
| --- | --- |
| 甲 | 1 |

> 被嵌入的引用块

行内 `code` 与 **粗体**，还有 [外部链接](https://example.com)。

这是一个可以按块引用的段落。 ^blockid

结尾段落。
EOF

# 13. 日记与日历（M2）
#
# 「今天」与「昨天」由**系统自己的 date 命令**算出，不由脚本复刻 dateFormat 的格式化
# 逻辑——项目里已经吃过一次苦头（测试脚本复刻换行符探测，把 CRLF 误判成 LF 还全绿）。
# 这里用到的只是 YYYY-MM-DD，与 fixture 配置里的 dateFormat 一致。
TODAY="$(date +%Y-%m-%d)"
YESTERDAY="$(date -d yesterday +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d)"

# 今天有日记（带名字，验证「日期 + 名字」的发现规则与今日字数）
printf '# %s 验证\n\n今天这篇是给日历与字数统计用的。\n' "$TODAY" \
  > "$VAULT/日记/$TODAY 验证.md"
# 昨天也有一篇。**必须带名字**：不带名字就是 `$YESTERDAY.md`，而它正好会等于上面
# 第 1 条固定的 fixture（今天恰好是 2026-09-15 时），把那篇的内容覆盖掉——
# 换行符与文件管理的测试全都依赖那篇。
printf '# %s 昨天\n\n昨天的日记。\n' "$YESTERDAY" > "$VAULT/日记/$YESTERDAY 昨天.md"

# 模板：把全部占位符都写上，包括一个**故意写错**的未知占位符
# （未知占位符必须原样留在文件里，才能被用户看见）
cat > "$VAULT/模板/日记模板.md" <<'EOF'
# {{title}}

日期：{{date}}
另一种写法：{{date:YYYY年M月D日}}
时间：{{time}}
未知占位符：{{未知}}
EOF
cat > "$VAULT/模板/周记模板.md" <<'EOF'
# {{title}}

周标识：{{week}}
本周周一：{{date}}
EOF

# 库内配置：与 Obsidian 插件共用同一份。刻意塞进一批 Quick Note **不认识**的键
# （emailAccessKey、天气、提醒开关……），用来验证"补丁式写回"真的没有把它们抹掉。
cat > "$VAULT/quick-daily-note.json" <<EOF
{
  "folder": "日记",
  "dateFormat": "YYYY-MM-DD",
  "todos": {
    "$YESTERDAY": [
      {
        "id": "fixture-yesterday-pending",
        "text": "昨天没做完的事",
        "done": false,
        "updatedAt": 1757800000000
      },
      {
        "id": "fixture-yesterday-done",
        "text": "昨天做完的事",
        "done": true,
        "updatedAt": 1757800000001
      }
    ]
  },
  "todosUpdatedAt": 1757800000001,
  "todoReminderEnabled": true,
  "todoReminderTime": "08:00",
  "emailNotifyEnabled": true,
  "emailAccessKey": "plugin-only-key-do-not-drop",
  "weatherEnabled": true,
  "weatherCity": "北京",
  "dailyTemplateEnabled": true,
  "dailyTemplatePath": "模板/日记模板.md",
  "weeklyTemplateEnabled": true,
  "weeklyTemplatePath": "模板/周记模板.md"
}
EOF

echo "测试仓库已生成：$VAULT"
find "$VAULT" -type f | sed "s|^$VAULT/||" | sort