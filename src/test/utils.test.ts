import { describe, it, expect } from "vitest";
import {
  shuffle,
  sortByDisplayOrder,
  quizStateEquals,
  countDueCards,
  normalizeAnswerValue,
  normalizeMemoryCard,
  normalizeMemoryCards,
  resolveKeyBinding,
} from "../utils";
import { QuizSessionState, MemoryCard, DEFAULT_SETTINGS } from "../types";

const validCard: MemoryCard = {
  state: 2,
  stability: 3.5,
  difficulty: 5.2,
  due: "2026-01-01T00:00:00.000Z",
  reps: 4,
  lapses: 1,
  learningSteps: 0,
  lastReview: "2025-12-30T00:00:00.000Z",
};

describe("normalizeAnswerValue", () => {
  it("大写化、去非 A-D、去重并排序", () => {
    expect(normalizeAnswerValue("ca,b")).toBe("ABC");
    expect(normalizeAnswerValue("aA")).toBe("A");
    expect(normalizeAnswerValue("dcab")).toBe("ABCD");
    expect(normalizeAnswerValue("E")).toBe("");
  });
});

describe("normalizeMemoryCard", () => {
  it("合法卡片原样通过", () => {
    expect(normalizeMemoryCard(validCard)).toEqual(validCard);
  });

  it("非对象输入返回 null", () => {
    expect(normalizeMemoryCard(null)).toBeNull();
    expect(normalizeMemoryCard("x")).toBeNull();
    expect(normalizeMemoryCard(42)).toBeNull();
  });

  it("state 越界或非整数返回 null", () => {
    expect(normalizeMemoryCard({ ...validCard, state: 4 })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, state: -1 })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, state: 2.5 })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, state: "2" })).toBeNull();
  });

  it("数值字段为字符串/NaN/Infinity 返回 null（防 toFixed 崩溃）", () => {
    expect(normalizeMemoryCard({ ...validCard, stability: "8.5" })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, difficulty: NaN })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, reps: Infinity })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, lapses: "1" })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, learningSteps: null })).toBeNull();
  });

  it("difficulty 超出 1-10 定义域返回 null", () => {
    expect(normalizeMemoryCard({ ...validCard, difficulty: 0 })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, difficulty: 10.5 })).toBeNull();
  });

  it("due/lastReview 非字符串返回 null", () => {
    expect(normalizeMemoryCard({ ...validCard, due: 1767225600000 })).toBeNull();
    expect(normalizeMemoryCard({ ...validCard, lastReview: undefined })).toBeNull();
  });
});

describe("normalizeMemoryCards", () => {
  it("逐卡片校验：损坏卡剔除、合法卡保留", () => {
    const result = normalizeMemoryCards({
      good1: validCard,
      bad: { ...validCard, stability: "oops" },
      alsoBad: "not an object",
      good2: { ...validCard, state: 3 },
    });
    expect(Object.keys(result).sort()).toEqual(["good1", "good2"]);
    expect(result.good1).toEqual(validCard);
  });

  it("非对象输入返回空记录", () => {
    expect(normalizeMemoryCards(undefined)).toEqual({});
    expect(normalizeMemoryCards("x")).toEqual({});
  });
});

describe("countDueCards", () => {
  it("统计 due <= now 的卡片，非法 due 不计入", () => {
    const now = new Date("2026-09-03T00:00:00Z");
    const cards: Record<string, MemoryCard> = {
      due1: { ...validCard, due: "2026-09-02T00:00:00Z" },
      due2: { ...validCard, due: "2026-09-03T00:00:00Z" },
      future: { ...validCard, due: "2026-09-04T00:00:00Z" },
      invalid: { ...validCard, due: "not-a-date" },
    };
    expect(countDueCards(cards, now)).toBe(2);
  });

  it("undefined 返回 0", () => {
    expect(countDueCards(undefined)).toBe(0);
  });
});

