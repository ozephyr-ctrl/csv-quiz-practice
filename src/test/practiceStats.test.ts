import { describe, it, expect } from "vitest";
import {
  dateKey,
  parseDateKey,
  startOfDayMs,
  addDaysMs,
  computePracticeStats,
  buildDailySeries,
  normalizeDailyAnswers,
  pruneDailyAnswers,
  MAX_DAILY_ANSWER_KEYS,
} from "../practiceStats";
import { MemoryCard } from "../types";

/** 构造记忆卡片（仅 due 影响统计/序列）。 */
const card = (due: string): MemoryCard => ({
  state: 2,
  stability: 3,
  difficulty: 5,
  due,
  reps: 1,
  lapses: 0,
  learningSteps: 0,
  lastReview: due,
});

/** 固定“当前时刻”：2026-09-20 12:00 本地时间（跨用例一致的基准）。 */
const NOW = new Date(2026, 8, 20, 12, 0, 0);

describe("dateKey / parseDateKey", () => {
  it("dateKey 输出本地自然日 YYYY-MM-DD（补零）", () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dateKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("parseDateKey 与 dateKey 互逆（本地 00:00）", () => {
    const d = new Date(2026, 8, 20, 15, 30);
    expect(parseDateKey(dateKey(d))).toBe(startOfDayMs(d));
  });

  it("格式非法或日期不存在的键返回 null", () => {
    expect(parseDateKey("2026-9-20")).toBeNull();
    expect(parseDateKey("2026/09/20")).toBeNull();
    expect(parseDateKey("abc")).toBeNull();
    expect(parseDateKey("")).toBeNull();
    expect(parseDateKey("2026-02-31")).toBeNull(); // 滚动到 3 月，非合法日
    expect(parseDateKey("2026-13-01")).toBeNull();
  });
});

describe("startOfDayMs / addDaysMs", () => {
  it("startOfDayMs 归零到本地 00:00", () => {
    const d = new Date(2026, 8, 20, 23, 59, 59);
    expect(startOfDayMs(d)).toBe(new Date(2026, 8, 20).getTime());
  });

  it("addDaysMs 支持正负天数与跨月", () => {
    const base = startOfDayMs(NOW);
    expect(addDaysMs(base, 1)).toBe(new Date(2026, 8, 21).getTime());
    expect(addDaysMs(base, -20)).toBe(new Date(2026, 7, 31).getTime());
  });
});

describe("computePracticeStats", () => {
  it("三项统计边界：已到期含逾期与恰到期，今日内到期不含明日 0 点", () => {
    const cards: Record<string, MemoryCard> = {
      overdue: card(new Date(2026, 8, 19).toISOString()), // 昨天（逾期）
      dueNow: card(NOW.toISOString()), // 恰好此刻
      laterToday: card(new Date(2026, 8, 20, 18).toISOString()), // 今日稍晚
      tomorrow: card(new Date(2026, 8, 21).toISOString()), // 明日 0 点（不计入今日）
      nextWeek: card(new Date(2026, 8, 26).toISOString()),
      invalid: card("not-a-date"),
    };
    const stats = computePracticeStats(
      cards,
      { "2026-09-20": 7 },
      NOW
    );
    expect(stats.practicedToday).toBe(7);
    expect(stats.dueNow).toBe(2); // overdue + dueNow
    expect(stats.dueLaterToday).toBe(1); // laterToday
  });

  it("无卡片/无记录时全零；今日计数缺失按 0", () => {
    const stats = computePracticeStats(undefined, undefined, NOW);
    expect(stats).toEqual({
      practicedToday: 0,
      dueNow: 0,
      dueLaterToday: 0,
    });
    const onlyYesterday = computePracticeStats(
      undefined,
      { "2026-09-19": 5 },
      NOW
    );
    expect(onlyYesterday.practicedToday).toBe(0);
  });

  it("today 之外的每日答题量不污染今日统计；损坏值按 0", () => {
    const stats = computePracticeStats(
      undefined,
      { "2026-09-20": Number.NaN, "2026-09-19": 5 },
      NOW
    );
    expect(stats.practicedToday).toBe(0);
  });

  it("scopeIds 提供时到期统计只计筛选范围内的题（随筛选变化）", () => {
    const cards: Record<string, MemoryCard> = {
      q1: card(new Date(2026, 8, 19).toISOString()), // 逾期
      q2: card(new Date(2026, 8, 20, 18).toISOString()), // 今日稍晚
      q3: card(new Date(2026, 8, 26).toISOString()), // 未来
    };
    const all = computePracticeStats(cards, undefined, NOW);
    expect(all.dueNow).toBe(1);
    expect(all.dueLaterToday).toBe(1);
    // 只留 q2：已到期清零、今日内到期保留
    const onlyQ2 = computePracticeStats(cards, undefined, NOW, new Set(["q2"]));
    expect(onlyQ2.dueNow).toBe(0);
    expect(onlyQ2.dueLaterToday).toBe(1);
    // 只留 q1：反转
    const onlyQ1 = computePracticeStats(cards, undefined, NOW, new Set(["q1"]));
    expect(onlyQ1.dueNow).toBe(1);
    expect(onlyQ1.dueLaterToday).toBe(0);
    // 空范围：到期全为零
    const none = computePracticeStats(cards, undefined, NOW, new Set());
    expect(none.dueNow).toBe(0);
    expect(none.dueLaterToday).toBe(0);
  });
});

describe("buildDailySeries", () => {
  it("无任何数据：区间为今日起 forecastDays+1 天，今日下标 0，全零", () => {
    const series = buildDailySeries(undefined, undefined, NOW, {
      forecastDays: 14,
    });
    expect(series.points.length).toBe(15);
    expect(series.todayIndex).toBe(0);
    expect(series.points[0].key).toBe("2026-09-20");
    expect(series.points.every((p) => p.answered === 0 && p.due === 0)).toBe(
      true
    );
  });

  it("最早数据日决定起点，且不早于回溯上限", () => {
    // 10 天前有答题记录 → 起点 = 今日-10，共 10+30+1 天
    const s1 = buildDailySeries({ "2026-09-10": 3 }, undefined, NOW);
    expect(s1.points.length).toBe(41);
    expect(s1.todayIndex).toBe(10);
    expect(s1.points[0].key).toBe("2026-09-10");
    expect(s1.points[0].answered).toBe(3);
    expect(s1.points[s1.todayIndex].answered).toBe(0);

    // 200 天前的记录被 historyDays=180 夹住 → 起点 = 今日-180，旧记录丢弃
    const s2 = buildDailySeries({ "2026-03-04": 9 }, undefined, NOW);
    expect(s2.points.length).toBe(211);
    expect(s2.points[0].key).toBe("2026-03-24");
    expect(s2.points.every((p) => p.answered === 0)).toBe(true);
  });

  it("卡片按 due 所在自然日分桶：逾期累积至今日桶，非法 due 跳过", () => {
    const cards: Record<string, MemoryCard> = {
      overdue: card(new Date(2026, 8, 18, 8).toISOString()),
      overdue2: card(new Date(2026, 8, 10, 8).toISOString()),
      today: card(new Date(2026, 8, 20, 23).toISOString()),
      in3d: card(new Date(2026, 8, 23, 9).toISOString()),
      beyond: card(new Date(2026, 9, 15).toISOString()),
      invalid: card("bad"),
    };
    const series = buildDailySeries(undefined, cards, NOW);
    const byKey = new Map(series.points.map((p) => [p.key, p.due]));
    // 逾期两张 + 今日一张 → 今日桶 3；历史日不回填
    expect(byKey.get("2026-09-20")).toBe(3);
    expect(byKey.has("2026-09-18")).toBe(false);
    expect(byKey.get("2026-09-23")).toBe(1);
    expect(byKey.get("2026-10-15")).toBe(1);
    // 无答题历史时区间起点为今日（逾期卡片不拉长区间）
    expect(series.points[0].key).toBe("2026-09-20");
    expect(series.todayIndex).toBe(0);
    const totalDue = series.points.reduce((s, p) => s + p.due, 0);
    expect(totalDue).toBe(5);
    // 今日桶 = 统计口径的目前已到期 + 预计今日内到期
    const stats = computePracticeStats(cards, undefined, NOW);
    expect(byKey.get("2026-09-20")).toBe(stats.dueNow + stats.dueLaterToday);
  });

  it("有答题历史时逾期卡片仍累积至今日，历史日到期为 0", () => {
    const cards: Record<string, MemoryCard> = {
      overdue: card(new Date(2026, 8, 15).toISOString()),
    };
    const series = buildDailySeries({ "2026-09-14": 2 }, cards, NOW);
    expect(series.points[0].key).toBe("2026-09-14");
    expect(series.points[0].answered).toBe(2);
    expect(series.points[0].due).toBe(0);
    expect(series.points[series.todayIndex].due).toBe(1);
    expect(series.points[series.todayIndex].key).toBe("2026-09-20");
  });

  it("每日答题量按日对齐（未来日期的记录也保留在预测区）", () => {
    const series = buildDailySeries(
      { "2026-09-19": 2, "2026-09-20": 5, "2026-09-22": 1 },
      undefined,
      NOW
    );
    const byKey = new Map(series.points.map((p) => [p.key, p.answered]));
    expect(byKey.get("2026-09-19")).toBe(2);
    expect(byKey.get("2026-09-20")).toBe(5);
    expect(byKey.get("2026-09-22")).toBe(1);
  });

  it("historyDays/forecastDays 可定制区间长度", () => {
    const series = buildDailySeries(
      { "2026-09-13": 1 },
      undefined,
      NOW,
      { historyDays: 5, forecastDays: 10 }
    );
    expect(series.points.length).toBe(16); // 5 历史 + 今日 + 10 预测
    expect(series.todayIndex).toBe(5);
  });

  it("scopeIds 提供时到期系列只计筛选范围内的卡片", () => {
    const cards: Record<string, MemoryCard> = {
      q1: card(new Date(2026, 8, 18, 8).toISOString()), // 逾期 → 今日桶
      q2: card(new Date(2026, 8, 23, 9).toISOString()), // 3 天后
      q3: card(new Date(2026, 8, 24, 9).toISOString()), // 4 天后（范围外）
    };
    const scoped = buildDailySeries(undefined, cards, NOW, {
      scopeIds: new Set(["q1", "q2"]),
    });
    const byKey = new Map(scoped.points.map((p) => [p.key, p.due]));
    expect(byKey.get("2026-09-20")).toBe(1); // q1 逾期累积至今日
    expect(byKey.get("2026-09-23")).toBe(1); // q2
    expect(byKey.get("2026-09-24")).toBe(0); // q3 被排除
    const total = scoped.points.reduce((s, p) => s + p.due, 0);
    expect(total).toBe(2);
    // 缺省（无 scopeIds）为全库口径
    const global = buildDailySeries(undefined, cards, NOW);
    expect(global.points.reduce((s, p) => s + p.due, 0)).toBe(3);
  });
});

describe("normalizeDailyAnswers", () => {
  it("undefined/null/非对象返回 undefined（旧进度兼容）", () => {
    expect(normalizeDailyAnswers(undefined)).toBeUndefined();
    expect(normalizeDailyAnswers(null)).toBeUndefined();
    expect(normalizeDailyAnswers("x")).toBeUndefined();
    expect(normalizeDailyAnswers(42)).toBeUndefined();
  });

  it("合法记录四舍五入保留；非法键/值剔除", () => {
    expect(
      normalizeDailyAnswers({
        "2026-09-20": 3,
        "2026-09-19": 2.6, // → 3
        "2026-9-8": 5, // 键格式非法 → 剔除
        "2026-02-31": 1, // 日期不存在 → 剔除
        "2026-09-18": -2, // 负值 → 剔除
        "2026-09-17": "4", // 非数字 → 剔除
        "2026-09-16": Number.POSITIVE_INFINITY, // 非有限 → 剔除
      })
    ).toEqual({ "2026-09-20": 3, "2026-09-19": 3 });
  });

  it("空对象原样返回空记录", () => {
    expect(normalizeDailyAnswers({})).toEqual({});
  });
});

describe("pruneDailyAnswers", () => {
  it("删除 keepDays 之前的旧键，保留近期键", () => {
    const rec: Record<string, number> = {
      "2026-09-20": 1,
      "2026-09-19": 2,
      "2026-03-01": 3, // 200+ 天前 → 删除
      "bad-key": 4, // 非法键一并清理
    };
    const changed = pruneDailyAnswers(rec, NOW, 180);
    expect(changed).toBe(true);
    expect(rec).toEqual({ "2026-09-20": 1, "2026-09-19": 2 });
  });

  it("键数超上限时保留最近的键", () => {
    const rec: Record<string, number> = {};
    // 从今日往前造 MAX+10 个合法键
    for (let i = 0; i < MAX_DAILY_ANSWER_KEYS + 10; i++) {
      rec[dateKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - i))] = 1;
    }
    const changed = pruneDailyAnswers(rec, NOW, 10000);
    expect(changed).toBe(true);
    expect(Object.keys(rec).length).toBe(MAX_DAILY_ANSWER_KEYS);
    // 最早的键被删：今日仍在
    expect(rec[dateKey(NOW)]).toBe(1);
  });

  it("无需清理时返回 false 且不动记录", () => {
    const rec = { "2026-09-20": 1 };
    expect(pruneDailyAnswers(rec, NOW, 180)).toBe(false);
    expect(rec).toEqual({ "2026-09-20": 1 });
  });
});
