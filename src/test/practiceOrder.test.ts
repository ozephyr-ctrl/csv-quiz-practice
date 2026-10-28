import { describe, it, expect, vi, type Mock } from "vitest";
import {
  hasValidDue,
  orderFilterPracticePool,
  FilterPracticeOrder,
} from "../practiceOrder";
import { MemoryCard, Question } from "../types";

/** 构造最小题目对象（排序只关心 id）。 */
const q = (id: string): Question => ({ id } as Question);

/** 构造记忆卡片（仅 due 参与排序）。 */
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

/** 固定基准：2026-09-20 12:00 本地时间。 */
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

const ids = (items: Question[]): string[] => items.map((item) => item.id);

describe("hasValidDue", () => {
  it("有卡片且 due 可解析时为 true", () => {
    expect(hasValidDue(card(new Date(2026, 8, 19).toISOString()))).toBe(true);
    expect(hasValidDue(card(""))).toBe(false);
  });

  it("无卡片或 due 非法时为 false", () => {
    expect(hasValidDue(undefined)).toBe(false);
    expect(hasValidDue(card("not-a-date"))).toBe(false);
    expect(hasValidDue(card(""))).toBe(false);
  });
});

describe("orderFilterPracticePool / bank", () => {
  it("原样保留题库顺序（不按 due 重排）", () => {
    const pool = [q("c"), q("a"), q("b")];
    const cards: Record<string, MemoryCard> = {
      a: card(new Date(2026, 8, 19).toISOString()),
      b: card(new Date(2026, 8, 25).toISOString()),
      c: card(new Date(2026, 8, 21).toISOString()),
    };
    expect(ids(orderFilterPracticePool(pool, "bank", cards, NOW))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("不修改入参且返回新数组", () => {
    const pool = [q("b"), q("a")];
    const snapshot = ids(pool);
    const result = orderFilterPracticePool(pool, "bank", {}, NOW);
    expect(result).not.toBe(pool);
    expect(ids(pool)).toEqual(snapshot);
    expect(ids(result)).toEqual(["b", "a"]);
  });
});

describe("orderFilterPracticePool / random", () => {
  it("使用注入的 shuffleFn（可确定性断言）", () => {
    const pool = [q("a"), q("b"), q("c"), q("d")];
    // 简化的确定性“洗牌”：整体反转。vi.fn 推断会丢掉泛型，故显式断言为泛型函数 & Mock。
    const reverse = vi.fn(<T,>(items: T[]): T[] =>
      [...items].reverse()
    ) as unknown as (<T>(items: T[]) => T[]) & Mock;
    const result = orderFilterPracticePool(pool, "random", {}, NOW, reverse);
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(ids(result)).toEqual(["d", "c", "b", "a"]);
  });

  it("返回同一多重集合，且不改动入参", () => {
    const pool = [q("a"), q("b"), q("c"), q("d"), q("e")];
    const snapshot = ids(pool);
    const result = orderFilterPracticePool(pool, "random", {}, NOW);
    expect(ids(pool)).toEqual(snapshot); // 入参未被就地打乱
    expect([...ids(result)].sort()).toEqual([...snapshot].sort());
    expect(result.length).toBe(pool.length);
  });

  it("注入的 shuffleFn 若返回原数组，结果仍是新数组", () => {
    const pool = [q("a"), q("b")];
    const identity = <T,>(items: T[]): T[] => items;
    const result = orderFilterPracticePool(pool, "random", {}, NOW, identity);
    expect(result).not.toBe(pool);
    expect(ids(result)).toEqual(["a", "b"]);
  });
});

describe("orderFilterPracticePool / due", () => {
  it("逾期题排在未到期题之前", () => {
    const pool = [q("future"), q("overdue")];
    const cards: Record<string, MemoryCard> = {
      future: card(new Date(2026, 8, 27).toISOString()),
      overdue: card(new Date(2026, 8, 18).toISOString()),
    };
    expect(ids(orderFilterPracticePool(pool, "due", cards, NOW))).toEqual([
      "overdue",
      "future",
    ]);
  });

  it("跨混合日期按 due 升序排列", () => {
    const pool = [q("d3"), q("past"), q("d2"), q("d1")];
    const cards: Record<string, MemoryCard> = {
      d3: card(new Date(2026, 9, 10).toISOString()),
      past: card(new Date(2026, 0, 1).toISOString()),
      d2: card(new Date(2026, 8, 25).toISOString()),
      d1: card(new Date(2026, 8, 20, 18).toISOString()),
    };
    expect(ids(orderFilterPracticePool(pool, "due", cards, NOW))).toEqual([
      "past",
      "d1",
      "d2",
      "d3",
    ]);
  });

  it("同 due 的题保持题池相对顺序（显式稳定排序）", () => {
    const same = new Date(2026, 8, 22, 9).toISOString();
    const pool = [q("tie3"), q("tie1"), q("tie2")];
    const cards: Record<string, MemoryCard> = {
      tie3: card(same),
      tie1: card(same),
      tie2: card(same),
    };
    expect(ids(orderFilterPracticePool(pool, "due", cards, NOW))).toEqual([
      "tie3",
      "tie1",
      "tie2",
    ]);
  });

  it("无卡片的题按原顺序追加在到期排序题之后", () => {
    const pool = [q("noCardA"), q("later"), q("noCardB"), q("earlier")];
    const cards: Record<string, MemoryCard> = {
      later: card(new Date(2026, 9, 1).toISOString()),
      earlier: card(new Date(2026, 8, 1).toISOString()),
    };
    expect(ids(orderFilterPracticePool(pool, "due", cards, NOW))).toEqual([
      "earlier",
      "later",
      "noCardA",
      "noCardB",
    ]);
  });

  it("due 非法的卡片等同无卡片（追加，保持原序）", () => {
    const pool = [q("bad1"), q("ok"), q("bad2")];
    const cards: Record<string, MemoryCard> = {
      bad1: card("not-a-date"),
      ok: card(new Date(2026, 8, 19).toISOString()),
      bad2: card(""),
    };
    expect(ids(orderFilterPracticePool(pool, "due", cards, NOW))).toEqual([
      "ok",
      "bad1",
      "bad2",
    ]);
  });

  it("不过滤 now：早于/晚于 now 的题都保留", () => {
    const pool = [q("evening"), q("yesterday")];
    const cards: Record<string, MemoryCard> = {
      yesterday: card(new Date(2026, 8, 19, 12).toISOString()),
      evening: card(new Date(2026, 8, 20, 23).toISOString()),
    };
    const result = orderFilterPracticePool(pool, "due", cards, NOW);
    expect(ids(result)).toEqual(["yesterday", "evening"]);
    expect(result.length).toBe(2);
  });

  it("不修改入参题池与卡片表", () => {
    const pool = [q("b"), q("a")];
    const cards: Record<string, MemoryCard> = {
      a: card(new Date(2026, 8, 19).toISOString()),
      b: card(new Date(2026, 8, 25).toISOString()),
    };
    const poolSnapshot = ids(pool);
    const cardsSnapshot = JSON.stringify(cards);
    const result = orderFilterPracticePool(pool, "due", cards, NOW);
    expect(ids(pool)).toEqual(poolSnapshot);
    expect(JSON.stringify(cards)).toBe(cardsSnapshot);
    expect(ids(result)).toEqual(["a", "b"]);
  });
});

describe("orderFilterPracticePool / 边界与全长保留", () => {
  const modes: FilterPracticeOrder[] = ["bank", "random", "due"];

  it("空题池返回空数组", () => {
    for (const mode of modes) {
      expect(orderFilterPracticePool([], mode, {}, NOW)).toEqual([]);
    }
  });

  it("全部无卡片时各模式均保留完整题池", () => {
    const pool = [q("a"), q("b"), q("c")];
    for (const mode of modes) {
      const result = orderFilterPracticePool(pool, mode, {}, NOW);
      expect(result.length).toBe(pool.length);
      expect([...ids(result)].sort()).toEqual(["a", "b", "c"]);
    }
    // 无卡片时 due 模式即原序
    expect(ids(orderFilterPracticePool(pool, "due", {}, NOW))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("全部有卡片时各模式均保留完整题池（due 不截断）", () => {
    const pool = [q("c"), q("a"), q("b")];
    const cards: Record<string, MemoryCard> = {
      a: card(new Date(2026, 8, 19).toISOString()),
      b: card(new Date(2026, 8, 23).toISOString()),
      c: card(new Date(2026, 9, 5).toISOString()),
    };
    for (const mode of modes) {
      expect(orderFilterPracticePool(pool, mode, cards, NOW).length).toBe(3);
    }
  });

  it("memoryCards 缺省为 undefined 时不抛错（按无卡片处理）", () => {
    const pool = [q("a"), q("b")];
    expect(
      ids(
        orderFilterPracticePool(
          pool,
          "due",
          undefined as unknown as Record<string, MemoryCard>,
          NOW
        )
      )
    ).toEqual(["a", "b"]);
  });
});
