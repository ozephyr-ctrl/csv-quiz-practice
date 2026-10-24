import { Notice, Plugin, Vault } from "obsidian";
import {
  QuizSessionState,
  PluginSettings,
} from "./types";
import { normalizeMemoryCards } from "./utils";
import { normalizeDailyAnswers } from "./practiceStats";
import {
  SidecarConflictSource,
  SidecarData,
  SidecarMeta,
  SidecarState,
  SidecarTombstones,
  SidecarWriteQueue,
  StatsBaseline,
  backupSidecar,
  backupPathFor,
  cloneSidecarData,
  countersOfSidecar,
  findMergedSidecarPaths,
  findSidecarConflictPaths,
  mergeSidecarData,
  mergeSidecarForWrite,
  normalizeSidecar,
  readSidecar,
  renameOverwriteWithRetry,
  sidecarPathFor,
  writeSidecar,
  SIDECAR_MERGED_SUFFIX,
  SIDECAR_SAVE_DEBOUNCE_MS,
} from "./sidecar";
import { checkIdQuality, parseCSV } from "./csvHandler";
import { expandShortAnswerRows, validateQuestionRows } from "./shortAnswer";
import { normalizeVaultFolder } from "./contentSource";

interface DataPatch {
  settings?: PluginSettings;
  quizState?: QuizSessionState | null;
}

/** 防抖最长等待（ms）：连续变更不断重置防抖时，自首次调度起最迟 3s 必落盘（避免磁盘写入被无限期饿死）。 */
const SAVE_MAX_WAIT_MS = 3000;

/**
 * 计算本次防抖的实际定时延迟：常规取 delay；自首次调度起累计逼近 maxWaitMs 时
 * 压缩为剩余时间，保证首次调度后 maxWaitMs 内必然触发（连续重置也不会无限推迟）。
 */
export function computeSaveDelay(
  delay: number,
  firstScheduledAt: number,
  now: number,
  maxWaitMs: number
): number {
  return Math.max(0, Math.min(delay, firstScheduledAt + maxWaitMs - now));
}

/** 非负有限计数（损坏数据兜底为 0）。 */
function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * 每日答题量按日期取 max（而非求和）：冲突副本/内容源迁移重复执行时不翻倍，
 * 同时保留另一分支独有的日期计数。全部为空时返回 undefined（不写入空对象）。
 */
function maxDailyAnswers(
  ...sources: Array<Record<string, number> | undefined>
): Record<string, number> | undefined {
  const out = new Map<string, number>();
  for (const source of sources) {
    if (!source) continue;
    for (const [date, count] of Object.entries(source)) {
      const value = safeCount(count);
      out.set(date, Math.max(out.get(date) ?? 0, value));
    }
  }
  if (out.size === 0) return undefined;
  // Object.fromEntries 对 "__proto__" 等键生成自有属性（不同于赋值）
  return Object.fromEntries(out);
}

/**
 * 应用「导出已清理字段」记录：返回过滤后的新 meta（不修改入参）。
 * 对每个 id 的每个字段：条目存在该字段且条目写入时间不晚于清除时刻
 * （entry.ts ?? 0 <= clearTs）→ 丢弃该字段；条目无剩余字段（ts 除外）→ 丢弃整条。
 * 条目 ts 晚于清除时刻说明导出后又被重新编辑，保留新值。
 */
function applyMetaFieldClears(
  meta: Record<string, SidecarMeta>,
  clears: Map<string, Map<string, number>>
): Record<string, SidecarMeta> {
  const entries: Array<[string, SidecarMeta]> = [];
  for (const [id, entry] of Object.entries(meta)) {
    if (!entry) continue;
    const fieldClears = clears.get(id);
    if (!fieldClears || fieldClears.size === 0) {
      entries.push([id, { ...entry }]);
      continue;
    }
    const next = { ...entry } as SidecarMeta & Record<string, unknown>;
    for (const [field, clearTs] of fieldClears) {
      if (next[field] === undefined) continue;
      if ((next.ts ?? 0) <= clearTs) delete next[field];
    }
    const remaining = Object.keys(next).filter((key) => key !== "ts");
    if (remaining.length === 0) continue;
    entries.push([id, next]);
  }
  // 用 fromEntries 生成自有键，避免题号 "__proto__"/"constructor" 改写原型丢失
  return Object.fromEntries(entries);
}

/** 递归按对象键排序（数组保持顺序），用于生成与键顺序无关的 JSON 比较基准。 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeysDeep(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * sidecar 的规范化 JSON（键排序 + 可选忽略 state.updatedAt）：合并前后内容
 * 是否真有变化以它为准，避免「每次运行都因为时间戳/键顺序不同而写盘」。
 */
function canonicalSidecarJson(
  data: SidecarData,
  opts: { ignoreUpdatedAt?: boolean } = {}
): string {
  const copy = cloneSidecarData(data);
  if (opts.ignoreUpdatedAt !== false) delete copy.state.updatedAt;
  return JSON.stringify(sortKeysDeep(copy));
}

