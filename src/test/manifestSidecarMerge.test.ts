import { describe, it, expect } from "vitest";
import type { Vault, Plugin } from "obsidian";
import { StateManager } from "../stateManager";
import { sidecarPathFor, SidecarData } from "../sidecar";
import { cardFor } from "./fixtures";

/** 内存文件表 → 最小 Vault 桩（覆盖 read/write/rename/stat）。 */
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
      stat: async (p: string) => ({
        mtime: mtimes[p] ?? 1_000_000,
        type: "file",
        size: 0,
      }),
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

const DEFAULT_FILTERS = { favorite: "", mastered: "", repeat: "", wrong: "" };

/** manifest 目标空 sidecar（无进度，但带会话字段，用于验证保留语义）。 */
function emptyTargetSidecar(): SidecarData {
  return {
    version: 1,
    meta: {},
    state: {
      currentIndex: 1,
      correctCount: 0,
      wrongCount: 0,
      displayOrder: ["t1", "t2"],
      filterText: "abc",
      filterTags: "",
      filterTagsExcluded: "",
      filterCat1: "",
      filterCat2: "",
      filterCat3: "",
      filterFavorite: "1",
      filterMastered: "",
      filterRepeat: "",
      filterWrong: "",
      filterUnanswered: "",
      answeredQuestions: {},
      updatedAt: 1_000_000,
    },
  };
}

/** 组成 sidecar：按需给出进度字段。 */
function componentSidecar(overrides: {
  correctCount?: number;
  wrongCount?: number;
  answered?: Record<string, string>;
  meta?: SidecarData["meta"];
  memoryCards?: SidecarData["state"]["memoryCards"];
  dailyAnswers?: Record<string, number>;
  updatedAt?: number;
}): SidecarData {
  return {
    version: 1,
    meta: overrides.meta ?? {},
    state: {
      currentIndex: 0,
      correctCount: overrides.correctCount ?? 0,
      wrongCount: overrides.wrongCount ?? 0,
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
      answeredQuestions: overrides.answered ?? {},
      memoryCards: overrides.memoryCards,
      dailyAnswers: overrides.dailyAnswers,
      updatedAt: overrides.updatedAt ?? 1_000_000,
    },
  };
}

function setup(initial: Record<string, SidecarData>): {
  files: Record<string, string>;
  manager: StateManager;
  vault: Vault;
} {
  const files: Record<string, string> = {};
  for (const [path, data] of Object.entries(initial)) {
    files[path] = JSON.stringify(data);
  }
  const vault = stubVault(files);
  const manager = new StateManager(stubPlugin(vault));
  return { files, manager, vault };
}

function readJson(files: Record<string, string>, path: string): SidecarData {
  return JSON.parse(files[path]) as SidecarData;
}

