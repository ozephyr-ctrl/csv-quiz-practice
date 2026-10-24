import { describe, it, expect, vi } from "vitest";
import type { Plugin } from "obsidian";
import { StateManager } from "../stateManager";
import {
  SidecarData,
  SidecarMeta,
  SidecarState,
  sidecarPathFor,
} from "../sidecar";
import { cardFor } from "./fixtures";
import { FakeVault } from "./fakeVault";

const CONTENT = "bank.csv";
const SIDECAR = sidecarPathFor(CONTENT);
const FILTERS = { favorite: "", mastered: "", repeat: "", wrong: "" };

function makeSidecar(
  overrides: Partial<SidecarState> = {},
  meta: Record<string, SidecarMeta> = {}
): SidecarData {
  return {
    version: 1,
    meta,
    state: {
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
    },
  };
}

function makePlugin(fake: FakeVault): Plugin {
  return {
    app: { vault: fake.vault },
    loadData: async () => ({}),
    saveData: async () => {},
  } as unknown as Plugin;
}

/** 从 fake vault 中的 sidecar JSON 读回数据。 */
function written(fake: FakeVault): SidecarData {
  return fake.readJson<SidecarData>(SIDECAR);
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

/** StateManager 内部保存层状态（仅测试直接断言快照隔离/清理）。 */
interface GateInternals {
  sidecarBase: Map<string, { data: SidecarData; mtimeMs: number; size: number }>;
  statsBaseline: Map<string, { correct: number; wrong: number; daily: object }>;
  tombstones: Map<string, { answered: Set<string>; cards: Set<string>; meta: Set<string> }>;
}

function internals(sm: StateManager): GateInternals {
  return sm as unknown as GateInternals;
}

async function load(
  fake: FakeVault,
  contentPath: string = CONTENT
): Promise<StateManager> {
  const sm = new StateManager(makePlugin(fake));
  await sm.loadSidecar(contentPath, FILTERS);
  return sm;
}

describe("StateManager 门控写：磁盘未变快路径", () => {
  it("mtime/size 未变时直接写内存，不读文件", async () => {
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(
        makeSidecar({ answeredQuestions: { q1: "A" }, correctCount: 1 })
      ),
    });
    const sm = await load(fake);
    fake.readCalls.length = 0;

    await sm.saveStateImmediately(sm.getState()!);

    expect(fake.readCalls).toEqual([]);
    expect(written(fake).state.answeredQuestions).toEqual({ q1: "A" });
    expect(written(fake).state.correctCount).toBe(1);
  });
});

