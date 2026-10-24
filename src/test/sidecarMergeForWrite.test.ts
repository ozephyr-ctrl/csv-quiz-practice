import { describe, it, expect } from "vitest";
import {
  cloneSidecarData,
  countersOfSidecar,
  mergeSidecarForWrite,
  normalizeSidecar,
  SidecarData,
  SidecarMeta,
  SidecarState,
  SidecarTombstones,
  StatsBaseline,
} from "../sidecar";
import { MemoryCard } from "../types";
import { cardFor } from "./fixtures";

function makeState(overrides: Partial<SidecarState> = {}): SidecarState {
  return {
    currentIndex: 0,
    correctCount: 0,
    wrongCount: 0,
    displayOrder: [],
    filterText: "",
    filterTags: "",
    filterTagsExcluded: "",
    filterCat1: "",
    filterCat2: "",
    filterCat3: "",
    filterFavorite: "",
    filterMastered: "",
    filterRepeat: "",
    filterWrong: "",
    filterUnanswered: "",
    answeredQuestions: {},
    ...overrides,
  };
}

function makeSidecar(
  state: Partial<SidecarState> = {},
  meta: Record<string, SidecarMeta> = {}
): SidecarData {
  return { version: 1, meta, state: makeState(state) };
}

function noTombstones(): SidecarTombstones {
  return {
    answered: new Set(),
    cards: new Set(),
    meta: new Set(),
    metaFields: new Map(),
  };
}

/** 相对今天偏移 n 天的本地日期键 "YYYY-MM-DD"。 */
function dayKey(offsetDays: number, from: Date = new Date()): string {
  const d = new Date(
    from.getFullYear(),
    from.getMonth(),
    from.getDate() + offsetDays
  );
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function merge(args: {
  base: SidecarData | null;
  memory: SidecarData;
  disk: SidecarData | null;
  statsBaseline?: StatsBaseline;
  tombstones?: SidecarTombstones;
}): SidecarData {
  return mergeSidecarForWrite({
    base: args.base,
    memory: args.memory,
    disk: args.disk,
    statsBaseline: args.statsBaseline ?? countersOfSidecar(args.base),
    tombstones: args.tombstones ?? noTombstones(),
  });
}

describe("mergeSidecarForWrite：事故回归", () => {
  it("base=memory=普通题子集、disk=全量 → 数据不被磁盘全量之外的子集覆盖", () => {
    const today = dayKey(0);
    const yesterday = dayKey(-1);
    const base = makeSidecar(
      {
        correctCount: 10,
        wrongCount: 4,
        answeredQuestions: { q1: "A", q2: "B" },
        memoryCards: { q1: cardFor({ lastReview: "2026-01-01T00:00:00.000Z" }) },
        dailyAnswers: { [today]: 2 },
      },
      { q1: { tags: "#base" } }
    );
    const memory = cloneSidecarData(base);
    const disk = makeSidecar(
      {
        correctCount: 105,
        wrongCount: 30,
        answeredQuestions: {
          q1: "A",
          q2: "B",
          q3: "C",
          q4: "D",
          q5: "E",
        },
        memoryCards: {
          q1: cardFor({ lastReview: "2026-01-01T00:00:00.000Z" }),
          q3: cardFor({ lastReview: "2026-02-01T00:00:00.000Z" }),
        },
        dailyAnswers: { [today]: 5, [yesterday]: 1 },
        memoryInitialized: true,
      },
      {
        q1: { tags: "#base" },
        q4: { favorite: "1" },
      }
    );

    const out = merge({ base, memory, disk });

    // answered：并集，磁盘多出的 q3/q4/q5 全部保留
    expect(Object.keys(out.state.answeredQuestions).sort()).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);
    expect(out.state.answeredQuestions.q5).toBe("E");
    // cards：磁盘独有的 q3 保留，未被内存子集抹掉
    expect(Object.keys(out.state.memoryCards ?? {}).sort()).toEqual([
      "q1",
      "q3",
    ]);
    // meta：磁盘独有的 q4 保留
    expect(out.meta.q1.tags).toBe("#base");
    expect(out.meta.q4.favorite).toBe("1");
    // daily：磁盘值保留（本次会话无增量）
    expect(out.state.dailyAnswers).toEqual({ [today]: 5, [yesterday]: 1 });
    // 计数：磁盘 105 不被内存 10 抹小
    expect(out.state.correctCount).toBe(105);
    expect(out.state.wrongCount).toBe(30);
    expect(out.state.memoryInitialized).toBe(true);
    expect(out.version).toBe(1);
    expect(typeof out.state.updatedAt).toBe("number");
  });
});

