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

  it("记忆卡片按较新 ts 胜，无 ts 时回退源时间戳", () => {
    const base = baseSidecar();
    const conflict: SidecarConflictSource = {
      path: "x",
      tsMs: BASE_TS - 100,
      data: {
        ...baseSidecar(),
        state: {
          ...baseSidecar().state,
          memoryCards: {
            // 无 ts → 源 ts（较旧）参与，base 卡片胜
            q1: cardFor({ due: "2026-03-01T00:00:00.000Z" }),
            // base 无 q2 卡 → 补入
            q2: cardFor({ ts: BASE_TS - 100 }),
          },
        },
      },
    };
    const res = mergeSidecarData(base, BASE_TS, [conflict]);
    expect(res.data.state.memoryCards!.q1.due).toBe("2026-02-01T00:00:00.000Z");
    expect(res.data.state.memoryCards!.q2.ts).toBe(BASE_TS - 100);
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
});