class StateWriteQueue {
  private queue: Array<{
    patch: DataPatch;
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];
  private processing = false;
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  enqueue(patch: DataPatch): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ patch, resolve, reject });
      void this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    try {
      const data =
        ((await this.plugin.loadData()) as Record<string, unknown> | null) ||
        {};
      if (item.patch.settings !== undefined) {
        data.settings = item.patch.settings;
      }
      if (item.patch.quizState !== undefined) {
        data.quizState = item.patch.quizState;
      }
      await this.plugin.saveData(data);
      item.resolve();
    } catch (e: unknown) {
      item.reject(e);
    } finally {
      this.processing = false;
      void this.processNext();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

/**
 * loadSidecar 的结果。调用方据此决定后续动作：
 * - ok / recovered：题库 sidecar 已载入（recovered 为从 .bak 恢复，readSidecar 内部已弹提示）
 * - missing：sidecar 不存在，已初始化空状态（含 defaultFilters 填写的默认筛选）
 * - corrupt：sidecar 与备份均损坏，内存未动，调用方弹「重建」提示后自行清空或重新初始化
 */
export type SidecarLoadResult =
  | {
      status: "ok" | "recovered";
      state: QuizSessionState;
      meta: Record<string, SidecarMeta>;
    }
  | {
      status: "missing";
      state: QuizSessionState;
      meta: Record<string, SidecarMeta>;
    }
  | { status: "corrupt"; reason: string };

/** 旧版进度迁移结果（阶段 4）。rejected 携带细分原因，供调用方针对性提示。 */
export type LegacyMigrationResult =
  | { status: "migrated" }
  | { status: "skipped" }
  | {
      status: "rejected";
      reason:
        | "csv-missing"
        | "csv-read-error"
        | "bad-id"
        | "path-mismatch"
        | "bad-state";
    };

/** mergeSidecarConflicts 的结果（status=none 时其余字段缺失/为零）。 */
export interface SidecarMergeOutcome {
  status: "none" | "merged";
  /** 成功参与合并的冲突副本数。 */
  mergedSources?: number;
  /** 并入的、当前状态缺失的答题记录条数。 */
  addedAnswers?: number;
  /** 本次并入的答题记录对应题 id（供调用方按累计口径补计对错统计）。 */
  addedAnswerIds?: string[];
  /** 读取失败（损坏/结构非法）被跳过的副本数。 */
  unreadable?: number;
  /** 成功归档为 .merged 的副本数。 */
  archived?: number;
  /** 归档失败的副本数（仍会再次被检测到，下次可重试）。 */
  archiveFailed?: number;
}

/** 内容源之间转移 sidecar 的结果。status=error 时携带 reason（不抛出）。 */
export interface SidecarMergeOpResult {
  status: "skipped" | "copied" | "merged" | "error";
  reason?: string;
}

/** manifest 复合题库：把组成内容源 sidecar 一次性并入 manifest sidecar 的结果。 */
export interface ManifestSidecarMergeResult {
  status: "merged" | "skipped" | "error";
  reason?:
    | "no-change"
    | "no-component-progress"
    | "target-corrupt"
    | "write-failed";
  mergedComponents?: number;
  addedAnswers?: number;
  correctCount?: number;
  wrongCount?: number;
}

/** 从 `.merged` 归档恢复进度的结果（status=none 时其余字段缺失）。 */
export interface MergedArchiveRecoveryResult {
  status: "merged" | "none" | "error";
  reason?: "target-corrupt" | "write-failed";
  /** 成功读取并参与合并的归档数（损坏归档跳过不计）。 */
  archives?: number;
  /** 并入目标时新增的答题记录条数。 */
  addedAnswers?: number;
  /** 成功改名（+".recovered"）的归档数。 */
  renamed?: number;
  /** 改名失败的归档数（失败者保留原名，下次可重试）。 */
  renameFailed?: number;
}

/** 保存层 base 快照：本次会话最近一次读到/写成的 sidecar 数据 + 其磁盘 stat。
 *  写盘前用 stat 比对判断磁盘是否被外部改动（未变→快路径，变了→重读磁盘再合并）。 */
interface SidecarBaseSnapshot {
  data: SidecarData;
  mtimeMs: number;
  size: number;
}


export class StateManager {
  private plugin: Plugin;
  private vault: Vault;
  private currentState: QuizSessionState | null = null;
  private saveTimer: number | null = null;
  /** 本轮防抖的首次调度时间戳（maxWait 计时起点）；无挂起调度时为 null。 */
  private saveFirstScheduledAt: number | null = null;
  /** T3: 上次弹「保存失败」Notice 的时间戳（30 秒节流，避免反复失败时 Notice 刷屏）。 */
  private lastSaveErrorNoticeAt = 0;
  private writeQueue: StateWriteQueue;
  private settingsSaveTimer: number | null = null;
  private pendingSettings: PluginSettings | null = null;
  /** 等待本次设置落盘完成的 resolve 集合（共享 promise 语义：后一次保存覆盖前一次，所有等待者统一在最终写入完成后 resolve）。 */
  private settingsResolvers: Array<() => void> = [];
  /** 当前题库内容源路径（null = 兼容模式：状态仍写 data.json.quizState）。 */
  private contentPath: string | null = null;
  /** 当前题库 meta 覆盖层（B/C 类），键为题 id。 */
  private currentMeta: Record<string, SidecarMeta> = {};
  /** 最近一次本插件提交写盘的时间戳（persistNow 入队时更新）。
   *  供外部修改检测抑制"关闭面板随即重开"的竞态误报：写盘尚未落盘时磁盘滞后于内存。 */
  lastPersistAt: number = 0;
  /** 默认筛选值（loadSidecar 入参保存），供「全部重置」时 emptySidecarState 复用，
   *  避免重置后默认筛选设置被清空（与首次打开 missing 路径的 emptySessionState 行为保持一致）。 */
  private defaultFilters: {
    favorite: string;
    mastered: string;
    repeat: string;
    wrong: string;
  } = { favorite: "", mastered: "", repeat: "", wrong: "" };
  /** sidecar 串行写队列（通用 job 链：读-合并-写整段串行，不按路径合并 payload）。 */
  private sidecarQueue: SidecarWriteQueue;
  /** 每个内容源最近一次读到/写成的 sidecar 快照（写盘前的磁盘变更检测基准）。 */
  private sidecarBase = new Map<string, SidecarBaseSnapshot>();
  /** 每个内容源的统计基线（上次读到/写成时 state 的累计计数快照）。 */
  private statsBaseline = new Map<string, StatsBaseline>();
  /** 每个内容源本次会话内被权威删除的题 id（阻止磁盘旧数据复活）。 */
  private tombstones = new Map<string, SidecarTombstones>();
  /** 最近一次从磁盘载入或成功写入当前 sidecar 的时间（epoch ms；0=未知）。
   *  冲突合并时作为 base 的时间戳：必须用磁盘侧真实时间（updatedAt/mtime/本插件
   *  最近成功写入时刻），绝不能用合并时刻 Date.now()——否则 base 条目会以「合并
   *  当天」压掉冲突副本里较新的状态（真实事故根因之一）。 */
  private currentSidecarUpdatedAt = 0;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.vault = plugin.app.vault;
    this.writeQueue = new StateWriteQueue(plugin);
    this.sidecarQueue = new SidecarWriteQueue();
  }

  /**
   * 读取 data.json 中的旧版 quizState（兼容模式内存态），字段级归一化后设置为
   * currentState，返回归一化结果（null = 无旧状态）。设置不在此处理——加载与
   * 净化由 main.loadSettings 负责（旧实现把未净化的磁盘 settings 覆盖进合并
   * 结果，容易被误当作已应用的设置使用）。
   */
  async loadLegacyQuizState(): Promise<QuizSessionState | null> {
    const data =
      ((await this.plugin.loadData()) as Record<string, unknown> | null) || {};
    this.currentState = this.normalizeQuizState(data.quizState);
    return this.currentState;
  }

  /**
   * 对磁盘上读取的 quizState 做字段级归一化防御：类型错误的字段
   * （如 correctCount: "5"、memoryDailyNew: "abc"）在此兜底，避免
   * 类型错误进入运行时崩溃。
   */
  private normalizeQuizState(raw: unknown): QuizSessionState | null {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const toNumber = (v: unknown): number => {
      const n = Number(v);
      return Number.isNaN(n) ? 0 : n;
    };
    const toStr = (v: unknown): string => (typeof v === "string" ? v : "");
    const toStrArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const toRecord = (v: unknown): Record<string, string> =>
      v && typeof v === "object" ? (v as Record<string, string>) : {};
    // 记忆卡片逐卡字段级归一化：类型错误的损坏卡片整卡剔除（与 sidecar 路径一致）
    const memoryCards =
      r.memoryCards === undefined
        ? undefined
        : normalizeMemoryCards(r.memoryCards);
    return {
      csvPath: toStr(r.csvPath),
      currentIndex: toNumber(r.currentIndex),
      correctCount: toNumber(r.correctCount),
      wrongCount: toNumber(r.wrongCount),
      displayOrder: toStrArray(r.displayOrder),
      filterText: toStr(r.filterText),
      filterTags: toStr(r.filterTags),
      filterTagsExcluded: toStr(r.filterTagsExcluded),
      filterCat1: toStr(r.filterCat1),
      filterCat2: toStr(r.filterCat2),
      filterCat3: toStr(r.filterCat3),
      filterFavorite: toStr(r.filterFavorite),
      filterMastered: toStr(r.filterMastered),
      filterRepeat: toStr(r.filterRepeat),
      filterWrong: toStr(r.filterWrong),
      filterUnanswered: toStr(r.filterUnanswered),
      answeredQuestions: toRecord(r.answeredQuestions),
      memoryCards,
      memoryNewDate: toStr(r.memoryNewDate),
      memoryNewCountToday: toNumber(r.memoryNewCountToday),
      memoryPendingNew: toStrArray(r.memoryPendingNew),
      memoryInitialized:
        typeof r.memoryInitialized === "boolean" ? r.memoryInitialized : undefined,
      dailyAnswers: normalizeDailyAnswers(r.dailyAnswers),
    };
  }

  /**
   * SidecarState → QuizSessionState 转换：补齐 csvPath 字段，
   * 可选字段（memory*）原样传递（缺失保持 undefined）。
   */
  private stateFromSidecar(
    s: SidecarState,
    csvPath: string
  ): QuizSessionState {
    return {
      csvPath,
      currentIndex: s.currentIndex,
      correctCount: s.correctCount,
      wrongCount: s.wrongCount,
      displayOrder: s.displayOrder,
      filterText: s.filterText,
      filterTags: s.filterTags,
      filterTagsExcluded: s.filterTagsExcluded,
      filterCat1: s.filterCat1,
      filterCat2: s.filterCat2,
      filterCat3: s.filterCat3,
      filterFavorite: s.filterFavorite,
      filterMastered: s.filterMastered,
      filterRepeat: s.filterRepeat,
      filterWrong: s.filterWrong,
      filterUnanswered: s.filterUnanswered,
      answeredQuestions: s.answeredQuestions,
      memoryCards: s.memoryCards,
      memoryNewDate: s.memoryNewDate,
      memoryNewCountToday: s.memoryNewCountToday,
      memoryPendingNew: s.memoryPendingNew,
      memoryInitialized: s.memoryInitialized,
      dailyAnswers: s.dailyAnswers,
    };
  }

  /** 新题库空会话状态（sidecar 缺失初始化用）：默认筛选取自 defaultFilters，其余为默认值。 */
  private emptySessionState(defaultFilters: {
    favorite: string;
    mastered: string;
    repeat: string;
    wrong: string;
  }): QuizSessionState {
    return {
      csvPath: "",
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
      filterFavorite: defaultFilters.favorite,
      filterMastered: defaultFilters.mastered,
      filterRepeat: defaultFilters.repeat,
      filterWrong: defaultFilters.wrong,
      filterUnanswered: "",
      answeredQuestions: {},
    };
  }

  /** 空 sidecar state（「全部重置」时保留文件写入的空状态）。
   *  filterFavorite/filterMastered/filterRepeat/filterWrong 用 loadSidecar 保存的
   *  defaultFilters 成员填充，避免重置后用户设置的默认筛选丢失；其余字段保持空串。
   *  updatedAt 与 stateToSidecar 一致：文件被同步/复制后 mtime 不再可靠，
   *  有 in-file 时间戳才能正确参与冲突合并。 */
  private emptySidecarState(): SidecarState {
    return {
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
      filterFavorite: this.defaultFilters.favorite,
      filterMastered: this.defaultFilters.mastered,
      filterRepeat: this.defaultFilters.repeat,
      filterWrong: this.defaultFilters.wrong,
      filterUnanswered: "",
      answeredQuestions: {},
      updatedAt: Date.now(),
    };
  }

  getState(): QuizSessionState | null {
    return this.currentState;
  }

  setState(state: QuizSessionState | null): void {
    this.currentState = state;
  }

  /** 当前题库内容源路径；null 表示兼容模式（未调用 loadSidecar）。 */
  getContentPath(): string | null {
    return this.contentPath;
  }

  /** 当前题库 meta 覆盖层（B/C 类）。 */
  getMeta(): Record<string, SidecarMeta> {
    return this.currentMeta;
  }

  /**
   * 载入题库的 sidecar：读文件 → 归一化 → 设置 currentState/currentMeta/contentPath。
   * - missing：初始化空状态（filter* 用 defaultFilters 的 defaultFilter*）
   * - recovered/corrupt：按 readSidecar 结果处理并返回给调用方
   *   （recovered 时 readSidecar 内部已弹「从备份恢复」提示；corrupt 不动内存，由调用方提示重建）
   */
  async loadSidecar(
    contentPath: string,
    defaultFilters: {
      favorite: string;
      mastered: string;
      repeat: string;
      wrong: string;
    }
  ): Promise<SidecarLoadResult> {
    // 载入前先等挂起写盘完成：否则未落盘的读-合并-写会与本函数的读互相穿插
    await this.sidecarQueue.drain();
    // M3: 保存入参默认筛选，供「全部重置」（emptySidecarState）复用
    this.defaultFilters = defaultFilters;
    const result = await readSidecar(this.vault, contentPath);
    if (result.status === "corrupt") {
      // 不动内存，返回 corrupt 由调用方决定是否重建（不设置 base 快照）
      this.currentSidecarUpdatedAt = 0;
      return { status: "corrupt", reason: result.reason };
    }

    let baseData: SidecarData;
    if (result.status === "missing") {
      baseData = this.emptySidecarData();
      this.currentSidecarUpdatedAt = 0;
    } else {
      baseData = cloneSidecarData(result.data);
      // base 时间戳取磁盘侧真实时间：文件内 state.updatedAt 优先（有限且 >0），
      // 旧文件缺失该字段时回退文件 mtime；都拿不到则 0（未知，合并时照传，
      // 绝不回退 Date.now()，否则旧备份会压掉较新副本）。
      const diskUpdatedAt = result.data.state.updatedAt;
      if (
        typeof diskUpdatedAt === "number" &&
        Number.isFinite(diskUpdatedAt) &&
        diskUpdatedAt > 0
      ) {
        this.currentSidecarUpdatedAt = diskUpdatedAt;
      } else {
        // recovered：readSidecar 恢复时已用 writeSidecar 重写 canonical，其 mtime≈now，
        // 不能代表恢复出的旧内容时间；应取 .bak（实际载入的数据来源）的 mtime。
        // ok：使用 canonical 的 mtime。
        const statPath =
          result.status === "recovered"
            ? backupPathFor(contentPath)
            : sidecarPathFor(contentPath);
        try {
          const stat = await this.vault.adapter.stat(statPath);
          const mtime = stat?.mtime;
          this.currentSidecarUpdatedAt =
            typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0
              ? mtime
              : 0;
        } catch {
          this.currentSidecarUpdatedAt = 0;
        }
      }
    }

    // 记录保存层基准：base 数据（独立副本）+ canonical sidecar 的磁盘 stat
    const stat = await this.statSidecar(contentPath);
    this.sidecarBase.set(contentPath, {
      data: baseData,
      mtimeMs: stat?.mtimeMs ?? 0,
      size: stat?.size ?? -1,
    });
    this.statsBaseline.set(contentPath, countersOfSidecar(baseData));
    this.tombstones.set(contentPath, this.emptyTombstones());

    // currentState/currentMeta 为 base 的独立副本（不与 base 快照共享引用）
    const memoryCopy = cloneSidecarData(baseData);
    this.currentState = this.stateFromSidecar(memoryCopy.state, contentPath);
    this.currentMeta = memoryCopy.meta;
    this.contentPath = contentPath;
    return {
      status: result.status,
      state: this.currentState,
      meta: this.currentMeta,
    };
  }

  /**
   * 卸载当前 sidecar：flush（取消挂起防抖 + 立即写盘）后清空
   * contentPath/currentState/currentMeta 及该路径的保存层基准。兼容模式下仅清空内存。
   */
  async unloadSidecar(): Promise<void> {
    this.cancelScheduledSave();
    const path = this.contentPath;
    if (path !== null && this.currentState !== null) {
      await this.persistNow();
    }
    if (path !== null) {
      this.sidecarBase.delete(path);
      this.statsBaseline.delete(path);
      this.tombstones.delete(path);
    }
    this.contentPath = null;
    this.currentState = null;
    this.currentMeta = {};
    this.currentSidecarUpdatedAt = 0;
  }

  /**
   * 更新某题的 meta 字段（内存）+ 调度保存。
   * field 为 SidecarMeta 的字符串键；空串也写入（永久遮蔽语义）。
   * currentState 为 null（题库未载入）时仅改内存不调度。
   */
  setMetaField(
    questionId: string,
    field:
      | "repeat"
      | "tags"
      | "category1"
      | "category2"
      | "category3"
      | "favorite"
      | "mastered"
      | "wrong",
    value: string
  ): void {
    let entry = this.currentMeta[questionId];
    if (!entry) {
      entry = {};
      this.currentMeta[questionId] = entry;
    }
    entry[field] = value;
    // 冲突合并时间戳：记录该条目最近写入时间（较新者胜）
    entry.ts = Date.now();
    if (this.currentState) {
      this.scheduleSave(this.currentState, SIDECAR_SAVE_DEBOUNCE_MS);
    }
  }

  /** 删除某题的整条 meta（内存）+ 调度保存。currentState 为 null 时仅改内存。
   *  同时登记 meta tombstone：否则保存层三方合并会把磁盘上的旧 meta 条目并回来。 */
  clearQuestionMeta(questionId: string): void {
    delete this.currentMeta[questionId];
    if (this.contentPath !== null && this.currentState !== null) {
      // markMetaDeleted 内已调度保存（含 tombstone 登记）
      this.markMetaDeleted([questionId]);
      return;
    }
    if (this.currentState) {
      this.scheduleSave(this.currentState, SIDECAR_SAVE_DEBOUNCE_MS);
    }
  }

  /**
   * 登记「本次会话权威删除了这些记忆卡片」：保存层合并时据此阻止磁盘旧卡复活。
   * 只登记 + 调度防抖保存（不立即写盘），由调用方随后从内存删除卡片即可；
   * tombstone 仅在写盘成功（commitGated/writeRaw）后清空，写失败则保留待下次重试。
   * contentPath/currentState 均为空（题库未载入/兼容模式）时不登记。
   */
  markCardsDeleted(ids: Iterable<string>): void {
    if (!this.addTombstones("cards", ids)) return;
    this.scheduleSave(this.currentState!, SIDECAR_SAVE_DEBOUNCE_MS);
  }

  /** 登记「本次会话权威删除了这些题的 meta」；语义同 markCardsDeleted。 */
  markMetaDeleted(ids: Iterable<string>): void {
    if (!this.addTombstones("meta", ids)) return;
    this.scheduleSave(this.currentState!, SIDECAR_SAVE_DEBOUNCE_MS);
  }

  /**
   * 登记「本次会话显式删除了某题的这些 meta 字段」（字段级 tombstone）：
   * 保存层三方合并时该字段一律不写回（即使磁盘仍有旧值），其余字段照常合并。
   * 只登记 + 调度防抖保存；tombstone 在写盘成功后随空集合一起清空，失败则保留重试。
   * contentPath/currentState 为空（题库未载入/兼容模式）时不登记。
   */
  markMetaFieldsDeleted(id: string, fields: Iterable<string>): void {
    const path = this.contentPath;
    if (path === null || this.currentState === null) return;
    if (typeof id !== "string" || id === "") return;
    let tomb = this.tombstones.get(path);
    if (!tomb) {
      tomb = this.emptyTombstones();
      this.tombstones.set(path, tomb);
    }
    let deleted = tomb.metaFields.get(id);
    if (!deleted) {
      deleted = new Set();
      tomb.metaFields.set(id, deleted);
    }
    let added = false;
    for (const field of fields) {
      if (typeof field !== "string" || field === "") continue;
      if (!deleted.has(field)) {
        deleted.add(field);
        added = true;
      }
    }
    if (!added) {
      // 未新增任何字段：避免留下空集合
      if (deleted.size === 0) tomb.metaFields.delete(id);
      return;
    }
    this.scheduleSave(this.currentState, SIDECAR_SAVE_DEBOUNCE_MS);
  }

  /** 把 id 加入当前内容源的指定 tombstone 集合。返回是否登记成功（未载入题库时 false）。 */
  private addTombstones(
    kind: "cards" | "meta",
    ids: Iterable<string>
  ): boolean {
    const path = this.contentPath;
    if (path === null || this.currentState === null) return false;
    let tomb = this.tombstones.get(path);
    if (!tomb) {
      tomb = this.emptyTombstones();
      this.tombstones.set(path, tomb);
    }
    for (const id of ids) {
      if (typeof id === "string" && id !== "") tomb[kind].add(id);
    }
    return true;
  }

  /** 从 currentState + currentMeta 组装 sidecar 全量数据（version 1）。
   *  返回深拷贝快照：answered/memoryCards/meta/displayOrder/dailyAnswers 不与
   *  currentState/currentMeta 共享引用，保存后才修改内存不会污染 base 快照。 */
  private buildSidecarData(): SidecarData {
    const state = this.currentState;
    return cloneSidecarData({
      version: 1,
      meta: this.currentMeta,
      state: state ? this.stateToSidecar(state) : this.emptySidecarState(),
    });
  }

  /** QuizSessionState → SidecarState：去掉 csvPath 字段（关联靠文件命名约定，不入 sidecar）。
   *  updatedAt 不在此处写：由保存层 commitGated/writeRaw 在真正落盘时统一打时间戳。 */
  private stateToSidecar(s: QuizSessionState): SidecarState {
    return {
      currentIndex: s.currentIndex,
      correctCount: s.correctCount,
      wrongCount: s.wrongCount,
      displayOrder: s.displayOrder,
      filterText: s.filterText,
      filterTags: s.filterTags,
      filterTagsExcluded: s.filterTagsExcluded,
      filterCat1: s.filterCat1,
      filterCat2: s.filterCat2,
      filterCat3: s.filterCat3,
      filterFavorite: s.filterFavorite,
      filterMastered: s.filterMastered,
      filterRepeat: s.filterRepeat,
      filterWrong: s.filterWrong,
      filterUnanswered: s.filterUnanswered,
      answeredQuestions: s.answeredQuestions,
      memoryCards: s.memoryCards,
      memoryNewDate: s.memoryNewDate,
      memoryNewCountToday: s.memoryNewCountToday,
      memoryPendingNew: s.memoryPendingNew,
      memoryInitialized: s.memoryInitialized,
      dailyAnswers: s.dailyAnswers,
    };
  }

  /** 空 sidecar 数据（空 meta + 空状态）。 */
  private emptySidecarData(): SidecarData {
    return { version: 1, meta: {}, state: this.emptySidecarState() };
  }

  /** 空 tombstone 集合（每个内容源一份，写盘成功后清空）。 */
  private emptyTombstones(): SidecarTombstones {
    return {
      answered: new Set(),
      cards: new Set(),
      meta: new Set(),
      metaFields: new Map(),
    };
  }

  /** 把 job 投入串行链（所有读-合并-写必须经此入口，避免并发穿插）。 */
  private runExclusive<T>(job: () => Promise<T>): Promise<T> {
    return this.sidecarQueue.enqueue(job);
  }

  /** 读 canonical sidecar 的磁盘 stat；mtime 非有限正数按 0，size 非有限正数按 -1。 */
  private async statSidecar(
    contentPath: string
  ): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const stat = await this.vault.adapter.stat(sidecarPathFor(contentPath));
      const mtime = stat?.mtime;
      const size = stat?.size;
      return {
        mtimeMs:
          typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0
            ? mtime
            : 0,
        size:
          typeof size === "number" && Number.isFinite(size) && size > 0
            ? size
            : -1,
      };
    } catch {
      return null;
    }
  }

  /** 两个 stat 是否可判定为「同一份未被改动的磁盘文件」。未知 stat 一律视为不同。 */
  private sameStat(
    a: { mtimeMs: number; size: number } | null,
    b: { mtimeMs: number; size: number } | null
  ): boolean {
    if (!a || !b) return false;
    return (
      a.mtimeMs > 0 &&
      a.size >= 0 &&
      a.mtimeMs === b.mtimeMs &&
      a.size === b.size
    );
  }

  /**
   * 门控写盘（sidecar 模式唯一入口）：
   * - 磁盘 stat 与 base 快照一致 → 磁盘没被外部改过，快路径直接写内存（无需读文件）；
   * - stat 变了/未知 → 重读磁盘，按 base/memory/disk 三方合并后写回；
   * - 文件缺失（disk=null）→ 用 base 兜底，绝不当成空状态清库；
   * - sidecar 损坏 → 提示后按 base 兜底继续保存。
   */
  private async writeGated(
    contentPath: string,
    memory: SidecarData
  ): Promise<void> {
    const base = this.sidecarBase.get(contentPath);
    const baseline =
      this.statsBaseline.get(contentPath) ?? countersOfSidecar(memory);
    const tomb = this.tombstones.get(contentPath) ?? this.emptyTombstones();
    let disk: SidecarData | null;
    if (!base) {
      // 本次会话没有 base（未经过 loadSidecar）：按磁盘现有内容做并集
      const r = await readSidecar(this.vault, contentPath);
      disk = r.status === "ok" || r.status === "recovered" ? r.data : null;
    } else {
      const st = await this.statSidecar(contentPath);
      if (this.sameStat(st, base)) {
        const out = cloneSidecarData(memory);
        await this.commitGated(contentPath, out, memory, baseline, false);
        return;
      }
      const r = await readSidecar(this.vault, contentPath);
      if (r.status === "corrupt") {
        console.error(
          "CSV Quiz: sidecar 损坏，保存时按 base 兜底",
          contentPath,
          r.reason
        );
        new Notice("状态文件损坏，已按内存和上次快照继续保存");
        disk = null;
      } else {
        disk = r.status === "missing" ? null : r.data;
      }
    }
    const out = mergeSidecarForWrite({
      base: base?.data ?? null,
      memory,
      disk,
      statsBaseline: baseline,
      tombstones: tomb,
    });
    // 如果慢路径把磁盘上比内存更多的数据并了进来，视图 currentState 仍是旧子集；
    // 不能让下一次保存走快路径把它覆盖回去。标记 stat 未知，后续保存继续慢路径，
    // 直到视图重载/内存补齐后 out 与 memory 一致。
    const forceNextSlow =
      canonicalSidecarJson(out) !== canonicalSidecarJson(memory);
    await this.commitGated(contentPath, out, memory, baseline, forceNextSlow);
  }

  /**
   * 落盘 out 并刷新保存层基准。写完比对文件字节数：与实际写入长度不符（写入被
   * 同步服务截断/追加等）则重读磁盘再合并一次（最多一次），避免直接信任损坏内容。
   */
  private async commitGated(
    contentPath: string,
    out: SidecarData,
    memory: SidecarData,
    baseline: StatsBaseline,
    forceNextSlow: boolean
  ): Promise<void> {
    out.state.updatedAt = Date.now();
    await writeSidecar(this.vault, contentPath, out);
    let st = await this.statSidecar(contentPath);
    const expectedBytes = new TextEncoder().encode(JSON.stringify(out)).length;
    if (st !== null && st.size > 0 && st.size !== expectedBytes) {
      // 写后大小不符：重读磁盘合并一次后重写（不再校验第二次，避免死循环）
      const r = await readSidecar(this.vault, contentPath);
      const disk = r.status === "ok" || r.status === "recovered" ? r.data : null;
      // 重试时 out 已经是本次写入的完整结果；不能再拿原始 memory 的增量叠加，
      // 否则 correct/wrong/daily 会被重复计算。以 out 同时作为 base 和 memory，
      // 计数增量归零，只把写入窗口内出现的磁盘差异并进来。
      const retried = mergeSidecarForWrite({
        base: out,
        memory: out,
        disk,
        statsBaseline: countersOfSidecar(out),
        tombstones: this.emptyTombstones(),
      });
      retried.state.updatedAt = Date.now();
      await writeSidecar(this.vault, contentPath, retried);
      out = retried;
      st = await this.statSidecar(contentPath);
      // 重试若又并入了磁盘差异，同样要让后续保存继续走慢路径
      forceNextSlow =
        forceNextSlow ||
        canonicalSidecarJson(out) !== canonicalSidecarJson(memory);
    }
    this.sidecarBase.set(contentPath, {
      data: cloneSidecarData(out),
      // 慢路径合并了内存里没有的数据时，内存仍是旧子集；不能把 stat 标成
      // “已同步”，否则下一次快路径会把它覆盖回去。
      mtimeMs: forceNextSlow ? 0 : st?.mtimeMs ?? 0,
      size: forceNextSlow ? -1 : st?.size ?? -1,
    });
    // 基线取 memory 的计数（= 本次已确认写入的会话累计值），下次保存才算增量
    this.statsBaseline.set(contentPath, countersOfSidecar(memory));
    this.currentSidecarUpdatedAt = out.state.updatedAt ?? 0;
    this.tombstones.set(contentPath, this.emptyTombstones());
  }

  /**
   * 直接写盘（不合并）：用于「全部重置」、旧进度迁移、冲突/成分合并等权威写。
   * 成功后 base/baseline 同步为写入内容，tombstone 清空。
   */
  private async writeRaw(
    contentPath: string,
    data: SidecarData,
    opts: { authoritative?: boolean } = {}
  ): Promise<void> {
    // opts 记录调用方语义（authoritative = 覆盖写）；两条路径行为一致：
    // 不与磁盘合并，直接以 data 为准。
    void opts;
    const out = cloneSidecarData(data);
    out.state.updatedAt = Date.now();
    await writeSidecar(this.vault, contentPath, out);
    // 权威直写可能不是当前视图内存状态的完整投影（例如 manifest 组成合并
    // 刚把组件进度写进目标 sidecar，而视图 currentState 仍是旧子集）。
    // 不能把这里的磁盘 stat 当成“下一次快路径可直接写内存”的依据，
    // 否则下一次普通保存会把刚写入的数据覆盖回去。标记 stat 未知，
    // 强制下一次保存走慢路径：以本次 out 为 base、旧内存为 memory 做三方合并。
    this.sidecarBase.set(contentPath, {
      data: cloneSidecarData(out),
      mtimeMs: 0,
      size: -1,
    });
    this.statsBaseline.set(contentPath, countersOfSidecar(out));
    this.currentSidecarUpdatedAt = out.state.updatedAt;
    this.tombstones.set(contentPath, this.emptyTombstones());
  }

  /**
   * 立即落盘当前状态：
   * - sidecar 模式（contentPath 非 null）→ 串行链内门控读改写（stat 未变走快路径）
   * - 兼容模式（contentPath 为 null）→ 写 data.json.quizState
   */
  private async persistNow(): Promise<void> {
    // 入队即视为本插件已提交该状态写盘（供外部修改检测抑制窗口使用）
    this.lastPersistAt = Date.now();
    const path = this.contentPath;
    if (path !== null) {
      const memory = this.buildSidecarData();
      await this.runExclusive(() => this.writeGated(path, memory));
    } else {
      await this.writeQueue.enqueue({ quizState: this.currentState });
    }
  }

  async saveStateImmediately(
    state: QuizSessionState,
    opts: { authoritative?: boolean; forceMerge?: boolean } = {}
  ): Promise<void> {
    this.cancelScheduledSave();
    this.currentState = state;
    const path = this.contentPath;
    if (opts.authoritative && path !== null) {
      // 权威写（如「重建状态」）：直接覆盖，不保留磁盘旧数据
      this.lastPersistAt = Date.now();
      const memory = this.buildSidecarData();
      await this.runExclusive(() =>
        this.writeRaw(path, memory, { authoritative: true })
      );
      return;
    }
    // 3A「使用当前进度」：内存可能是磁盘全量的旧子集（loadSidecar 后 base 是磁盘
    // 真实值），此时快路径会把合并结果覆盖回子集。标记该路径 stat 未知（保留 base
    // data），强制 persistNow 走慢路径做三方合并，把磁盘/合并结果保留下来。
    if (opts.forceMerge && path !== null) {
      const base = this.sidecarBase.get(path);
      if (base) {
        base.mtimeMs = 0;
        base.size = -1;
      }
    }
    await this.persistNow();
  }

  /**
   * 调度一次防抖保存：连续变更合并为最后一次后 delay(默认 1s) 落盘；但自本轮
   * 首次调度起最长 SAVE_MAX_WAIT_MS(3s) 必落盘（computeSaveDelay 压缩剩余等待），
   * 避免作答间隔始终小于防抖间隔时写盘被无限期推迟。
   */
  scheduleSave(
    state: QuizSessionState,
    delay: number = SIDECAR_SAVE_DEBOUNCE_MS
  ): void {
    // H-1: 立即同步 currentState（内存），保证切题库 flush（unloadSidecar 的
    // persistNow）与状态栏刷新等读到最新状态，避免防抖窗口内丢最近进度；
    // 回调内仍保留路径检查，防止挂起回调把旧题库状态写回。
    this.currentState = state;
    // M1: 快照入队时的 contentPath；定时器回调执行时若路径已切换（切换题库/
    // unloadSidecar 后）则丢弃本次写入，避免挂起回调把旧题库状态写回
    // （含兼容模式复活 data.json.quizState 导致下次启动重复迁移）
    const scheduledPath = this.contentPath;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    const now = Date.now();
    // maxWait 计时起点：本轮防抖首次调度时间；持续重置时保持不变
    const firstScheduledAt =
      this.saveFirstScheduledAt === null ? now : this.saveFirstScheduledAt;
    this.saveFirstScheduledAt = firstScheduledAt;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      // 本轮防抖结束（含路径切换丢弃分支）：重置 maxWait 计时
      this.saveFirstScheduledAt = null;
      // M1: 路径已切换 → 丢弃本次写入（旧状态已由 unloadSidecar 的 persistNow 落盘，无需再写）。
      // 兼容模式（contentPath 恒为 null）下 scheduledPath 恒为 null，null !== null 恒 false，
      // 校验恒通过，不影响旧行为。
      if (this.contentPath !== scheduledPath) return;
      this.persistNow().catch((e: unknown) => {
        console.error("CSV Quiz: Failed to save state", e);
        // T3: 30 秒内只弹一次失败提示，避免连续失败时 Notice 刷屏
        const now = Date.now();
        if (now - this.lastSaveErrorNoticeAt < 30000) return;
        this.lastSaveErrorNoticeAt = now;
        const message = e instanceof Error ? e.message : String(e);
        new Notice("刷题进度保存失败: " + message);
      });
    }, computeSaveDelay(delay, firstScheduledAt, now, SAVE_MAX_WAIT_MS));
  }

  async clearState(): Promise<void> {
    this.cancelScheduledSave();
    this.currentState = null;
    const path = this.contentPath;
    if (path !== null) {
      // 清空 sidecar（保留文件，避免重建）：meta 与状态全清。权威写，不与磁盘合并。
      this.currentMeta = {};
      const empty = this.emptySidecarData();
      await this.runExclusive(() =>
        this.writeRaw(path, empty, { authoritative: true })
      );
    } else {
      await this.writeQueue.enqueue({ quizState: null });
    }
  }

  cancelScheduledSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveFirstScheduledAt = null;
  }

  /**
   * 迁移旧 data.json.quizState → 指定内容源的 sidecar；成功后清空
   * data.json.quizState 并把原 data.json 备份为 data.json.bak（供回滚手工导回）。
   * - skipped：无旧 quizState
   * - rejected：携带细分 reason（csv-missing / csv-read-error / bad-id / path-mismatch），
   *   拒绝迁移（避免状态错位或迁移失败时丢失旧数据）
   * - migrated：已搬入 sidecar 并清空旧位置
   * defaultFilters 参数预留（旧状态自带筛选，无需填充）。
   */
  async migrateLegacyState(
    contentPath: string,
    defaultFilters: {
      favorite: string;
      mastered: string;
      repeat: string;
      wrong: string;
    }
  ): Promise<LegacyMigrationResult> {
    const data = (await this.plugin.loadData()) as Record<string, unknown> | null;
    const quizState = data?.quizState ?? null;
    if (quizState === null || quizState === undefined) {
      return { status: "skipped" };
    }

    // 清空内存中的旧 data.json 状态：迁移后数据搬入 sidecar（或迁移被拒），内存旧值已不可信。
    // 若不清理，首次打开面板时 initializeFromState 的 3A 检测会拿旧状态与迁移后 sidecar
    // 比较，误报「检测到刷题进度被外部修改」；且 rejected 场景下用户若选「使用当前进度」
    // 会把旧状态（可能含脏数据）写回 sidecar。
    this.currentState = null;
    this.currentMeta = {};

    // 脏拒迁：源 CSV 必须存在且通过统一题库管线（逐行校验 + 展开后的 id 质量）。
    // 与视图加载同口径：简答题选项/答案/方向非法、id 含 "::"、空/重复题号（含派生
    // `::rev`）一律拒迁，避免把旧进度错位搬到与视图不一致的题库。
    try {
      if (!(await this.vault.adapter.exists(contentPath))) {
        return { status: "rejected", reason: "csv-missing" };
      }
      const csvContent = await this.vault.adapter.read(contentPath);
      const rows = parseCSV(csvContent);
      const rowErrors = validateQuestionRows(rows);
      const { emptyIds, duplicateIds } = checkIdQuality(
        expandShortAnswerRows(rows)
      );
      if (
        rowErrors.length > 0 ||
        emptyIds.length > 0 ||
        duplicateIds.length > 0
      ) {
        return { status: "rejected", reason: "bad-id" };
      }
    } catch {
      return { status: "rejected", reason: "csv-read-error" };
    }

    // 归一化旧 quizState（字段级防御，避免类型错误进入 sidecar）
    const normalized = this.normalizeQuizState(quizState);
    // L-final-3: quizState 存在但非对象/无法归一化 = 损坏数据，并入 rejected 体系提示用户
    // （而非静默 skipped，避免用户误以为旧进度已迁移）
    if (!normalized) {
      return { status: "rejected", reason: "bad-state" };
    }

    // S5: 校验旧 quizState.csvPath 与目标内容源路径一致，避免把旧题库进度
    // 错位迁移到新题库的 sidecar（升级前换过题库路径的场景）。
    // 空串表示最老版本无 csvPath 字段，视为「无法校验」，允许迁移（兼容老数据）。
    if (normalized.csvPath && normalized.csvPath !== contentPath) {
      return { status: "rejected", reason: "path-mismatch" };
    }

    // M7: 目标 sidecar 已存在（回滚-再升级场景：3.0 的进度仍留在 sidecar 中）时，
    // 先把现有 sidecar 备份为 <sidecarPath>.bak.pre-migrate 再写入迁移数据，
    // 避免 3.0 进度被覆盖丢失。备份失败不阻断迁移（仅 console.error）。
    const sidecarPath = sidecarPathFor(contentPath);
    if (await this.vault.adapter.exists(sidecarPath)) {
      try {
        const existing = await this.vault.adapter.read(sidecarPath);
        await this.vault.adapter.write(
          sidecarPath + ".bak.pre-migrate",
          existing
        );
      } catch (e) {
        console.error(
          "CSV Quiz: 备份现有 sidecar 失败（不阻断迁移）",
          e
        );
      }
    }

    // 旧版无 meta 概念：meta 写入空层；state 原样搬入 sidecar（权威覆盖写，不合并磁盘）
    // writeRaw 成功后会同步 sidecarBase/statsBaseline，避免后续门控保存拿旧 base 误判。
    await this.runExclusive(() =>
      this.writeRaw(
        contentPath,
        {
          version: 1,
          meta: {},
          state: this.stateToSidecar(normalized),
        },
        { authoritative: true }
      )
    );

    // S4: 顺序依赖——必须先写完整 data.json 备份、成功后再清空 quizState。
    // 若顺序颠倒（先清空再备份），第二步失败时 data.json 已清空且无备份，
    // 回滚路径永久丢失。
    const backup = JSON.stringify(data, null, 2);
    await this.vault.adapter.write("data.json.bak", backup);
    await this.plugin.saveData({ ...data, quizState: null });
    return { status: "migrated" };
  }

  /** 备份当前 sidecar 到 .bak（无 contentPath 时跳过；sidecar 文件不存在时静默跳过）。
   *  失败仅 console.error，不抛出（尽力而为的备份，不应产生 unhandled rejection）。 */
  async backupCurrentSidecar(): Promise<void> {
    if (this.contentPath === null) return;
    try {
      await backupSidecar(this.vault, this.contentPath);
    } catch (e) {
      console.error("CSV Quiz: 备份当前 sidecar 失败", e);
    }
  }

  /**
   * 检测当前题库 sidecar 的同步冲突副本（iCloud 等服务改名保留的近似文件）。
   * 列 contentPath 所在目录，按 findSidecarConflictPaths 的命名模式匹配。
   * 返回冲突副本的完整路径列表；无 contentPath 或无冲突时返回空数组。
   */
  async detectSidecarConflicts(): Promise<string[]> {
    if (this.contentPath === null) return [];
    const dir = this.contentPath.includes("/")
      ? this.contentPath.slice(0, this.contentPath.lastIndexOf("/"))
      : "/";
    try {
      const listing = await this.vault.adapter.list(dir);
      return findSidecarConflictPaths(listing.files, this.contentPath);
    } catch (e) {
      console.error("CSV Quiz: 列目录检测冲突副本失败", e);
      return [];
    }
  }

  /**
   * 合并 sidecar 冲突副本到当前状态并写盘，然后把副本归档为 ".merged"（不删除用户数据）。
   * 合并语义见 mergeSidecarData：标量保留当前，answered/meta/memoryCards 取并集
   * （meta 以 entry.ts/源时间戳取新，记忆卡片以 lastReview 取新、缺 lastReview 回退
   * ts/源时间戳，完全平局当前优先）。currentState 的 answeredQuestions/memoryCards 原地更新内容
   * （保持对象引用，调用方持有的状态对象同步可见）；currentMeta 整体替换为合并结果。
   * dailyAnswers 按日期取 max(current, 各副本)，避免重复合并不翻倍；memoryInitialized 取 OR。
   * 正确/错误计数不在合并内改写（统计口径是累计作答事件数，整体重算会篡改历史；
   * 由调用方按 addedAnswerIds 为新并入的答案逐条补计）。
   * 整个「检测 → 读副本 → 合并 → 写回 → 归档」在串行链内完成，不会与门控保存穿插。
   */
  async mergeSidecarConflicts(
    metaFieldClears?: Map<string, Map<string, number>>
  ): Promise<SidecarMergeOutcome> {
    const path = this.contentPath;
    const state = this.currentState;
    if (path === null || state === null) {
      return { status: "none" };
    }
    // 检测副本 → 读副本 → 合并 → 写回 → 归档 整段串行；实现体不得再入队（避免死锁）
    return this.runExclusive(async () => {
      // 排队期间题库已切换/卸载：不把旧状态写到新路径
      if (this.contentPath !== path || this.currentState !== state) {
        return { status: "none" };
      }
      return this.mergeSidecarConflictsImpl(path, metaFieldClears);
    });
  }

  /** mergeSidecarConflicts 的实现体（须在 runExclusive 内调用，不可自行入队）。 */
  private async mergeSidecarConflictsImpl(
    path: string,
    metaFieldClears?: Map<string, Map<string, number>>
  ): Promise<SidecarMergeOutcome> {
    const state = this.currentState;
    if (state === null) return { status: "none" };
    const conflictPaths = await this.detectSidecarConflicts();
    if (conflictPaths.length === 0) return { status: "none" };

    // 逐个读取冲突副本：解析失败/结构非法的跳过并计数（不阻塞其余副本合并）
    const sources: SidecarConflictSource[] = [];
    let unreadable = 0;
    for (const conflictPath of conflictPaths) {
      try {
        const content = await this.vault.adapter.read(conflictPath);
        const data = normalizeSidecar(JSON.parse(content));
        if (!data) {
          unreadable++;
          continue;
        }
        // 有效写入时间：文件内 updatedAt 优先，缺失回退文件 mtime
        let tsMs =
          typeof data.state.updatedAt === "number" ? data.state.updatedAt : 0;
        if (!tsMs) {
          const stat = await this.vault.adapter.stat(conflictPath);
          tsMs = stat?.mtime ?? 0;
        }
        sources.push({ path: conflictPath, data, tsMs });
      } catch (e) {
        console.error("CSV Quiz: 读取冲突副本失败", conflictPath, e);
        unreadable++;
      }
    }
    if (sources.length === 0) {
      return { status: "none", unreadable };
    }

    // base 时间戳用磁盘侧真实时间（载入时的 updatedAt/mtime，或本插件最近成功写入
    // 时刻），不能用 Date.now()：合并时刻永远最新，会让 base 旧条目压掉较新副本。
    // 未知（0）也照传，由 lastReview/内部 ts 决胜。
    const merge = mergeSidecarData(
      this.buildSidecarData(),
      this.currentSidecarUpdatedAt,
      sources
    );
    // 冲突副本可能包含导出时已清理的旧 B 类字段；在写回前按持久化清理记录丢掉，
    // 否则下一次 writeGated 会把它写回磁盘，遮蔽导出的 CSV 值。
    if (metaFieldClears && metaFieldClears.size > 0) {
      const mergedBeforeClears = merge.data.meta;
      merge.data.meta = applyMetaFieldClears(
        mergedBeforeClears,
        metaFieldClears
      );
      // 仅过滤内存不够：writeGated 慢路径会用 base/disk 的三方合并把旧字段
      // 重新物化。这里同时登记字段级 tombstone，确保本次写入真正删除。
      // 只登记「合并结果中确实还是旧值」的字段；导出后用户重新编辑的新值
      //（entry.ts > clearTs）不能被 tombstone 删掉。
      const tomb = this.tombstones.get(path) ?? this.emptyTombstones();
      for (const [id, fields] of metaFieldClears) {
        if (fields.size === 0) continue;
        const entry = (
          Object.prototype.hasOwnProperty.call(mergedBeforeClears, id)
            ? mergedBeforeClears[id]
            : undefined
        ) as (SidecarMeta & Record<string, unknown>) | undefined;
        if (!entry) continue;
        let set = tomb.metaFields.get(id);
        for (const [field, clearTs] of fields) {
          if (entry[field] === undefined) continue;
          if ((entry.ts ?? 0) > clearTs) continue;
          if (!set) {
            set = new Set();
            tomb.metaFields.set(id, set);
          }
          set.add(field);
        }
      }
      if (tomb.metaFields.size > 0) this.tombstones.set(path, tomb);
    }

    // 每日答题量：按日期取 max(current, 各冲突副本)，不求和——重复合并不会翻倍，
    // 也不会丢掉另一分支独有的日期计数；当前缺失的日期由副本补入。
    // correct/wrong 保持 base 计数（视图按 addStatsForAnswers/addedAnswerIds 继续补新增
    // answered），不在合并里重算，避免把累计作答事件数改成唯一题数。
    const mergedDaily = maxDailyAnswers(
      merge.data.state.dailyAnswers,
      ...sources.map((s) => s.data.state.dailyAnswers)
    );
    const memoryInitialized =
      merge.data.state.memoryInitialized === true ||
      sources.some((s) => s.data.state.memoryInitialized === true);
    merge.data.state.dailyAnswers = mergedDaily;
    merge.data.state.memoryInitialized = memoryInitialized;

    // 写回内存：answeredQuestions/memoryCards 原地替换内容（保持引用，视图持有的
    // effectiveState/loadResult.state 与本 currentState 为同一对象）；daily/初始化标记整体更新
    const st = this.currentState;
    if (st === null) return { status: "none" };
    for (const key of Object.keys(st.answeredQuestions)) {
      delete st.answeredQuestions[key];
    }
    Object.assign(st.answeredQuestions, merge.data.state.answeredQuestions);
    if (merge.data.state.memoryCards !== undefined) {
      const merged = st.memoryCards ?? {};
      for (const key of Object.keys(merged)) delete merged[key];
      Object.assign(merged, merge.data.state.memoryCards);
      st.memoryCards = merged;
    }
    st.dailyAnswers = mergedDaily;
    st.memoryInitialized = memoryInitialized;
    this.currentMeta = merge.data.meta;

    // 合并结果已是「base ∪ 冲突副本（daily 取 max）」。用门控写而不是权威写：
    // 本方法已在串行链内，writeGated 会再吸收读副本期间 canonical 的外部变化；
    // statsBaseline 仍是合并前的内存计数，daily 增量只会叠加冲突副本新增部分，
    // 不会把 base 计数重复加一次。写成功后 base/baseline 同步刷新。
    await this.writeGated(path, this.buildSidecarData());

    // 归档冲突副本（改名保留备查；单个失败不阻塞其余）
    let archived = 0;
    let archiveFailed = 0;
    for (const conflictPath of conflictPaths) {
      try {
        const dest = conflictPath + SIDECAR_MERGED_SUFFIX;
        // 重试式覆盖归档：Windows 同步目录下 remove+rename 易 EBUSY，走桌面原子 rename/兜底重试。
        // 预算收紧到 3s：多个副本串行归档时不因单副本 30s 重试阻塞视图渲染（失败者下次再试）
        await renameOverwriteWithRetry(this.vault, conflictPath, dest, {
          budgetMs: 3000,
        });
        archived++;
      } catch (e) {
        console.error("CSV Quiz: 归档冲突副本失败", conflictPath, e);
        archiveFailed++;
      }
    }

    return {
      status: "merged",
      mergedSources: merge.mergedSources,
      addedAnswers: merge.addedAnswers,
      addedAnswerIds: merge.addedAnswerIds,
      unreadable,
      archived,
      archiveFailed,
    };
  }

  /** 取内容源 sidecar 的有效时间戳：state.updatedAt（有限正数）优先，
   *  否则文件 mtime，都拿不到返回 0（绝不回退 Date.now()，否则「现在」会压掉真实较新数据）。 */
  private async sidecarTimestampMs(
    contentPath: string,
    data: SidecarData
  ): Promise<number> {
    const updatedAt = data.state.updatedAt;
    if (
      typeof updatedAt === "number" &&
      Number.isFinite(updatedAt) &&
      updatedAt > 0
    ) {
      return updatedAt;
    }
    try {
      const stat = await this.vault.adapter.stat(sidecarPathFor(contentPath));
      const mtime = stat?.mtime;
      if (typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0) {
        return mtime;
      }
    } catch {
      // 拿不到 mtime 视为未知
    }
    return 0;
  }

  /**
   * 把某内容源的 sidecar 归档为 `.merged`（不删除数据）。
   * 用于 manifest 删除后反向迁移完成、避免下次启动重复合并旧快照。
   */
  async archiveSidecar(contentPath: string): Promise<void> {
    if (contentPath === "") return;
    await this.runExclusive(async () => {
      const srcPath = sidecarPathFor(contentPath);
      const dstPath = `${srcPath}.merged`;
      try {
        if (!(await this.vault.adapter.exists(srcPath))) return;
        if (await this.vault.adapter.exists(dstPath)) {
          await this.vault.adapter.remove(dstPath);
        }
        await this.vault.adapter.rename(srcPath, dstPath);
        // 归档后该内容源已无 canonical sidecar：保存层基准失效，避免下次写盘误判未变
        this.sidecarBase.delete(contentPath);
        this.statsBaseline.delete(contentPath);
        this.tombstones.delete(contentPath);
      } catch (e) {
        console.error("CSV Quiz: 归档 sidecar 失败", srcPath, e);
      }
    });
  }

  /**
   * 把 from 内容源的 sidecar 复制/合并到 to 内容源（不删除 from）。
   * 用于「图片文件夹-only ↔ CSV 锚点」切换：用户补上/去掉 CSV 路径时，
   * 让进度跟随内容源迁移，且保留源文件以便回退。
   * - 空路径或 from === to → skipped
   * - from 缺失 → skipped；from 损坏 → error（不抛，仅 console.error）
   * - to 缺失 → copied（直接写入 from 的数据）
   * - to ok/recovered → merged（answered 并集、meta/memoryCards 取较新）
   */
  async transferSidecar(
    fromContentPath: string,
    toContentPath: string
  ): Promise<SidecarMergeOpResult> {
    const fromPath = fromContentPath.trim();
    const toPath = toContentPath.trim();
    if (fromPath === "" || toPath === "") {
      return { status: "skipped", reason: "empty-path" };
    }
    if (fromPath === toPath) {
      return { status: "skipped", reason: "same-path" };
    }
    // 读源 + 读目标 + 写目标必须整体串行（避免与门控保存互相穿插）
    return this.runExclusive(() => this.transferSidecarImpl(fromPath, toPath));
  }

  /** transferSidecar 的实现体（须在 runExclusive 内调用，不可自行入队）。 */
  private async transferSidecarImpl(
    fromPath: string,
    toPath: string
  ): Promise<SidecarMergeOpResult> {
    try {
      const fromResult = await readSidecar(this.vault, fromPath);
      if (fromResult.status === "missing") {
        return { status: "skipped", reason: "source-missing" };
      }
      if (fromResult.status === "corrupt") {
        console.error(
          "CSV Quiz: 读取源内容源 sidecar 失败，跳过转移",
          fromPath,
          fromResult.reason
        );
        return { status: "error", reason: fromResult.reason };
      }

      const fromData = fromResult.data;
      const fromTs = await this.sidecarTimestampMs(fromPath, fromData);

      const toResult = await readSidecar(this.vault, toPath);
      if (toResult.status === "corrupt") {
        // 目标损坏：不覆盖（可能仍可人工修复/从 bak 恢复），交回调用方处理
        console.error(
          "CSV Quiz: 目标内容源 sidecar 损坏，跳过转移",
          toPath,
          toResult.reason
        );
        return { status: "error", reason: toResult.reason };
      }
      if (toResult.status === "missing") {
        await this.writeRaw(toPath, fromData);
        return { status: "copied" };
      }

      // ok / recovered：以目标为 base 合并（recovered 视为 ok 合并）
      const toTs = await this.sidecarTimestampMs(toPath, toResult.data);
      const merged = mergeSidecarData(toResult.data, toTs, [
        { path: sidecarPathFor(fromPath), data: fromData, tsMs: fromTs },
      ]);
      // 幂等口径：同一源重复迁移时，计数/每日不能翻倍。
      // - correct/wrong 取 max(target, from)：累计精确值无法从快照反推，保留高位；
      // - daily 逐日取 max；memoryInitialized 取 OR。
      merged.data.state.correctCount = Math.max(
        safeCount(toResult.data.state.correctCount),
        safeCount(fromData.state.correctCount)
      );
      merged.data.state.wrongCount = Math.max(
        safeCount(toResult.data.state.wrongCount),
        safeCount(fromData.state.wrongCount)
      );
      merged.data.state.dailyAnswers = maxDailyAnswers(
        toResult.data.state.dailyAnswers,
        fromData.state.dailyAnswers
      );
      merged.data.state.memoryInitialized =
        toResult.data.state.memoryInitialized === true ||
        fromData.state.memoryInitialized === true;
      // writeRaw 成功后会同步刷新目标路径的 base/baseline（重复迁移以新 base 为准）
      await this.writeRaw(toPath, merged.data);
      return { status: "merged" };
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error("CSV Quiz: 转移 sidecar 失败", fromPath, "→", toPath, e);
      return { status: "error", reason };
    }
  }

  /**
   * 同时有 CSV 与图片文件夹时，把图片文件夹的 `<folder>.sidecar.json`
   * 合并进 CSV sidecar；成功后把图片 sidecar 归档为 `.merged`（失败保留原文件，
   * 下次可重试）。返回 copied/merged/skipped/error，归档失败不影响 status。
   */
  async mergeImageSidecar(
    csvPath: string,
    imageFolder: string
  ): Promise<SidecarMergeOpResult> {
    const csv = csvPath.trim();
    const imagePath = normalizeVaultFolder(imageFolder);
    if (csv === "" || imagePath === "") {
      return { status: "skipped", reason: "empty-path" };
    }
    if (csv === imagePath) {
      return { status: "skipped", reason: "same-path" };
    }

    // 转移 + 归档整体串行：transferSidecarImpl 不自行入队，避免死锁
    return this.runExclusive(async () => {
      const result = await this.transferSidecarImpl(imagePath, csv);
      if (result.status !== "copied" && result.status !== "merged") {
        return result;
      }

      // 归档源 sidecar（重试式覆盖：目标 .merged 已存在时先删再改名）
      const srcPath = sidecarPathFor(imagePath);
      try {
        if (!(await this.vault.adapter.exists(srcPath))) return result;
        await renameOverwriteWithRetry(
          this.vault,
          srcPath,
          srcPath + SIDECAR_MERGED_SUFFIX,
          { budgetMs: 3000 }
        );
      } catch (e) {
        // 归档失败只记日志：合并已成功，原文件保留可下次重试
        console.error("CSV Quiz: 归档图片内容源 sidecar 失败", srcPath, e);
      }
      return result;
    });
  }

  /** sidecar 是否含用户进度（answered / memoryCards / 对错计数 / meta 任一非空）。 */
  private sidecarHasProgress(data: SidecarData): boolean {
    const s = data.state;
    return (
      Object.keys(s.answeredQuestions).length > 0 ||
      (s.memoryCards !== undefined && Object.keys(s.memoryCards).length > 0) ||
      s.correctCount > 0 ||
      s.wrongCount > 0 ||
      Object.keys(data.meta).length > 0
    );
  }

  /**
   * manifest 复合题库：把组成内容源（content/contents/图片文件夹）的 sidecar 一次性
   * 并入 manifest 锚点的 sidecar（5.0.0 遗留问题：复合题库加载了全部题目，但
   * manifest.sidecar.json 是新建空状态，组成 sidecar 里的进度全部不可见）。
   *
   * - 目标缺失 → 以空状态为 base；目标损坏 → error（不覆盖，避免丢数据）
   * - 目标已有进度也继续合并（幂等）：answered/meta/memoryCards 为并集，
   *   计数/每日按「组件求和后与目标取 max」合并，重复运行不翻倍
   * - 会话字段（displayOrder/currentIndex/filter*）一律保留目标值（缺失时为空，后续由视图重建）
   * - 合并结果与目标规范化 JSON 完全一致 → skipped/no-change（不写盘）
   * - 不删除/不归档任何组成 sidecar（保留回退数据源）
   * - metaFieldClears：导出清理记录（id → field → 清除时刻）。目标与组件的 B 类字段
   *   若写入时间不晚于清除时刻则丢弃，避免导出到 CSV 后旧组件字段被回填。
   */
  async mergeManifestComponentSidecars(
    targetAnchor: string,
    componentAnchors: string[],
    defaultFilters: { favorite: string; mastered: string; repeat: string; wrong: string },
    componentCutoffMs = 0,
    metaFieldClears?: Map<string, Map<string, number>>
  ): Promise<ManifestSidecarMergeResult> {
    const target = targetAnchor.trim();
    if (target === "") return { status: "skipped" };
    // 读 target/组件、合并、写盘必须在同一个串行 job 内，否则普通保存可能
    // 在读取和权威写之间插入，随后被 manifest 合并结果覆盖。
    return this.runExclusive(() =>
      this.mergeManifestComponentSidecarsImpl(
        target,
        componentAnchors,
        defaultFilters,
        componentCutoffMs,
        metaFieldClears
      )
    );
  }

  /** mergeManifestComponentSidecars 的实现体（须在 runExclusive 内调用，不可再入队）。 */
  private async mergeManifestComponentSidecarsImpl(
    target: string,
    componentAnchors: string[],
    defaultFilters: { favorite: string; mastered: string; repeat: string; wrong: string },
    componentCutoffMs: number,
    metaFieldClears?: Map<string, Map<string, number>>
  ): Promise<ManifestSidecarMergeResult> {
    const targetResult = await readSidecar(this.vault, target);
    if (targetResult.status === "corrupt") {
      console.error(
        "CSV Quiz: manifest sidecar 损坏，跳过组成侧进度合并",
        target,
        targetResult.reason
      );
      return { status: "error", reason: "target-corrupt" };
    }

    let targetData: SidecarData;
    let targetTs = 0;
    if (targetResult.status === "missing") {
      // 目标缺失：空状态作 base。剔除 csvPath（sidecar 不存该字段）。
      const { csvPath: _csvPath, ...emptyState } =
        this.emptySessionState(defaultFilters);
      void _csvPath;
      targetData = { version: 1, meta: {}, state: { ...emptyState } };
    } else {
      targetData = targetResult.data;
      targetTs = await this.sidecarTimestampMs(target, targetResult.data);
    }

    // 导出清理记录：目标侧同样过滤（目标若在导出后重新编辑，entry.ts 更新会保留）
    if (metaFieldClears && metaFieldClears.size > 0) {
      targetData = {
        ...targetData,
        meta: applyMetaFieldClears(targetData.meta, metaFieldClears),
      };
    }

    // 组成去重（排除空与 target 自身），只收「有进度」的 sidecar
    const seen = new Set<string>();
    const components: SidecarConflictSource[] = [];
    for (const rawAnchor of componentAnchors) {
      const anchor = rawAnchor.trim();
      if (anchor === "" || anchor === target || seen.has(anchor)) continue;
      seen.add(anchor);
      const result = await readSidecar(this.vault, anchor);
      if (result.status === "missing") continue;
      if (result.status === "corrupt") {
        // 单个组成损坏不阻塞其余组成合并
        console.error(
          "CSV Quiz: 组成内容源 sidecar 损坏，跳过合并",
          anchor,
          result.reason
        );
        continue;
      }
      if (!this.sidecarHasProgress(result.data)) continue;
      // 组件侧旧 B 类字段过滤（先过滤再判进度，避免只剩已清理字段的组件被并回）
      if (metaFieldClears && metaFieldClears.size > 0) {
        result.data = {
          ...result.data,
          meta: applyMetaFieldClears(result.data.meta, metaFieldClears),
        };
        if (!this.sidecarHasProgress(result.data)) continue;
      }
      const tsMs = await this.sidecarTimestampMs(anchor, result.data);
      // 重置闸门：重置前写入的组件 sidecar 不得被自动并回（否则重置后进度复活）。
      // 重置后单独使用组件来源产生的新进度（ts > cutoff）仍可并入。
      if (componentCutoffMs > 0 && tsMs <= componentCutoffMs) continue;
      components.push({
        path: sidecarPathFor(anchor),
        data: result.data,
        tsMs,
      });
    }
    if (components.length === 0) {
      return { status: "skipped", reason: "no-component-progress" };
    }

    const merge = mergeSidecarData(targetData, targetTs, components);

    // 幂等口径：组件侧先按组件求和（累计作答事件口径），再与 target 取 max。
    // 重复运行同一批组件不会翻倍；target 已有更高计数/日期值时保留高位。
    let sumCorrect = 0;
    let sumWrong = 0;
    let anyComponentInitialized = false;
    const sumDaily = new Map<string, number>();
    for (const component of components) {
      sumCorrect += safeCount(component.data.state.correctCount);
      sumWrong += safeCount(component.data.state.wrongCount);
      anyComponentInitialized =
        anyComponentInitialized ||
        component.data.state.memoryInitialized === true;
      for (const [date, count] of Object.entries(
        component.data.state.dailyAnswers ?? {}
      )) {
        sumDaily.set(date, (sumDaily.get(date) ?? 0) + safeCount(count));
      }
    }
    const correctCount = Math.max(
      safeCount(targetData.state.correctCount),
      sumCorrect
    );
    const wrongCount = Math.max(
      safeCount(targetData.state.wrongCount),
      sumWrong
    );
    const dailyAnswers: Record<string, number> = {};
    for (const [date, count] of Object.entries(
      targetData.state.dailyAnswers ?? {}
    )) {
      dailyAnswers[date] = safeCount(count);
    }
    for (const [date, count] of sumDaily) {
      const targetCount = Object.prototype.hasOwnProperty.call(
        dailyAnswers,
        date
      )
        ? dailyAnswers[date]
        : 0;
      dailyAnswers[date] = Math.max(targetCount, count);
    }
    const memoryInitialized =
      anyComponentInitialized || targetData.state.memoryInitialized === true;

    const mergedData: SidecarData = {
      version: 1,
      meta: merge.data.meta,
      state: {
        ...merge.data.state,
        // 会话字段（displayOrder/currentIndex/filter*）取自 base（target）
        correctCount,
        wrongCount,
        // 双方都无每日记录时保持 target 原值（undefined 不写成空对象）
        dailyAnswers:
          Object.keys(dailyAnswers).length > 0
            ? dailyAnswers
            : targetData.state.dailyAnswers,
        // OR 语义；两方都不是 true 时保留 target 原值（含 undefined）
        memoryInitialized: memoryInitialized
          ? true
          : targetData.state.memoryInitialized,
        updatedAt: targetData.state.updatedAt,
      },
    };

    // 无变化判断：忽略 updatedAt 后规范化 JSON 完全相同 → 不写盘（重复运行零副作用）
    if (
      canonicalSidecarJson(mergedData) === canonicalSidecarJson(targetData)
    ) {
      return { status: "skipped", reason: "no-change" };
    }
    mergedData.state.updatedAt = Date.now();

    try {
      // 已在 mergeManifestComponentSidecars 的 runExclusive job 内，不能再次入队。
      await this.writeRaw(target, mergedData);
    } catch (e: unknown) {
      console.error("CSV Quiz: 写入 manifest 合并后 sidecar 失败", target, e);
      return { status: "error", reason: "write-failed" };
    }

    return {
      status: "merged",
      mergedComponents: components.length,
      addedAnswers: merge.addedAnswers,
      correctCount,
      wrongCount,
    };
  }

  /**
   * 从 `.merged` 归档（冲突副本合并后保留的快照）恢复进度：把每个归档按
   * mergeSidecarData 并入目标 sidecar，成功后把归档改名为 `+".recovered"`
   * （幂等：第二次运行时已无 `.merged` 可匹配）。整个过程在串行链内完成。
   *
   * - 目标损坏 → error/target-corrupt（不写、不改名）
   * - 目标缺失 → 用空状态（默认筛选取自 defaultFilters）作 base
   * - 坏归档跳过（不阻塞其余归档）
   * - correct/wrong 保持目标当前值（累计作答事件数无法从快照反推）；
   *   dailyAnswers 逐日取 max；memoryInitialized 取 OR
   * - 合并结果与目标一致时不写盘（只改名归档）
   * - 写盘失败 → error/write-failed（不改名，保留归档待下次重试）
   */
  async recoverMergedSidecars(
    targetAnchor: string,
    componentAnchors: string[],
    defaultFilters: { favorite: string; mastered: string; repeat: string; wrong: string },
    metaFieldClears?: Map<string, Map<string, number>>
  ): Promise<MergedArchiveRecoveryResult> {
    const target = targetAnchor.trim();
    if (target === "") return { status: "none" };

    // 读归档 → 合并 → 写回 → 改名整段串行，避免与门控保存穿插
    return this.runExclusive(async () => {
      // 1. 收集各锚点目录下的 .merged 归档（路径去重）
      const anchors: string[] = [];
      const seenAnchors = new Set<string>();
      const pushAnchor = (raw: string): void => {
        const value = raw.trim();
        if (value === "" || seenAnchors.has(value)) return;
        seenAnchors.add(value);
        anchors.push(value);
      };
      pushAnchor(target);
      for (const raw of componentAnchors) pushAnchor(raw);

      const archivePaths: string[] = [];
      const seenPaths = new Set<string>();
      const dirListings = new Map<string, string[]>();
      for (const anchor of anchors) {
        const dir = anchor.includes("/")
          ? anchor.slice(0, anchor.lastIndexOf("/"))
          : "/";
        let files = dirListings.get(dir);
        if (!files) {
          try {
            const listing = await this.vault.adapter.list(dir);
            files = listing.files;
          } catch (e) {
            console.error("CSV Quiz: 列目录查找 .merged 归档失败", dir, e);
            files = [];
          }
          dirListings.set(dir, files);
        }
        for (const archivePath of findMergedSidecarPaths(files, anchor)) {
          if (seenPaths.has(archivePath)) continue;
          seenPaths.add(archivePath);
          archivePaths.push(archivePath);
        }
      }
      if (archivePaths.length === 0) return { status: "none" };

      // 2. 读目标（损坏不写不改名；缺失用空状态兜底）
      const targetResult = await readSidecar(this.vault, target);
      if (targetResult.status === "corrupt") {
        console.error(
          "CSV Quiz: 目标 sidecar 损坏，跳过 .merged 归档恢复",
          target,
          targetResult.reason
        );
        return { status: "error", reason: "target-corrupt" };
      }
      let base: SidecarData;
      let baseTs = 0;
      if (targetResult.status === "missing") {
        const { csvPath: _csvPath, ...emptyState } =
          this.emptySessionState(defaultFilters);
        void _csvPath;
        base = { version: 1, meta: {}, state: { ...emptyState } };
      } else {
        base = targetResult.data;
        baseTs = await this.sidecarTimestampMs(target, base);
      }

      // 3. 逐个读归档（坏归档跳过）
      const sources: SidecarConflictSource[] = [];
      for (const archivePath of archivePaths) {
        try {
          const content = await this.vault.adapter.read(archivePath);
          const data = normalizeSidecar(JSON.parse(content));
          if (!data) continue;
          let tsMs =
            typeof data.state.updatedAt === "number" &&
            Number.isFinite(data.state.updatedAt)
              ? data.state.updatedAt
              : 0;
          if (!tsMs) {
            try {
              const stat = await this.vault.adapter.stat(archivePath);
              const mtime = stat?.mtime;
              tsMs =
                typeof mtime === "number" && Number.isFinite(mtime) ? mtime : 0;
            } catch {
              tsMs = 0;
            }
          }
          sources.push({ path: archivePath, data, tsMs });
        } catch (e) {
          console.error("CSV Quiz: 读取 .merged 归档失败", archivePath, e);
        }
      }

      // 4. 合并：answered/meta/cards 并集；correct/wrong 保持目标；daily 取 max
      const merge = mergeSidecarData(base, baseTs, sources);
      // 归档可能包含导出时已清理的旧 B 类字段；恢复后同样不能让它回填。
      const recoveredMeta =
        metaFieldClears && metaFieldClears.size > 0
          ? applyMetaFieldClears(merge.data.meta, metaFieldClears)
          : merge.data.meta;
      const dailyAnswers = maxDailyAnswers(
        base.state.dailyAnswers,
        ...sources.map((source) => source.data.state.dailyAnswers)
      );
      const memoryInitialized =
        base.state.memoryInitialized === true ||
        sources.some((source) => source.data.state.memoryInitialized === true);
      const merged: SidecarData = {
        version: 1,
        meta: recoveredMeta,
        state: {
          ...merge.data.state,
          // 累计作答事件数无法从快照反推 → 保持目标当前值
          correctCount: base.state.correctCount,
          wrongCount: base.state.wrongCount,
          dailyAnswers,
          memoryInitialized: memoryInitialized
            ? true
            : base.state.memoryInitialized,
          updatedAt: base.state.updatedAt,
        },
      };

      // 5. 有内容变化才写盘（避免无变化时白写；写失败不改名）
      const changed =
        canonicalSidecarJson(merged) !== canonicalSidecarJson(base);
      if (changed) {
        merged.state.updatedAt = Date.now();
        try {
          await this.writeRaw(target, merged, { authoritative: true });
        } catch (e) {
          console.error("CSV Quiz: 写入 .merged 恢复结果失败", target, e);
          return { status: "error", reason: "write-failed" };
        }
      }

      // 6. 归档改名为 .recovered（已存在则加时间戳后缀；失败计数不改变 status）
      let renamed = 0;
      let renameFailed = 0;
      for (const archivePath of archivePaths) {
        let dest = archivePath + ".recovered";
        try {
          if (await this.vault.adapter.exists(dest)) {
            dest = `${archivePath}.recovered.${Date.now()}`;
          }
          await renameOverwriteWithRetry(this.vault, archivePath, dest, {
            budgetMs: 3000,
          });
          renamed++;
        } catch (e) {
          console.error("CSV Quiz: 归档 .merged 改名失败", archivePath, e);
          renameFailed++;
        }
      }

      return {
        status: "merged",
        archives: sources.length,
        addedAnswers: merge.addedAnswers,
        renamed,
        renameFailed,
      };
    });
  }

  /**
   * 设置保存防抖：设置面板每次击键都会触发，合并为最后一次变更后 400ms 写入一次。
   * 使用"共享 promise"语义：每次调用都会登记一个 resolve，由最终那次写入完成后统一
   * resolve，避免旧调用 clearTimeout 后其返回的 Promise 永不 resolve。
   */
  async saveSettings(settings: PluginSettings): Promise<void> {
    this.pendingSettings = settings;
    // W2: 默认筛选设置变更即时同步成员（面板打开期间改设置 + 「全部重置」场景：
    // 空 sidecar 写入的默认筛选必须用最新值，与首次打开 missing 路径行为一致）。
    // loadSidecar 的入参保存保留（首开/切换时也正确），两个更新来源最终一致，无冲突。
    this.defaultFilters = {
      favorite: settings.defaultFilterFavorite,
      mastered: settings.defaultFilterMastered,
      repeat: settings.defaultFilterRepeat,
      wrong: settings.defaultFilterWrong,
    };
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
    }
    return new Promise<void>((resolve) => {
      this.settingsResolvers.push(resolve);
      this.settingsSaveTimer = window.setTimeout(() => {
        this.settingsSaveTimer = null;
        void this.flushSettingsSave();
      }, 400);
    });
  }

  /** 立即落盘挂起的设置保存（设置页关闭 / 插件卸载时调用，避免防抖窗口内丢设置）。 */
  async flushSettingsSave(): Promise<void> {
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
    }
    const s = this.pendingSettings;
    this.pendingSettings = null;
    const resolvers = this.settingsResolvers;
    this.settingsResolvers = [];
    try {
      if (s) {
        await this.writeQueue.enqueue({ settings: s });
      }
    } finally {
      // 统一 resolve 所有登记过的等待者（即使写入失败也需解除挂起）
      resolvers.forEach((resolve) => resolve());
    }
  }
}