describe("mergeSidecarForWrite：answeredQuestions", () => {
  it("本地新答 + 磁盘新答 → 取并集", () => {
    const base = makeSidecar({ answeredQuestions: { q1: "A" } });
    const memory = makeSidecar({
      answeredQuestions: { q1: "A", q2: "B" },
    });
    const disk = makeSidecar({
      answeredQuestions: { q1: "A", q3: "C" },
    });

    const out = merge({ base, memory, disk });
    expect(out.state.answeredQuestions).toEqual({
      q1: "A",
      q2: "B",
      q3: "C",
    });
  });

  it("同题本地重答（m≠b）本地胜；本地没改（m===b）磁盘胜", () => {
    const base = makeSidecar({
      answeredQuestions: { changed: "A", untouched: "A" },
    });
    const memory = makeSidecar({
      answeredQuestions: { changed: "C", untouched: "A" },
    });
    const disk = makeSidecar({
      answeredQuestions: { changed: "D", untouched: "D" },
    });

    const out = merge({ base, memory, disk });
    expect(out.state.answeredQuestions.changed).toBe("C");
    expect(out.state.answeredQuestions.untouched).toBe("D");
  });

  it("内存缺失（题被移出范围）不等于删除：磁盘/基线答案保留", () => {
    const base = makeSidecar({ answeredQuestions: { q1: "A" } });
    const memory = makeSidecar({ answeredQuestions: {} });
    const disk = makeSidecar({ answeredQuestions: { q1: "A", q2: "B" } });

    const out = merge({ base, memory, disk });
    expect(out.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
  });

  it("answered tombstone 阻止磁盘答案复活", () => {
    const base = makeSidecar({ answeredQuestions: { q1: "A", q2: "B" } });
    const memory = makeSidecar({ answeredQuestions: { q1: "A" } });
    const disk = makeSidecar({ answeredQuestions: { q1: "A", q2: "B" } });

    const out = merge({
      base,
      memory,
      disk,
      tombstones: {
        answered: new Set(["q2"]),
        cards: new Set(),
        meta: new Set(),
        metaFields: new Map(),
      },
    });
    expect(out.state.answeredQuestions).toEqual({ q1: "A" });
  });

  it("空字符串答案被视为有效值（不因 falsy 丢失）", () => {
    const base = makeSidecar({ answeredQuestions: { q1: "" } });
    const memory = makeSidecar({ answeredQuestions: { q1: "" } });
    const disk = makeSidecar({ answeredQuestions: { q1: "" } });

    const out = merge({ base, memory, disk });
    expect(Object.prototype.hasOwnProperty.call(out.state.answeredQuestions, "q1")).toBe(
      true
    );
    expect(out.state.answeredQuestions.q1).toBe("");
  });
});

describe("mergeSidecarForWrite：meta", () => {
  it("逐字段合并：内存改动字段胜，未改/缺失字段取磁盘或 base（删除只靠 tombstone）", () => {
    const base = makeSidecar({}, {
      q1: { tags: "#old", favorite: "1", mastered: "1", ts: 10 },
    });
    const memory = makeSidecar({}, {
      q1: { tags: "#new", favorite: "1", ts: 20 }, // 旧视图未包含 mastered
    });
    const disk = makeSidecar({}, {
      q1: { tags: "#disk", wrong: "1", ts: 30 },
    });

    const out = merge({ base, memory, disk });
    expect(out.meta.q1.tags).toBe("#new"); // 内存相对 base 变化
    expect(out.meta.q1.favorite).toBe("1"); // 内存未改且磁盘无该字段 → base/memory 值
    expect(out.meta.q1.wrong).toBe("1"); // 磁盘新增字段保留
    // 内存缺失字段不视为删除：旧视图子集不能删掉磁盘/base 的字段
    expect(out.meta.q1.mastered).toBe("1");
    expect(out.meta.q1.ts).toBe(30); // 取用到的 entry ts 最大值（磁盘 30 用于 wrong 字段）
  });

  it("内存未改的字段 → 磁盘新值胜出", () => {
    const base = makeSidecar({}, { q1: { tags: "#old", ts: 10 } });
    const memory = makeSidecar({}, { q1: { tags: "#old", ts: 10 } });
    const disk = makeSidecar({}, { q1: { tags: "#disk", ts: 99 } });

    const out = merge({ base, memory, disk });
    expect(out.meta.q1.tags).toBe("#disk");
    expect(out.meta.q1.ts).toBe(99);
  });

  it("meta tombstone 整条删除且磁盘不复活", () => {
    const base = makeSidecar({}, { q1: { tags: "#a" }, q2: { tags: "#b" } });
    const memory = makeSidecar({}, { q1: { tags: "#a" } });
    const disk = makeSidecar({}, {
      q1: { tags: "#a" },
      q2: { tags: "#b" },
    });

    const out = merge({
      base,
      memory,
      disk,
      tombstones: {
        answered: new Set(),
        cards: new Set(),
        meta: new Set(["q2"]),
        metaFields: new Map(),
      },
    });
    expect(Object.keys(out.meta)).toEqual(["q1"]);
  });

  it("字段级 meta tombstone：删除字段不复活，未标记字段仍合并", () => {
    const base = makeSidecar({}, {
      q1: { tags: "#a", repeat: "1", favorite: "1", ts: 10 },
    });
    const memory = makeSidecar({}, { q1: { favorite: "1", ts: 20 } });
    const disk = makeSidecar({}, {
      q1: { tags: "#a", repeat: "1", favorite: "1", mastered: "1", ts: 30 },
    });

    const out = merge({
      base,
      memory,
      disk,
      tombstones: {
        answered: new Set(),
        cards: new Set(),
        meta: new Set(),
        metaFields: new Map([["q1", new Set(["tags", "repeat"])]]),
      },
    });
    // 被 tombstone 的字段即使磁盘仍有旧值也不写回
    expect(out.meta.q1.tags).toBeUndefined();
    expect(out.meta.q1.repeat).toBeUndefined();
    // 未标记字段照常合并（C 类 favorite + 磁盘新增 mastered）
    expect(out.meta.q1.favorite).toBe("1");
    expect(out.meta.q1.mastered).toBe("1");
  });

  it("无字段的 entry 被丢弃", () => {
    const base = null;
    const memory = makeSidecar({}, { q1: {} });
    const out = merge({ base, memory, disk: null });
    expect(Object.keys(out.meta)).toEqual([]);
  });

  it("原型键（__proto__ / constructor）不丢失，且不污染原型", () => {
    const protoMeta = JSON.parse(
      '{"__proto__":{"tags":"#proto"},"constructor":{"tags":"#ctor"}}'
    ) as Record<string, SidecarMeta>;
    const memory: SidecarData = {
      version: 1,
      meta: protoMeta,
      state: makeState(),
    };

    const out = merge({ base: null, memory, disk: null });
    expect(Object.getPrototypeOf(out.meta)).toBe(Object.prototype);
    expect(
      Object.prototype.hasOwnProperty.call(out.meta, "__proto__")
    ).toBe(true);
    expect(out.meta["__proto__"].tags).toBe("#proto");
    expect(
      Object.prototype.hasOwnProperty.call(out.meta, "constructor")
    ).toBe(true);
    expect(out.meta["constructor"].tags).toBe("#ctor");
  });

  it("normalizeSidecar 写入 meta 时保留原型键", () => {
    const raw = JSON.parse(
      '{"version":1,"meta":{"__proto__":{"tags":"#p"}},"state":{}}'
    );
    const normalized = normalizeSidecar(raw);
    expect(normalized).not.toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(normalized!.meta, "__proto__")
    ).toBe(true);
    expect(Object.getPrototypeOf(normalized!.meta)).toBe(Object.prototype);
    expect(normalized!.meta["__proto__"].tags).toBe("#p");
  });
});

