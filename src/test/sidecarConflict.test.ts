import { describe, it, expect } from "vitest";
import type { Vault, Plugin } from "obsidian";
import {
  findSidecarConflictPaths,
  mergeSidecarData,
  normalizeSidecar,
  SidecarData,
  SidecarConflictSource,
} from "../sidecar";
import { StateManager } from "../stateManager";
import { normalizeMemoryCard } from "../utils";
import { validSidecar, cardFor } from "./fixtures";

describe("findSidecarConflictPaths", () => {
  const content = "vault/执照认证2026去重.cqv";

  it("识别 macOS（空格序号 2 起）与 Windows（括号序号 1 起）两种 sidecar 冲突命名", () => {
    const files = [
      "vault/执照认证2026去重.cqv.sidecar.json", // 规范 sidecar（不匹配）
      "vault/执照认证2026去重.cqv.sidecar 2.json",
      "vault/执照认证2026去重.cqv.sidecar 10.json",
      "vault/执照认证2026去重.cqv.sidecar(1).json",
      "vault/执照认证2026去重.cqv.sidecar(2)(1).json",
    ];
    expect(findSidecarConflictPaths(files, content)).toEqual(files.slice(1));
  });

  it("识别主文件被冲突后其 sidecar（.cqv 2.sidecar.json）与正则元字符文件名", () => {
    const files = [
      "vault/执照认证2026去重.cqv 2.sidecar.json",
      "vault/执照认证2026去重.cqv(1).sidecar.json",
    ];
    expect(findSidecarConflictPaths(files, content)).toEqual(files);
  });

  it("排除 tmp/bak/merged 归档、用户命名的空格序号 1、无关文件", () => {
    const files = [
      "vault/执照认证2026去重.cqv.sidecar.json.tmp",
      "vault/执照认证2026去重.cqv.sidecar.json.bak",
      "vault/执照认证2026去重.cqv.sidecar 2.json.merged", // 已归档
      "vault/执照认证2026去重.cqv.sidecar 1.json", // 空格序号 1 视为用户命名
      "vault/其它题库.cqv.sidecar 2.json", // 不同题库
      "vault/执照认证2026去重.cqv", // 主文件
      "vault/执照认证2026去重.cqv.sidecar.jsonx", // 后缀不同
    ];
    expect(findSidecarConflictPaths(files, content)).toEqual([]);
  });

  it("括号序号 (1) 是合法冲突（Windows iCloud 从 1 起）", () => {
    expect(
      findSidecarConflictPaths(["b.cqv.sidecar(1).json"], "b.cqv")
    ).toEqual(["b.cqv.sidecar(1).json"]);
  });
});

function baseSidecar(): SidecarData {
  return {
    version: 1,
    meta: {
      q1: { favorite: "1" },
      q2: { repeat: "" },
    },
    state: {
      ...validSidecar().state,
      currentIndex: 7,
      correctCount: 3,
      wrongCount: 1,
      answeredQuestions: { q1: "A", q2: "" },
      memoryCards: { q1: cardFor({ due: "2026-02-01T00:00:00.000Z" }) },
    },
  };
}

