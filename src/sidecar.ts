import { Notice, Platform, Vault } from "obsidian";
import { MemoryCard } from "./types";
import { normalizeMemoryCards } from "./utils";
import { normalizeDailyAnswers, pruneDailyAnswers } from "./practiceStats";

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
  /** 该条目最近一次写入时间（epoch ms）。供同步冲突合并时判定字段新旧；旧文件缺失。 */
  ts?: number;
}

/** sidecar 的 state 层（C' 使用痕迹），与现有 QuizSessionState 字段对应（见 types.ts）。 */
export interface SidecarState {
  currentIndex: number;
  correctCount: number;
  wrongCount: number;
  displayOrder: string[];
  filterText: string;
  filterTags: string;
  /** 排除标签筛选（空格分隔；题含任一排除标签即被滤除）。旧进度无此字段。 */
  filterTagsExcluded: string;
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
  /** 每日答题事件数（"YYYY-MM-DD" → 次数）。供练习面板统计与折线图；旧进度无此字段。 */
  dailyAnswers?: Record<string, number>;
  /** 该 sidecar 最近一次写盘时间（epoch ms）。供同步冲突合并时判定文件新旧；旧文件缺失。 */
  updatedAt?: number;
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
 * 读 sidecar。sidecar 不存在时尝试从 .bak 恢复（writeSidecar 的覆盖写入持续
 * 失败的极端窗口下 sidecar 可能缺失、tmp 已尽力清理，.bak 是唯一可恢复来源）；
 * 恢复失败才返回 missing。损坏时自动尝试从 .bak 恢复；bak 也损坏返回 corrupt。
 */
export async function readSidecar(
  vault: Vault,
  contentPath: string
): Promise<SidecarReadResult> {
  const sidecarPath = sidecarPathFor(contentPath);
  if (!(await vault.adapter.exists(sidecarPath))) {
    // 缺失：尝试从 .bak 恢复（覆盖写入长期失败导致原文件未落地的极端窗口，
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

/** sidecar 保存防抖间隔（ms）：降低同步目录（iCloud 等）的写入频率与冲突副本概率。 */
export const SIDECAR_SAVE_DEBOUNCE_MS = 1000;

/** 同步目录下常见的「文件被占用/锁定」类可重试错误码（Windows EBUSY，权限类 EPERM/EACCES，目录非空 ENOTEMPTY）。 */
const RETRYABLE_FS_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

/** 判断错误是否为可重试的文件系统错误：错误码命中集合，或 message 匹配 EBUSY/EPERM/EACCES/占用/锁定。 */
export function isRetryableFsError(e: unknown): boolean {
  if (e !== null && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_FS_CODES.has(code)) return true;
  }
  const message = e instanceof Error ? e.message : String(e);
  return /\b(EBUSY|EPERM|EACCES)\b|resource busy|locked/i.test(message);
}

/** renameOverwriteWithRetry 的重试参数（均可选，默认值见函数实现）。 */
export interface RenameRetryOptions {
  /** 重试总预算（ms）：从首次尝试起累计超过后抛出最后一次错误。 */
  budgetMs?: number;
  /** 退避基数（ms）：第 n 次失败后延迟 baseDelayMs × (n + 1)。 */
  baseDelayMs?: number;
  /** 退避上限（ms）。 */
  maxDelayMs?: number;
}

const DEFAULT_RENAME_RETRY_BUDGET_MS = 30000;
const DEFAULT_RENAME_RETRY_BASE_DELAY_MS = 50;
const DEFAULT_RENAME_RETRY_MAX_DELAY_MS = 250;

/** 睡眠指定毫秒（window.setTimeout 保证 popout 兼容；vitest 为 node 环境无 window，退回 globalThis）。 */
function sleep(ms: number): Promise<void> {
  const host: { setTimeout: (cb: () => void, ms: number) => number } =
    typeof window !== "undefined" ? window : globalThis;
  return new Promise<void>((resolve) => host.setTimeout(resolve, ms));
}

/**
 * 懒加载 Node fs.promises（动态 import + Platform.isDesktop 守卫，结果缓存）。
 * manifest 是 isDesktopOnly:false，esbuild 将 fs 标记 external，若在模块顶层
 * 静态 import fs，移动端加载插件即崩溃；动态 import（esbuild cjs 输出保留原生
 * import()）由 Platform.isDesktop 守卫短路，移动端永不触发。加载失败（异常
 * 环境）返回 null。
 */
let fsPromisesCache: typeof import("fs").promises | null | undefined;
async function loadNodeFsPromises(): Promise<typeof import("fs").promises | null> {
  if (fsPromisesCache !== undefined) return fsPromisesCache;
  if (!Platform.isDesktop) {
    fsPromisesCache = null;
    return null;
  }
  try {
    fsPromisesCache = (await import("fs")).promises;
  } catch {
    fsPromisesCache = null;
  }
  return fsPromisesCache;
}

/**
 * 执行一次覆盖式移动。桌面快路径：adapter 提供 getFullPath 且 Node fs 可用时，
 * 用 fs.rename 覆盖目标（Windows 走 MoveFileEx 覆盖语义，无需先删目标，避开
 * remove 的 EBUSY）。**一旦进入快路径，任何错误（含非可重试的 ENOENT，典型
 * 源 tmp 被同步服务/杀软清掉）都直接抛给重试循环，绝不 fall through**——
 * 否则源缺失时兜底会先 remove 掉唯一有效的目标文件，再 rename 失败造成数据丢失。
 * 仅当 getFullPath 缺失或 fs 不可用（移动端/异常环境）时才走兜底路径：
 * 目标存在则先 remove 再 adapter.rename（Obsidian rename 不覆盖已存在目标）。
 */
async function renameOverwriteOnce(
  vault: Vault,
  sourcePath: string,
  destPath: string
): Promise<void> {
  const adapter = vault.adapter as unknown as {
    getFullPath?: (p: string) => string;
  };
  if (typeof adapter.getFullPath === "function") {
    const fsp = await loadNodeFsPromises();
    if (fsp) {
      // 桌面快路径：错误一律上报（可重试错误由外层退避重试；非可重试立即抛）
      await fsp.rename(
        adapter.getFullPath(sourcePath),
        adapter.getFullPath(destPath)
      );
      return;
    }
  }
  if (await vault.adapter.exists(destPath)) {
    await vault.adapter.remove(destPath);
  }
  await vault.adapter.rename(sourcePath, destPath);
}

/**
 * 覆盖式移动（带重试）：把 sourcePath 移动到 destPath，目标已存在时覆盖。
 * 桌面端优先 Node fs.rename（原子覆盖，避免 unlink 目标导致的 EBUSY）；其余
 * 情况回退「存在则 remove + rename」兜底。可重试错误按预算退避重试（首次
 * console.warn 一次，后续不刷屏）；总耗时超过 budgetMs 抛出最后一次错误；
 * 非可重试错误立即抛出。
 */
export async function renameOverwriteWithRetry(
  vault: Vault,
  sourcePath: string,
  destPath: string,
  options: RenameRetryOptions = {}
): Promise<void> {
  const budgetMs = options.budgetMs ?? DEFAULT_RENAME_RETRY_BUDGET_MS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RENAME_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RENAME_RETRY_MAX_DELAY_MS;
  const startedAt = Date.now();
  let failures = 0;
  let warned = false;
  for (;;) {
    try {
      await renameOverwriteOnce(vault, sourcePath, destPath);
      return;
    } catch (e: unknown) {
      if (!isRetryableFsError(e)) throw e;
      if (!warned) {
        warned = true;
        console.warn("CSV Quiz: 文件被占用，正在重试覆盖写入", sourcePath, e);
      }
      if (Date.now() - startedAt >= budgetMs) throw e;
      const delay = Math.min(maxDelayMs, baseDelayMs * (failures + 1));
      failures++;
      await sleep(delay);
    }
  }
}

/** 清理失败的临时文件（exists→remove）；清理自身的错误吞掉，避免掩盖原始错误。 */
async function cleanupTempFile(vault: Vault, tmpPath: string): Promise<void> {
  try {
    if (await vault.adapter.exists(tmpPath)) {
      await vault.adapter.remove(tmpPath);
    }
  } catch {
    // 残留 .tmp 可被下次写入覆盖，不因清理失败改变抛出行为
  }
}

/**
 * 写入 sidecar：先写 <path>.tmp（紧凑 JSON，无缩进，缩小体积与同步冲突面），
 * 成功后用 renameOverwriteWithRetry 覆盖最终文件（桌面原子 rename / 兜底
 * remove+rename，EBUSY 等可重试错误带预算重试）。tmp 写入或覆盖失败时清理
 * 残留 tmp，避免被 iCloud 等同步服务当成新文件产生冲突副本。
 * 写前应确保目录存在（内容源文件已存在时同目录必然存在，无需处理）。
 */
export async function writeSidecar(
  vault: Vault,
  contentPath: string,
  data: SidecarData
): Promise<void> {
  const finalPath = sidecarPathFor(contentPath);
  const tmpPath = finalPath + ".tmp";
  try {
    await vault.adapter.write(tmpPath, JSON.stringify(data));
    await renameOverwriteWithRetry(vault, tmpPath, finalPath);
  } catch (e) {
    // write 半写/覆盖失败均清理残留 tmp，避免被同步服务当成新文件产生冲突副本
    await cleanupTempFile(vault, tmpPath);
    throw e;
  }
}

/** 创建/覆盖 .bak 备份（复制当前 sidecar 内容）。sidecar 不存在时静默跳过。
 *  走 tmp + renameOverwriteWithRetry 稳健路径（bak 是损坏恢复的唯一来源）；
 *  失败清理 tmp 并抛出，由调用方 try/catch console.error 维持尽力而为语义。 */
export async function backupSidecar(
  vault: Vault,
  contentPath: string
): Promise<void> {
  const srcPath = sidecarPathFor(contentPath);
  if (!(await vault.adapter.exists(srcPath))) return;
  const bakPath = backupPathFor(contentPath);
  const tmpPath = bakPath + ".tmp";
  try {
    const content = await vault.adapter.read(srcPath);
    await vault.adapter.write(tmpPath, content);
    await renameOverwriteWithRetry(vault, tmpPath, bakPath);
  } catch (e) {
    await cleanupTempFile(vault, tmpPath);
    throw e;
  }
}

/**
 * 对磁盘上读取的 sidecar 做字段级归一化防御：类型错误的字段
 * （如 correctCount: "5"、memoryNewCountToday: "abc"）在此兜底，避免
 * 类型错误进入运行时崩溃。可选字段缺失保留 undefined。
 * JSON.parse 成功但结构不合法（version 非 1 / 根非对象）返回 null。
 */
export function normalizeSidecar(raw: unknown): SidecarData | null {
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

  // meta 层归一化：逐条校验可选字符串字段，非对象条目丢弃。
  // 用 defineProperty 而非 meta[id] = ...：题 id 可能是 "__proto__" 等原型键，
  // 直接赋值会改写原型而不是写入自有属性，导致该题 meta 静默丢失。
  const meta: Record<string, SidecarMeta> = {};
  if (r.meta && typeof r.meta === "object") {
    for (const [id, value] of Object.entries(r.meta)) {
      if (value && typeof value === "object") {
        Object.defineProperty(meta, id, {
          value: normalizeMeta(value as Record<string, unknown>),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }

  const s =
    r.state && typeof r.state === "object"
      ? (r.state as Record<string, unknown>)
      : {};

  // 记忆卡片在 state 层（写入端 stateToSidecar 输出 state.memoryCards），
  // 从顶层 r.memoryCards 读取会恒为 undefined 导致卡片读回丢失；
  // 逐卡片字段级归一化，类型错误的损坏卡片整卡剔除（题目回到新题状态）
  const memoryCards =
    s.memoryCards === undefined
      ? undefined
      : normalizeMemoryCards(s.memoryCards);

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
      filterTagsExcluded: toStr(s.filterTagsExcluded),
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
      dailyAnswers: normalizeDailyAnswers(s.dailyAnswers),
      updatedAt: toOptNumber(s.updatedAt),
    },
  };
}

/** meta 的字符串数据字段名（ts 是时间戳，不属于数据字段）。 */
export type MetaStringField = Exclude<keyof SidecarMeta, "ts">;

/** meta 单条归一化：仅保留字符串类型的可选字段，其余字段/类型丢弃。ts 数值字段单独保留。 */
function normalizeMeta(raw: Record<string, unknown>): SidecarMeta {
  const toStrOpt = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const result: SidecarMeta = {};
  // 逐字段校验，可选字段缺失保留 undefined（即不写入 result）
  const candidate: [MetaStringField, string | undefined][] = [
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
  // 冲突合并时间戳：有限非负数值才保留
  if (
    typeof raw.ts === "number" &&
    Number.isFinite(raw.ts) &&
    raw.ts >= 0
  ) {
    result.ts = raw.ts;
  }
  return result;
}

/**
 * 通用串行 job 链：所有通过 enqueue 提交的异步任务严格按提交顺序执行（前一个
 * 完成/失败后再跑下一个），任一任务失败不会中断后续任务（job 的 rejection
 * 只回传给提交者）。写盘前的「读-合并-写」必须串行，否则并发保存会互相覆盖
 * 或重复计数；因此队列不再按 contentPath 合并 payload，由调用方在 job 内部
 * 自行决定读改写语义。
 */
export class SidecarWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.depth++;
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => {}).finally(() => {
      this.depth--;
    });
    return run;
  }

  get pending(): number {
    return this.depth;
  }

  /** 等待队列清空（含等待期间新入队的任务）。 */
  async drain(): Promise<void> {
    while (this.depth > 0) await this.tail;
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

/* ===================== 同步冲突副本：检测与合并 ===================== */

/** 冲突副本归档后缀（iCloud 等同步服务产生的冲突副本合并后改名保留，不删除）。 */
export const SIDECAR_MERGED_SUFFIX = ".merged";

/** 正则元字符转义（文件名进入 RegExp 前必须转义）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从目录文件列表中找出 contentPath 的 sidecar 冲突副本。覆盖两类命名（S = 一个或多个序号组）：
 * - sidecar 自身被冲突：`<contentPath>.sidecar<S>.json`（macOS " 2"、Windows "(1)"，含嵌套 "(2)(1)"）
 * - 主文件被冲突后其 sidecar：`<contentPath><S>.sidecar.json`（如 "题库.cqv 2.sidecar.json"）
 * macOS 空格序号从 2 起（" 1" 视为用户命名），Windows 括号序号从 1 起。
 * 返回匹配的完整路径列表（不含规范 sidecar，也不含 .tmp/.bak/.merged 归档）。
 */
export function findSidecarConflictPaths(
  allFiles: string[],
  contentPath: string
): string[] {
  const suffixGroup = "((?: \\d+| ?\\(\\d+\\))+)?";
  const re = new RegExp(
    "^" +
      escapeRegExp(contentPath) +
      suffixGroup +
      "\\.sidecar" +
      suffixGroup +
      "\\.json$"
  );
  const result: string[] = [];
  for (const file of allFiles) {
    const m = re.exec(file);
    if (!m) continue;
    const mainSuffix = m[1];
    const sidecarSuffix = m[2];
    if (!mainSuffix && !sidecarSuffix) continue; // 规范 sidecar 本身
    // 校验序号：空格组必须 ≥2（排除用户命名 "xxx 1"）；括号组 ≥1 即可（Windows iCloud 从 (1) 起）
    const spaceNums: string[] = [
      ...(mainSuffix?.match(/ \d+/g) ?? []),
      ...(sidecarSuffix?.match(/ \d+/g) ?? []),
    ];
    if (spaceNums.some((n) => Number(n.trim()) < 2)) continue;
    result.push(file);
  }
  return result;
}

/**
 * 从目录文件列表中找出 contentPath 的「已归档冲突副本」路径（`.merged` 后缀）。
 * 覆盖与 findSidecarConflictPaths 相同的两类命名，另加规范 sidecar 自身的归档：
 * - `<contentPath>.sidecar.json.merged`（规范 sidecar 被归档）
 * - `<contentPath>.sidecar<S>.json.merged`（sidecar 自身被冲突后归档）
 * - `<contentPath><S>.sidecar.json.merged`（主文件被冲突后归档）
 * 编号校验同 findSidecarConflictPaths：空格序号 ≥2、括号序号 ≥1。
 * 只接受以 `.merged` 结尾的路径；`.merged.recovered`（已恢复过一次的归档）不匹配，
 * 避免重复恢复。
 */
export function findMergedSidecarPaths(
  allFiles: string[],
  contentPath: string
): string[] {
  const suffixGroup = "((?: \\d+| ?\\(\\d+\\))+)?";
  const re = new RegExp(
    "^" +
      escapeRegExp(contentPath) +
      suffixGroup +
      "\\.sidecar" +
      suffixGroup +
      "\\.json" +
      escapeRegExp(SIDECAR_MERGED_SUFFIX) +
      "$"
  );
  const result: string[] = [];
  for (const file of allFiles) {
    const m = re.exec(file);
    if (!m) continue;
    const mainSuffix = m[1];
    const sidecarSuffix = m[2];
    // 校验序号：空格组必须 ≥2（排除用户命名的 "xxx 1"）；括号组 ≥1 即可
    const spaceNums: string[] = [
      ...(mainSuffix?.match(/ \d+/g) ?? []),
      ...(sidecarSuffix?.match(/ \d+/g) ?? []),
    ];
    if (spaceNums.some((n) => Number(n.trim()) < 2)) continue;
    result.push(file);
  }
  return result;
}

/** 参与合并的冲突副本源：归一化数据 + 有效写入时间（state.updatedAt ?? 文件 mtime）。 */
export interface SidecarConflictSource {
  path: string;
  data: SidecarData;
  tsMs: number;
}

/** mergeSidecarData 的结果：合并数据 + 诊断计数。 */
export interface SidecarMergeResult {
  data: SidecarData;
  /** 并入 base 中原本缺失的答题记录条数。 */
  addedAnswers: number;
  /** 本次并入的答题记录对应题 id（供调用方按累计口径补计对错统计）。 */
  addedAnswerIds: string[];
  /** 实际参与合并的冲突副本数。 */
  mergedSources: number;
}

/** meta 条目的可合并字符串字段（ts 是时间戳，不参与字段合并）。 */
const META_MERGE_FIELDS: MetaStringField[] = [
  "repeat",
  "tags",
  "category1",
  "category2",
  "category3",
  "favorite",
  "mastered",
  "wrong",
];

/**
 * 把冲突副本并入 base（当前权威状态），产出合并后的完整 sidecar 数据。合并语义：
 * - state 标量（位置/筛选/统计/displayOrder/memory 配额）整体保留 base —— 会话级字段
 *   以用户当前所见为准，不跨设备拼接；
 * - answeredQuestions 按 key 取并集，同 key 以 base 为准（无逐条时间戳，取当前进度可预期）；
 * - meta 按 (id, field) 合并，冲突时以较新的写入时间（entry.ts ?? 源时间戳）为准，
 *   时间相同 base 优先；
 * - memoryCards 按 id 取较新卡片，卡片真实新旧以 lastReview 为准（同步/恢复过程中
 *   card.ts 可能被旧版合并逻辑污染成「现在」，不能作为唯一依据）；lastReview 缺失/为空
 *   时回退 (card.ts ?? 源时间戳)，元组字典序相同则 base 优先。
 * 合并为纯函数且幂等：对已合并结果重放相同副本不改变数据。
 */
export function mergeSidecarData(
  base: SidecarData,
  baseTsMs: number,
  others: SidecarConflictSource[]
): SidecarMergeResult {
  // 源按时间升序处理；base 放最后（时间相同时 base 的写入覆盖副本）
  const orderedSources: Array<{
    meta: Record<string, SidecarMeta>;
    state: SidecarState;
    tsMs: number;
  }> = others
    .slice()
    .sort((a, b) => a.tsMs - b.tsMs)
    .map((src) => ({ meta: src.data.meta, state: src.data.state, tsMs: src.tsMs }));
  orderedSources.push({ meta: base.meta, state: base.state, tsMs: baseTsMs });

  // answered：并集，同 key 后写覆盖（base 最后处理 → base 优先）
  const answered: Record<string, string> = {};
  const addedAnswerIds: string[] = [];
  const baseAnswered = base.state.answeredQuestions;
  for (let i = 0; i < orderedSources.length; i++) {
    const src = orderedSources[i];
    const isBase = i === orderedSources.length - 1;
    for (const [id, ans] of Object.entries(src.state.answeredQuestions)) {
      if (typeof ans !== "string") continue;
      // 只记录"由冲突副本首次补入且 base 缺失"的 key（调用方据此补计统计）
      if (!isBase && !(id in answered) && !(id in baseAnswered)) {
        addedAnswerIds.push(id);
      }
      answered[id] = ans;
    }
  }

  // meta：按 (id, field) 以写入时间取胜者。
  // 用 Map 而非普通对象做字典：题 id 可能是 "constructor"/"toString" 等原型属性名，
  // 普通对象的取值/`in` 会命中 Object.prototype，导致字段比较与写入被静默跳过。
  type Cell = { value: string; ts: number };
  const cells = new Map<string, Partial<Record<keyof SidecarMeta, Cell>>>();
  for (const src of orderedSources) {
    for (const [id, entry] of Object.entries(src.meta)) {
      if (!entry) continue;
      const entryTs =
        typeof entry.ts === "number" && Number.isFinite(entry.ts)
          ? entry.ts
          : src.tsMs;
      for (const field of META_MERGE_FIELDS) {
        const value = entry[field];
        if (typeof value !== "string") continue;
        const fields = cells.get(id);
        const cur = fields?.[field];
        if (!cur || entryTs >= cur.ts) {
          if (fields) {
            fields[field] = { value, ts: entryTs };
          } else {
            cells.set(id, { [field]: { value, ts: entryTs } });
          }
        }
      }
    }
  }
  const meta: Record<string, SidecarMeta> = {};
  for (const [id, fields] of cells) {
    const entry: SidecarMeta = {};
    let maxTs: number | undefined;
    for (const field of META_MERGE_FIELDS) {
      const cell = fields[field];
      if (!cell) continue;
      entry[field] = cell.value;
      maxTs = maxTs === undefined ? cell.ts : Math.max(maxTs, cell.ts);
    }
    if (maxTs !== undefined) entry.ts = maxTs;
    // 原型键（__proto__ 等）经赋值会落成原型而非自有属性；Object.defineProperty
    // 保证任意合法 id 都能成为 meta 的自有键。
    Object.defineProperty(meta, id, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  // memoryCards：按 id 取较新卡片。卡片真实新旧以 lastReview 为准——card.ts 可能被
  // 旧版合并逻辑（base 时间戳兜底 Date.now()）污染成「现在」，仅凭 ts 会把旧卡片
  // 误判为较新；lastReview 缺失/为空/不可解析时回退 cardTs。
  // 以 (lastReviewMs, cardTs) 字典序比较，源按时间升序、base 最后处理 → 完全平局 base 优先。
  // 同样用 Map 防原型键污染（"constructor" 等 id 在普通对象上会命中 Object.prototype）。
  const cards = new Map<string, MemoryCard>();
  const cardKeys = new Map<
    string,
    { lastReviewMs: number; cardTs: number }
  >();
  for (const src of orderedSources) {
    const srcCards = src.state.memoryCards;
    if (!srcCards) continue;
    for (const [id, card] of Object.entries(srcCards)) {
      if (!card) continue;
      const cardTs =
        typeof card.ts === "number" && Number.isFinite(card.ts)
          ? card.ts
          : src.tsMs;
      const reviewParsed =
        typeof card.lastReview === "string" && card.lastReview !== ""
          ? Date.parse(card.lastReview)
          : NaN;
      const lastReviewMs = Number.isFinite(reviewParsed)
        ? reviewParsed
        : -Infinity;
      const cur = cardKeys.get(id);
      if (
        !cur ||
        lastReviewMs > cur.lastReviewMs ||
        (lastReviewMs === cur.lastReviewMs && cardTs >= cur.cardTs)
      ) {
        cards.set(id, {
          ...card,
          // ts 归一为 max(cardTs, lastReviewMs)：保证恢复出的较新卡片不会在后续
          // 合并中再被旧 ts 压住；正常复习时 lastReview ≤ ts，最大值即原 cardTs，行为不变。
          ts: Math.max(
            cardTs,
            lastReviewMs === -Infinity ? 0 : lastReviewMs
          ),
        });
        cardKeys.set(id, { lastReviewMs, cardTs });
      }
    }
  }

  const state: SidecarState = {
    ...base.state,
    answeredQuestions: answered,
    // 双方都无卡片时保持 undefined（不写入空对象污染旧格式兼容）。
    // Object.fromEntries 对 "__proto__" 等键也生成自有属性（不同于赋值）。
    memoryCards:
      base.state.memoryCards === undefined && cards.size === 0
        ? undefined
        : Object.fromEntries(cards),
  };

  return {
    data: { version: 1, meta, state },
    addedAnswers: addedAnswerIds.length,
    addedAnswerIds,
    mergedSources: others.length,
  };
}

/* ===================== 保存层 base/memory/disk 三方合并 ===================== */

/**
 * 统计基线：上次从磁盘读出（或上次成功保存）时 state 的累计计数快照。
 * 保存时用 memory - baseline 得到「本次会话新增的答题事件数」，再叠加到磁盘当前值上，
 * 避免用 memory - base 或整体覆盖把其他设备写入的计数抹掉。
 */
export interface StatsBaseline {
  correct: number;
  wrong: number;
  daily: Record<string, number>;
}

/** 本次会话内被显式删除（权威删除）的题 id 集合，保存合并时据此阻止磁盘侧「复活」。 */
export interface SidecarTombstones {
  answered: Set<string>;
  cards: Set<string>;
  meta: Set<string>;
  /** 字段级 meta tombstone：题 id → 被显式删除的 B 类字段名（其余字段仍可合并）。 */
  metaFields: Map<string, Set<string>>;
}

/** 取 own 属性值：区分「键缺失」与「键存在但值为空字符串」，且不受原型链干扰。 */
function ownProp<T>(
  record: Record<string, T> | undefined,
  key: string
): T | undefined {
  if (!record) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/** 有限数值才视为有效时间戳。 */
function finiteTs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 非负有限计数（损坏数据兜底为 0）。 */
function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * 深拷贝 sidecar：meta 逐 entry 拷贝，state 的记录/数组/卡片对象全部新建，
 * 避免合并结果与入参共享引用（合并函数不得修改入参）。
 */
export function cloneSidecarData(data: SidecarData): SidecarData {
  const metaEntries: Array<[string, SidecarMeta]> = Object.entries(data.meta).map(
    ([id, entry]) => [id, entry ? { ...entry } : entry]
  );
  const state = data.state;
  const cardEntries: Array<[string, MemoryCard]> | undefined =
    state.memoryCards === undefined
      ? undefined
      : Object.entries(state.memoryCards).map(([id, card]) => [
          id,
          card ? { ...card } : card,
        ]);
  return {
    version: 1,
    meta: Object.fromEntries(metaEntries) as Record<string, SidecarMeta>,
    state: {
      ...state,
      displayOrder: state.displayOrder.slice(),
      answeredQuestions: { ...state.answeredQuestions },
      memoryCards:
        cardEntries === undefined
          ? undefined
          : (Object.fromEntries(cardEntries) as Record<string, MemoryCard>),
      memoryPendingNew:
        state.memoryPendingNew === undefined
          ? undefined
          : state.memoryPendingNew.slice(),
      dailyAnswers:
        state.dailyAnswers === undefined
          ? undefined
          : { ...state.dailyAnswers },
    },
  };
}

/** 提取 sidecar 的统计快照（null = 未读到文件 → 全 0 基线）。 */
export function countersOfSidecar(data: SidecarData | null): StatsBaseline {
  if (!data) return { correct: 0, wrong: 0, daily: {} };
  return {
    correct: safeCount(data.state.correctCount),
    wrong: safeCount(data.state.wrongCount),
    daily: { ...(data.state.dailyAnswers ?? {}) },
  };
}

/** 卡片新旧排序键：lastReview 优先，非法/缺失回退 ts。 */
function cardFreshness(card: MemoryCard): { review: number; ts: number } {
  const parsed =
    typeof card.lastReview === "string" && card.lastReview !== ""
      ? Date.parse(card.lastReview)
      : NaN;
  return {
    review: Number.isFinite(parsed) ? parsed : -Infinity,
    ts: finiteTs(card.ts) ?? -Infinity,
  };
}

/** disk 卡片是否严格新于 memory 卡片（完全平局返回 false → 内存优先）。 */
function isCardNewer(diskCard: MemoryCard, memCard: MemoryCard): boolean {
  const d = cardFreshness(diskCard);
  const m = cardFreshness(memCard);
  if (d.review !== m.review) return d.review > m.review;
  return d.ts > m.ts;
}

/**
 * 保存层三方合并（纯函数，不修改入参）：把内存状态写成磁盘可接受的新状态。
 * - base：本次会话最初从磁盘读到的数据（null = 本次会话从未读到该文件）；
 * - memory：当前内存中的权威会话状态；
 * - disk：保存前重新读到的磁盘最新数据（null = 文件缺失，此时用 base 兜底，
 *   绝不能当成空状态）；
 * - statsBaseline：计数/每日的累计快照，用于只把「本次会话增量」叠加到磁盘值上；
 * - tombstones：本次会话权威删除的题 id，阻止磁盘旧数据复活。
 *
 * 合并语义：
 * - answeredQuestions / meta / memoryCards 按并集处理：内存缺失≠删除（只由
 *   tombstones 或权威写删除）；内存未改动（m === base）的键让磁盘新值胜出；
 * - 计数与每日用 statsBaseline 计算增量，叠加到磁盘当前值（不被内存整体覆盖）；
 * - 会话级字段（位置/筛选/displayOrder/memory 配额）一律内存优先。
 */
export function mergeSidecarForWrite(args: {
  base: SidecarData | null;
  memory: SidecarData;
  disk: SidecarData | null;
  statsBaseline: StatsBaseline;
  tombstones: SidecarTombstones;
}): SidecarData {
  const { base, memory, disk, statsBaseline, tombstones } = args;
  const memState = memory.state;
  const baseState = base?.state;
  const diskLike = disk ?? base;
  const diskState = diskLike?.state;
  const diskMeta = diskLike?.meta ?? {};
  const baseMeta = base?.meta ?? {};

  /* ----- answeredQuestions：并集 + 「内存没改则磁盘胜」 ----- */
  const answeredIds = new Set<string>([
    ...Object.keys(memState.answeredQuestions),
    ...Object.keys(diskState?.answeredQuestions ?? {}),
    ...Object.keys(baseState?.answeredQuestions ?? {}),
  ]);
  const answeredEntries: Array<[string, string]> = [];
  for (const id of answeredIds) {
    if (tombstones.answered.has(id)) continue;
    const m = ownProp(memState.answeredQuestions, id);
    const d = ownProp(diskState?.answeredQuestions, id);
    const b = ownProp(baseState?.answeredQuestions, id);
    let value: string | undefined;
    if (m === undefined) {
      // 内存没有≠删除：磁盘有则用磁盘，否则用 base
      value = d ?? b;
    } else if (d !== undefined && (b === undefined || m === b)) {
      // 内存未改动该题 → 磁盘新答案胜出
      value = d;
    } else {
      value = m;
    }
    if (value !== undefined) answeredEntries.push([id, value]);
  }
  const answered = Object.fromEntries(answeredEntries) as Record<string, string>;

  /* ----- meta：tombstone 整条删；否则逐字段三方合并 ----- */
  const metaIds = new Set<string>([
    ...Object.keys(memory.meta),
    ...Object.keys(diskMeta),
    ...Object.keys(baseMeta),
  ]);
  const metaEntries: Array<[string, SidecarMeta]> = [];
  for (const id of metaIds) {
    if (tombstones.meta.has(id)) continue;
    const memEntry = ownProp(memory.meta, id);
    const diskEntry = ownProp(diskMeta, id);
    const baseEntry = ownProp(baseMeta, id);
    const memHasEntry = memEntry !== undefined;
    const deletedFields = tombstones.metaFields.get(id);
    const entry: SidecarMeta = {};
    let maxTs: number | undefined;
    let hasField = false;
    for (const field of META_MERGE_FIELDS) {
      // 字段级 tombstone：本次会话显式删除了该字段 → 无论磁盘/内存如何都不写回。
      if (deletedFields?.has(field)) continue;
      const mv = memHasEntry ? memEntry[field] : undefined;
      const bv = baseEntry?.[field];
      const dv = diskEntry?.[field];
      let value: string | undefined;
      let primaryTs: number | undefined;
      if (memHasEntry && mv !== undefined && mv !== bv) {
        // 内存显式改了该字段（包括改为空串）→ 内存胜。
        // 注意：内存缺字段不等于删除——旧视图可能是磁盘全量的子集，
        // 真正的删除必须走 meta tombstone（clearQuestionMeta/pruneMetaEntries）。
        value = mv;
        primaryTs = memEntry.ts;
      } else if (dv !== undefined) {
        // 内存没改而磁盘有新值 → 磁盘胜
        value = dv;
        primaryTs = diskEntry?.ts;
      } else {
        // 都没变化/都没值 → 用 base/memory 当前值
        value = mv ?? bv;
        primaryTs = memHasEntry ? memEntry.ts : baseEntry?.ts;
      }
      if (value === undefined) continue;
      entry[field] = value;
      hasField = true;
      const ts = finiteTs(primaryTs);
      if (ts !== undefined) maxTs = maxTs === undefined ? ts : Math.max(maxTs, ts);
    }
    if (!hasField) continue; // 无字段则丢弃 entry
    if (maxTs !== undefined) entry.ts = maxTs;
    metaEntries.push([id, entry]);
  }
  const meta = Object.fromEntries(metaEntries) as Record<string, SidecarMeta>;

  /* ----- memoryCards：tombstone 删；否则取较新卡片（内存缺失≠删卡） ----- */
  const cardIds = new Set<string>([
    ...Object.keys(memState.memoryCards ?? {}),
    ...Object.keys(diskState?.memoryCards ?? {}),
    ...Object.keys(baseState?.memoryCards ?? {}),
  ]);
  const cardEntries: Array<[string, MemoryCard]> = [];
  for (const id of cardIds) {
    if (tombstones.cards.has(id)) continue;
    const m = ownProp(memState.memoryCards, id);
    const d = ownProp(diskState?.memoryCards, id);
    const b = ownProp(baseState?.memoryCards, id);
    let chosen: MemoryCard | undefined;
    if (m && d) {
      chosen = isCardNewer(d, m) ? d : m;
    } else if (m) {
      chosen = m;
    } else if (d) {
      chosen = d;
    } else {
      chosen = b;
    }
    if (!chosen) continue;
    cardEntries.push([id, { ...chosen }]);
  }
  const memoryCards =
    cardEntries.length === 0
      ? undefined
      : (Object.fromEntries(cardEntries) as Record<string, MemoryCard>);

  /* ----- 计数与每日：磁盘值 + 本次会话增量（statsBaseline 口径） ----- */
  const memCorrect = safeCount(memState.correctCount);
  const memWrong = safeCount(memState.wrongCount);
  let correctCount: number;
  let wrongCount: number;
  let dailyAnswers: Record<string, number>;
  if (base === null) {
    // 本次会话未读过该文件：以 memory 为准，避免 0 基线把计数抹掉
    correctCount = memCorrect;
    wrongCount = memWrong;
    dailyAnswers = { ...(memState.dailyAnswers ?? {}) };
  } else {
    correctCount = Math.max(
      0,
      safeCount(diskState?.correctCount) +
        Math.max(0, memCorrect - safeCount(statsBaseline.correct))
    );
    wrongCount = Math.max(
      0,
      safeCount(diskState?.wrongCount) +
        Math.max(0, memWrong - safeCount(statsBaseline.wrong))
    );
    const memDaily = memState.dailyAnswers ?? {};
    const diskDaily = diskState?.dailyAnswers ?? {};
    const dates = new Set<string>([
      ...Object.keys(diskDaily),
      ...Object.keys(memDaily),
    ]);
    const merged: Record<string, number> = {};
    for (const date of dates) {
      const value =
        safeCount(ownProp(diskDaily, date)) +
        Math.max(
          0,
          safeCount(ownProp(memDaily, date)) -
            safeCount(ownProp(statsBaseline.daily, date))
        );
      // 只保留结果 >0 的日期
      if (value > 0) merged[date] = value;
    }
    dailyAnswers = merged;
  }
  pruneDailyAnswers(dailyAnswers, new Date());

  const memoryInitialized =
    memState.memoryInitialized === true ||
    diskState?.memoryInitialized === true ||
    baseState?.memoryInitialized === true
      ? true
      : memState.memoryInitialized === false ||
          diskState?.memoryInitialized === false ||
          baseState?.memoryInitialized === false
        ? false
        : undefined;

  const state: SidecarState = {
    // 会话级字段（位置/筛选/displayOrder/memory 配额）一律内存优先
    ...memState,
    displayOrder: memState.displayOrder.slice(),
    currentIndex: memState.currentIndex,
    correctCount,
    wrongCount,
    answeredQuestions: answered,
    memoryCards,
    memoryInitialized,
    dailyAnswers,
    memoryPendingNew:
      memState.memoryPendingNew === undefined
        ? undefined
        : memState.memoryPendingNew.slice(),
    updatedAt: Date.now(),
  };

  return { version: 1, meta, state };
}
