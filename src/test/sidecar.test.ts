import { describe, it, expect } from "vitest";
import type { Vault } from "obsidian";
import {
  normalizeSidecar,
  readSidecar,
  sidecarPathFor,
  backupPathFor,
} from "../sidecar";
import { validSidecar, cardFor } from "./fixtures";

describe("sidecarPathFor / backupPathFor", () => {
  it("同名拼接扩展名（csv 与 cqv 均支持）", () => {
    expect(sidecarPathFor("题库.csv")).toBe("题库.csv.sidecar.json");
    expect(sidecarPathFor("题库.cqv")).toBe("题库.cqv.sidecar.json");
    expect(backupPathFor("题库.csv")).toBe("题库.csv.sidecar.json.bak");
  });
});

describe("normalizeSidecar", () => {
  it("version 非 1 或根非对象返回 null", () => {
    expect(normalizeSidecar(null)).toBeNull();
    expect(normalizeSidecar("x")).toBeNull();
    expect(normalizeSidecar({ version: 2, meta: {}, state: {} })).toBeNull();
  });

  it("字段级归一化兜底类型错误，可选字段缺失保持 undefined", () => {
    const data = normalizeSidecar({
      version: 1,
      meta: {},
      state: {
        currentIndex: "5",
        correctCount: "abc",
        displayOrder: [1, "b"],
        filterText: 123,
        memoryNewCountToday: "x",
        memoryPendingNew: ["a", 2],
        memoryInitialized: "yes",
      },
    });
    expect(data).not.toBeNull();
    expect(data!.state.currentIndex).toBe(5); // "5" → Number 归一
    expect(data!.state.correctCount).toBe(0); // "abc" → 0
    expect(data!.state.displayOrder).toEqual(["b"]); // 非字符串元素过滤
    expect(data!.state.filterText).toBe("");
    expect(data!.state.memoryNewCountToday).toBeUndefined();
    expect(data!.state.memoryPendingNew).toEqual(["a"]);
    expect(data!.state.memoryInitialized).toBeUndefined();
    expect(data!.state.memoryCards).toBeUndefined();
  });

  it("记忆卡片从 state 层读取（非顶层）且损坏卡整卡剔除", () => {
    const data = normalizeSidecar({
      version: 1,
      meta: {},
      state: {
        memoryCards: {
          good: cardFor(),
          corrupt: { ...cardFor(), stability: "8.5" },
        },
      },
    });
    // 顶层 memoryCards 不读取（v3.1.5 修复的层级错误不被回归）
    expect(data!.state.memoryCards).toBeDefined();
    expect(Object.keys(data!.state.memoryCards!)).toEqual(["good"]);
  });

  it("meta 层逐字段校验：非字符串字段丢弃、非对象条目丢弃", () => {
    const data = normalizeSidecar({
      version: 1,
      meta: {
        q1: { tags: "#t", repeat: 1 }, // repeat 非字符串 → 丢弃，tags 保留
        q2: "not an object",
        q3: { favorite: "1" },
      },
      state: {},
    });
    expect(data!.meta.q1).toEqual({ tags: "#t" });
    expect(data!.meta.q2).toBeUndefined();
    expect(data!.meta.q3).toEqual({ favorite: "1" });
  });
});

/** 内存文件表 → 最小 Vault 桩（覆盖 readSidecar 用到的 adapter 方法）。 */
function stubVault(files: Record<string, string>): Vault {
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
    },
  } as unknown as Vault;
}

describe("readSidecar", () => {
  it("存在且合法 → ok，字段经归一化", async () => {
    const vault = stubVault({
      "bank.csv.sidecar.json": JSON.stringify(validSidecar()),
    });
    const result = await readSidecar(vault, "bank.csv");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.state.currentIndex).toBe(7);
      expect(result.data.meta.q1).toEqual({ tags: "#t" });
    }
  });

  it("缺失且无备份 → missing", async () => {
    const result = await readSidecar(stubVault({}), "bank.csv");
    expect(result.status).toBe("missing");
  });

  it("损坏且无备份 → corrupt（不动内存、由调用方提示重建）", async () => {
    const vault = stubVault({ "bank.csv.sidecar.json": "{ not json" });
    const result = await readSidecar(vault, "bank.csv");
    expect(result.status).toBe("corrupt");
  });

  it("损坏但有合法备份 → recovered 并重写 sidecar", async () => {
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": "{ broken",
      "bank.csv.sidecar.json.bak": JSON.stringify(validSidecar()),
    };
    const result = await readSidecar(stubVault(files), "bank.csv");
    expect(result.status).toBe("recovered");
    // 恢复后 sidecar 已用备份内容重写
    expect(JSON.parse(files["bank.csv.sidecar.json"]).version).toBe(1);
  });
});
