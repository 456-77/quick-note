import { useMemo, useState } from "react";
import moment from "moment";
import {
  hasCarriedOver,
  orderedTodos,
  pendingCount,
} from "../lib/todos";
import {
  baseNameOf,
  monthDiaryCount,
  monthGrid,
  monthTitle,
  streakDays,
  validateDailyName,
} from "../lib/daily";
import type { DailyController } from "../lib/useDaily";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

interface Props {
  controller: DailyController;
  /** 打开一篇已有的笔记。 */
  onOpen: (path: string) => void;
  /** 新建当天日记；名字由用户在这个面板里输入。 */
  onCreateDaily: (dateStr: string, name: string) => void;
  /** 打开或创建某周的周记（`mondayKey` 供模板里的 \{\{date\}\} 使用）。 */
  onOpenWeekly: (weekKey: string, mondayKey: string) => void;
  /**
   * 打开条目的右键菜单（重命名 / 删除）。
   *
   * 与文件树共用 App 里的同一份菜单——面板里再实现一套重命名/删除的弹窗，
   * 就等于把 M1 已经验证过的改名会同步 wiki 引用、删除进 .trash 这些行为复制一遍。
   */
  onContext: (path: string, isDir: boolean, x: number, y: number) => void;
}

/**
 * 日历面板：月历（含 W 周记列）、日记统计、当天日记、当天待办。
 *
 * 交互刻意与 Obsidian 插件对齐，因为两边会换着用：
 * **单击日期只切换选中**（当天日记、待办与统计跟着换），**双击才打开/创建日记**。
 * 单击就打开的话，想看另一天的待办就必须先跳走一篇笔记。
 */