describe("mergeSidecarData", () => {
  const BASE_TS = 1_000_000;

  it("answered 取并集，同 key 以 base 为准，addedAnswers/addedAnswerIds 只计副本补入", () => {
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS - 100,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          answeredQuestions: { q1: "B", q3: "C" },
        },
      },
    };
    const res = mergeSidecarData(baseSidecar(), BASE_TS, [conflict]);
    expect(res.data.state.answeredQuestions).toEqual({ q1: "A", q2: "", q3: "C" });
    expect(res.addedAnswers).toBe(1);
    expect(res.addedAnswerIds).toEqual(["q3"]);
    expect(res.mergedSources).toBe(1);
  });

  it("meta 缺失字段由副本补入；冲突字段较新 ts 胜；相同 ts base 胜", () => {
    const base = baseSidecar();
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS - 100,
      data: {
        ...baseSidecar(),
        meta: {
          q1: { favorite: "", ts: BASE_TS + 50 }, // 比 base 新 → 副本胜
          q2: { repeat: "1", ts: BASE_TS - 50 }, // 比 base 旧 → base 胜
          q3: { mastered: "1" }, // base 缺失 → 补入
        },
        state: baseSidecar().state,
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    // base 的 q1 无 ts → 以源 ts（BASE_TS）参与，副本 entry ts 更新 → 副本胜
    expect(res.data.meta.q1.favorite).toBe("");
    expect(res.data.meta.q2.repeat).toBe(""); // base 的空串遮蔽语义保留
    expect(res.data.meta.q3).toEqual({ mastered: "1", ts: BASE_TS - 100 });
  });

  it("无 lastReview 时回退 card.ts/源时间戳取新，无 ts 时用源时间戳", () => {
    const base = baseSidecar();
    base.state.memoryCards = {
      q1: cardFor({ due: "2026-02-01T00:00:00.000Z", lastReview: "" }),
    };
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS - 100,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            // lastReview 为空、无 ts → 源 ts（较旧）参与，base 卡片胜
            q1: cardFor({ due: "2026-03-01T00:00:00.000Z", lastReview: "" }),
            // base 无 q2 卡 → 补入
            q2: cardFor({ ts: BASE_TS - 100, lastReview: "" }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    expect(res.data.state.memoryCards!.q1.due).toBe("2026-02-01T00:00:00.000Z");
    expect(res.data.state.memoryCards!.q2.ts).toBe(BASE_TS - 100);
  });

  it("卡片按 lastReview 取新：base lastReview 较新时，副本更新的 ts 不能翻盘（污染场景）", () => {
    const base = baseSidecar();
    base.state.memoryCards = {
      q1: cardFor({
        due: "2026-02-01T00:00:00.000Z",
        lastReview: "2026-08-25T00:00:00.000Z",
      }),
    };
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS + 999_999,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            q1: cardFor({
              due: "2026-03-01T00:00:00.000Z",
              lastReview: "2026-08-18T00:00:00.000Z",
              ts: BASE_TS + 999_999,
            }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, BASE_TS + 2_000_000, [conflict]);
    expect(res.data.state.memoryCards!.q1.due).toBe("2026-02-01T00:00:00.000Z");
    expect(res.data.state.memoryCards!.q1.lastReview).toBe(
      "2026-08-25T00:00:00.000Z"
    );
  });

  it("事故回归：base 卡 ts 被盖成今天、lastReview 旧 → 仍取 lastReview 较新的副本，输出 ts 归一为 lastReviewMs", () => {
    const pollutedToday = Date.parse("2026-09-12T10:00:00.000Z");
    const base = baseSidecar();
    base.state.memoryCards = {
      q1: cardFor({
        due: "2026-02-01T00:00:00.000Z",
        lastReview: "2026-08-18T00:00:00.000Z",
        ts: pollutedToday,
      }),
    };
    const sourceReview = "2026-08-25T00:00:00.000Z";
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: 1000, // 副本文件时间远早于被污染的 base ts
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            q1: cardFor({
              due: "2026-03-01T00:00:00.000Z",
              lastReview: sourceReview,
            }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, pollutedToday, [conflict]);
    expect(res.data.state.memoryCards!.q1.due).toBe("2026-03-01T00:00:00.000Z");
    expect(res.data.state.memoryCards!.q1.lastReview).toBe(sourceReview);
    expect(res.data.state.memoryCards!.q1.ts).toBe(Date.parse(sourceReview));
  });

  it("双方 lastReview 均为空 → 仍按 ts/源时间回退决胜；完全平局 base 优先", () => {
    const base = baseSidecar();
    base.state.memoryCards = {
      q1: cardFor({
        due: "2026-02-01T00:00:00.000Z",
        lastReview: "",
        ts: BASE_TS,
      }),
      q2: cardFor({
        due: "2026-02-01T00:00:00.000Z",
        lastReview: "",
        ts: BASE_TS,
      }),
    };
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            // q1：副本 ts 更新 → 副本胜
            q1: cardFor({
              due: "2026-03-01T00:00:00.000Z",
              lastReview: "",
              ts: BASE_TS + 100,
            }),
            // q2：与 base 完全平局（ts 相同）→ base 胜
            q2: cardFor({
              due: "2026-03-01T00:00:00.000Z",
              lastReview: "",
              ts: BASE_TS,
            }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    expect(res.data.state.memoryCards!.q1.due).toBe("2026-03-01T00:00:00.000Z");
    expect(res.data.state.memoryCards!.q2.due).toBe("2026-02-01T00:00:00.000Z");
  });

  it("输出卡 ts 归一：副本卡片无 ts 且 lastReview 较新 → ts=lastReviewMs", () => {
    const base = baseSidecar();
    base.state.memoryCards = {};
    const sourceReview = "2026-08-25T00:00:00.000Z";
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: 1, // 源文件时间远早于 lastReview
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            q7: cardFor({ lastReview: sourceReview }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    expect(res.data.state.memoryCards!.q7.ts).toBe(Date.parse(sourceReview));
    expect(res.data.state.memoryCards!.q7.ts!).toBeGreaterThan(1);
  });

  it("原型键题 id 不丢卡：constructor/valueOf 卡片按 lastReview 规则合并并保留", () => {
    const base = baseSidecar();
    base.state.memoryCards = {
      ["constructor"]: cardFor({
        due: "2026-02-01T00:00:00.000Z",
        lastReview: "2026-08-25T00:00:00.000Z",
      }),
    };
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS + 10,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            // base 的 lastReview 较新 → 副本更新的 ts 不能翻盘（旧实现直接丢卡）
            ["constructor"]: cardFor({
              due: "2026-03-01T00:00:00.000Z",
              lastReview: "2026-08-18T00:00:00.000Z",
              ts: BASE_TS + 10,
            }),
            // 仅副本存在 → 必须补入（旧实现同样丢卡）
            ["valueOf"]: cardFor({
              due: "2026-04-01T00:00:00.000Z",
              lastReview: "2026-08-20T00:00:00.000Z",
            }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    const cards = res.data.state.memoryCards!;
    expect(Object.prototype.hasOwnProperty.call(cards, "constructor")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cards, "valueOf")).toBe(true);
    expect(cards["constructor"].due).toBe("2026-02-01T00:00:00.000Z");
    expect(cards["valueOf"].due).toBe("2026-04-01T00:00:00.000Z");
  });

  it("原型键题 id 不丢 meta：toString 字段按较新 ts 合并、constructor 条目保留", () => {
    const base = baseSidecar();
    base.meta = {
      ["toString"]: { tags: "#base", ts: BASE_TS - 50 },
      ["constructor"]: { repeat: "base-only" },
    };
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS,
      data: {
        ...baseSidecar(),
        meta: {
          ["toString"]: { tags: "#source", ts: BASE_TS + 50 },
        },
        state: baseSidecar().state,
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    expect(Object.prototype.hasOwnProperty.call(res.data.meta, "toString")).toBe(
      true
    );
    expect(
      Object.prototype.hasOwnProperty.call(res.data.meta, "constructor")
    ).toBe(true);
    expect(res.data.meta["toString"]).toEqual({
      tags: "#source",
      ts: BASE_TS + 50,
    });
    expect(res.data.meta["constructor"]).toEqual({
      repeat: "base-only",
      ts: BASE_TS,
    });
  });

  it("标量（位置/筛选/统计）整体保留 base", () => {
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS + 100,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          currentIndex: 99,
          filterText: "别的设备筛选",
          correctCount: 100,
          displayOrder: ["z", "y"],
        },
      },
    };
    const res = mergeSidecarData(baseSidecar(), BASE_TS, [conflict]);
    expect(res.data.state.currentIndex).toBe(7);
    expect(res.data.state.filterText).toBe("");
    expect(res.data.state.correctCount).toBe(3);
    expect(res.data.state.displayOrder).toEqual(["q1", "q2"]);
  });

  it("幂等：对已合并结果重放相同副本不改变数据", () => {
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS - 100,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          answeredQuestions: { q1: "A", q2: "", q3: "C" },
        },
      },
    };
    const once = mergeSidecarData(baseSidecar(), BASE_TS, [conflict]);
    const twice = mergeSidecarData(once.data, BASE_TS, [conflict]);
    expect(twice.data.state.answeredQuestions).toEqual(
      once.data.state.answeredQuestions
    );
    expect(twice.addedAnswers).toBe(0);
    expect(twice.addedAnswerIds).toEqual([]);
  });

  it("双方都无记忆卡片时保持 undefined（不写入空对象）", () => {
    const base = baseSidecar();
    base.state.memoryCards = undefined;
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS,
      data: { ...baseSidecar(), state: { ...baseSidecar().state, memoryCards: undefined } },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    expect(res.data.state.memoryCards).toBeUndefined();
  });
});

