import { Notice, Plugin, Vault } from "obsidian";
import {
  MemoryCard,
  QuizSessionState,
  PluginData,
  PluginSettings,
} from "./types";
import {
  SidecarData,
  SidecarMeta,
  SidecarState,
  SidecarWriteQueue,
  backupSidecar,
  readSidecar,
  sidecarPathFor,
  writeSidecar,
} from "./sidecar";
import { checkIdQuality, parseCSV } from "./csvHandler";

interface DataPatch {
  settings?: PluginSettings;
  quizState?: QuizSessionState | null;
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

export class StateManager {
  private plugin: Plugin;
  private vault: Vault;
  private currentState: QuizSessionState | null = null;
  private saveTimer: number | null = null;
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
  /** sidecar 串行写队列（同 contentPath 连续入队合并）。 */
  private sidecarQueue: SidecarWriteQueue;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.vault = plugin.app.vault;
    this.writeQueue = new StateWriteQueue(plugin);
    this.sidecarQueue = new SidecarWriteQueue(this.vault);
  }

  async loadPluginData(currentSettings: PluginSettings): Promise<PluginData> {
    const data =
      ((await this.plugin.loadData()) as Record<string, unknown> | null) || {};
    const settings: PluginSettings = {
      ...currentSettings,
      ...(data.settings as Partial<PluginSettings> | undefined || {}),
    };
    const quizState = this.normalizeQuizState(data.quizState);
    this.currentState = quizState;
    return { settings, quizState };
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
    const memoryCards =
      r.memoryCards === undefined
        ? undefined
        : r.memoryCards && typeof r.memoryCards === "object"
          ? (r.memoryCards as Record<string, MemoryCard>)
          : {};
    return {
      csvPath: toStr(r.csvPath),
      currentIndex: toNumber(r.currentIndex),
      correctCount: toNumber(r.correctCount),
      wrongCount: toNumber(r.wrongCount),
      displayOrder: toStrArray(r.displayOrder),
      filterText: toStr(r.filterText),
      filterTags: toStr(r.filterTags),
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
   *  defaultFilters 成员填充，避免重置后用户设置的默认筛选丢失；其余字段保持空串。 */
  private emptySidecarState(): SidecarState {
    return {
      currentIndex: 0,
      correctCount: 0,
      wrongCount: 0,
      displayOrder: [],
      filterText: "",
      filterTags: "",
      filterCat1: "",
      filterCat2: "",
      filterCat3: "",
      filterFavorite: this.defaultFilters.favorite,
      filterMastered: this.defaultFilters.mastered,
      filterRepeat: this.defaultFilters.repeat,
      filterWrong: this.defaultFilters.wrong,
      filterUnanswered: "",
      answeredQuestions: {},
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
    // M3: 保存入参默认筛选，供「全部重置」（emptySidecarState）复用
    this.defaultFilters = defaultFilters;
    const result = await readSidecar(this.vault, contentPath);
    if (result.status === "corrupt") {
      // 不动内存，返回 corrupt 由调用方决定是否重建
      return { status: "corrupt", reason: result.reason };
    }
    if (result.status === "missing") {
      const state = this.emptySessionState(defaultFilters);
      state.csvPath = contentPath;
      this.currentState = state;
      this.currentMeta = {};
      this.contentPath = contentPath;
      return { status: "missing", state, meta: {} };
    }
    // ok / recovered
    this.currentState = this.stateFromSidecar(result.data.state, contentPath);
    this.currentMeta = result.data.meta;
    this.contentPath = contentPath;
    return {
      status: result.status,
      state: this.currentState,
      meta: this.currentMeta,
    };
  }

  /**
   * 卸载当前 sidecar：flush（取消挂起防抖 + 立即写盘）后清空
   * contentPath/currentState/currentMeta。兼容模式下仅清空内存。
   */
  async unloadSidecar(): Promise<void> {
    this.cancelScheduledSave();
    if (this.contentPath !== null && this.currentState !== null) {
      await this.persistNow();
    }
    this.contentPath = null;
    this.currentState = null;
    this.currentMeta = {};
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
    if (this.currentState) {
      this.scheduleSave(this.currentState, 300);
    }
  }

  /** 删除某题的整条 meta（内存）+ 调度保存。currentState 为 null 时仅改内存。 */
  clearQuestionMeta(questionId: string): void {
    delete this.currentMeta[questionId];
    if (this.currentState) {
      this.scheduleSave(this.currentState, 300);
    }
  }

  /** 从 currentState + currentMeta 组装 sidecar 全量数据（version 1）。 */
  private buildSidecarData(): SidecarData {
    const state = this.currentState;
    return {
      version: 1,
      meta: this.currentMeta,
      state: state ? this.stateToSidecar(state) : this.emptySidecarState(),
    };
  }

  /** QuizSessionState → SidecarState：去掉 csvPath 字段（关联靠文件命名约定，不入 sidecar）。 */
  private stateToSidecar(s: QuizSessionState): SidecarState {
    return {
      currentIndex: s.currentIndex,
      correctCount: s.correctCount,
      wrongCount: s.wrongCount,
      displayOrder: s.displayOrder,
      filterText: s.filterText,
      filterTags: s.filterTags,
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
    };
  }

  /**
   * 立即落盘当前状态：
   * - sidecar 模式（contentPath 非 null）→ sidecarQueue.enqueue（同 contentPath 合并）
   * - 兼容模式（contentPath 为 null）→ 写 data.json.quizState
   */
  private async persistNow(): Promise<void> {
    // 入队即视为本插件已提交该状态写盘（供外部修改检测抑制窗口使用）
    this.lastPersistAt = Date.now();
    if (this.contentPath !== null) {
      await this.sidecarQueue.enqueue(
        this.contentPath,
        this.buildSidecarData()
      );
    } else {
      await this.writeQueue.enqueue({ quizState: this.currentState });
    }
  }

  async saveStateImmediately(state: QuizSessionState): Promise<void> {
    this.cancelScheduledSave();
    this.currentState = state;
    await this.persistNow();
  }

  scheduleSave(state: QuizSessionState, delay: number = 300): void {
    // H-1: 立即同步 currentState（内存），保证切题库 flush（unloadSidecar 的
    // persistNow）与状态栏刷新等读到最新状态，避免 300ms 窗口内丢最近进度；
    // 回调内仍保留路径检查，防止挂起回调把旧题库状态写回。
    this.currentState = state;
    // M1: 快照入队时的 contentPath；定时器回调执行时若路径已切换（切换题库/
    // unloadSidecar 后）则丢弃本次写入，避免挂起回调把旧题库状态写回
    // （含兼容模式复活 data.json.quizState 导致下次启动重复迁移）
    const scheduledPath = this.contentPath;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
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
    }, delay);
  }

  async clearState(): Promise<void> {
    this.cancelScheduledSave();
    this.currentState = null;
    if (this.contentPath !== null) {
      // 清空 sidecar（保留文件，避免重建）：meta 与状态全清
      this.currentMeta = {};
      await this.sidecarQueue.enqueue(
        this.contentPath,
        this.buildSidecarData()
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

    // 脏拒迁：源 CSV 必须存在且 id 干净（空/重复题号拒绝迁移）
    try {
      if (!(await this.vault.adapter.exists(contentPath))) {
        return { status: "rejected", reason: "csv-missing" };
      }
      const csvContent = await this.vault.adapter.read(contentPath);
      const { emptyIds, duplicateIds } = checkIdQuality(parseCSV(csvContent));
      if (emptyIds.length > 0 || duplicateIds.length > 0) {
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

    // 旧版无 meta 概念：meta 写入空层；state 原样搬入 sidecar
    await writeSidecar(this.vault, contentPath, {
      version: 1,
      meta: {},
      state: this.stateToSidecar(normalized),
    });

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
