import { Notice, Vault } from "obsidian";
import { MemoryCard } from "./types";

/** sidecar 中 B 类覆盖 + C 类状态的合并存储层（同层）。键为题 id。 */
export interface SidecarMeta {
  repeat?: string;
  tags?: string;
  category1?: string;
  category2?: string;
  category3?: string;
  favorite?: string;
  mastered?: string;
  wrong?: string;
}

/** sidecar 的 state 层（C' 使用痕迹），与现有 QuizSessionState 字段对应（见 types.ts）。 */
export interface SidecarState {
  currentIndex: number;
  correctCount: number;
  wrongCount: number;
  displayOrder: string[];
  filterText: string;
  filterTags: string;
  filterCat1: string;
  filterCat2: string;
  filterCat3: string;
  filterFavorite: string;
  filterMastered: string;
  filterRepeat: string;
  filterWrong: string;
  filterUnanswered: string;
  answeredQuestions: Record<string, string>;
  /** 记忆练习的记忆卡片（题 id → 卡片）。旧进度无此字段。 */
  memoryCards?: Record<string, MemoryCard>;
  /** 每日新题配额：最近一次启用记忆练习的自然日（本地日期 "YYYY-MM-DD"）。旧进度无此字段。 */
  memoryNewDate?: string;
  /** 每日新题配额：当日已取的新题数量。旧进度无此字段。 */
  memoryNewCountToday?: number;
  /** 当日已选取但尚未作答的新题 id（退出再进仍保留，不重复扣配额）。旧进度无此字段。 */
  memoryPendingNew?: string[];
  /** 记忆练习是否已初始化过（至少判分一次）；仅删除记忆卡片时保留，避免重复触发首次启用重置提示。旧进度无此字段。 */
  memoryInitialized?: boolean;
}

/** sidecar 文件完整结构（v1）。注意：无 quizId 字段（关联靠同目录同名文件约定）。 */
export interface SidecarData {
  version: 1;
  meta: Record<string, SidecarMeta>;
  state: SidecarState;
}

/** 内容源路径 → sidecar 路径：同目录同名 + ".sidecar.json"（扩展名全名拼接）。
 *  例："题库.csv" → "题库.csv.sidecar.json"；"题库.cqv" → "题库.cqv.sidecar.json" */
export function sidecarPathFor(contentPath: string): string {
  return contentPath + ".sidecar.json";
}

/** 内容源路径 → 备份路径：sidecar 路径 + ".bak" */
export function backupPathFor(contentPath: string): string {
  return sidecarPathFor(contentPath) + ".bak";
}

/** 读 sidecar 的结果。返回 null 表示文件不存在。损坏时自动尝试从 .bak 恢复；bak 也损坏返回 corrupt。 */
export type SidecarReadResult =
  | { status: "ok"; data: SidecarData }
  | { status: "missing" }
  | { status: "recovered"; data: SidecarData } // 从 bak 恢复成功
  | { status: "corrupt"; reason: string }; // sidecar 与 bak 均损坏

/**
 * 读 sidecar。sidecar 不存在时尝试从 .bak 恢复（writeSidecar 的 remove+rename
 * 极端窗口下 sidecar 可能缺失但 tmp 残留，.bak 是唯一可恢复来源）；恢复失败
 * 才返回 missing。损坏时自动尝试从 .bak 恢复；bak 也损坏返回 corrupt。
 */
export async function readSidecar(
  vault: Vault,
  contentPath: string
): Promise<SidecarReadResult> {
  const sidecarPath = sidecarPathFor(contentPath);
  if (!(await vault.adapter.exists(sidecarPath))) {
    // 缺失：尝试从 .bak 恢复（覆盖「remove 成功、rename 失败」的极端窗口，
    // 避免返回 missing 导致进度被当成空状态静默初始化）
    const bakPath = backupPathFor(contentPath);
    const bakExists = await vault.adapter.exists(bakPath);
    if (bakExists) {
      try {
        const bakContent = await vault.adapter.read(bakPath);
        const bakData = normalizeSidecar(JSON.parse(bakContent));
        if (bakData) {
          try {
            await writeSidecar(vault, contentPath, bakData);
          } catch (writeErr) {
            console.error(
              "CSV Quiz: 从备份恢复后重写 sidecar 失败",
              writeErr
            );
          }
          new Notice("状态文件缺失，已从备份恢复");
          return { status: "recovered", data: bakData };
        }
      } catch {
        // bak 也损坏，fallthrough
      }
      // L-final-1: bak 存在但损坏/归一化失败——提示后再初始化新状态，
      // 避免用户误以为旧进度仍在（bak 完全不存在时不弹：新题库首次使用的正常路径）
      new Notice("状态文件缺失，且备份已损坏，将初始化新状态");
    }
    return { status: "missing" };
  }

  try {
    const content = await vault.adapter.read(sidecarPath);
    const data = normalizeSidecar(JSON.parse(content));
    if (!data) {
      throw new Error("sidecar 结构不合法（version 或字段缺失）");
    }
    return { status: "ok", data };
  } catch (e: unknown) {
    // 损坏：尝试从 .bak 恢复并自动修复
    const bakPath = backupPathFor(contentPath);
    const bakExists = await vault.adapter.exists(bakPath);
    if (bakExists) {
      try {
        const bakContent = await vault.adapter.read(bakPath);
        const bakData = normalizeSidecar(JSON.parse(bakContent));
        if (bakData) {
          try {
            await writeSidecar(vault, contentPath, bakData);
          } catch (writeErr) {
            console.error(
              "CSV Quiz: 从备份恢复后重写 sidecar 失败",
              writeErr
            );
          }
          new Notice("状态文件损坏，已从备份恢复");
          return { status: "recovered", data: bakData };
        }
      } catch {
        // bak 也损坏，fallthrough
      }
    }
    const reason = e instanceof Error ? e.message : String(e);
    return {
      status: "corrupt",
      // T12: reason 区分「备份不存在」与「备份也损坏」，供调用方提示重建时给出准确指引
      reason: bakExists
        ? `sidecar 与备份均损坏: ${reason}`
        : `sidecar 损坏且备份不存在: ${reason}`,
    };
  }
}

