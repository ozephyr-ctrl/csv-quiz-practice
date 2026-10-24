import type { Vault } from "obsidian";

/** 内存中的假文件：内容 + mtime（写入/外部写入时推进）。 */
interface FakeEntry {
  content: string;
  mtimeMs: number;
}

/** 单次写入后可替换落盘内容的钩子（模拟同步服务截断/追加造成的字节数不符）。 */
export type FakeWriteHook = (path: string, content: string) => string | undefined;

/**
 * 测试用最小 Vault：adapter.write/rename/remove 都维护内容与 mtime/size，
 * 支持 `foreignWrite` 模拟「外部设备/同步服务改了文件」（不经过本插件的写路径）。
 * 故意不实现 getFullPath，让 writeSidecar 走 adapter 兜底路径（避免真实 fs）。
 */
export class FakeVault {
  readonly files = new Map<string, FakeEntry>();
  /** adapter.read 调用记录（按路径，含 .bak/.tmp）。 */
  readonly readCalls: string[] = [];
  /** adapter.write 调用记录（按路径，含 .tmp 中间文件）。 */
  readonly writeCalls: string[] = [];
  writeHook: FakeWriteHook | null = null;
  private clock: number;

  constructor(initial: Record<string, string> = {}, startClock = 1_000) {
    this.clock = startClock;
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, { content, mtimeMs: this.tick() });
    }
  }

  /** 模拟外部写入：内容与 mtime 变化，且不计入 readCalls/writeCalls。 */
  foreignWrite(path: string, content: string, mtimeMs?: number): void {
    this.files.set(path, { content, mtimeMs: mtimeMs ?? this.tick() });
  }

  /** 模拟外部删除。 */
  foreignRemove(path: string): void {
    this.files.delete(path);
  }

  readText(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  readJson<T>(path: string): T {
    const content = this.files.get(path)?.content;
    if (content === undefined) throw new Error("file not found: " + path);
    return JSON.parse(content) as T;
  }

  /** 测试初始化用：直接放置 JSON（推进 mtime）。 */
  putJson(path: string, data: unknown): void {
    this.foreignWrite(path, JSON.stringify(data));
  }

  /** 某路径被 adapter.stat 观测到的字节数。 */
  sizeOf(path: string): number {
    const entry = this.files.get(path);
    return entry === undefined ? -1 : byteLength(entry.content);
  }

  private tick(): number {
    this.clock += 1_000;
    return this.clock;
  }

  get vault(): Vault {
    return {
      adapter: {
        exists: async (path: string) => this.files.has(path),
        read: async (path: string) => {
          this.readCalls.push(path);
          const entry = this.files.get(path);
          if (!entry) throw new Error("not found: " + path);
          return entry.content;
        },
        write: async (path: string, content: string) => {
          this.writeCalls.push(path);
          const hooked = this.writeHook?.(path, content);
          this.files.set(path, {
            content: hooked === undefined ? content : hooked,
            mtimeMs: this.tick(),
          });
        },
        rename: async (from: string, to: string) => {
          const entry = this.files.get(from);
          if (!entry) throw new Error("rename source not found: " + from);
          this.files.delete(from);
          // rename 保留 mtime（与真实文件系统覆盖移动一致）
          this.files.set(to, entry);
        },
        remove: async (path: string) => {
          this.files.delete(path);
        },
        stat: async (path: string) => {
          const entry = this.files.get(path);
          if (!entry) throw new Error("stat not found: " + path);
          return { mtime: entry.mtimeMs, size: byteLength(entry.content), type: "file" };
        },
        list: async (dir: string) => {
          const prefix = dir === "/" ? "" : dir + "/";
          const files = [...this.files.keys()].filter(
            (path) =>
              path.startsWith(prefix) &&
              !path.slice(prefix.length).includes("/")
          );
          return { files, folders: [] };
        },
      },
    } as unknown as Vault;
  }
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).length;
}