describe("mergeSidecarForWrite：memoryCards", () => {
  it("lastReview 较新者胜；完全平局内存优先", () => {
    const newer: MemoryCard = cardFor({
      lastReview: "2026-03-01T00:00:00.000Z",
      reps: 9,
    });
    const older: MemoryCard = cardFor({
      lastReview: "2026-01-01T00:00:00.000Z",
      reps: 1,
    });
    const base = makeSidecar({
      memoryCards: { a: older, b: older },
    });
    const memory = makeSidecar({
      memoryCards: {
        a: older,
        b: cardFor({ lastReview: "2026-01-01T00:00:00.000Z", reps: 2 }),
      },
    });
    const disk = makeSidecar({
      memoryCards: { a: newer, b: older },
    });

    const out = merge({ base, memory, disk });
    expect(out.state.memoryCards?.a.reps).toBe(9); // 磁盘更新
    expect(out.state.memoryCards?.b.reps).toBe(2); // 平局内存优先
  });

  it("lastReview 缺失/非法时回退 ts", () => {
    const base = makeSidecar({ memoryCards: { a: cardFor({ lastReview: "" }) } });
    const memory = makeSidecar({
      memoryCards: { a: cardFor({ lastReview: "", reps: 1, ts: 10 }) },
    });
    const disk = makeSidecar({
      memoryCards: { a: cardFor({ lastReview: "", reps: 2, ts: 20 }) },
    });

    const out = merge({ base, memory, disk });
    expect(out.state.memoryCards?.a.reps).toBe(2);
  });

  it("内存缺失不删卡：磁盘有则用磁盘，磁盘没有用 base", () => {
    const base = makeSidecar({
      memoryCards: { a: cardFor({ reps: 1 }), b: cardFor({ reps: 1 }) },
    });
    const memory = makeSidecar({ memoryCards: {} });
    const disk = makeSidecar({ memoryCards: { a: cardFor({ reps: 5 }) } });

    const out = merge({ base, memory, disk });
    expect(out.state.memoryCards?.a.reps).toBe(5);
    expect(out.state.memoryCards?.b.reps).toBe(1);
  });

  it("cards tombstone 阻止磁盘卡片复活；全部删光时 memoryCards 保持 undefined", () => {
    const base = makeSidecar({ memoryCards: { a: cardFor() } });
    const memory = makeSidecar({ memoryCards: {} });
    const disk = makeSidecar({ memoryCards: { a: cardFor() } });

    const out = merge({
      base,
      memory,
      disk,
      tombstones: {
        answered: new Set(),
        cards: new Set(["a"]),
        meta: new Set(),
        metaFields: new Map(),
      },
    });
    expect(out.state.memoryCards).toBeUndefined();
  });

  it("无卡片时保持 undefined", () => {
    const out = merge({
      base: makeSidecar(),
      memory: makeSidecar(),
      disk: makeSidecar(),
    });
    expect(out.state.memoryCards).toBeUndefined();
  });
});