/**
 * 原子写：写 <path>.tmp 成功后 rename 覆盖（避免写一半损坏）。
 * 注意：Obsidian 的 vault.adapter.rename 在目标文件已存在时会抛
 * "destination file already exist"（它显式检查目标存在，不自动覆盖），
 * 因此 rename 前必须先删除已存在的目标文件。
 * 写前应确保目录存在（内容源文件已存在时同目录必然存在，无需处理）。
 */
export async function writeSidecar(
  vault: Vault,
  contentPath: string,
  data: SidecarData
): Promise<void> {
  const finalPath = sidecarPathFor(contentPath);
  const tmpPath = finalPath + ".tmp";
  await vault.adapter.write(tmpPath, JSON.stringify(data, null, 2));
  // Obsidian rename 不覆盖目标：先删除已存在的目标（若 remove 后 rename 失败的
  // 极端窗口内原文件丢失，由 .bak 备份机制兜底恢复）
  if (await vault.adapter.exists(finalPath)) {
    await vault.adapter.remove(finalPath);
  }
  await vault.adapter.rename(tmpPath, finalPath);
}

/** 创建/覆盖 .bak 备份（复制当前 sidecar 内容）。sidecar 不存在时静默跳过。
 *  失败仅 console.error，不抛出（备份属尽力而为，不应导致调用方 unhandled rejection）。 */
export async function backupSidecar(
  vault: Vault,
  contentPath: string
): Promise<void> {
  const srcPath = sidecarPathFor(contentPath);
  if (!(await vault.adapter.exists(srcPath))) return;
  const bakPath = backupPathFor(contentPath);
  try {
    const content = await vault.adapter.read(srcPath);
    await vault.adapter.write(bakPath, content);
  } catch (e) {
    console.error("CSV Quiz: 备份 sidecar 失败", e);
  }
}

/**
 * 对磁盘上读取的 sidecar 做字段级归一化防御：类型错误的字段
 * （如 correctCount: "5"、memoryNewCountToday: "abc"）在此兜底，避免
 * 类型错误进入运行时崩溃。可选字段缺失保留 undefined。
 * JSON.parse 成功但结构不合法（version 非 1 / 根非对象）返回 null。
 */