describe("时间戳字段归一化", () => {
  it("normalizeSidecar 保留 state.updatedAt 与 meta.ts，非法值丢弃", () => {
    const data = normalizeSidecar({
      version: 1,
      meta: { q1: { favorite: "1", ts: 123 }, q2: { tags: "t", ts: "bad" } },
      state: { updatedAt: 456 },
    });
    expect(data!.meta.q1.ts).toBe(123);
    expect(data!.meta.q2.ts).toBeUndefined();
    expect(data!.state.updatedAt).toBe(456);
  });

  it("normalizeMemoryCard 保留合法 ts，非法值丢弃", () => {
    expect(normalizeMemoryCard({ ...cardFor(), ts: 789 })!.ts).toBe(789);
    expect(normalizeMemoryCard({ ...cardFor(), ts: "x" })!.ts).toBeUndefined();
  });
});

/** 内存文件表 → 最小 Vault 桩（含 list/stat，覆盖冲突检测/合并用到的 adapter 方法）。 */
function stubVault(
  files: Record<string, string>,
  mtimes: Record<string, number> = {}
): Vault {
  return {
    adapter: {
      exists: async (p: string) => p in files,
      read: async (p: string) => {
        if (!(p in files)) throw new Error("not found: " + p);
        return files[p];
      },
      write: async (p: string, c: string) => {
        files[p] = c;
      },
      rename: async (from: string, to: string) => {
        files[to] = files[from];
        delete files[from];
      },
      remove: async (p: string) => {
        delete files[p];
      },
      list: async (dir: string) => ({
        files: Object.keys(files)
          .filter((f) => !f.slice(dir === "/" ? 0 : dir.length + 1).includes("/"))
          .map((f) => f),
        folders: [],
      }),
      stat: async (p: string) => ({ mtime: mtimes[p] ?? 0, type: "file", size: 0 }),
    },
  } as unknown as Vault;
}