describe("mergeSidecarForWrite：计数与每日", () => {
  it("correct：disk=105, S=100, M=101 → 106；M=90 → 105（delta 钳 0）", () => {
    const base = makeSidecar({ correctCount: 100, wrongCount: 50 });
    const disk = makeSidecar({ correctCount: 105, wrongCount: 60 });

    const up = merge({
      base,
      memory: makeSidecar({ correctCount: 101, wrongCount: 55 }),
      disk,
      statsBaseline: { correct: 100, wrong: 50, daily: {} },
    });
    expect(up.state.correctCount).toBe(106);
    expect(up.state.wrongCount).toBe(65);

    const down = merge({
      base,
      memory: makeSidecar({ correctCount: 90, wrongCount: 40 }),
      disk,
      statsBaseline: { correct: 100, wrong: 50, daily: {} },
    });
    expect(down.state.correctCount).toBe(105);
    expect(down.state.wrongCount).toBe(60);
  });

  it("daily：磁盘值 + 本次会话增量，结果非正的日期被丢弃", () => {
    const today = dayKey(0);
    const old = dayKey(-3);
    const base = makeSidecar({
      dailyAnswers: { [today]: 3, [old]: 2 },
    });
    const memory = makeSidecar({
      dailyAnswers: { [today]: 4, [old]: 1 },
    });
    const disk = makeSidecar({
      dailyAnswers: { [today]: 5, [old]: 1 },
    });

    const out = merge({
      base,
      memory,
      disk,
      statsBaseline: { correct: 0, wrong: 0, daily: { [today]: 3, [old]: 2 } },
    });
    // today: 5 + max(0, 4-3) = 6；old: 1 + max(0, 1-2) = 1
    expect(out.state.dailyAnswers).toEqual({ [today]: 6, [old]: 1 });
  });

  it("daily 结果 0 的日期不写入", () => {
    const today = dayKey(0);
    const out = merge({
      base: makeSidecar({ dailyAnswers: { [today]: 2 } }),
      memory: makeSidecar({ dailyAnswers: {} }),
      disk: makeSidecar({ dailyAnswers: {} }),
      statsBaseline: { correct: 0, wrong: 0, daily: { [today]: 2 } },
    });
    expect(out.state.dailyAnswers).toEqual({});
  });

  it("180 天前的日期被裁剪", () => {
    const today = dayKey(0);
    const stale = dayKey(-200);
    const out = merge({
      base: makeSidecar(),
      memory: makeSidecar(),
      disk: makeSidecar({
        dailyAnswers: { [today]: 2, [stale]: 7 },
      }),
      statsBaseline: { correct: 0, wrong: 0, daily: {} },
    });
    expect(out.state.dailyAnswers).toEqual({ [today]: 2 });
  });

  it("base=null → 计数/每日以 memory 为准（不被 0 基线抹掉）", () => {
    const today = dayKey(0);
    const memory = makeSidecar({
      correctCount: 42,
      wrongCount: 7,
      dailyAnswers: { [today]: 9 },
    });
    const out = merge({
      base: null,
      memory,
      disk: null,
      statsBaseline: { correct: 0, wrong: 0, daily: {} },
    });
    expect(out.state.correctCount).toBe(42);
    expect(out.state.wrongCount).toBe(7);
    expect(out.state.dailyAnswers).toEqual({ [today]: 9 });
  });

  it("disk=null → 用 base 兜底，不当空状态", () => {
    const base = makeSidecar(
      {
        correctCount: 30,
        wrongCount: 6,
        displayOrder: ["q1", "q2"],
        answeredQuestions: { q1: "A", q2: "B" },
        memoryCards: { q2: cardFor() },
        dailyAnswers: { [dayKey(0)]: 3 },
      },
      { q2: { tags: "#keep" } }
    );
    const memory = makeSidecar({
      correctCount: 31,
      wrongCount: 6,
      displayOrder: ["q1"],
      answeredQuestions: { q1: "A" },
    });

    const out = merge({ base, memory, disk: null });
    expect(out.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
    expect(Object.keys(out.state.memoryCards ?? {})).toEqual(["q2"]);
    expect(out.meta.q2.tags).toBe("#keep");
    expect(out.state.correctCount).toBe(31); // base 30 + 增量 1
    expect(out.state.wrongCount).toBe(6);
    expect(out.state.dailyAnswers).toEqual({ [dayKey(0)]: 3 });
    // displayOrder 内存优先
    expect(out.state.displayOrder).toEqual(["q1"]);
  });
});

describe("mergeSidecarForWrite：会话级字段与纯度", () => {
  it("displayOrder / currentIndex / 筛选 / memory 配额内存优先，memoryInitialized 任一为 true", () => {
    const base = makeSidecar({
      currentIndex: 1,
      displayOrder: ["q1"],
      filterText: "old",
      memoryNewDate: "2026-01-01",
      memoryNewCountToday: 1,
      memoryPendingNew: ["q2"],
      memoryInitialized: undefined,
    });
    const memory = makeSidecar({
      currentIndex: 5,
      displayOrder: ["q3", "q2"],
      filterText: "new",
      filterTags: "#tag",
      memoryNewDate: "2026-10-24",
      memoryNewCountToday: 3,
      memoryPendingNew: ["q9"],
      memoryInitialized: false,
    });
    const disk = makeSidecar({ memoryInitialized: true });

    const out = merge({ base, memory, disk });
    expect(out.state.currentIndex).toBe(5);
    expect(out.state.displayOrder).toEqual(["q3", "q2"]);
    expect(out.state.filterText).toBe("new");
    expect(out.state.filterTags).toBe("#tag");
    expect(out.state.memoryNewDate).toBe("2026-10-24");
    expect(out.state.memoryNewCountToday).toBe(3);
    expect(out.state.memoryPendingNew).toEqual(["q9"]);
    expect(out.state.memoryInitialized).toBe(true);
  });

  it("不修改入参", () => {
    const base = makeSidecar(
      { answeredQuestions: { q1: "A" }, correctCount: 1 },
      { q1: { tags: "#a" } }
    );
    const memory = makeSidecar(
      { answeredQuestions: { q1: "A", q2: "B" }, correctCount: 2 },
      { q1: { tags: "#b" } }
    );
    const disk = makeSidecar(
      { answeredQuestions: { q3: "C" }, correctCount: 10 },
      { q3: { tags: "#c" } }
    );
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    const memorySnapshot = JSON.parse(JSON.stringify(memory));
    const diskSnapshot = JSON.parse(JSON.stringify(disk));

    const out = merge({ base, memory, disk });
    out.state.answeredQuestions.q1 = "Z";
    out.meta.q1.tags = "#z";

    expect(JSON.parse(JSON.stringify(base))).toEqual(baseSnapshot);
    expect(JSON.parse(JSON.stringify(memory))).toEqual(memorySnapshot);
    expect(JSON.parse(JSON.stringify(disk))).toEqual(diskSnapshot);
  });
});

describe("cloneSidecarData / countersOfSidecar", () => {
  it("深拷贝：记录/数组/卡片/meta entry 引用隔离", () => {
    const src = makeSidecar(
      {
        displayOrder: ["q1", "q2"],
        answeredQuestions: { q1: "A" },
        memoryCards: { q1: cardFor() },
        memoryPendingNew: ["q2"],
        dailyAnswers: { [dayKey(0)]: 2 },
      },
      { q1: { tags: "#t", ts: 5 } }
    );

    const clone = cloneSidecarData(src);
    expect(clone).toEqual(src);
    expect(clone).not.toBe(src);
    expect(clone.state).not.toBe(src.state);
    expect(clone.meta).not.toBe(src.meta);
    expect(clone.meta.q1).not.toBe(src.meta.q1);
    expect(clone.state.answeredQuestions).not.toBe(src.state.answeredQuestions);
    expect(clone.state.displayOrder).not.toBe(src.state.displayOrder);
    expect(clone.state.memoryCards?.q1).not.toBe(src.state.memoryCards?.q1);
    expect(clone.state.memoryPendingNew).not.toBe(src.state.memoryPendingNew);
    expect(clone.state.dailyAnswers).not.toBe(src.state.dailyAnswers);

    clone.state.answeredQuestions.q1 = "B";
    clone.state.displayOrder.push("q3");
    clone.state.memoryCards!.q1.reps = 99;
    clone.state.memoryPendingNew!.push("q9");
    clone.state.dailyAnswers![dayKey(0)] = 99;
    clone.meta.q1.tags = "#mutated";

    expect(src.state.answeredQuestions.q1).toBe("A");
    expect(src.state.displayOrder).toEqual(["q1", "q2"]);
    expect(src.state.memoryCards?.q1.reps).toBe(4);
    expect(src.state.memoryPendingNew).toEqual(["q2"]);
    expect(src.state.dailyAnswers?.[dayKey(0)]).toBe(2);
    expect(src.meta.q1.tags).toBe("#t");
  });

  it("countersOfSidecar(null) 返回全 0 基线", () => {
    expect(countersOfSidecar(null)).toEqual({
      correct: 0,
      wrong: 0,
      daily: {},
    });
  });

  it("countersOfSidecar 复制 dailyAnswers（不与源共享引用）", () => {
    const src = makeSidecar({
      correctCount: 3,
      wrongCount: 1,
      dailyAnswers: { [dayKey(0)]: 2 },
    });
    const baseline = countersOfSidecar(src);
    baseline.daily[dayKey(0)] = 99;
    expect(src.state.dailyAnswers?.[dayKey(0)]).toBe(2);
  });
});