function normalizeSidecar(raw: unknown): SidecarData | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return null;

  const toNumber = (v: unknown): number => {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  };
  const toStr = (v: unknown): string => (typeof v === "string" ? v : "");
  const toStrArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const toRecord = (v: unknown): Record<string, string> =>
    v && typeof v === "object" ? (v as Record<string, string>) : {};
  // 可选数值字段：缺失保留 undefined；非法值也归为 undefined
  const toOptNumber = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  };
  // 可选字符串数组字段：仅当原值为数组时保留（过滤非字符串元素）
  const toOptStrArray = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : undefined;
  // 可选布尔字段：仅当原值为 boolean 时保留
  const toOptBool = (v: unknown): boolean | undefined =>
    typeof v === "boolean" ? v : undefined;

  const memoryCards =
    r.memoryCards === undefined
      ? undefined
      : r.memoryCards && typeof r.memoryCards === "object"
        ? (r.memoryCards as Record<string, MemoryCard>)
        : {};

  // meta 层归一化：逐条校验可选字符串字段，非对象条目丢弃
  const meta: Record<string, SidecarMeta> = {};
  if (r.meta && typeof r.meta === "object") {
    for (const [id, value] of Object.entries(r.meta)) {
      if (value && typeof value === "object") {
        meta[id] = normalizeMeta(value as Record<string, unknown>);
      }
    }
  }

  const s =
    r.state && typeof r.state === "object"
      ? (r.state as Record<string, unknown>)
      : {};

  return {
    version: 1,
    meta,
    state: {
      currentIndex: toNumber(s.currentIndex),
      correctCount: toNumber(s.correctCount),
      wrongCount: toNumber(s.wrongCount),
      displayOrder: toStrArray(s.displayOrder),
      filterText: toStr(s.filterText),
      filterTags: toStr(s.filterTags),
      filterCat1: toStr(s.filterCat1),
      filterCat2: toStr(s.filterCat2),
      filterCat3: toStr(s.filterCat3),
      filterFavorite: toStr(s.filterFavorite),
      filterMastered: toStr(s.filterMastered),
      filterRepeat: toStr(s.filterRepeat),
      filterWrong: toStr(s.filterWrong),
      filterUnanswered: toStr(s.filterUnanswered),
      answeredQuestions: toRecord(s.answeredQuestions),
      memoryCards,
      memoryNewDate:
        typeof s.memoryNewDate === "string" ? s.memoryNewDate : undefined,
      memoryNewCountToday: toOptNumber(s.memoryNewCountToday),
      memoryPendingNew: toOptStrArray(s.memoryPendingNew),
      memoryInitialized: toOptBool(s.memoryInitialized),
    },
  };
}

/** meta 单条归一化：仅保留字符串类型的可选字段，其余字段/类型丢弃。 */
function normalizeMeta(raw: Record<string, unknown>): SidecarMeta {
  const toStrOpt = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const result: SidecarMeta = {};
  // 逐字段校验，可选字段缺失保留 undefined（即不写入 result）
  const candidate: [keyof SidecarMeta, string | undefined][] = [
    ["repeat", toStrOpt(raw.repeat)],
    ["tags", toStrOpt(raw.tags)],
    ["category1", toStrOpt(raw.category1)],
    ["category2", toStrOpt(raw.category2)],
    ["category3", toStrOpt(raw.category3)],
    ["favorite", toStrOpt(raw.favorite)],
    ["mastered", toStrOpt(raw.mastered)],
    ["wrong", toStrOpt(raw.wrong)],
  ];
  for (const [key, value] of candidate) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** 串行写队列：同内容源连续入队时合并（只保留最后一次数据，写一次）。参考 CSVWriteQueue 模式，无 transform 合并。 */
export class SidecarWriteQueue {
  private queue: Array<{
    contentPath: string;
    data: SidecarData;
    resolves: Array<(value: void) => void>;
    rejects: Array<(reason: unknown) => void>;
  }> = [];
  private processing = false;
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /** 入队一次 sidecar 全量写。同内容源连续入队时合并（只保留最后一次数据，写一次）。 */
  enqueue(contentPath: string, data: SidecarData): Promise<void> {
    // 若队列中已有同 contentPath 的项（尚未开始处理），合并写入：
    // 用新 data 全量替换旧数据，并把本次 promise 的 resolve/reject 登记到该项。
    const existing = this.queue.find(
      (item) => item.contentPath === contentPath
    );
    if (existing) {
      existing.data = data;
      return new Promise<void>((resolve, reject) => {
        existing.resolves.push(resolve);
        existing.rejects.push(reject);
      });
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        contentPath,
        data,
        resolves: [resolve],
        rejects: [reject],
      });
      void this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift()!;
    try {
      await writeSidecar(this.vault, item.contentPath, item.data);
      for (const resolve of item.resolves) resolve();
    } catch (e: unknown) {
      // 写入失败：reject 该项所有 promise
      for (const reject of item.rejects) reject(e);
    } finally {
      this.processing = false;
      void this.processNext();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  /** 等待队列清空（参考 CSVWriteQueue.drain 的轮询实现）。 */
  async drain(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
    }
  }
}

/** 每 backupIntervalMs 触发一次 backupCb 的定时器管理（供"活跃 30 分钟备份"使用）。
 *  start 可重复调用（先 stop 再 start）。 */
export interface BackupTimer {
  start(backupCb: () => void, backupIntervalMs?: number): void;
  stop(): void;
}

const DEFAULT_BACKUP_INTERVAL_MS = 30 * 60 * 1000;

/** 创建备份定时器。默认间隔 30 分钟；start 重复调用会先停止旧定时器。 */
export function createBackupTimer(): BackupTimer {
  let timer: number | null = null;
  return {
    start(backupCb: () => void, backupIntervalMs?: number): void {
      if (timer !== null) {
        window.clearInterval(timer);
      }
      timer = window.setInterval(
        backupCb,
        backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS
      );
    },
    stop(): void {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
  };
}