describe("StateManager 门控写：磁盘变化慢路径", () => {
  it("事故回归：base=memory=子集、disk=全量 → 写出全量，不丢 answered/cards/meta/daily", async () => {
    const today = dayKey(0);
    const yesterday = dayKey(-1);
    const base = makeSidecar(
      {
        correctCount: 10,
        answeredQuestions: { q1: "A", q2: "B" },
        memoryCards: {
          q1: cardFor({ lastReview: "2026-01-01T00:00:00.000Z" }),
        },
        dailyAnswers: { [today]: 2 },
      },
      { q1: { tags: "#base" } }
    );
    const fake = new FakeVault({ [SIDECAR]: JSON.stringify(base) });
    const sm = await load(fake);

    // 其他设备写入全量数据（本机内存仍是载入时的子集）
    fake.putJson(
      SIDECAR,
      makeSidecar(
        {
          correctCount: 105,
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
        },
        { q1: { tags: "#base" }, q4: { favorite: "1" } }
      )
    );

    await sm.saveStateImmediately(sm.getState()!);
    const disk = written(fake);

    expect(Object.keys(disk.state.answeredQuestions).sort()).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);
    expect(Object.keys(disk.state.memoryCards ?? {}).sort()).toEqual([
      "q1",
      "q3",
    ]);
    expect(disk.meta.q1.tags).toBe("#base");
    expect(disk.meta.q4.favorite).toBe("1");
    expect(disk.state.dailyAnswers).toEqual({ [today]: 5, [yesterday]: 1 });
    expect(disk.state.correctCount).toBe(105);
  });

  it("计数增量叠加：disk=105/S=100/M=101 → 106；M=90 → 105", async () => {
    // M=101：基线 100，增量 1 → 105 + 1
    {
      const fake = new FakeVault({
        [SIDECAR]: JSON.stringify(
          makeSidecar({ correctCount: 100, wrongCount: 50 })
        ),
      });
      const sm = await load(fake);
      fake.putJson(
        SIDECAR,
        makeSidecar({ correctCount: 105, wrongCount: 60 })
      );
      sm.setState({ ...sm.getState()!, correctCount: 101, wrongCount: 55 });
      await sm.saveStateImmediately(sm.getState()!);
      expect(written(fake).state.correctCount).toBe(106);
      expect(written(fake).state.wrongCount).toBe(65);
    }
    // M=90（低于基线，delta 钳 0）→ 105
    {
      const fake = new FakeVault({
        [SIDECAR]: JSON.stringify(
          makeSidecar({ correctCount: 100, wrongCount: 50 })
        ),
      });
      const sm = await load(fake);
      fake.putJson(
        SIDECAR,
        makeSidecar({ correctCount: 105, wrongCount: 60 })
      );
      sm.setState({ ...sm.getState()!, correctCount: 90, wrongCount: 40 });
      await sm.saveStateImmediately(sm.getState()!);
      expect(written(fake).state.correctCount).toBe(105);
      expect(written(fake).state.wrongCount).toBe(60);
    }
  });

  it("本地新答 + 磁盘新答取并集；本地重答（m≠b）本地胜", async () => {
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(makeSidecar({ answeredQuestions: { q1: "A" } })),
    });
    const sm = await load(fake);
    // 本机：重答 q1，新答 q2
    const st = sm.getState()!;
    st.answeredQuestions.q1 = "B";
    st.answeredQuestions.q2 = "B";
    // 其他设备：q3 新答（q1 仍是旧值）
    fake.putJson(
      SIDECAR,
      makeSidecar({ answeredQuestions: { q1: "A", q3: "C" } })
    );

    await sm.saveStateImmediately(st);
    expect(written(fake).state.answeredQuestions).toEqual({
      q1: "B",
      q2: "B",
      q3: "C",
    });
  });

  it("连续两次保存不重复累计计数、不重复答题记录", async () => {
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(
        makeSidecar({ correctCount: 10, answeredQuestions: { q1: "A" } })
      ),
    });
    const sm = await load(fake);
    const st = sm.getState()!;
    st.correctCount = 11; // 本次会话新答 1 题
    st.answeredQuestions.q2 = "B";

    await sm.saveStateImmediately(st);
    expect(written(fake).state.correctCount).toBe(11);
    await sm.saveStateImmediately(st);

    const disk = written(fake);
    expect(disk.state.correctCount).toBe(11);
    expect(disk.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
  });

  it("磁盘文件缺失（同步删除）→ 用 base 兜底，不清库", async () => {
    const base = makeSidecar({
      correctCount: 30,
      answeredQuestions: { q1: "A", q2: "B" },
      displayOrder: ["q1", "q2"],
    });
    const fake = new FakeVault({ [SIDECAR]: JSON.stringify(base) });
    const sm = await load(fake);

    fake.foreignRemove(SIDECAR);
    await sm.saveStateImmediately(sm.getState()!);

    const disk = written(fake);
    expect(disk.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
    expect(disk.state.correctCount).toBe(30);
    expect(disk.state.displayOrder).toEqual(["q1", "q2"]);
  });
});

