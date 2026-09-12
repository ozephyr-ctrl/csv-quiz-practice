import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Plugin } from "obsidian";
import { StateManager, computeSaveDelay } from "../stateManager";
import type { QuizSessionState } from "../types";

describe("computeSaveDelay", () => {
  it("正常场景保持原防抖延迟", () => {
    expect(computeSaveDelay(1000, 0, 0, 3000)).toBe(1000);
    expect(computeSaveDelay(1000, 0, 1500, 3000)).toBe(1000); // 剩余 1500 > 1000
    expect(computeSaveDelay(100, 0, 0, 3000)).toBe(100);
  });

  it("连续重置逼近上限时压缩为剩余等待（2900ms → 100ms）", () => {
    expect(computeSaveDelay(1000, 0, 2900, 3000)).toBe(100);
    expect(computeSaveDelay(1000, 0, 2950, 3000)).toBe(50);
  });

  it("达到/超过 maxWait 时压到 0（立即触发）", () => {
    expect(computeSaveDelay(1000, 0, 3000, 3000)).toBe(0);
    expect(computeSaveDelay(1000, 0, 3500, 3000)).toBe(0);
  });

  it("delay 小于剩余时间时取 delay（maxWait 不放大延迟）", () => {
    expect(computeSaveDelay(200, 0, 1000, 3000)).toBe(200);
  });
});

/** 最小 QuizSessionState（仅调度用）。 */
function dummyState(): QuizSessionState {
  return {
    csvPath: "bank.csv",
    currentIndex: 0,
    correctCount: 0,
    wrongCount: 0,
    displayOrder: [],
    filterText: "",
    filterTags: "",
    filterCat1: "",
    filterCat2: "",
    filterCat3: "",
    filterFavorite: "",
    filterMastered: "",
    filterRepeat: "",
    filterWrong: "",
    filterUnanswered: "",
    answeredQuestions: {},
  };
}

describe("StateManager.scheduleSave maxWait（伪定时器）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // stateManager 用 window.setTimeout/clearTimeout，node 环境需桩到伪定时器
    vi.stubGlobal("window", {
      setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("间隔小于防抖的连续重置仍在首次调度后 3s 内落盘", async () => {
    const saveData = vi.fn(async () => {});
    const plugin = {
      app: { vault: {} },
      loadData: async () => ({}),
      saveData,
    } as unknown as Plugin;
    const sm = new StateManager(plugin);

    sm.scheduleSave(dummyState());
    // t=0/900/1800/2700 各重置一次（间隔 900ms < 1s 防抖）
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(900);
      sm.scheduleSave(dummyState());
    }
    // t=2700：距首次调度剩余 maxWait 仅 300ms，定时器被压缩到 300ms 后
    expect(saveData).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    expect(saveData).toHaveBeenCalledTimes(1); // 最迟 3s 已强制落盘
  });

  it("间隔大于防抖时按 1s 正常落盘", async () => {
    const saveData = vi.fn(async () => {});
    const plugin = {
      app: { vault: {} },
      loadData: async () => ({}),
      saveData,
    } as unknown as Plugin;
    const sm = new StateManager(plugin);

    sm.scheduleSave(dummyState());
    await vi.advanceTimersByTimeAsync(999);
    expect(saveData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveData).toHaveBeenCalledTimes(1);
  });
});