export default function CalendarPanel({
  controller,
  onOpen,
  onCreateDaily,
  onOpenWeekly,
  onContext,
}: Props) {
  const { settings, dateFormat, today, selectedDate, setSelectedDate, dateSet, weeklySet } =
    controller;
  const [viewMonth, setViewMonth] = useState(() => moment().startOf("month"));
  /** 正在等待输入名字的日期；null 表示输入行未展开。 */
  const [namingDate, setNamingDate] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** 名字不合法的原因；输入行保持展开，方便直接改。 */
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [todoDraft, setTodoDraft] = useState("");
  /** 正在修改文字的待办 id；null 表示没有行处于编辑态。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const rows = useMemo(() => monthGrid(viewMonth, dateFormat, today), [viewMonth, dateFormat, today]);
  const monthCount = useMemo(
    () => monthDiaryCount(dateSet, dateFormat, viewMonth),
    [dateSet, dateFormat, viewMonth],
  );
  const streak = useMemo(() => streakDays(dateSet, dateFormat, moment()), [dateSet, dateFormat]);

  /** 选中日期已有的日记（同一天可以有多篇）。 */
  const dayNotes = useMemo(
    () => controller.dailyNotesOn(selectedDate),
    [controller, selectedDate],
  );

  const todos = orderedTodos(controller.todos[selectedDate]);
  const pending = pendingCount(controller.todos[selectedDate]);

  /**
   * 顺延提示只在"选中今天"时出现，且今天尚未顺延过。
   *
   * 昨天有未完成待办时提醒一次；顺延后今天就有了「遗留」条目，提示自动消失，
   * 不会反复催促。
   */
  const yesterday = moment().subtract(1, "day").format(dateFormat);
  const yesterdayPending = pendingCount(controller.todos[yesterday]);
  const showCarryOver =
    selectedDate === today && yesterdayPending > 0 && !hasCarriedOver(controller.todos[today]);

  /** 展开命名输入行（「＋ 新建」与双击空日期都走这里）。 */
  const beginNaming = (dateStr: string) => {
    setNamingDate(dateStr);
    setNameDraft("");
    setNameProblem(null);
  };

  const openDay = (dateStr: string) => {
    const existing = controller.dailyNoteOn(dateStr);
    if (existing) {
      onOpen(existing);
      return;
    }
    beginNaming(dateStr);
  };

  const submitName = () => {
    if (!namingDate) return;
    const name = nameDraft.trim();
    const problem = validateDailyName(name);
    if (problem) {
      // 名字非法时**不**关闭输入行：用户可以直接改，不用重新双击日期
      setNameProblem(problem);
      return;
    }
    onCreateDaily(namingDate, name);
    setNamingDate(null);
    setNameDraft("");
    setNameProblem(null);
  };

  const submitTodo = () => {
    const text = todoDraft.trim();
    if (!text) return;
    controller.addTodo(selectedDate, text);
    setTodoDraft("");
  };

  const beginEditTodo = (id: string, text: string) => {
    setEditingId(id);
    setEditDraft(text);
  };

  const submitEditTodo = () => {
    if (!editingId) return;
    const row = todos.find(({ item }) => item.id === editingId);
    const text = editDraft.trim();
    // 空文字不当作"清空"，保持原样退出编辑——要删用删除按钮
    if (row && text && text !== row.item.text) {
      controller.updateTodoText(selectedDate, row.index, text);
    }
    setEditingId(null);
    setEditDraft("");
  };

  const copyTodo = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用（权限等）就静默失败：复制是便利功能，不该为此弹错误横幅
    }
  };

  return (
    <div className="calendar">
      <div className="cal-head">
        <button
          type="button"
          className="mini-btn cal-nav"
          onClick={() => setViewMonth((value) => value.clone().subtract(1, "month"))}
          title="上个月"
          aria-label="上个月"
        >
          ‹
        </button>
        <span className="cal-title">{monthTitle(viewMonth)}</span>
        <button
          type="button"
          className="mini-btn cal-nav"
          onClick={() => setViewMonth((value) => value.clone().add(1, "month"))}
          title="下个月"
          aria-label="下个月"
        >
          ›
        </button>
        <button
          type="button"
          className="mini-btn cal-today-btn"
          onClick={() => {
            // 既要跳回本月，也要把选中日切到今天：只跳月的话，当天日记、待办、
            // 统计还停在别的日期上，看起来像"按钮没起作用"
            setViewMonth(moment().startOf("month"));
            setSelectedDate(today);
          }}
          title="回到今天并选中"
        >
          今天
        </button>
      </div>

      <div className="cal-grid">
        <div className="cal-cell cal-weekday cal-week-col">W</div>
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="cal-cell cal-weekday">
            {label}
          </div>
        ))}

        {/* 刻意不按行包一层容器：整个月历就是一张 8 列的网格（W 列 + 7 天），
            包一层会让每行退化成一个格子。周与日之间的关系由 weekKey 表达。 */}
        {rows.flatMap((row) => [
          <button
            type="button"
            key={`w-${row.weekKey}`}
            className="cal-cell cal-week-cell"
            data-week={row.weekKey}
            data-monday={row.mondayKey}
            title={`${row.weekKey} 周记（双击打开或创建）`}
            onDoubleClick={() => onOpenWeekly(row.weekKey, row.mondayKey)}
          >
            <span className="cal-week-label">{row.weekLabel}</span>
            {weeklySet.has(row.weekKey) && <span className="cal-dot" />}
          </button>,
          ...row.days.map((day) => (
            <button
              type="button"
              key={day.key}
              className={[
                "cal-cell",
                "cal-day",
                day.inMonth ? "" : "is-outside",
                day.isToday ? "is-today" : "",
                day.key === selectedDate ? "is-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-date={day.key}
              title={day.key}
              onClick={() => setSelectedDate(day.key)}
              onDoubleClick={() => openDay(day.key)}
            >
              <span className="cal-day-num">{day.date.date().toString()}</span>
              {dateSet.has(day.key) && <span className="cal-dot" />}
            </button>
          )),
        ])}
      </div>

      <div className="cal-stats">
        <span className="cal-stat">本月 {monthCount} 天</span>
        <span className="cal-stat">连续 {streak} 天</span>
        <span className="cal-stat">
          {controller.todayWords === null ? "今日未写" : `今日 ${controller.todayWords} 字`}
        </span>
      </div>

      {/* 当天日记：选中日期已创建的日记，点名字打开，行尾 ⋯ 与右键是同一份菜单。
          同一天可以有多篇（插件就是靠这块列出来的），所以「＋ 新建」始终可用。 */}
      <div className="cal-daynotes">
        <div className="cal-daynotes-head">
          <span className="cal-daynotes-title">当天日记（{dayNotes.length}）</span>
          <button
            type="button"
            className="mini-btn cal-daynotes-add"
            onClick={() => beginNaming(selectedDate)}
            title={`在 ${selectedDate} 再建一篇日记`}
          >
            ＋ 新建
          </button>
        </div>
        {dayNotes.length === 0 && <div className="cal-daynotes-empty">当天还没有日记</div>}
        {dayNotes.map((path) => (
          <div
            className="cal-daynote"
            key={path}
            title={path}
            onClick={() => onOpen(path)}
            onContextMenu={(event) => {
              event.preventDefault();
              onContext(path, false, event.clientX, event.clientY);
            }}
          >
            <span className="cal-daynote-name">{baseNameOf(path)}</span>
            <button
              type="button"
              className="cal-more"
              aria-label="更多操作"
              title="重命名 / 删除"
              onClick={(event) => {
                // 与右键同一份菜单；用按钮自身的右下角定位，菜单才会贴着它出现
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                onContext(path, false, rect.right, rect.bottom);
              }}
            >
              ⋯
            </button>
          </div>
        ))}
      </div>

      {namingDate && (
        <div className="create-row cal-create-row">
          <input
            autoFocus
            type="text"
            value={nameDraft}
            placeholder={`${namingDate} 的名字，例如：项目周报`}
            onChange={(event) => {
              setNameDraft(event.target.value);
              setNameProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitName();
              if (event.key === "Escape") setNamingDate(null);
            }}
          />
          <div className="create-hint">
            {nameProblem ? (
              <span className="cal-create-problem">{nameProblem}</span>
            ) : (
              <>
                落点 {settings.folder || "仓库根目录"} · 文件名 = 日期 + 空格 + 名字 ·
                Enter 确认 / Esc 取消
              </>
            )}
          </div>
        </div>
      )}

      <div className="cal-section-head">
        <span className="cal-section-title">待办 · {selectedDate || "—"}</span>
        <span className="cal-pending">{pending} 项未完成</span>
      </div>

      {showCarryOver && (
        <div className="cal-carryover">
          <span>昨天有 {yesterdayPending} 项待办未完成</span>
          <span className="spacer" />
          <button
            type="button"
            className="mini-btn cal-carryover-btn"
            onClick={() => controller.moveTodo(yesterday, today)}
            title={`把 ${yesterday} 未完成的待办顺延到 ${today}（带「遗留」前缀）`}
          >
            顺延到今天
          </button>
        </div>
      )}

      <div className="cal-todos">
        {todos.length === 0 && <div className="cal-empty">暂无待办，添加一条吧</div>}
        {todos.map(({ item, index }) => (
          <div className="cal-todo" key={item.id} data-todo-index={index}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => controller.toggleTodo(selectedDate, index)}
              title={item.done ? "标记为未完成" : "标记为已完成"}
            />
            {editingId === item.id ? (
              <input
                autoFocus
                type="text"
                className="cal-todo-edit"
                value={editDraft}
                onChange={(event) => setEditDraft(event.target.value)}
                onBlur={submitEditTodo}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitEditTodo();
                  if (event.key === "Escape") {
                    setEditingId(null);
                    setEditDraft("");
                  }
                }}
                title="回车保存，Esc 取消"
              />
            ) : (
              <>
                <span
                  className={`cal-todo-text${item.done ? " is-done" : ""}`}
                  onDoubleClick={() => beginEditTodo(item.id, item.text)}
                  title="双击修改文字"
                >
                  {item.text}
                </span>
                <button
                  type="button"
                  className="cal-todo-act"
                  onClick={() => void copyTodo(item.text)}
                  title="复制文字"
                  aria-label="复制这条待办"
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="cal-todo-act"
                  onClick={() => beginEditTodo(item.id, item.text)}
                  title="修改文字"
                  aria-label="修改这条待办"
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="cal-todo-del"
                  onClick={() => controller.deleteTodo(selectedDate, index)}
                  title="删除这条待办"
                  aria-label="删除这条待办"
                >
                  ✕
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="cal-todo-add">
        <input
          type="text"
          value={todoDraft}
          placeholder="添加待办，回车确认"
          onChange={(event) => setTodoDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitTodo();
          }}
        />
        <button type="button" className="mini-btn" onClick={submitTodo} disabled={!todoDraft.trim()}>
          添加
        </button>
      </div>
    </div>
  );
}
