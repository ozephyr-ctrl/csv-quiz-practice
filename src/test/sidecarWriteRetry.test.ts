import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Vault } from "obsidian";
import {
  backupSidecar,
  isRetryableFsError,
  renameOverwriteWithRetry,
  writeSidecar,
} from "../sidecar";
import { validSidecar } from "./fixtures";

/** 构造带 code 的模拟 fs 错误。 */
function ioError(code: string, message?: string): Error {
  const e = new Error(message ?? `${code}: resource busy or locked`);
  (e as Error & { code?: string }).code = code;
  return e;
}

interface FsFailureOptions {
  /** 前 N 次 remove 调用抛错。 */
  failRemoveTimes?: number;
  /** 前 N 次 rename 调用抛错。 */
  failRenameTimes?: number;
  /** 前 N 次 write 调用抛错（先落半写内容再抛，模拟半写 tmp）。 */
  failWriteTimes?: number;
  /** 注入错误的 code（默认 EBUSY）。 */
  errorCode?: string;
  /** 注入错误的 message（默认含 code 文本）。 */
  errorMessage?: string;
}

/** 内存文件表 + 可注入失败的 adapter 桩。adapter 无 getFullPath → 走兜底 remove+rename 路径。 */
function failingVault(
  files: Record<string, string>,
  options: FsFailureOptions = {}
): {
  vault: Vault;
  files: Record<string, string>;
  calls: { exists: number; write: number; remove: number; rename: number };
} {
  const calls = { exists: 0, write: 0, remove: 0, rename: 0 };
  let removeFailures = options.failRemoveTimes ?? 0;
  let renameFailures = options.failRenameTimes ?? 0;
  let writeFailures = options.failWriteTimes ?? 0;
  const vault = {
    adapter: {
      exists: async (p: string) => {
        calls.exists++;
        return p in files;
      },
      read: async (p: string) => {
        if (!(p in files)) throw new Error("not found: " + p);
        return files[p];
      },
      write: async (p: string, c: string) => {
        calls.write++;
        files[p] = c; // 先写入（供半写模拟），失败注入在写入之后抛
        if (writeFailures > 0) {
          writeFailures--;
          throw ioError(options.errorCode ?? "EBUSY", options.errorMessage);
        }
      },
      rename: async (from: string, to: string) => {
        calls.rename++;
        if (renameFailures > 0) {
          renameFailures--;
          throw ioError(options.errorCode ?? "EBUSY", options.errorMessage);
        }
        files[to] = files[from];
        delete files[from];
      },
      remove: async (p: string) => {
        calls.remove++;
        if (removeFailures > 0) {
          removeFailures--;
          throw ioError(options.errorCode ?? "EBUSY", options.errorMessage);
        }
        delete files[p];
      },
    },
  } as unknown as Vault;
  return { vault, files, calls };
}

describe("isRetryableFsError", () => {
  it("错误码与 message 双通道判定", () => {
    expect(isRetryableFsError(ioError("EBUSY"))).toBe(true);
    expect(isRetryableFsError(ioError("EPERM"))).toBe(true);
    expect(isRetryableFsError(ioError("EACCES"))).toBe(true);
    expect(isRetryableFsError(ioError("ENOTEMPTY", "directory not empty"))).toBe(
      true
    );
    expect(isRetryableFsError(new Error("resource busy or locked"))).toBe(true);
    expect(isRetryableFsError(new Error("file is locked"))).toBe(true);
    expect(isRetryableFsError(ioError("EIO", "i/o error"))).toBe(false);
    expect(isRetryableFsError(new Error("operation not permitted"))).toBe(false);
    expect(isRetryableFsError(null)).toBe(false);
    expect(isRetryableFsError(undefined)).toBe(false);
  });
});

