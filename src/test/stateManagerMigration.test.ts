import { describe, it, expect } from "vitest";
import type { Vault, Plugin } from "obsidian";
import { StateManager } from "../stateManager";

/** 内存文件表 → 最小 Vault 桩（覆盖 migrateLegacyState / writeSidecar 用到的 adapter 方法）。 */
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
      writeBinary: async (p: string) => {
        files[p] = "";
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

/** 旧 data.json 中带 csvPath 的 quizState（其余字段由 normalizeQuizState 补默认值）。 */
function stubPlugin(vault: Vault, csvPath: string): Plugin {
  return {
    app: { vault },
    loadData: async () => ({ quizState: { csvPath } }),
    saveData: async () => {},
  } as unknown as Plugin;
}

/** 生成 15/16 列 CSV 行：id, stem, A-D, answer, tags, cat1-3, fav, mastered, repeat, wrong, [direction]。 */
function csvRow(
  id: string,
  answer: string,
  tags: string,
  direction?: string
): string {
  const cols = [
    id,
    `题干 ${id}`,
    "",
    "",
    "",
    "",
    answer,
    tags,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ];
  if (direction !== undefined) cols.push(direction);
  return cols.join(",");
}

const CSV = "bank.csv";

describe("StateManager.migrateLegacyState 旧 CSV 统一管线校验", () => {
  it("合法简答题（<> 展开后无空/重复）→ migrated", async () => {
    const files: Record<string, string> = {
      [CSV]: [
        "id,stem,A,B,C,D,answer,tags,c1,c2,c3,fav,mastered,repeat,wrong,direction",
        csvRow("q1", "答案原文", "#简答题", "<>"),
      ].join("\n"),
    };
    const sm = new StateManager(stubPlugin(stubVault(files), CSV));
    const res = await sm.migrateLegacyState(CSV, {
      favorite: "",
      mastered: "",
      repeat: "",
      wrong: "",
    });
    expect(res.status).toBe("migrated");
  });

  it("简答题选项非空（行校验失败）→ rejected/bad-id", async () => {
    const files: Record<string, string> = {
      [CSV]: [
        "id,stem,A,B,C,D,answer,tags,c1,c2,c3,fav,mastered,repeat,wrong,direction",
        // 简答题必须选项为空：A 列填了值
        ["q1", "题干 q1", "误填", "", "", "", "答案", "#简答题", "", "", "", "", "", "", "", ">"].join(","),
      ].join("\n"),
    };
    const sm = new StateManager(stubPlugin(stubVault(files), CSV));
    const res = await sm.migrateLegacyState(CSV, {
      favorite: "",
      mastered: "",
      repeat: "",
      wrong: "",
    });
    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.reason).toBe("bad-id");
  });

  it("选择题第 16 列非空（行校验失败）→ rejected/bad-id", async () => {
    const files: Record<string, string> = {
      [CSV]: [
        "id,stem,A,B,C,D,answer,tags,c1,c2,c3,fav,mastered,repeat,wrong,direction",
        csvRow("q1", "A", "#普通", "<>"),
      ].join("\n"),
    };
    const sm = new StateManager(stubPlugin(stubVault(files), CSV));
    const res = await sm.migrateLegacyState(CSV, {
      favorite: "",
      mastered: "",
      repeat: "",
      wrong: "",
    });
    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.reason).toBe("bad-id");
  });

  it("简答题 id 含 :: → rejected/bad-id", async () => {
    const files: Record<string, string> = {
      [CSV]: [
        "id,stem,A,B,C,D,answer,tags,c1,c2,c3,fav,mastered,repeat,wrong,direction",
        csvRow("q1::rev", "答案", "#简答题"),
      ].join("\n"),
    };
    const sm = new StateManager(stubPlugin(stubVault(files), CSV));
    const res = await sm.migrateLegacyState(CSV, {
      favorite: "",
      mastered: "",
      repeat: "",
      wrong: "",
    });
    expect(res.status).toBe("rejected");
    if (res.status === "rejected") expect(res.reason).toBe("bad-id");
  });
});