describe("quizStateEquals", () => {
  const base: QuizSessionState = {
    csvPath: "题库.csv",
    currentIndex: 3,
    correctCount: 5,
    wrongCount: 2,
    displayOrder: ["1", "2", "3"],
    filterText: "",
    filterTags: "#a",
    filterCat1: "",
    filterCat2: "",
    filterCat3: "",
    filterFavorite: "",
    filterMastered: "",
    filterRepeat: "",
    filterWrong: "",
    filterUnanswered: "",
    answeredQuestions: { "1": "A" },
    memoryCards: { "1": validCard },
    memoryNewDate: "2026-09-03",
    memoryNewCountToday: 4,
    memoryPendingNew: ["9"],
    memoryInitialized: true,
  };

  it("相同状态相等；null 与非 null 不等", () => {
    expect(quizStateEquals(base, { ...base })).toBe(true);
    expect(quizStateEquals(base, null)).toBe(false);
    expect(quizStateEquals(null, null)).toBe(true);
  });

  it("memoryCards 单字段差异可检出（stability 为字符串时类型不同即不等）", () => {
    const other: QuizSessionState = {
      ...base,
      memoryCards: {
        "1": { ...validCard, stability: 3.6 },
      },
    };
    expect(quizStateEquals(base, other)).toBe(false);
  });

  it("可选字段缺失按空值处理（旧进度兼容）", () => {
    const legacy = { ...base } as Partial<QuizSessionState>;
    delete legacy.memoryCards;
    delete legacy.memoryNewDate;
    delete legacy.memoryPendingNew;
    delete legacy.memoryInitialized;
    const freshEmpty: QuizSessionState = {
      ...base,
      memoryCards: {},
      memoryNewDate: "",
      memoryPendingNew: [],
      memoryInitialized: false,
    };
    expect(quizStateEquals(legacy as QuizSessionState, freshEmpty)).toBe(true);
  });

  it("answeredQuestions 空串值与缺失键可区分（判错空选语义）", () => {
    const withEmptyAnswer: QuizSessionState = {
      ...base,
      answeredQuestions: { "1": "" },
    };
    expect(quizStateEquals(base, withEmptyAnswer)).toBe(false);
  });
});

describe("shuffle / sortByDisplayOrder", () => {
  it("shuffle 保持元素集合不变", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = shuffle(arr);
    expect(shuffled.sort()).toEqual(arr);
    expect(arr).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // 原数组不被修改
  });

  it("sortByDisplayOrder 按 id 排序，未知 id 沉底且不崩溃", () => {
    const items = [
      { id: "3", v: 3 },
      { id: "1", v: 1 },
      { id: "new", v: 0 },
    ];
    const sorted = sortByDisplayOrder(items, ["1", "3"]);
    expect(sorted.map((x) => x.id)).toEqual(["1", "3", "new"]);
  });
});

describe("resolveKeyBinding", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
  };

  it("默认映射：1-4 命中选项位，m/e/x 命中标记", () => {
    expect(resolveKeyBinding(settings, "1")).toEqual({ kind: "option", index: 0 });
    expect(resolveKeyBinding(settings, "4")).toEqual({ kind: "option", index: 3 });
    expect(resolveKeyBinding(settings, "m")).toEqual({ kind: "mark", field: "favorite" });
    expect(resolveKeyBinding(settings, "e")).toEqual({ kind: "mark", field: "mastered" });
    expect(resolveKeyBinding(settings, "x")).toEqual({ kind: "mark", field: "repeat" });
  });

  it("大小写不敏感；空串/空白/未绑定键不命中", () => {
    expect(resolveKeyBinding(settings, "M")).toEqual({ kind: "mark", field: "favorite" });
    expect(resolveKeyBinding(settings, "5")).toBeNull();
    expect(resolveKeyBinding(settings, "")).toBeNull();
    expect(resolveKeyBinding(settings, " ")).toBeNull();
    expect(resolveKeyBinding({ ...settings, keyFavorite: "  " }, " ")).toBeNull();
    expect(resolveKeyBinding({ ...settings, keyFavorite: "" }, "m")).toBeNull();
  });

  it("绑定值 trim 后比较；选项与标记重复绑定时选项优先", () => {
    expect(resolveKeyBinding({ ...settings, keyMastered: " q " }, "Q")).toEqual({
      kind: "mark",
      field: "mastered",
    });
    // 收藏绑定改成 "1" 与选项位 1 冲突 → 选项优先
    expect(resolveKeyBinding({ ...settings, keyFavorite: "1" }, "1")).toEqual({
      kind: "option",
      index: 0,
    });
  });

  it("方向键等非单字符键默认不命中（不影响内置方向键处理）", () => {
    expect(resolveKeyBinding(settings, "ArrowLeft")).toBeNull();
  });
});