describe("sidecar 写入重试与原子覆盖", () => {
  beforeEach(() => {
    // 重试路径会 console.warn 诊断一次；测试中静音避免刷屏（用例内单独断言次数）
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remove 连续 2 次 EBUSY 后成功：写盘成功、紧凑 JSON、无 tmp 残留", async () => {
    const files: Record<string, string> = {
      "bank.csv.sidecar.json": JSON.stringify(validSidecar()),
    };
    const { vault, calls } = failingVault(files, { failRemoveTimes: 2 });
    const data = validSidecar();

    await writeSidecar(vault, "bank.csv", data);

    const written = files["bank.csv.sidecar.json"];
    expect(written).toBeDefined();
    expect(written).not.toContain("\n"); // 紧凑 JSON（无缩进）
    expect(JSON.parse(written)).toEqual(data);
    expect(files["bank.csv.sidecar.json.tmp"]).toBeUndefined();
    expect(calls.remove).toBe(3); // 2 次失败 + 1 次成功
  });

  it("rename 连续 2 次 EBUSY 后成功", async () => {
    const { vault, files, calls } = failingVault(
      {},
      { failRenameTimes: 2 }
    );

    await writeSidecar(vault, "bank.csv", validSidecar());

    expect(files["bank.csv.sidecar.json"]).toBeDefined();
    expect(files["bank.csv.sidecar.json.tmp"]).toBeUndefined();
    expect(calls.rename).toBe(3); // 确有重试而非降级静默
  });

  it("非可重试错误（EIO）立即 reject 且清理 tmp，不重试", async () => {
    const { vault, files, calls } = failingVault(
      {},
      { failRenameTimes: 1, errorCode: "EIO", errorMessage: "EIO: i/o error" }
    );

    await expect(
      writeSidecar(vault, "bank.csv", validSidecar())
    ).rejects.toThrow("EIO");

    expect(calls.rename).toBe(1); // 不重试
    expect(files["bank.csv.sidecar.json.tmp"]).toBeUndefined(); // tmp 已清理
  });

  it("预算耗尽：永久 EBUSY + 小预算 → reject 且尝试次数 > 1，仅 warn 一次", async () => {
    const { vault, calls } = failingVault(
      { "bank.csv.sidecar.json.tmp": "tmp" },
      { failRenameTimes: Number.MAX_SAFE_INTEGER }
    );

    await expect(
      renameOverwriteWithRetry(
        vault,
        "bank.csv.sidecar.json.tmp",
        "bank.csv.sidecar.json",
        { budgetMs: 150, baseDelayMs: 10, maxDelayMs: 20 }
      )
    ).rejects.toThrow("EBUSY");

    expect(calls.rename).toBeGreaterThan(1);
    expect(console.warn).toHaveBeenCalledTimes(1); // 首次诊断后不再刷屏
  });

  it("桌面快路径：真实 fs 原子覆盖，不调用 adapter 的 remove/rename", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cqv-sidecar-fast-"));
    try {
      fs.writeFileSync(path.join(dir, "bank.csv.sidecar.json.tmp"), "new");
      fs.writeFileSync(path.join(dir, "bank.csv.sidecar.json"), "old");
      let removeCalls = 0;
      let renameCalls = 0;
      const vault = {
        adapter: {
          getFullPath: (p: string) => path.join(dir, p),
          exists: async () => {
            throw new Error("兜底 exists 不应被调用");
          },
          remove: async () => {
            removeCalls++;
          },
          rename: async () => {
            renameCalls++;
          },
        },
      } as unknown as Vault;

      await renameOverwriteWithRetry(
        vault,
        "bank.csv.sidecar.json.tmp",
        "bank.csv.sidecar.json"
      );

      expect(
        fs.readFileSync(path.join(dir, "bank.csv.sidecar.json"), "utf8")
      ).toBe("new");
      expect(
        fs.existsSync(path.join(dir, "bank.csv.sidecar.json.tmp"))
      ).toBe(false);
      expect(removeCalls).toBe(0);
      expect(renameCalls).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tmp 写入失败（半写）：reject 且清理半写 tmp", async () => {
    const { vault, files, calls } = failingVault(
      {},
      { failWriteTimes: 1, errorCode: "EIO", errorMessage: "EIO: i/o error" }
    );

    await expect(
      writeSidecar(vault, "bank.csv", validSidecar())
    ).rejects.toThrow("EIO");

    expect(files["bank.csv.sidecar.json.tmp"]).toBeUndefined(); // 半写 tmp 已清理
    expect(calls.rename).toBe(0); // 未进入覆盖阶段
    expect(calls.remove).toBe(1); // 仅清理一次
  });

  it("桌面快路径 ENOENT 不 fall through：dest 内容不变且不调用兜底 remove/rename", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cqv-sidecar-enoent-"));
    try {
      // 只建 dest，不建 source（模拟源 tmp 被 iCloud/杀软清掉）
      fs.writeFileSync(path.join(dir, "bank.csv.sidecar.json"), "old");
      let removeCalls = 0;
      let renameCalls = 0;
      const vault = {
        adapter: {
          getFullPath: (p: string) => path.join(dir, p),
          exists: async () => {
            throw new Error("兜底 exists 不应被调用");
          },
          remove: async () => {
            removeCalls++;
          },
          rename: async () => {
            renameCalls++;
          },
        },
      } as unknown as Vault;

      await expect(
        renameOverwriteWithRetry(
          vault,
          "bank.csv.sidecar.json.tmp",
          "bank.csv.sidecar.json"
        )
      ).rejects.toThrow(/ENOENT/);

      // 唯一有效的 sidecar 未被破坏性兜底删除
      expect(
        fs.readFileSync(path.join(dir, "bank.csv.sidecar.json"), "utf8")
      ).toBe("old");
      expect(removeCalls).toBe(0);
      expect(renameCalls).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backupSidecar：写入与 sidecar 一致的 .bak，无 tmp 残留", async () => {
    const sidecarContent = JSON.stringify(validSidecar());
    const { vault, files } = failingVault({
      "bank.csv.sidecar.json": sidecarContent,
    });

    await backupSidecar(vault, "bank.csv");

    expect(files["bank.csv.sidecar.json.bak"]).toBe(sidecarContent);
    expect(files["bank.csv.sidecar.json.bak.tmp"]).toBeUndefined();
  });
});
