/**
 * 周回顾：把某一周（ISO 周）的日记与待办汇总成 Markdown，插入当前笔记光标处。
 *
 * 自 quick-daily-note 插件的 insertWeeklyReview 移植，**输出格式逐行一致**——
 * 两边生成的回顾长一个样，用户从 Obsidian 换过来不会觉得格式变了。
 *
 * 纯函数拆分：这里只做「数据 → Markdown 文本」，读文件、读配置、找光标都是
 * 调用方（App）的事，这样 Node 里能直接断言格式与统计口径。
 */

import moment from "moment";
import type { Moment } from "moment";
import { liveItems, type TodoMap } from "./todos.ts";

/** 汇总里的一篇日记。 */
export interface ReviewDiary {
  /** 日期串（配置格式的 key，如 2026-09-15）。 */
  dateKey: string;
  /** 笔记标题（不含 .md）。 */
  title: string;
  /** 该篇字数（去空白后的长度，与统计同口径）。 */
  words: number;
}

export interface WeeklyReviewInput {
  /** 该周周一。 */
  start: Moment;
  /** 该周周日。 */
  end: Moment;
  /** 当前周用「本周回顾」标题，其余周用 `2026-W37 回顾`（与插件一致）。 */
  isCurrent: boolean;
  /** 本周日记（调用方已按范围筛好）。 */
  diaries: ReviewDiary[];
  /** 待办数据（全量；函数内部按日期范围挑）。 */
  todos: TodoMap;
  /** 待办分桶用的日期格式（即 dateFormat）。 */
  dateFormat: string;
  /** 周几的显示文案（ moment 的 dddd 随 locale 走，这里由调用方固定传中文）。 */
  weekdayLabel: (day: Moment) => string;
}

/** 「周几」的固定中文文案。moment 的 dddd 依赖 locale 设置，桌面端不一定装了 zh-cn。 */
export function weekdayZh(day: Moment): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][day.day()];
}

/**
 * 生成周回顾的 Markdown（不含结尾换行——插入时由补位换行与后文隔开）。
 *
 * 输出结构（与插件一致）：
 * `## 本周回顾（9月15日 ~ 9月21日）` → 日记汇总 → 待办完成 → 待办未完成。
 */
export function buildWeeklyReview(input: WeeklyReviewInput): string {
  const { start, end, isCurrent, diaries, todos, dateFormat, weekdayLabel } = input;
  const heading = isCurrent ? "本周回顾" : `${start.clone().format("GGGG-[W]WW")} 回顾`;
  const lines: string[] = [];
  lines.push(`## ${heading}（${start.clone().format("M月D日")} ~ ${end.clone().format("M月D日")}）`);
  lines.push("");

  const diaryWords = diaries.reduce((sum, d) => sum + d.words, 0);
  lines.push(`### 本周日记（${diaries.length} 天，共 ${diaryWords} 字）`);
  if (diaries.length > 0) {
    for (const diary of diaries) {
      const day = moment(diary.dateKey, dateFormat, true);
      const label = day.isValid()
        ? `${day.clone().format("MM-DD")} ${weekdayLabel(day)}`
        : diary.dateKey;
      lines.push(`- ${label}《${diary.title}》`);
    }
  } else {
    lines.push("- 本周没有写日记");
  }
  lines.push("");

  // 待办按日遍历，一天内保持录入顺序（与插件一致）。
  const doneLines: string[] = [];
  const pendingLines: string[] = [];
  for (let d = start.clone(); d.isBefore(end) || d.isSame(end, "day"); d.add(1, "day")) {
    const dateStr = d.clone().format(dateFormat);
    const dateLabel = `${d.clone().format("MM-DD")} ${weekdayLabel(d)}`;
    for (const item of liveItems(todos[dateStr])) {
      // 多行待办压平成单行，避免拆断 markdown 复选框行
      const flat = item.text.replace(/\s*\n+\s*/g, " / ");
      if (item.done) doneLines.push(`- [x] ${flat}（${dateLabel}）`);
      else pendingLines.push(`- [ ] ${flat}（${dateLabel}）`);
    }
  }
  lines.push(`### 待办完成（${doneLines.length} 项）`);
  lines.push(...(doneLines.length > 0 ? doneLines : ["- 本周没有完成待办"]));
  lines.push("");
  lines.push(`### 待办未完成（${pendingLines.length} 项）`);
  lines.push(...(pendingLines.length > 0 ? pendingLines : ["- 本周待办全部完成"]));

  return lines.join("\n");
}

export interface WeekChoice {
  /** ISO 周标识（2026-W37）。 */
  weekKey: string;
  /** 该周周一（选中后取它的 startOf("isoWeek") 也一样，这里预计算好方便显示）。 */
  monday: Moment;
  /** 展示文案：`2026-W37（09-14 ~ 09-20）`。 */
  label: string;
}

/**
 * 最近 N 周（含指定的那一周，通常传「今天」）的备选列表，新的在前。
 *
 * 与插件的选周弹窗同一口径：`{N} weeks` 从本周开始往前数。
 */
export function recentWeeks(anchor: Moment, count = 12): WeekChoice[] {
  const monday = anchor.clone().startOf("isoWeek");
  const choices: WeekChoice[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = monday.clone().subtract(i, "week");
    const end = start.clone().add(6, "day");
    choices.push({
      weekKey: start.clone().format("GGGG-[W]WW"),
      monday: start,
      label: `${start.clone().format("GGGG-[W]WW")}（${start.clone().format("MM-DD")} ~ ${end.clone().format("MM-DD")}）`,
    });
  }
  return choices;
}