describe("mergeManifestComponentSidecars", () => {
  const TARGET = "bank/复合题库/manifest";
  const CQV = "bank/复合题库/执照认证.cqv";
  const CSV = "bank/复合题库/简答题库.csv";

  it("目标为空：并入两个组成 sidecar 的进度（累计计数、并集、每日求和、保留会话字段）", async () => {
    const { files, manager } = setup({
      [sidecarPathFor(TARGET)]: emptyTargetSidecar(),
      [sidecarPathFor(CQV)]: componentSidecar({
        correctCount: 2,
        wrongCount: 1,
        answered: { q1: "A", q2: "B" },
        meta: { q1: { favorite: "1" } },
        memoryCards: { q1: cardFor() },
        dailyAnswers: { "2026-10-01": 2 },
        updatedAt: 1_000_000,
      }),
      [sidecarPathFor(CSV)]: componentSidecar({
        correctCount: 1,
        wrongCount: 0,
        answered: { q3: "C" },
        meta: { q2: { mastered: "1" } },
        memoryCards: { q2: cardFor({ lastReview: "2025-12-31T00:00:00.000Z" }) },
        dailyAnswers: { "2026-10-01": 1, "2026-10-02": 1 },
        updatedAt: 2_000_000,
      }),
    });

    const result = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV, CSV],
      DEFAULT_FILTERS
    );

    expect(result.status).toBe("merged");
    expect(result.mergedComponents).toBe(2);
    expect(result.correctCount).toBe(3);
    expect(result.wrongCount).toBe(1);
    expect(result.addedAnswers).toBe(3);

    const merged = readJson(files, sidecarPathFor(TARGET));
    expect(merged.state.correctCount).toBe(3);
    expect(merged.state.wrongCount).toBe(1);
    expect(Object.keys(merged.state.answeredQuestions).sort()).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
    expect(Object.keys(merged.meta).sort()).toEqual(["q1", "q2"]);
    expect(merged.meta.q1.favorite).toBe("1");
    expect(merged.meta.q2.mastered).toBe("1");
    expect(Object.keys(merged.state.memoryCards ?? {}).sort()).toEqual([
      "q1",
      "q2",
    ]);
    expect(merged.state.dailyAnswers).toEqual({
      "2026-10-01": 3,
      "2026-10-02": 1,
    });
    // 会话字段保留 target
    expect(merged.state.displayOrder).toEqual(["t1", "t2"]);
    expect(merged.state.currentIndex).toBe(1);
    expect(merged.state.filterText).toBe("abc");
    expect(merged.state.filterFavorite).toBe("1");
    // 组成 sidecar 不删除（保留回退）
    expect(files[sidecarPathFor(CQV)]).toBeDefined();
    expect(files[sidecarPathFor(CSV)]).toBeDefined();
  });

  it("目标已有普通题进度：仍并入组件（图片/简答）补全，计数/每日取 max、会话字段保留", async () => {
    const existing: SidecarData = {
      ...emptyTargetSidecar(),
      meta: {},
      state: {
        ...emptyTargetSidecar().state,
        correctCount: 5,
        wrongCount: 0,
        answeredQuestions: { own: "A" },
        dailyAnswers: { "2026-10-01": 1 },
      },
    };
    const { files, manager } = setup({
      [sidecarPathFor(TARGET)]: existing,
      [sidecarPathFor(CQV)]: componentSidecar({
        correctCount: 2,
        wrongCount: 1,
        answered: { q1: "A" },
        meta: { q1: { favorite: "1" } },
        memoryCards: { q1: cardFor() },
        dailyAnswers: { "2026-10-01": 2, "2026-10-02": 1 },
      }),
    });

    const result = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV],
      DEFAULT_FILTERS
    );

    expect(result.status).toBe("merged");
    expect(result.mergedComponents).toBe(1);
    expect(result.correctCount).toBe(5); // max(target 5, 组件 2)
    expect(result.wrongCount).toBe(1); // max(target 0, 组件 1)

    const merged = readJson(files, sidecarPathFor(TARGET));
    expect(Object.keys(merged.state.answeredQuestions).sort()).toEqual([
      "own",
      "q1",
    ]);
    expect(Object.keys(merged.state.memoryCards ?? {})).toEqual(["q1"]);
    expect(merged.meta.q1?.favorite).toBe("1");
    expect(merged.state.dailyAnswers).toEqual({
      "2026-10-01": 2,
      "2026-10-02": 1,
    });
    // 会话字段与目标普通题进度都不被组件覆盖
    expect(merged.state.displayOrder).toEqual(["t1", "t2"]);
    expect(merged.state.currentIndex).toBe(1);
    expect(merged.state.filterText).toBe("abc");
  });

  it("重复运行 → skipped/no-change，不写盘、计数不翻倍", async () => {
    const { files, manager } = setup({
      [sidecarPathFor(TARGET)]: {
        ...emptyTargetSidecar(),
        state: {
          ...emptyTargetSidecar().state,
          correctCount: 5,
          answeredQuestions: { own: "A" },
        },
      },
      [sidecarPathFor(CQV)]: componentSidecar({
        correctCount: 2,
        wrongCount: 1,
        answered: { q1: "A" },
        dailyAnswers: { "2026-10-01": 2 },
      }),
    });

    const first = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV],
      DEFAULT_FILTERS
    );
    expect(first.status).toBe("merged");
    const afterFirst = files[sidecarPathFor(TARGET)];

    const second = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV],
      DEFAULT_FILTERS
    );
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("no-change");
    // 无变化不写盘（内容逐字节相同）
    expect(files[sidecarPathFor(TARGET)]).toBe(afterFirst);

    const merged = readJson(files, sidecarPathFor(TARGET));
    expect(merged.state.correctCount).toBe(5);
    expect(merged.state.wrongCount).toBe(1);
    expect(merged.state.dailyAnswers).toEqual({ "2026-10-01": 2 });
    expect(Object.keys(merged.state.answeredQuestions).sort()).toEqual([
      "own",
      "q1",
    ]);
  });

  it("组成 sidecar 均无进度 → skipped/no-component-progress，不创建目标文件", async () => {
    const { files, manager } = setup({
      [sidecarPathFor(CQV)]: componentSidecar({}),
      [sidecarPathFor(CSV)]: componentSidecar({ dailyAnswers: {} }),
    });

    const result = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV, CSV, "", TARGET],
      DEFAULT_FILTERS
    );

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no-component-progress");
    expect(files[sidecarPathFor(TARGET)]).toBeUndefined();
  });

  it("目标缺失 → 以空状态为 base 合并成功，displayOrder 为空（后续由视图重建）", async () => {
    const { files, manager } = setup({
      [sidecarPathFor(CQV)]: componentSidecar({
        correctCount: 4271,
        wrongCount: 1608,
        answered: { q1: "A", q2: "B" },
        meta: { q1: { tags: "#t" } },
      }),
      [sidecarPathFor(CSV)]: componentSidecar({
        correctCount: 0,
        wrongCount: 0,
        answered: { q3: "C" },
      }),
    });

    const result = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV, CSV, CQV],
      DEFAULT_FILTERS
    );

    expect(result.status).toBe("merged");
    expect(result.mergedComponents).toBe(2);
    expect(result.correctCount).toBe(4271);
    expect(result.wrongCount).toBe(1608);

    const merged = readJson(files, sidecarPathFor(TARGET));
    expect(merged.state.displayOrder).toEqual([]);
    expect(merged.state.currentIndex).toBe(0);
    expect(Object.keys(merged.state.answeredQuestions).sort()).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
  });

  it("重复调用（目标已非空）→ skipped/no-change，计数不翻倍", async () => {
    const { files, manager } = setup({
      [sidecarPathFor(CQV)]: componentSidecar({
        correctCount: 2,
        wrongCount: 1,
        answered: { q1: "A" },
        dailyAnswers: { "2026-10-01": 2 },
      }),
    });

    const first = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV],
      DEFAULT_FILTERS
    );
    const second = await manager.mergeManifestComponentSidecars(
      TARGET,
      [CQV],
      DEFAULT_FILTERS
    );

    expect(first.status).toBe("merged");
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("no-change");

    const merged = readJson(files, sidecarPathFor(TARGET));
    expect(merged.state.correctCount).toBe(2);
    expect(merged.state.wrongCount).toBe(1);
    expect(merged.state.dailyAnswers).toEqual({ "2026-10-01": 2 });
  });
});
