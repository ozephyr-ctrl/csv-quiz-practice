import { describe, it, expect } from "vitest";
import type { Plugin, Vault } from "obsidian";
import { StateManager } from "../stateManager";
import { sidecarPathFor, SidecarData } from "../sidecar";
import { FakeVault } from "./fakeVault";
import { cardFor } from "./fixtures";

const DEFAULT_FILTERS = { favorite: "", mastered: "", repeat: "", wrong: "" };

function stubPlugin(vault: Vault): Plugin {
  return {
    app: { vault },
    loadData: async () => ({}),
    saveData: async () => {},
  } as unknown as Plugin;
}

/** 构造 sidecar 数据（默认空进度，按需覆盖）。 */
function sidecar(overrides: {
  answered?: Record<string, string>;
  meta?: SidecarData["meta"];
  memoryCards?: SidecarData["state"]["memoryCards"];
  dailyAnswers?: Record<string, number>;
  correctCount?: number;
  wrongCount?: number;
  memoryInitialized?: boolean;
  updatedAt?: number;
  currentIndex?: number;
  displayOrder?: string[];
  filterText?: string;
}): SidecarData {
  return {
    version: 1,
    meta: overrides.meta ?? {},
    state: {
      currentIndex: overrides.currentIndex ?? 0,
      correctCount: overrides.correctCount ?? 0,
      wrongCount: overrides.wrongCount ?? 0,
      displayOrder: overrides.displayOrder ?? [],
      filterText: overrides.filterText ?? "",
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
      memoryInitialized: overrides.memoryInitialized,
      dailyAnswers: overrides.dailyAnswers,
      updatedAt: overrides.updatedAt,
    },
  };
}