describe("StateManager 门控写：快照隔离与写入校验", () => {
  it("保存后修改 currentState/currentMeta 不影响 base 快照（buildSidecarData 深拷贝）", async () => {
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(
        makeSidecar(
          { answeredQuestions: { q1: "A" }, displayOrder: ["q1"] },
          { q1: { tags: "#t" } }
        )
      ),
    });
    const sm = await load(fake);
    await sm.saveStateImmediately(sm.getState()!);

    const base = internals(sm).sidecarBase.get(CONTENT)!.data;
    const st = sm.getState()!;
    st.answeredQuestions.q9 = "Z";
    st.displayOrder.push("q9");
    sm.getMeta().q1.tags = "#mutated";

    expect(base.state.answeredQuestions.q9).toBeUndefined();
    expect(base.state.displayOrder).toEqual(["q1"]);
    expect(base.meta.q1.tags).toBe("#t");
  });

  it("写后字节数与期望不符 → 重读磁盘再合并一次后重写", async () => {
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(makeSidecar({ answeredQuestions: { q1: "A" } })),
    });
    const sm = await load(fake);
    fake.readCalls.length = 0;
    fake.writeCalls.length = 0;
    // 模拟写入被追加内容（JSON 仍合法但大小不符）
    fake.writeHook = (path, content) =>
      path.endsWith(".sidecar.json.tmp") ? content + " " : undefined;

    await sm.saveStateImmediately(sm.getState()!);

    // 重读 canonical sidecar 一次（不反复重试）
    expect(fake.readCalls.filter((p) => p === SIDECAR)).toHaveLength(1);
    // 两次写（首次 + 校验失败后重写）
    expect(
      fake.writeCalls.filter((p) => p === SIDECAR + ".tmp")
    ).toHaveLength(2);
    expect(written(fake).state.answeredQuestions).toEqual({ q1: "A" });
    // base 快照按最终落盘结果刷新（可判定为「已同步」）
    const base = internals(sm).sidecarBase.get(CONTENT)!;
    expect(base.size).toBe(fake.sizeOf(SIDECAR));
  });

  it("路径切换/unload 清理该路径的保存层基准", async () => {
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(
        makeSidecar({ answeredQuestions: { q1: "A" }, correctCount: 1 })
      ),
      [sidecarPathFor("other.csv")]: JSON.stringify(
        makeSidecar({ answeredQuestions: { q2: "B" }, correctCount: 2 })
      ),
    });
    const sm = await load(fake);
    const inner = internals(sm);
    expect(inner.sidecarBase.has(CONTENT)).toBe(true);
    expect(inner.statsBaseline.get(CONTENT)?.correct).toBe(1);
    expect(inner.tombstones.has(CONTENT)).toBe(true);

    // 切换路径：旧路径基准保留（不会串用），新路径基准建立
    await sm.loadSidecar("other.csv", FILTERS);
    expect(inner.sidecarBase.get("other.csv")?.data.state.correctCount).toBe(2);
    expect(inner.sidecarBase.get(CONTENT)?.data.state.correctCount).toBe(1);

    await sm.unloadSidecar();
    expect(inner.sidecarBase.has("other.csv")).toBe(false);
    expect(inner.statsBaseline.has("other.csv")).toBe(false);
    expect(inner.tombstones.has("other.csv")).toBe(false);
  });
});

/** 冲突副本路径（findSidecarConflictPaths 识别的「sidecar N.json」形式）。 */
function conflictPath(n: number): string {
  return SIDECAR.replace(/\.json$/, ` ${n}.json`);
}

function conflictFixture(): { current: SidecarData; conflict: SidecarData } {
  return {
    current: makeSidecar(
      {
        correctCount: 3,
        wrongCount: 1,
        answeredQuestions: { q1: "A" },
        memoryCards: { q1: cardFor() },
        dailyAnswers: { "2026-10-22": 2 },
      },
      { q1: { tags: "#current" } }
    ),
    conflict: makeSidecar(
      {
        correctCount: 90,
        answeredQuestions: { q1: "B", q2: "C" },
        memoryCards: {
          q2: cardFor({ lastReview: "2026-09-01T00:00:00.000Z" }),
        },
        dailyAnswers: { "2026-10-22": 279, "2026-10-23": 166 },
      },
      { q2: { favorite: "1" } }
    ),
  };
}

