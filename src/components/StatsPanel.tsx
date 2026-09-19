/**
 * 知识统计面板：仓库概览卡片、写作活动热力图、最近编辑。
 *
 * 数据全部来自**已经在内存里**的两份状态——`entries`（文件树刷新时更新，含
 * 大小与修改时间）与 `useDaily` 的 dateSet/todos（日记打点与待办）——所以这个
 * 面板是零 IO 的：不做全库字数统计那类需要逐文件读盘的事，等真的需要时再由
 * Rust 侧出一条扫描命令。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import moment from "moment";
import { baseNameOf, monthDiaryCount, streakDays } from "../lib/daily";
import type { EntryMeta } from "../lib/api";
import type { DailyController } from "../lib/useDaily";

interface Props {
  entries: EntryMeta[];
  daily: DailyController;
  onOpen: (path: string) => void;
}

const HEATMAP_WEEKS = 17;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 数字增长动画：从 0 缓动到目标值（ease-out cubic），用于统计卡片。
 *
 * 目标值变化时**从上一次显示的值继续**缓动，而不是重播 0 → 目标：
 * 「今日字数」在打字时每敲一字都会变，重播会让卡片数字反复掉回小值，
 * 看起来就像"没在更新"。 */
function useCountUp(target: number, duration = 650): number {
  const [value, setValue] = useState(0);
  const shownRef = useRef(0);
  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = Math.round(from + (target - from) * eased);
      shownRef.current = next;
      setValue(next);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/** 按时段问候。 */
function greetingFor(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

interface HeatCell {
  key: string;
  date: moment.Moment;
  active: boolean;
  future: boolean;
}

/** 最近 N 周的打点网格（列=周，行=周一..周日），来自日记目录的文件名日期。 */
function buildHeatmap(dateSet: Set<string>, dateFormat: string): HeatCell[] {
  const today = moment();
  // 末列对齐到本周（isoWeek 周一开头，与月历一致），起点往前推 N-1 周
  const lastMonday = today.clone().startOf("isoWeek");
  const cells: HeatCell[] = [];
  for (let week = HEATMAP_WEEKS - 1; week >= 0; week -= 1) {
    for (let day = 0; day < 7; day += 1) {
      const date = lastMonday.clone().subtract(week, "weeks").add(day, "days");
      const key = date.format(dateFormat);
      cells.push({
        key: `${week}-${day}`,
        date,
        active: dateSet.has(key),
        future: date.isAfter(today, "day"),
      });
    }
  }
  return cells;
}

interface StatCardSpec {
  label: string;
  /** 参与增长动画的数值（0 = 不动画，直接显示 display）。 */
  value: number;
  display: string;
  hint: string;
  icon: string;
}

/** 统计卡片：数值走 count-up 动画，非数字（如库容量）直接显示。 */
function StatCard({ card }: { card: StatCardSpec }) {
  const animated = useCountUp(card.value);
  const display = card.value > 0 ? String(animated) : card.display;
  return (
    <div className="stats-card">
      <span className="stats-card-icon">{card.icon}</span>
      <span className="stats-card-value">
        {display}
        {card.hint && <small>{card.hint}</small>}
      </span>
      <span className="stats-card-label">{card.label}</span>
    </div>
  );
}

export default function StatsPanel({ entries, daily, onOpen }: Props) {
  const mdEntries = useMemo(
    () => entries.filter((entry) => !entry.isDir && entry.name.toLowerCase().endsWith(".md")),
    [entries],
  );

  const totalBytes = useMemo(
    () => mdEntries.reduce((sum, entry) => sum + entry.size, 0),
    [mdEntries],
  );

  const streak = useMemo(
    () => streakDays(daily.dateSet, daily.dateFormat, moment()),
    [daily.dateSet, daily.dateFormat],
  );

  const monthCount = useMemo(
    () => monthDiaryCount(daily.dateSet, daily.dateFormat, moment().startOf("month")),
    [daily.dateSet, daily.dateFormat],
  );

  /** 待办完成率：跨全部日期汇总（墓碑不参与）。 */
  const todoStats = useMemo(() => {
    let done = 0;
    let pending = 0;
    for (const items of Object.values(daily.todos)) {
      for (const item of items) {
        if (item.deleted) continue;
        if (item.done) done += 1;
        else pending += 1;
      }
    }
    const total = done + pending;
    return { done, pending, total, rate: total === 0 ? 0 : Math.round((done / total) * 100) };
  }, [daily.todos]);

  const heat = useMemo(
    () => buildHeatmap(daily.dateSet, daily.dateFormat),
    [daily.dateSet, daily.dateFormat],
  );

  const activeDays = useMemo(() => heat.filter((cell) => cell.active).length, [heat]);

  const recent = useMemo(
    () => [...mdEntries].sort((a, b) => b.modified - a.modified).slice(0, 6),
    [mdEntries],
  );

  const cards = [
    { label: "笔记", value: mdEntries.length, display: String(mdEntries.length), hint: "篇", icon: "🗂" },
    { label: "知识库", value: 0, display: formatBytes(totalBytes), hint: "", icon: "💾" },
    {
      label: "今日字数",
      value: daily.todayWords ?? 0,
      display: daily.todayWords === null ? "—" : String(daily.todayWords),
      hint: "字",
      icon: "✍️",
    },
    { label: "连续记录", value: streak, display: String(streak), hint: "天", icon: "🔥" },
  ];

  return (
    <div className="stats">
      <div className="stats-greeting">
        <span className="stats-greeting-title">
          {greetingFor(moment().hour())}，{moment().format("M 月 D 日 dddd")}
        </span>
        <span className="stats-greeting-sub">
          {daily.todayWords === null
            ? "今天还没写日记，从一段话开始吧"
            : `今天已写 ${daily.todayWords} 字 · 连续记录 ${streak} 天`}
        </span>
      </div>

      <div className="stats-grid">
        {cards.map((card) => (
          <StatCard key={card.label} card={card} />
        ))}
      </div>

      <div className="stats-section">
        <div className="stats-section-head">
          <span className="stats-section-title">写作活动</span>
          <span className="stats-section-meta">{activeDays} 天 / 近 {HEATMAP_WEEKS} 周</span>
        </div>
        <div className="heatmap" role="img" aria-label={`近 ${HEATMAP_WEEKS} 周写了 ${activeDays} 天日记`}>
          {heat.map((cell) => (
            <span
              key={cell.key}
              className={[
                "heat-cell",
                cell.active ? "is-active" : "",
                cell.future ? "is-future" : "",
                cell.date.isSame(daily.today, "day") ? "is-today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={`${cell.date.format("YYYY-MM-DD")}${cell.active ? " · 有日记" : ""}`}
            />
          ))}
        </div>
        <div className="heatmap-legend">
          <span>近 {HEATMAP_WEEKS} 周</span>
          <span className="spacer" />
          <span>本月日记 {monthCount} 天</span>
        </div>
      </div>

      <div className="stats-section">
        <div className="stats-section-head">
          <span className="stats-section-title">任务完成</span>
          <span className="stats-section-meta">
            {todoStats.total === 0 ? "暂无待办" : `${todoStats.rate}%`}
          </span>
        </div>
        <div className="stats-bar">
          <div className="stats-bar-fill" style={{ width: `${todoStats.rate}%` }} />
        </div>
        <div className="heatmap-legend">
          <span>已完成 {todoStats.done}</span>
          <span className="spacer" />
          <span>未完成 {todoStats.pending}</span>
        </div>
      </div>

      <div className="stats-section">
        <div className="stats-section-head">
          <span className="stats-section-title">最近编辑</span>
        </div>
        {recent.length === 0 && <div className="stats-empty">仓库里还没有笔记</div>}
        {recent.map((entry) => (
          <button
            type="button"
            className="stats-recent"
            key={entry.path}
            title={entry.path}
            onClick={() => onOpen(entry.path)}
          >
            <span className="stats-recent-name">{baseNameOf(entry.path)}</span>
            <span className="stats-recent-time">{moment(entry.modified).format("MM-DD HH:mm")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
