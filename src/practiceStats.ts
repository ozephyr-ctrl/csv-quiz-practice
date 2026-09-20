import { MemoryCard } from "./types";

/**
 * 练习面板的纯数据层：按日答题量序列、到期预测序列与三项分类统计。
 * 全部为无 DOM 副作用的纯函数（便于单测）；图表绘制见 practiceChart.ts。
 * 日期口径均为本地自然日（与记忆练习每日新题配额的跨天判定一致）。
 */

/** 本地自然日键 "YYYY-MM-DD"。 */
export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 解析 "YYYY-MM-DD" 为本地当日 00:00 的毫秒时间戳。
 * 格式非法或日期不存在（如 2026-02-31 滚动到 3 月）返回 null。
 */
export function parseDateKey(key: string): number | null {
  const m = DATE_KEY_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(y, mo - 1, day);
  if (
    d.getFullYear() !== y ||
    d.getMonth() !== mo - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  return d.getTime();
}

/** 本地当日 00:00 的毫秒时间戳。 */
export function startOfDayMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 在本地自然日基础上加 n 天（走 Date 构造器，自动处理 DST/闰年）。n 可为负。 */
export function addDaysMs(dayMs: number, n: number): number {
  const d = new Date(dayMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** 练习面板三项分类统计。 */
export interface PracticeStats {
  /** 今日已练习：今日答题事件数（含常规/随机考试/记忆练习，全库口径）。 */
  practicedToday: number;
  /** 目前已到期：due ≤ 当前时刻的记忆卡片数（随筛选范围）。 */
  dueNow: number;
  /** 预计今日内到期：当前时刻 < due < 明日 0 点的记忆卡片数（随筛选范围）。 */
  dueLaterToday: number;
}

/**
 * 计算练习面板三项统计（到期口径与 countDueCards 一致：due 非法不计入）。
 * scopeIds 提供时到期统计只计范围内的题（随当前筛选变化）；缺省为全库口径。
 */
export function computePracticeStats(
  cards: Record<string, MemoryCard> | undefined,
  dailyAnswers: Record<string, number> | undefined,
  now: Date,
  scopeIds?: Set<string>
): PracticeStats {
  const nowMs = now.getTime();
  const nextDayMs = addDaysMs(startOfDayMs(now), 1);
  let dueNow = 0;
  let dueLaterToday = 0;
  if (cards) {
    for (const [id, c] of Object.entries(cards)) {
      if (!c || typeof c !== "object") continue;
      if (scopeIds && !scopeIds.has(id)) continue;
      const t = new Date(c.due).getTime();
      if (Number.isNaN(t)) continue;
      if (t <= nowMs) {
        dueNow++;
      } else if (t < nextDayMs) {
        dueLaterToday++;
      }
    }
  }
  const today = dailyAnswers ? dailyAnswers[dateKey(now)] : undefined;
  return {
    practicedToday: typeof today === "number" && Number.isFinite(today) ? today : 0,
    dueNow,
    dueLaterToday,
  };
}

/** 折线图单日数据点。 */
export interface ChartDayPoint {
  /** 本地自然日键 "YYYY-MM-DD"。 */
  key: string;
  /** 本地当日 00:00 毫秒时间戳。 */
  ms: number;
  /** 该日答题事件数。 */
  answered: number;
  /** 该日预计到期的记忆卡片数（按 due 所在自然日分桶；逾期卡片累积至今日桶）。 */
  due: number;
}

/** buildDailySeries 的可选参数。 */
export interface DailySeriesOptions {
  /** 历史回溯天数上限（自今日起向前，避免无界数据）。默认 180。 */
  historyDays?: number;
  /** 预测未来天数（自今日起向后）。默认 30。 */
  forecastDays?: number;
  /** 到期系列的筛选范围（题 id 集）：仅统计范围内的卡片；缺省为全部卡片。 */
  scopeIds?: Set<string>;
}

/** 按日序列（points 升序，todayIndex 指向今日所在下标）。 */
export interface DailySeries {
  points: ChartDayPoint[];
  todayIndex: number;
}

/**
 * 构建折线图按日序列：区间为 [最早数据日（回溯不超过 historyDays）, 今日+forecastDays]。
 * answered 取 dailyAnswers 按日计数（全库口径）；due 把每张卡片按 due 所在自然日分桶，
 * 逾期卡片（due 早于今日）累积到今日桶——它们现在就已到期，历史日不回填，
 * 故区间起点只由答题历史决定（逾期卡片不再把区间拉长）。
 * scopeIds 提供时到期系列只计范围内的题（随当前筛选变化）。
 */
export function buildDailySeries(
  dailyAnswers: Record<string, number> | undefined,
  cards: Record<string, MemoryCard> | undefined,
  now: Date,
  options: DailySeriesOptions = {}
): DailySeries {
  const historyDays = options.historyDays ?? 180;
  const forecastDays = options.forecastDays ?? 30;
  const todayMs = startOfDayMs(now);
  const startLimitMs = addDaysMs(todayMs, -historyDays);
  const endMs = addDaysMs(todayMs, forecastDays);

  // 最早数据日：仅由答题历史决定（到期系列的可见数据都在今日及以后）
  let earliestMs: number | null = null;
  if (dailyAnswers) {
    for (const key of Object.keys(dailyAnswers)) {
      const ms = parseDateKey(key);
      if (ms !== null && (earliestMs === null || ms < earliestMs)) {
        earliestMs = ms;
      }
    }
  }
  // 无任何数据（或数据全在未来）时区间仍包含今日
  const startMs = Math.max(
    startLimitMs,
    Math.min(todayMs, earliestMs ?? todayMs)
  );

  const points: ChartDayPoint[] = [];
  const indexByKey = new Map<string, number>();
  for (let ms = startMs; ms <= endMs; ms = addDaysMs(ms, 1)) {
    const key = dateKey(new Date(ms));
    indexByKey.set(key, points.length);
    points.push({ key, ms, answered: 0, due: 0 });
  }
  // 今日可能因 earliest < today 使区间不含今日？不会：start ≤ today 且 end ≥ today。
  const todayIndex = Math.max(
    0,
    Math.round((todayMs - startMs) / 86400000)
  );

  if (dailyAnswers) {
    for (const [key, value] of Object.entries(dailyAnswers)) {
      const idx = indexByKey.get(key);
      if (idx === undefined) continue;
      const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
      points[idx].answered = Math.max(0, v);
    }
  }
  if (cards) {
    const todayKey = dateKey(now);
    for (const [id, c] of Object.entries(cards)) {
      if (!c || typeof c !== "object") continue;
      if (options.scopeIds && !options.scopeIds.has(id)) continue;
      const t = new Date(c.due).getTime();
      if (Number.isNaN(t)) continue;
      // 逾期卡片（due 早于今日）累积到今日桶
      const key =
        t < todayMs ? todayKey : dateKey(new Date(t));
      const idx = indexByKey.get(key);
      if (idx !== undefined) points[idx].due++;
    }
  }

  return { points, todayIndex };
}

/** dailyAnswers 记录保留的最大键数（防异常数据撑爆 sidecar）。 */
export const MAX_DAILY_ANSWER_KEYS = 400;
/** 单日计数值上限（防损坏数据出现天文数字撑爆 y 轴）。 */
const MAX_DAILY_ANSWER_VALUE = 1000000;

/**
 * dailyAnswers 的字段级归一化防御（磁盘/冲突副本数据可能损坏）：
 * 键必须为合法 "YYYY-MM-DD"，值必须为有限非负数字；超上限键数时保留最近的键。
 */
export function normalizeDailyAnswers(
  raw: unknown
): Record<string, number> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return undefined;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (parseDateKey(key) === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    result[key] = Math.min(Math.round(value), MAX_DAILY_ANSWER_VALUE);
  }
  return result;
}

/**
 * 原地裁剪 dailyAnswers：删除 keepDays 天前的旧键；键数超上限时保留最近的键。
 * 返回是否有删改（调用方据此决定是否落盘）。
 */
export function pruneDailyAnswers(
  record: Record<string, number>,
  now: Date,
  keepDays: number = 180
): boolean {
  const cutoffMs = addDaysMs(startOfDayMs(now), -keepDays);
  let changed = false;
  for (const key of Object.keys(record)) {
    const ms = parseDateKey(key);
    if (ms === null || ms < cutoffMs) {
      delete record[key];
      changed = true;
    }
  }
  const keys = Object.keys(record);
  if (keys.length > MAX_DAILY_ANSWER_KEYS) {
    // 键为定长日期格式，字典序即时间序：排序后删最旧的溢出部分
    keys.sort();
    const overflow = keys.length - MAX_DAILY_ANSWER_KEYS;
    for (let i = 0; i < overflow; i++) {
      delete record[keys[i]];
    }
    changed = true;
  }
  return changed;
}