describe("StateManager.recoverMergedSidecars", () => {
  const TARGET = "bank/复合题库/manifest";
  const CQV = "bank/复合题库/执照认证.cqv";

  function setup(): { fake: FakeVault; manager: StateManager } {
    const fake = new FakeVault({}, 1_000);
    const manager = new StateManager(stubPlugin(fake.vault));
    return { fake, manager };
  }

  it("把 .merged 归档并入目标：answered/meta/cards 补全、daily 逐日 max、correct/wrong 不变", async () => {
    const { fake, manager } = setup();
    // 目标只有 10/24 的部分进度（冲突合并后丢了另一分支）
    fake.putJson(
      sidecarPathFor(TARGET),
      sidecar({
        answered: { q1: "A" },
        meta: { q1: { tags: "#base", ts: 900 } },
        correctCount: 7,
        wrongCount: 2,
        dailyAnswers: { "2026-10-24": 1 },
        currentIndex: 3,
        displayOrder: ["a", "b"],
        filterText: "筛选",
        updatedAt: 1000,
      })
    );
    // 归档 A：sidecar 自身被冲突后的归档（含 10/24 全量、卡片、meta）
    fake.putJson(`${TARGET}.sidecar 2.json.merged`, sidecar({
      answered: { q1: "B", q2: "C" },
      meta: { q1: { favorite: "1" }, q3: { mastered: "1" } },
      memoryCards: {
        q1: cardFor({ lastReview: "2026-08-01T00:00:00.000Z" }),
      },
      dailyAnswers: { "2026-10-23": 2, "2026-10-24": 5 },
      correctCount: 99,
      wrongCount: 42,
      updatedAt: 2000,
    }));
    // 归档 B：主文件被冲突后的归档（另一分支独有日期/题目）
    fake.putJson(`${TARGET} 2.sidecar.json.merged`, sidecar({
      answered: { q5: "E" },
      memoryCards: {
        q5: cardFor({ lastReview: "2026-08-02T00:00:00.000Z" }),
      },
      dailyAnswers: { "2026-10-22": 4 },
      updatedAt: 3000,
    }));
    // 组件（manifest 组成内容源）的规范 sidecar 归档
    fake.putJson(`${sidecarPathFor(CQV)}.merged`, sidecar({
      answered: { q4: "D" },
      memoryCards: {
        q4: cardFor({ lastReview: "2026-08-03T00:00:00.000Z" }),
      },
      dailyAnswers: { "2026-10-20": 3 },
      memoryInitialized: true,
      updatedAt: 1500,
    }));

    const result = await manager.recoverMergedSidecars(TARGET, [CQV], DEFAULT_FILTERS);

    expect(result.status).toBe("merged");
    expect(result.archives).toBe(3);
    expect(result.addedAnswers).toBe(3); // q2/q4/q5（q1 已存在）
    expect(result.renamed).toBe(3);
    expect(result.renameFailed).toBe(0);

    const merged = fake.readJson<SidecarData>(sidecarPathFor(TARGET));
    // answered 并集，同 key 以当前（target）为准
    expect(merged.state.answeredQuestions).toEqual({
      q1: "A",
      q2: "C",
      q4: "D",
      q5: "E",
    });
    // 累计作答事件数无法从快照反推 → 保持 target 原值
    expect(merged.state.correctCount).toBe(7);
    expect(merged.state.wrongCount).toBe(2);
    // meta / 卡片由归档补全
    expect(merged.meta.q1?.tags).toBe("#base");
    expect(merged.meta.q1?.favorite).toBe("1");
    expect(merged.meta.q3?.mastered).toBe("1");
    expect(Object.keys(merged.state.memoryCards ?? {}).sort()).toEqual([
      "q1",
      "q4",
      "q5",
    ]);
    // 每日逐日取 max（10/24 保留全量 5，另一分支独有日期补入）
    expect(merged.state.dailyAnswers).toEqual({
      "2026-10-20": 3,
      "2026-10-22": 4,
      "2026-10-23": 2,
      "2026-10-24": 5,
    });
    expect(merged.state.memoryInitialized).toBe(true);
    // 会话字段保留 target
    expect(merged.state.currentIndex).toBe(3);
    expect(merged.state.displayOrder).toEqual(["a", "b"]);
    expect(merged.state.filterText).toBe("筛选");

    // 归档改名 .recovered（原路径不再存在）
    for (const archive of [
      `${TARGET}.sidecar 2.json.merged`,
      `${TARGET} 2.sidecar.json.merged`,
      `${sidecarPathFor(CQV)}.merged`,
    ]) {
      expect(fake.readText(archive)).toBeUndefined();
      expect(fake.readText(archive + ".recovered")).toBeDefined();
    }
  });

  it("幂等：第二次运行无 .merged → none，目标内容不变", async () => {
    const { fake, manager } = setup();
    fake.putJson(sidecarPathFor(TARGET), sidecar({ answered: { q1: "A" } }));
    fake.putJson(
      `${TARGET}.sidecar 2.json.merged`,
      sidecar({ answered: { q2: "B" } })
    );

    const first = await manager.recoverMergedSidecars(TARGET, [], DEFAULT_FILTERS);
    expect(first.status).toBe("merged");
    const afterFirst = fake.readText(sidecarPathFor(TARGET));

    const second = await manager.recoverMergedSidecars(TARGET, [], DEFAULT_FILTERS);
    expect(second.status).toBe("none");
    expect(fake.readText(sidecarPathFor(TARGET))).toBe(afterFirst);
  });

  it("目标损坏 → error/target-corrupt，不写盘也不改名", async () => {
    const { fake, manager } = setup();
    fake.foreignWrite(sidecarPathFor(TARGET), "{ broken");
    fake.putJson(
      `${TARGET}.sidecar 2.json.merged`,
      sidecar({ answered: { q2: "B" } })
    );

    const result = await manager.recoverMergedSidecars(TARGET, [], DEFAULT_FILTERS);
    expect(result.status).toBe("error");
    expect(result.reason).toBe("target-corrupt");
    expect(fake.readText(sidecarPathFor(TARGET))).toBe("{ broken");
    expect(fake.readText(`${TARGET}.sidecar 2.json.merged`)).toBeDefined();
    expect(fake.readText(`${TARGET}.sidecar 2.json.merged.recovered`)).toBeUndefined();
  });

  it("写盘失败 → error/write-failed，归档保持原名可重试", async () => {
    const fake = new FakeVault({}, 1_000);
    fake.putJson(sidecarPathFor(TARGET), sidecar({ answered: { q1: "A" } }));
    fake.putJson(
      `${TARGET}.sidecar 2.json.merged`,
      sidecar({ answered: { q1: "A", q2: "B" } })
    );
    const vault = fake.vault as unknown as {
      adapter: { write: (p: string, c: string) => Promise<void> };
    };
    const origWrite = vault.adapter.write.bind(vault.adapter);
    vault.adapter.write = async (p: string, c: string) => {
      if (p === sidecarPathFor(TARGET) + ".tmp") throw new Error("disk full");
      return origWrite(p, c);
    };
    const manager = new StateManager(stubPlugin(vault as unknown as Vault));
    const before = fake.readText(sidecarPathFor(TARGET));

    const result = await manager.recoverMergedSidecars(
      TARGET,
      [],
      DEFAULT_FILTERS
    );
    expect(result.status).toBe("error");
    expect(result.reason).toBe("write-failed");
    expect(fake.readText(sidecarPathFor(TARGET))).toBe(before);
    expect(fake.readText(`${TARGET}.sidecar 2.json.merged`)).toBeDefined();
    expect(fake.readText(`${TARGET}.sidecar 2.json.merged.recovered`)).toBeUndefined();
  });

  it("无归档 → none（不创建目标文件）", async () => {
    const { fake, manager } = setup();
    const result = await manager.recoverMergedSidecars(
      TARGET,
      [CQV],
      DEFAULT_FILTERS
    );
    expect(result.status).toBe("none");
    expect(fake.readText(sidecarPathFor(TARGET))).toBeUndefined();
  });

  it("恢复时应用导出清理记录，旧 tags 不回填", async () => {
    const { fake, manager } = setup();
    fake.putJson(
      sidecarPathFor(TARGET),
      sidecar({
        answered: { q1: "A" },
        meta: { q1: { tags: "#base", ts: 10 } },
      })
    );
    fake.putJson(
      `${TARGET}.sidecar 2.json.merged`,
      sidecar({
        answered: { q1: "A", q2: "B" },
        meta: { q1: { tags: "#old", ts: 20 } },
      })
    );
    const result = await manager.recoverMergedSidecars(
      TARGET,
      [],
      DEFAULT_FILTERS,
      new Map([["q1", new Map([["tags", 1000]])]])
    );
    expect(result.status).toBe("merged");
    const merged = fake.readJson<SidecarData>(sidecarPathFor(TARGET));
    expect(merged.meta.q1?.tags).toBeUndefined();
    expect(merged.state.answeredQuestions.q2).toBe("B");
  });
});