const MERGED_DAILY = { "2026-10-22": 279, "2026-10-23": 166 };

describe("StateManager.mergeSidecarConflicts：串行合并 + 每日 max", () => {
  it("daily 按日期取 max（不求和）、answered/cards 并集、计数保持 base、base/baseline 刷新", async () => {
    const { current, conflict } = conflictFixture();
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(current),
      [conflictPath(2)]: JSON.stringify(conflict),
    });
    const sm = await load(fake);

    const outcome = await sm.mergeSidecarConflicts();
    expect(outcome.status).toBe("merged");

    const disk = written(fake);
    expect(disk.state.dailyAnswers).toEqual(MERGED_DAILY);
    // 计数不在此重算（保持 base，视图按 addedAnswerIds 补计）
    expect(disk.state.correctCount).toBe(3);
    expect(disk.state.wrongCount).toBe(1);
    expect(Object.keys(disk.state.answeredQuestions).sort()).toEqual([
      "q1",
      "q2",
    ]);
    expect(disk.state.answeredQuestions.q1).toBe("A");
    expect(Object.keys(disk.state.memoryCards ?? {}).sort()).toEqual([
      "q1",
      "q2",
    ]);
    // 内存同步（daily 补入副本独有日期）
    expect(sm.getState()!.dailyAnswers).toEqual(MERGED_DAILY);
    // base/baseline 已同步为合并结果
    const inner = internals(sm);
    expect(inner.sidecarBase.get(CONTENT)!.data.state.dailyAnswers).toEqual(
      MERGED_DAILY
    );
    expect(inner.statsBaseline.get(CONTENT)!.daily).toEqual(MERGED_DAILY);
  });

  it("重复合并同一份数据（另一副本）不翻倍：daily/answered/cards 保持", async () => {
    const { current, conflict } = conflictFixture();
    const fake = new FakeVault({
      [SIDECAR]: JSON.stringify(current),
      [conflictPath(2)]: JSON.stringify(conflict),
    });
    const sm = await load(fake);
    expect((await sm.mergeSidecarConflicts()).status).toBe("merged");

    // 同步服务再次产生同内容副本
    fake.putJson(conflictPath(3), conflict);
    expect((await sm.mergeSidecarConflicts()).status).toBe("merged");

    const disk = written(fake);
    expect(disk.state.dailyAnswers).toEqual(MERGED_DAILY);
    expect(Object.keys(disk.state.answeredQuestions).sort()).toEqual([
      "q1",
      "q2",
    ]);
    expect(Object.keys(disk.state.memoryCards ?? {}).sort()).toEqual([
      "q1",
      "q2",
    ]);
    expect(internals(sm).statsBaseline.get(CONTENT)!.daily).toEqual(
      MERGED_DAILY
    );
  });

  it("合并期间有挂起的定时保存：串行执行、每日不二次叠加、base 不丢", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
    try {
      const { current, conflict } = conflictFixture();
      const fake = new FakeVault({
        [SIDECAR]: JSON.stringify(current),
        [conflictPath(2)]: JSON.stringify(conflict),
      });
      const sm = await load(fake);

      sm.scheduleSave(sm.getState()!, 100);
      const outcome = await sm.mergeSidecarConflicts();
      expect(outcome.status).toBe("merged");
      // 防抖保存随后落盘（队列串行，不嵌套死锁）
      await vi.advanceTimersByTimeAsync(150);

      const disk = written(fake);
      expect(disk.state.dailyAnswers).toEqual(MERGED_DAILY);
      expect(disk.state.answeredQuestions).toEqual({ q1: "A", q2: "C" });
      expect(internals(sm).sidecarBase.has(CONTENT)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("StateManager.transferSidecar：计数/每日 max 幂等", () => {
  const FROM = "imgs/quiz";
  const FROM_SIDECAR = sidecarPathFor(FROM);

  function transferFixture(): Record<string, string> {
    return {
      [SIDECAR]: JSON.stringify(
        makeSidecar({
          correctCount: 5,
          wrongCount: 1,
          answeredQuestions: { q1: "A" },
          dailyAnswers: { "2026-10-10": 2 },
        })
      ),
      [FROM_SIDECAR]: JSON.stringify(
        makeSidecar({
          correctCount: 3,
          wrongCount: 4,
          answeredQuestions: { q2: "B" },
          dailyAnswers: { "2026-10-22": 279, "2026-10-23": 166 },
          memoryInitialized: true,
        })
      ),
    };
  }

  it("target/source 计数取 max、daily 逐日 max、memoryInitialized OR", async () => {
    const fake = new FakeVault(transferFixture());
    const sm = new StateManager(makePlugin(fake));

    expect((await sm.transferSidecar(FROM, CONTENT)).status).toBe("merged");

    const disk = written(fake);
    expect(disk.state.correctCount).toBe(5);
    expect(disk.state.wrongCount).toBe(4);
    expect(disk.state.dailyAnswers).toEqual({
      "2026-10-10": 2,
      "2026-10-22": 279,
      "2026-10-23": 166,
    });
    expect(disk.state.memoryInitialized).toBe(true);
    expect(disk.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
  });

  it("重复迁移同一源不翻倍", async () => {
    const fake = new FakeVault(transferFixture());
    const sm = new StateManager(makePlugin(fake));

    await sm.transferSidecar(FROM, CONTENT);
    await sm.transferSidecar(FROM, CONTENT);

    const disk = written(fake);
    expect(disk.state.correctCount).toBe(5);
    expect(disk.state.wrongCount).toBe(4);
    expect(disk.state.dailyAnswers).toEqual({
      "2026-10-10": 2,
      "2026-10-22": 279,
      "2026-10-23": 166,
    });
  });
});

describe("StateManager.mergeManifestComponentSidecars：求和后取 max 幂等", () => {
  const TARGET = "bank/复合题库/manifest";
  const CQV = "bank/复合题库/执照认证.cqv";
  const CSV = "bank/复合题库/简答题库.csv";
  const TARGET_SIDECAR = sidecarPathFor(TARGET);

  it("target 有会话进度/每日时：计数=组件求和，daily 逐日 max，重复运行不再增大", async () => {
    const fake = new FakeVault({
      [TARGET_SIDECAR]: JSON.stringify(
        makeSidecar({
          currentIndex: 1,
          displayOrder: ["t1", "t2"],
          filterText: "abc",
          dailyAnswers: { "2026-10-01": 10 },
        })
      ),
      [sidecarPathFor(CQV)]: JSON.stringify(
        makeSidecar({
          correctCount: 2,
          wrongCount: 1,
          answeredQuestions: { q1: "A" },
          dailyAnswers: { "2026-10-01": 2 },
        })
      ),
      [sidecarPathFor(CSV)]: JSON.stringify(
        makeSidecar({
          correctCount: 1,
          wrongCount: 0,
          answeredQuestions: { q3: "C" },
          dailyAnswers: { "2026-10-01": 1, "2026-10-02": 1 },
        })
      ),
    });
    const sm = new StateManager(makePlugin(fake));

    const first = await sm.mergeManifestComponentSidecars(
      TARGET,
      [CQV, CSV],
      FILTERS
    );
    expect(first.status).toBe("merged");
    expect(first.correctCount).toBe(3);
    expect(first.wrongCount).toBe(1);

    const merged = fake.readJson<SidecarData>(TARGET_SIDECAR);
    expect(merged.state.correctCount).toBe(3);
    expect(merged.state.wrongCount).toBe(1);
    // target 的 10 高于组件求和 3 → 保留 10（不求和成 13）
    expect(merged.state.dailyAnswers).toEqual({
      "2026-10-01": 10,
      "2026-10-02": 1,
    });
    expect(merged.state.displayOrder).toEqual(["t1", "t2"]);
    expect(merged.state.currentIndex).toBe(1);

    // L4: 目标已有进度不再早退，而是幂等合并——重复运行返回 no-change（不写盘）
    const second = await sm.mergeManifestComponentSidecars(
      TARGET,
      [CQV, CSV],
      FILTERS
    );
    expect(second.status).toBe("skipped");
    expect(second.reason).toBe("no-change");
    const after = fake.readJson<SidecarData>(TARGET_SIDECAR);
    expect(after.state.correctCount).toBe(3);
    expect(after.state.dailyAnswers).toEqual({
      "2026-10-01": 10,
      "2026-10-02": 1,
    });
  });
});

describe("StateManager tombstone（权威删除记忆卡片/整条 meta）", () => {
  function tombstoneFixture(): FakeVault {
    return new FakeVault({
      [SIDECAR]: JSON.stringify(
        makeSidecar(
          {
            answeredQuestions: { q1: "A" },
            memoryCards: {
              q1: cardFor(),
              q2: cardFor({ lastReview: "2026-09-01T00:00:00.000Z" }),
            },
          },
          { q1: { tags: "#keep" }, q2: { favorite: "1" } }
        )
      ),
    });
  }

  it("markCardsDeleted/markMetaDeleted 后正常保存 → 磁盘记录删除、tombstone 清空", async () => {
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
    try {
      const fake = tombstoneFixture();
      const sm = await load(fake);
      const st = sm.getState()!;

      sm.markCardsDeleted(["q2"]);
      sm.markMetaDeleted(["q2"]);
      expect(internals(sm).tombstones.get(CONTENT)!.cards.has("q2")).toBe(true);
      expect(internals(sm).tombstones.get(CONTENT)!.meta.has("q2")).toBe(true);
      // 尚未保存：磁盘仍保留（tombstone 只影响后续写盘）
      expect(written(fake).state.memoryCards!.q2).toBeDefined();

      // 视图随后删除内存并保存
      delete st.memoryCards!.q2;
      delete sm.getMeta().q2;
      await sm.saveStateImmediately(st);

      const disk = written(fake);
      expect(disk.state.memoryCards!.q2).toBeUndefined();
      expect(disk.state.memoryCards!.q1).toBeDefined();
      expect(disk.meta.q2).toBeUndefined();
      expect(disk.meta.q1.tags).toBe("#keep");
      // 写盘成功后 tombstone 清空
      expect(internals(sm).tombstones.get(CONTENT)!.cards.size).toBe(0);
      expect(internals(sm).tombstones.get(CONTENT)!.meta.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("写盘失败时 tombstone 保留（下次保存继续阻止磁盘记录复活）", async () => {
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
    try {
      const fake = tombstoneFixture();
      const plugin = makePlugin(fake);
      const sm = new StateManager(plugin);
      await sm.loadSidecar(CONTENT, FILTERS);

      sm.markCardsDeleted(["q2"]);
      // 让写盘失败：writeSidecar 走 adapter.write
      (plugin.app.vault.adapter as { write: unknown }).write = async () => {
        throw new Error("disk full");
      };
      await expect(sm.saveStateImmediately(sm.getState()!)).rejects.toThrow();

      expect(internals(sm).tombstones.get(CONTENT)!.cards.has("q2")).toBe(true);
      // 写失败：磁盘仍是旧内容（q2 未被删除）
      expect(written(fake).state.memoryCards!.q2).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("未载入题库（contentPath 为空）时 mark* 只返回、不建 tombstone", () => {
    const sm = new StateManager(makePlugin(new FakeVault()));
    sm.markCardsDeleted(["q1"]);
    sm.markMetaDeleted(["q1"]);
    expect(internals(sm).tombstones.size).toBe(0);
  });
});