function stubPlugin(vault: Vault): Plugin {
  return {
    app: { vault },
    loadData: async () => ({}),
    saveData: async () => {},
  } as unknown as Plugin;
}

describe("StateManager.mergeSidecarConflicts（端到端）", () => {
  const filters = { favorite: "", mastered: "", repeat: "", wrong: "" };

  it("合并副本并入当前状态、写盘并把副本归档为 .merged", async () => {
    const base = validSidecar(); // answered {q1:"A"}, meta {q1:{tags:"#t"}}
    const conflict: SidecarData = {
      version: 1,
      meta: { q2: { repeat: "1" } },
      state: {
        ...validSidecar().state,
        answeredQuestions: { q1: "B", q2: "C" },
        updatedAt: undefined,
      },
    };
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(base),
      "bank.csv.sidecar 2.json": JSON.stringify(conflict),
    };
    const vault = stubVault(files, { "bank.csv.sidecar 2.json": 12345 });
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");
    expect(outcome.mergedSources).toBe(1);
    expect(outcome.addedAnswers).toBe(1); // q2 并入，q1 同 key 以当前为准
    expect(outcome.archived).toBe(1);

    // 内存：并集 + meta 补入
    const st = sm.getState()!;
    expect(st.answeredQuestions).toEqual({ q1: "A", q2: "C" });
    expect(sm.getMeta().q2).toEqual({ repeat: "1", ts: 12345 });

    // 磁盘：规范文件已写入合并结果（含 updatedAt 时间戳），副本已改名归档
    const written = JSON.parse(files["bank.csv.sidecar.json"]);
    expect(written.state.answeredQuestions).toEqual({ q1: "A", q2: "C" });
    expect(typeof written.state.updatedAt).toBe("number");
    expect(files["bank.csv.sidecar 2.json"]).toBeUndefined();
    expect(files["bank.csv.sidecar 2.json.merged"]).toBeDefined();
  });

  it("损坏副本跳过并计入 unreadable，不阻塞其余副本", async () => {
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(validSidecar()),
      "bank.csv.sidecar 2.json": "{ broken",
      "bank.csv.sidecar(1).json": JSON.stringify({
        ...validSidecar(),
        state: { ...validSidecar().state, answeredQuestions: { q9: "A" } },
      }),
    };
    const vault = stubVault(files);
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");
    expect(outcome.mergedSources).toBe(1);
    expect(outcome.unreadable).toBe(1);
    expect(sm.getState()!.answeredQuestions).toEqual({ q1: "A", q9: "A" });
    // 损坏副本同样归档（避免每次打开都弹合并提示）
    expect(outcome.archived).toBe(2);
  });

  it("无冲突副本时返回 none", async () => {
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(validSidecar()),
    };
    const vault = stubVault(files);
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);
    expect((await sm.mergeSidecarConflicts()).status).toBe("none");
  });

  it("answeredQuestions 对象引用保持不变（视图持有的状态对象原地可见）", async () => {
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(validSidecar()),
      "bank.csv.sidecar 2.json": JSON.stringify({
        ...validSidecar(),
        state: { ...validSidecar().state, answeredQuestions: { q5: "D" } },
      }),
    };
    const vault = stubVault(files);
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);
    const st = sm.getState()!;
    const answeredRef = st.answeredQuestions;
    await sm.mergeSidecarConflicts();
    expect(st.answeredQuestions).toBe(answeredRef);
    expect(answeredRef.q5).toBe("D");
  });

  it("base updatedAt 旧（100）、副本 mtime 新（500）：同 lastReview 卡片取副本（base 不再用 Date.now() 兜底）", async () => {
    const review = "2026-08-20T00:00:00.000Z";
    const base = validSidecar();
    base.state.updatedAt = 100;
    base.state.memoryCards = {
      q1: cardFor({ due: "2026-09-01T00:00:00.000Z", lastReview: review }),
    };
    const conflict: SidecarData = {
      version: 1,
      meta: {},
      state: {
        ...validSidecar().state,
        updatedAt: undefined,
        memoryCards: {
          q1: cardFor({ due: "2026-10-01T00:00:00.000Z", lastReview: review }),
        },
      },
    };
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(base),
      "bank.csv.sidecar 2.json": JSON.stringify(conflict),
    };
    const vault = stubVault(files, { "bank.csv.sidecar 2.json": 500 });
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");
    // 副本 mtime 500 > base updatedAt 100 → 同 lastReview 下副本卡片胜；
    // 旧实现 base 用 Date.now() 兜底，会错误地压掉副本
    expect(sm.getState()!.memoryCards!.q1.due).toBe(
      "2026-10-01T00:00:00.000Z"
    );
  });

  it("base updatedAt 新（900）、副本 mtime 旧（500）：同 lastReview 卡片取 base", async () => {
    const review = "2026-08-20T00:00:00.000Z";
    const base = validSidecar();
    base.state.updatedAt = 900;
    base.state.memoryCards = {
      q1: cardFor({ due: "2026-09-01T00:00:00.000Z", lastReview: review }),
    };
    const conflict: SidecarData = {
      version: 1,
      meta: {},
      state: {
        ...validSidecar().state,
        updatedAt: undefined,
        memoryCards: {
          q1: cardFor({ due: "2026-10-01T00:00:00.000Z", lastReview: review }),
        },
      },
    };
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(base),
      "bank.csv.sidecar 2.json": JSON.stringify(conflict),
    };
    const vault = stubVault(files, { "bank.csv.sidecar 2.json": 500 });
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");
    expect(sm.getState()!.memoryCards!.q1.due).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });

  it("事故回归：base 卡片 ts 被盖成今天且 lastReview 旧，副本 lastReview 较新但 mtime 更旧 → 内存与写盘均取副本", async () => {
    const pollutedToday = Date.parse("2026-09-12T10:00:00.000Z");
    const sourceReview = "2026-08-25T00:00:00.000Z";
    const base = validSidecar();
    base.state.updatedAt = pollutedToday;
    base.state.memoryCards = {
      q1: cardFor({
        due: "2026-09-01T00:00:00.000Z",
        lastReview: "2026-08-18T00:00:00.000Z",
        ts: pollutedToday,
      }),
    };
    const conflict: SidecarData = {
      version: 1,
      meta: {},
      state: {
        ...validSidecar().state,
        updatedAt: undefined,
        memoryCards: {
          q1: cardFor({
            due: "2026-10-01T00:00:00.000Z",
            lastReview: sourceReview,
          }),
        },
      },
    };
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(base),
      "bank.csv.sidecar 2.json": JSON.stringify(conflict),
    };
    const vault = stubVault(files, { "bank.csv.sidecar 2.json": 1000 });
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");

    const st = sm.getState()!;
    expect(st.memoryCards!.q1.lastReview).toBe(sourceReview);
    expect(st.memoryCards!.q1.ts).toBe(Date.parse(sourceReview));

    const written = JSON.parse(files["bank.csv.sidecar.json"]);
    expect(written.state.memoryCards.q1.lastReview).toBe(sourceReview);
    expect(written.state.memoryCards.q1.ts).toBe(Date.parse(sourceReview));
  });

  it("recovered 路径：base 时间戳取 .bak 的 mtime，不取被重写的 canonical（重写后 mtime≈now）", async () => {
    const review = "2026-08-20T00:00:00.000Z";
    const baseBak = validSidecar();
    baseBak.state.updatedAt = undefined;
    baseBak.meta = { q1: { tags: "#base" } }; // 无 entry.ts 的 meta 字段
    baseBak.state.memoryCards = {
      q1: cardFor({ due: "2026-09-01T00:00:00.000Z", lastReview: review }),
    };
    const conflict: SidecarData = {
      version: 1,
      meta: { q1: { tags: "#conflict" } },
      state: {
        ...validSidecar().state,
        updatedAt: undefined,
        memoryCards: {
          q1: cardFor({ due: "2026-10-01T00:00:00.000Z", lastReview: review }),
        },
      },
    };
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": "{ broken", // canonical 损坏 → 从 .bak 恢复并重写
      "bank.csv.sidecar.json.bak": JSON.stringify(baseBak),
      "bank.csv.sidecar 2.json": JSON.stringify(conflict),
    };
    const vault = stubVault(files, {
      "bank.csv.sidecar.json.bak": 1000,
      // readSidecar 恢复用 writeSidecar 重写 canonical：模拟其 mtime≈now。
      // 旧实现 stat canonical 会取到 now，导致恢复出的旧 bak 被当成最新。
      "bank.csv.sidecar.json": Date.now(),
      "bank.csv.sidecar 2.json": 2000,
    });
    const sm = new StateManager(stubPlugin(vault));
    const loadResult = await sm.loadSidecar("bank.csv", filters);
    expect(loadResult.status).toBe("recovered");

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");
    // 同 lastReview、双方卡片均无 ts：副本 mtime 2000 > bak mtime 1000 → 取副本
    expect(sm.getState()!.memoryCards!.q1.due).toBe(
      "2026-10-01T00:00:00.000Z"
    );
    // meta 无 entry.ts：副本源时间戳 2000 > base(bak) 1000 → 副本字段胜
    expect(sm.getMeta().q1.tags).toBe("#conflict");
  });

  it("saveStateImmediately 刷新 base 时间戳：load 旧（100）后写盘，同 lastReview 且双方无 ts 时取 base", async () => {
    const review = "2026-08-20T00:00:00.000Z";
    const base = validSidecar();
    base.state.updatedAt = 100;
    base.state.memoryCards = {
      q1: cardFor({ due: "2026-09-01T00:00:00.000Z", lastReview: review }),
    };
    const conflict: SidecarData = {
      version: 1,
      meta: {},
      state: {
        ...validSidecar().state,
        updatedAt: undefined,
        memoryCards: {
          q1: cardFor({ due: "2026-10-01T00:00:00.000Z", lastReview: review }),
        },
      },
    };
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(base),
      "bank.csv.sidecar 2.json": JSON.stringify(conflict),
    };
    const vault = stubVault(files, { "bank.csv.sidecar 2.json": 500 });
    const sm = new StateManager(stubPlugin(vault));
    await sm.loadSidecar("bank.csv", filters);
    await sm.saveStateImmediately(sm.getState()!);

    // 写盘已带新 updatedAt（in-file），base marker 亦应刷新为 now
    const written = JSON.parse(files["bank.csv.sidecar.json"]);
    expect(written.state.updatedAt).toBeGreaterThan(100);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");
    // marker 刷新为 now（> 副本 mtime 500）→ 同 lastReview 下 base 卡片胜；
    // 若 persistNow 未刷新 marker（仍为 100），副本会错误胜出
    expect(sm.getState()!.memoryCards!.q1.due).toBe(
      "2026-09-01T00:00:00.000Z"
    );
  });
});
