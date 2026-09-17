/**
 * 定时提醒：每天到点提醒「添加待办」，到点检查当日未完成待办。
 *
 * 触发判定自 quick-daily-note 插件移植（30 秒轮询 + 当天已触发标记）：
 * - 时间比较用 "HH:mm" 的字符串比较——零填充格式下字典序即时间序；
 * - 启用时如果当天时间点已过，当天不再补提醒（从次日生效）；
 * - 「检查待办」只在当日确有未完成项时提醒，一条都没有就不打扰。
 *
 * 纯函数只回答「此刻该不该提醒」；定时器、系统通知、界面提示在 useReminders 里。
 */

export interface ReminderConfig {
  todoEnabled: boolean;
  /** HH:mm。 */
  todoTime: string;
  checkEnabled: boolean;
  /** HH:mm。 */
  checkTime: string;
}

export interface ReminderFired {
  /** YYYY-MM-DD → 当天已提醒（进程内记忆，重启即重置，与插件一致）。 */
  todo: string;
  check: string;
}

export interface ReminderDue {
  todo: boolean;
  check: boolean;
  /** 两条提醒都处理完后的新标记（即使没有触发也要带回，保持接口单一）。 */
  next: ReminderFired;
}

/** "HH:mm" 合法性：非零填充的 "8:00" 字典序会出错格，直接视为未启用。 */
export function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * 启动（或配置变更）时的初始标记：当天时间点**已经过了**的通道直接标记为已提醒。
 *
 * 这是插件「启用时若当天时间点已过，则当天不再提醒（从次日生效）」的实现方式——
 * 语义在初始化里，不在轮询判定里。
 */
export function initialFiredMarks(now: Date, config: ReminderConfig): ReminderFired {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return {
    todo:
      config.todoEnabled && isValidTime(config.todoTime) && nowTime >= config.todoTime
        ? today
        : "",
    check:
      config.checkEnabled && isValidTime(config.checkTime) && nowTime >= config.checkTime
        ? today
        : "",
  };
}

export function dueReminders(
  now: Date,
  config: ReminderConfig,
  fired: ReminderFired,
): ReminderDue {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  // 已触发标记只在与「今天」相等时才有拦截意义（昨天的标记不妨碍今天的提醒）
  const todoDue =
    config.todoEnabled &&
    isValidTime(config.todoTime) &&
    nowTime >= config.todoTime &&
    fired.todo !== today;
  const checkDue =
    config.checkEnabled &&
    isValidTime(config.checkTime) &&
    nowTime >= config.checkTime &&
    fired.check !== today;

  return {
    todo: todoDue,
    check: checkDue,
    next: { todo: todoDue ? today : fired.todo, check: checkDue ? today : fired.check },
  };
}
