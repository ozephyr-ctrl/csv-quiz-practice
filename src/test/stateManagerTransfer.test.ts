import { describe, it, expect } from "vitest";
import type { Vault, Plugin } from "obsidian";
import { StateManager } from "../stateManager";
import { sidecarPathFor, SidecarData, SIDECAR_MERGED_SUFFIX } from "../sidecar";
import { validSidecar, cardFor } from "./fixtures";

/** 内存文件表 → 最小 Vault 桩（覆盖 transfer/merge 用到的 adapter 方法）。 */
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
        mtime: mtimes[p] ?? 0,
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

function sidecarWith(
  answered: Record<string, string>,
  updatedAt?: number,
  cards?: Record<string, ReturnType<typeof cardFor>>
): SidecarData {
  return {
    version: 1,
    meta: {},
    state: {
      ...validSidecar().state,
      answeredQuestions: answered,
      memoryCards: cards,
      updatedAt,
    },
  };
}

describe("StateManager.transferSidecar", () => {
  it("from 缺失 → skipped", async () => {
    const files: Record<string, string> = {};
    const sm = new StateManager(stubPlugin(stubVault(files)));
    const res = await sm.transferSidecar("imgs/quiz", "bank.csv");
    expect(res.status).toBe("skipped");
    expect(files[sidecarPathFor("bank.csv")]).toBeUndefined();
  });

  it("to 缺失 → copied，目标 sidecar 可读且 answered/cards 存在", async () => {
    const files: Record<string, string> = {
      [sidecarPathFor("imgs/quiz")]: JSON.stringify(
        sidecarWith({ q1: "A", q2: "B" }, 1000, { q1: cardFor() })
      ),
    };
    const sm = new StateManager(stubPlugin(stubVault(files)));
    const res = await sm.transferSidecar("imgs/quiz", "bank.csv");
    expect(res.status).toBe("copied");

    const written = JSON.parse(files[sidecarPathFor("bank.csv")]);
    expect(written.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
    expect(written.state.memoryCards.q1).toBeDefined();
    // 源文件保留（不删除 from）
    expect(files[sidecarPathFor("imgs/quiz")]).toBeDefined();
  });

  it("两边都有 → merged：answered 并集、较新卡片取胜、正常 sidecar 优先", async () => {
    const olderCard = cardFor({ lastReview: "2025-01-01T00:00:00.000Z" });
    const newerCard = cardFor({
      lastReview: "2026-05-01T00:00:00.000Z",
      reps: 9,
    });
    const files: Record<string, string> = {
      [sidecarPathFor("bank.csv")]: JSON.stringify(
        sidecarWith({ q1: "A" }, 2000, { q1: olderCard })
      ),
      [sidecarPathFor("imgs/quiz")]: JSON.stringify(
        sidecarWith({ q1: "X", q2: "B" }, 1000, { q1: newerCard })
      ),
    };
    const sm = new StateManager(stubPlugin(stubVault(files)));
    const res = await sm.transferSidecar("imgs/quiz", "bank.csv");
    expect(res.status).toBe("merged");

    const written = JSON.parse(files[sidecarPathFor("bank.csv")]);
    // 并集，同 key 以目标（CSV）为准
    expect(written.state.answeredQuestions).toEqual({ q1: "A", q2: "B" });
    // 卡片按 lastReview 取新：图片文件夹的较新卡片胜出
    expect(written.state.memoryCards.q1.reps).toBe(9);
    expect(written.state.memoryCards.q1.lastReview).toBe(
      "2026-05-01T00:00:00.000Z"
    );
    // 源文件保留
    expect(files[sidecarPathFor("imgs/quiz")]).toBeDefined();
  });

  it("from 损坏 → error（不抛出），目标不变", async () => {
    const target = JSON.stringify(sidecarWith({ q1: "A" }, 2000));
    const files: Record<string, string> = {
      [sidecarPathFor("bank.csv")]: target,
      [sidecarPathFor("imgs/quiz")]: "{ broken",
    };
    const sm = new StateManager(stubPlugin(stubVault(files)));
    const res = await sm.transferSidecar("imgs/quiz", "bank.csv");
    expect(res.status).toBe("error");
    expect(files[sidecarPathFor("bank.csv")]).toBe(target);
  });

  it("from === to 或空路径 → skipped", async () => {
    const files: Record<string, string> = {
      [sidecarPathFor("bank.csv")]: JSON.stringify(sidecarWith({ q1: "A" })),
    };
    const sm = new StateManager(stubPlugin(stubVault(files)));
    expect((await sm.transferSidecar("bank.csv", "bank.csv")).status).toBe(
      "skipped"
    );
    expect((await sm.transferSidecar("", "bank.csv")).status).toBe("skipped");
    expect((await sm.transferSidecar("bank.csv", "  ")).status).toBe("skipped");
  });
});

describe("StateManager.mergeImageSidecar", () => {
  it("合并图片文件夹 sidecar 进 CSV 并归档为 .merged", async () => {
    const files: Record<string, string> = {
      [sidecarPathFor("imgs/quiz")]: JSON.stringify(
        sidecarWith({ q2: "B" }, 1000)
      ),
    };
    const sm = new StateManager(stubPlugin(stubVault(files)));
    const res = await sm.mergeImageSidecar("bank.csv", "imgs/quiz");
    expect(res.status).toBe("copied");

    const written = JSON.parse(files[sidecarPathFor("bank.csv")]);
    expect(written.state.answeredQuestions).toEqual({ q2: "B" });
    // 图片 sidecar 已归档，原路径不再存在
    expect(files[sidecarPathFor("imgs/quiz")]).toBeUndefined();
    expect(
      files[sidecarPathFor("imgs/quiz") + SIDECAR_MERGED_SUFFIX]
    ).toBeDefined();
  });

  it("目标 .merged 已存在时覆盖归档", async () => {
    const src = sidecarPathFor("imgs/quiz");
    const files: Record<string, string> = {
      [src]: JSON.stringify(sidecarWith({ q2: "B" }, 1000)),
      [src + SIDECAR_MERGED_SUFFIX]: "old-content",
    };
    const sm = new StateManager(stubPlugin(stubVault(files)));
    const res = await sm.mergeImageSidecar("bank.csv", "imgs/quiz");
    expect(res.status).toBe("copied");
    expect(files[src]).toBeUndefined();
    expect(JSON.parse(files[src + SIDECAR_MERGED_SUFFIX]).state).toBeDefined();
  });

  it("图片文件夹为空 / 与 CSV 相同 → skipped，不产生文件", async () => {
    const files: Record<string, string> = {};
    const sm = new StateManager(stubPlugin(stubVault(files)));
    expect((await sm.mergeImageSidecar("bank.csv", "  ")).status).toBe(
      "skipped"
    );
    expect((await sm.mergeImageSidecar("", "imgs/quiz")).status).toBe(
      "skipped"
    );
    expect((await sm.mergeImageSidecar("imgs/quiz", "imgs/quiz")).status).toBe(
      "skipped"
    );
    expect(Object.keys(files)).toEqual([]);
  });
});
