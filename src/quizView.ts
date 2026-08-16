import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  Vault,
  Notice,
  Plugin,
} from "obsidian";
import {
  Question,
  QuizSessionState,
  PluginSettings,
  MemoryCard,
  VIEW_TYPE_QUIZ,
} from "./types";
import {
  parseCSV,
  readCSVFile,
  filterQuestions,
  getUniqueTags,
  getUniqueCategories,
  buildDisplayOrder,
  checkIdQuality,
  CSVWriteQueue,
} from "./csvHandler";
import { StateManager } from "./stateManager";
import { createBackupTimer } from "./sidecar";
import type { SidecarMeta } from "./sidecar";
import { decodeCqv, encodeCqv } from "./cqvHandler";
import {
  shuffle,
  sortByDisplayOrder,
  quizStateEquals,
  countDueCards,
  normalizeAnswerValue,
} from "./utils";
import { ChoiceModal, TagPickerModal, askResetChoice, askPrompt } from "./modals";
import { ProgressModal } from "./progressModal";
import { fsrs, createEmptyCard, Rating, type Card } from "ts-fsrs";
import Papa from "papaparse";

/** FSRS 调度器单例：纯函数调度、不持有状态，可跨会话复用（模块级）。 */
const memoryScheduler = fsrs();

export class QuizView extends ItemView {
  private plugin: Plugin;
  private stateManager: StateManager;
  private vault: Vault;
  private csvWriteQueue: CSVWriteQueue;

  private allQuestions: Question[] = [];
  private orderedQuestions: Question[] = [];
  private filteredQuestions: Question[] = [];
  private displayOrder: string[] = [];
  private currentIndex: number = 0;
  private correctCount: number = 0;
  private wrongCount: number = 0;

  private filterText: string = "";
  private filterTags: string = "";
  private filterCat1: string = "";
  private filterCat2: string = "";
  private filterCat3: string = "";
  private filterFavorite: string = "";
  private filterMastered: string = "";
  private filterRepeat: string = "";
  private filterWrong: string = "";
  private filterUnanswered: string = "";

  private csvPath: string = "";

  private answeredQuestions: Record<string, string> = {};
  private currentShuffledQId: string | null = null;
  private currentShuffledOptions: Array<{ key: string; text: string }> = [];
  private answering: boolean = false;
  private showingAnswer: boolean = false;
  private selectedOption: string | null = null;
  private selectedOptions: string[] = [];
  private autoNextTimer: number | null = null;
  /** M1: autoNext 计时器对应的作答题 id（用于在滑动/手动切题后校验题目是否已变化，防"幽灵自动跳题"）。 */
  private autoNextQuestionId: string | null = null;
  private autoSaveTimer: number | null = null;
  /** 活跃备份定时器（面板打开期间每 30 分钟备份当前 sidecar 到 .bak）。 */
  private backupTimer = createBackupTimer();
  /** 内容源 mtime 快照：首次加载只记录；再次加载对比，变化则提示「题库已更新」。 */
  private contentMtimeMs: number | null = null;
  /**
   * M2: 加载世代号——每次初始化/刷新自增，旧流程（多个 await 点之间用户改路径触发新加载）
   * 在任意 await 后检测世代号变化即中止，防止旧题库状态写入新题库 sidecar。
   */
  private loadEpoch: number = 0;
  private navigating: boolean = false;
  private isClosed: boolean = false;
  /** 题库加载成功前禁止写入状态，避免加载失败后用空进度覆盖磁盘进度。 */
  private canPersistState: boolean = false;
  /** 已排队或已写入磁盘的状态快照（心跳脏检查基准；buildCurrentState 每次返回新对象）。 */
  private lastSavedState: QuizSessionState | null = null;
  /** 当前打开的视图实例数（模块级）：防止同一窗口内出现双实例互相覆盖进度。 */
  private static openViewCount = 0;
  /** 本实例是否已计入 openViewCount。 */
  private counted = false;

  private filterContainer!: HTMLElement;
  private progressEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private questionArea!: HTMLElement;
  private feedbackArea!: HTMLElement;
  private checkboxArea!: HTMLElement;
  private editArea!: HTMLElement;
  private navigationArea!: HTMLElement;
  private readOnlyArea!: HTMLElement;
  private bottomBar!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    plugin: Plugin,
    stateManager: StateManager,
    vault: Vault,
    csvWriteQueue: CSVWriteQueue
  ) {
    super(leaf);
    this.plugin = plugin;
    this.stateManager = stateManager;
    this.vault = vault;
    this.csvWriteQueue = csvWriteQueue;
  }

  getViewType(): string {
    return VIEW_TYPE_QUIZ;
  }

  getDisplayText(): string {
    return "刷题啊";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    // V3: 防止同窗口双实例竞态（快速连点 ribbon 时 registerView 的守卫可能失效）。
    // 已有一个实例在运行时，把自己 detach 掉，避免两个实例互相覆盖进度。
    if (QuizView.openViewCount > 0) {
      if (this.leaf.parent) this.leaf.detach();
      return;
    }
    QuizView.openViewCount++;
    this.counted = true;

    this.contentEl.addClass("csv-quiz-container");
    this.contentEl.empty();
    this.buildLayout();

    await this.initializeFromState();
  }

  async onClose(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.counted) {
      QuizView.openViewCount--;
      this.counted = false;
    }
    this.cancelAutoNext();
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    // 4B: 面板关闭停止活跃备份定时器
    this.backupTimer.stop();
    this.stateManager.cancelScheduledSave();
    // 练习模式为临时会话：关闭前恢复常规位置，避免保存练习内的索引
    this.exitRandomPractice();
    this.exitMemoryPractice();
    if (this.textFilterTimer !== null) {
      window.clearTimeout(this.textFilterTimer);
      this.textFilterTimer = null;
    }
    if (this.stateManager.getState() && this.canPersistState) {
      const state = this.buildCurrentState();
      try {
        await this.stateManager.saveStateImmediately(state);
        // F4: 保存后同步脏检查基准，保证 lastSavedState 反映已落盘状态
        this.lastSavedState = this.snapshotState(state);
      } catch (e: unknown) {
        // T1: 保存失败不阻断 onClose 后续清理（csvWriteQueue.drain 仍须执行）
        console.error("CSV Quiz: Failed to save state on close", e);
        new Notice("进度保存失败，请检查题库状态文件");
      }
    }
    await this.csvWriteQueue.drain();
  }

  private buildLayout(): void {
    this.contentEl.empty();

    // 滑动切题：同步 data-ignore-swipe 屏蔽 Obsidian 原生手势（值须为字面量 "true"）
    this.syncSwipeNavigation();
    // 手势监听只注册一次（buildLayout 仅在 onOpen 调用一次；registerDomEvent 随视图卸载自动清理，守卫防止重复注册）
    if (!this.swipeBound) {
      this.swipeBound = true;
      this.registerDomEvent(
        this.contentEl,
        "touchstart",
        (e: TouchEvent) => this.handleSwipeStart(e),
        { capture: true, passive: true }
      );
      this.registerDomEvent(
        this.contentEl,
        "touchmove",
        (e: TouchEvent) => this.handleSwipeMove(e),
        { capture: true, passive: false }
      );
      this.registerDomEvent(
        this.contentEl,
        "touchend",
        (e: TouchEvent) => this.handleSwipeEnd(e),
        { capture: true, passive: true }
      );
      // M-1: 手势被系统取消时复位状态机，避免残留污染后续点击
      this.registerDomEvent(
        this.contentEl,
        "touchcancel",
        () => {
          this.swipeActive = false;
          this.swipeDecided = false;
        },
        { capture: true }
      );
    }

    // Progress & stats
    const infoBar = this.contentEl.createDiv("csv-quiz-info-bar");
    // 左侧组：图标 + 进度文本 紧贴对齐
    const leftGroup = infoBar.createDiv("csv-quiz-info-left");
    leftGroup.createSpan({
      text: "📋",
      cls: "csv-quiz-progress-icon",
    });
    this.progressEl = leftGroup.createDiv(
      "csv-quiz-progress csv-quiz-progress-clickable"
    );
    this.statsEl = infoBar.createDiv("csv-quiz-stats");
    // 点击进度文本打开刷题进度弹窗（列表顺序/筛选与当前视图一致）
    this.progressEl.addEventListener("click", () => this.openProgressModal());

    // Question area
    this.questionArea = this.contentEl.createDiv("csv-quiz-question-area");

    // Feedback area
    this.feedbackArea = this.contentEl.createDiv("csv-quiz-feedback");

    // Checkbox area for favorite/mastered/repeat/wrong
    this.checkboxArea = this.contentEl.createDiv("csv-quiz-checkbox-area");

    // Read-only tags/categories
    this.readOnlyArea = this.contentEl.createDiv("csv-quiz-readonly-area");

    // Navigation area
    this.navigationArea = this.contentEl.createDiv("csv-quiz-nav");

    // Bottom bar: next unanswered + question number
    this.bottomBar = this.contentEl.createDiv("csv-quiz-bottom-bar");

    // Filter panel
    this.filterContainer = this.contentEl.createDiv(
      "csv-quiz-filter-panel"
    );

    // Edit area (collapsible inputs) — moved below filter
    this.editArea = this.contentEl.createDiv("csv-quiz-edit-area");

    // Bottom spacer to avoid iOS toolbar overlap
    this.contentEl.createDiv("csv-quiz-bottom-spacer");

    // 键盘导航：左右方向键切换上/下一题
    this.contentEl.setAttribute("tabindex", "-1");
    this.registerDomEvent(this.contentEl, "click", (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(
          "a, button, input, textarea, select, label, [contenteditable]"
        )
      ) {
        return;
      }
      this.contentEl.focus();
    });
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      // 已答题显示答案时 answering=true 但方向键切题应恢复（与 handleSwipeEnd 口径统一）；
      // 仅真正作答中（未显示答案）或导航切换中才拦截键盘导航
      if ((this.answering && !this.showingAnswer) || this.navigating) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active) return;
      const focusedInPanel =
        active === this.contentEl || this.contentEl.contains(active);
      if (!focusedInPanel) return;
      // 焦点在可编辑元素内时放行，避免干扰输入
      if (
        active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.isContentEditable ||
        active.closest("[contenteditable]")
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        void this.prevQuestion();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        void this.nextQuestion();
      }
    });
  }

  private async initializeFromState(): Promise<void> {
    // M2: 记录本次加载世代号（新流程开始会自增，使本流程过期）
    const epoch = ++this.loadEpoch;
    // M5b: 使用内存中的最新设置（设置面板修改已写入内存并排队落盘），
    // 避免读到尚未落盘的旧磁盘设置导致竞态。settings 已由 main 的 loadSettings 加载，
    // 不再调用 loadPluginData（外部修改检测留到阶段 3 处理）。
    const settings = this.getSettings();
    this.csvPath = settings.csvPath;

    // 3A: 捕获加载前的内存进度（用于 sidecar 外部修改检测；loadSidecar 会覆盖 currentState）
    const inMemoryState = this.stateManager.getState();
    // M6: 一并捕获内存 meta 覆盖层（选择「使用当前」时恢复，避免本地未落盘 meta 丢失）
    const inMemoryMeta = this.stateManager.getMeta();

    // Build filter panel
    this.buildFilterPanel(settings);

    // 在任何弹窗 await 之前清空内存进度：若用户在弹窗期间关闭标签页，
    // onClose() 会因 getState() 为 null 而跳过保存，避免用默认值覆盖磁盘进度。
    // 成功加载路径末尾的 saveState() 会重新设置正确的 currentState。
    this.stateManager.setState(null);

    // 载入题库（loadQuestions 内部含 id 质量门槛：空/重复题号拒绝加载）
    const status = await this.loadQuestions();
    // V2: 加载期间视图被关闭 → 中止
    if (this.isClosed) return;
    // M2: 期间已开始新加载流程 → 本流程过期，丢弃结果
    if (epoch !== this.loadEpoch) return;
    if (status !== "ok") {
      // sidecar 化后无可恢复的磁盘 state，筛选恢复逻辑已移除，直接跳过
      this.startAutoSave();
      return;
    }

    // 载入当前题库的 sidecar 状态（缺失时初始化空状态，含 defaultFilter* 默认筛选）
    const loadResult = await this.stateManager.loadSidecar(this.csvPath, {
      favorite: settings.defaultFilterFavorite,
      mastered: settings.defaultFilterMastered,
      repeat: settings.defaultFilterRepeat,
      wrong: settings.defaultFilterWrong,
    });
    // V2: 加载期间视图被关闭 → 中止
    if (this.isClosed) return;
    // M2: 期间已开始新加载流程 → 本流程过期，丢弃结果
    if (epoch !== this.loadEpoch) return;
    if (loadResult.status === "corrupt") {
      // 级联损坏：不自动清空，提示用户重建（可手动重置或删除状态文件）
      this.showError("状态文件与备份均损坏，请重置刷题进度或删除状态文件后重试");
      this.canPersistState = false;
      return;
    }

    // 3A: sidecar 外部修改检测——内存状态（若与当前题库同源）与 sidecar 加载结果
    // 不一致时弹窗选择（复用「使用当前 / 使用外部」模式，仅存储对象换为 sidecar）。
    // M6: 条件扩展为 state 或 meta 任一不一致；选择 current 时 state 与 meta 一并恢复。
    let effectiveState: QuizSessionState = loadResult.state;
    if (
      inMemoryState &&
      this.stateManager.getContentPath() === this.csvPath &&
      inMemoryState.csvPath === this.csvPath
    ) {
      const loaded = this.stateManager.getState();
      const metaDiffers =
        JSON.stringify(inMemoryMeta) !==
        JSON.stringify(this.stateManager.getMeta());
      if (loaded && (!quizStateEquals(inMemoryState, loaded) || metaDiffers)) {
        // 关闭面板随即重开：onClose 的异步写盘可能尚未落盘（磁盘滞后于内存），
        // 此时内存与磁盘不一致属正常竞态而非外部修改。距上次本插件写盘 < 1.5s
        // 时直接信任内存状态并写盘同步，避免误报。
        const justSaved = Date.now() - this.stateManager.lastPersistAt < 1500;
        let useInMemory = justSaved;
        if (!justSaved) {
          const choice = await this.askExternalModificationChoice(false);
          if (this.isClosed) return;
          // M2: 弹窗期间已开始新加载流程 → 中止
          if (epoch !== this.loadEpoch) return;
          if (choice === "current") {
            useInMemory = true;
          } else if (choice === "external") {
            // 已加载 sidecar 状态，保持
          } else {
            // 用户取消：禁止后续写盘，避免空状态覆盖外部进度。
            // （弹窗前虽已 setState(null)，但 loadSidecar 已重新设置 currentState，
            //  若不清 canPersistState，onClose 会用实例默认值（空状态）覆盖外部 sidecar）
            this.canPersistState = false;
            this.showError("已取消加载题库。请重新打开刷题面板。");
            return;
          }
        }
        if (useInMemory) {
          // 用内存状态覆盖并保存；meta 逐字段恢复（getMeta 返回内部引用，无法整体替换）
          this.stateManager.setState(inMemoryState);
          this.restoreMetaFrom(inMemoryMeta);
          await this.stateManager.saveStateImmediately(inMemoryState);
          // M2: 落盘期间已开始新加载流程 → 中止
          if (epoch !== this.loadEpoch) return;
          effectiveState = inMemoryState;
        }
      }
    }

    // 对齐清理 sidecar meta 中已不存在于题库的僵尸条目（替换产物后 id 变化时）
    this.pruneMetaEntries();

    // 把 sidecar meta 覆盖层的 B/C 类字段合并到题目（meta 优先，永久遮蔽语义）
    this.applyMetaToQuestions();

    // 恢复进度或首次使用（sidecar 无 csvPath，stateFromSidecar 已补为 contentPath，恒匹配）
    if (effectiveState.csvPath === this.csvPath) {
      this.applyRestore(settings, effectiveState);
    } else {
      this.applyFreshStart(settings, effectiveState);
    }
    this.updateFilterUI();
    this.renderQuestion();
    // M2: saveState 前最后检查，防止过期流程写入已切换的题库
    if (epoch !== this.loadEpoch) return;
    this.saveState();
    this.startAutoSave();
    // 3D: 状态栏立即刷新为新题库的待复习数
    (this.plugin as unknown as { refreshMemoryReminder?: () => void })
      .refreshMemoryReminder?.();
  }

  /** Read and parse the content source. Returns "ok", "empty" (no questions), or "error". */
  private async loadQuestions(): Promise<"ok" | "empty" | "error"> {
    try {
      const questions = await this.readQuestionsFromSource();
      if (!questions) {
        // 读取失败：readQuestionsFromSource 已提示
        this.canPersistState = false;
        return "error";
      }
      this.allQuestions = questions;
      // id 质量门槛：空/重复题号拒绝加载（保护已有 sidecar 状态不被错位覆盖）
      const { emptyIds, duplicateIds } = checkIdQuality(this.allQuestions);
      if (emptyIds.length > 0 || duplicateIds.length > 0) {
        this.canPersistState = false;
        const parts: string[] = [];
        if (emptyIds.length > 0) parts.push(`空题号 ${emptyIds.length} 个`);
        if (duplicateIds.length > 0) {
          parts.push(
            `重复题号: ${duplicateIds.slice(0, 5).join(", ")}${duplicateIds.length > 5 ? "…" : ""}`
          );
        }
        this.showError(`题库存在${parts.join("、")}，请修改 CSV 后重试`);
        return "error";
      }
      if (this.allQuestions.length === 0) {
        this.canPersistState = false;
        this.showError("题库文件中没有找到题目数据");
        return "empty";
      }
      this.canPersistState = true;
      // 3B: 内容源 mtime 变更检测——首次加载只记录；再次加载（refresh/重开）对比，
      // 变化则提示。id 对齐由 applyMetaToQuestions 天然处理（新题库不存在的 meta 无效果）。
      const stat = await this.vault.adapter.stat(this.csvPath);
      const newMtime = stat?.mtime ?? null;
      if (
        this.contentMtimeMs !== null &&
        newMtime !== null &&
        newMtime !== this.contentMtimeMs
      ) {
        new Notice("题库文件已更新，状态已按题目对齐");
      }
      this.contentMtimeMs = newMtime;
      return "ok";
    } catch (e: unknown) {
      this.canPersistState = false;
      console.error("CSV Quiz: Failed to load questions", e);
      this.showError(`无法加载题库文件: ${e instanceof Error ? e.message : String(e)}`);
      return "error";
    }
  }

  /**
   * 按内容源类型读取题目：.cqv 走二进制解码（decodeCqv 含四重解析防御），
   * 其余按 CSV（readCSVFile + parseCSV）。失败返回 null（已 showError 提示）。
   */
  private async readQuestionsFromSource(): Promise<Question[] | null> {
    if (this.csvPath.toLowerCase().endsWith(".cqv")) {
      try {
        const buf = await this.vault.adapter.readBinary(this.csvPath);
        const result = decodeCqv(buf);
        return result.questions;
      } catch (e: unknown) {
        console.error("CSV Quiz: Failed to load .cqv", e);
        this.showError(
          `无法加载题库产物: ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }
    }
    try {
      const csvContent = await readCSVFile(this.vault, this.csvPath);
      return parseCSV(csvContent);
    } catch (e: unknown) {
      console.error("CSV Quiz: Failed to load CSV", e);
      this.showError(`无法加载 CSV 文件: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * 清理 sidecar meta 中已不存在于题库的僵尸条目（替换产物/CSV 后 id 变化时）。
   * getMeta() 返回内部引用，delete 后调度保存落盘。
   */
  private pruneMetaEntries(): void {
    const ids = new Set(this.allQuestions.map((q) => q.id));
    const meta = this.stateManager.getMeta();
    let changed = false;
    for (const k of Object.keys(meta)) {
      if (!ids.has(k)) {
        delete meta[k];
        changed = true;
      }
    }
    if (changed) {
      const st = this.stateManager.getState();
      if (st) this.stateManager.scheduleSave(st, 0);
    }
  }

  /** 把 sidecar meta 覆盖层的 B/C 类字段合并到 allQuestions（meta 优先，永久遮蔽语义）。 */
  private applyMetaToQuestions(): void {
    const meta = this.stateManager.getMeta();
    for (const q of this.allQuestions) {
      const m = meta[q.id];
      if (!m) continue;
      if (m.favorite !== undefined) q.favorite = m.favorite;
      if (m.mastered !== undefined) q.mastered = m.mastered;
      if (m.wrong !== undefined) q.wrong = m.wrong;
      if (m.repeat !== undefined) q.repeat = m.repeat;
      if (m.tags !== undefined) q.tags = m.tags;
      if (m.category1 !== undefined) q.category1 = m.category1;
      if (m.category2 !== undefined) q.category2 = m.category2;
      if (m.category3 !== undefined) q.category3 = m.category3;
    }
  }

  /**
   * 把题目的指定 B/C 类状态字段写入 sidecar meta（不再写 CSV）。无失败路径（内存操作 + 调度保存）。
   * 只写调用方明确修改过的字段，避免内容源默认值被烘焙进覆盖层（永久遮蔽误触发 + 导出反向覆盖作者更新）。
   */
  private saveQuestionMeta(
    question: Question,
    fields: Array<
      | "repeat"
      | "tags"
      | "category1"
      | "category2"
      | "category3"
      | "favorite"
      | "mastered"
      | "wrong"
    >
  ): void {
    for (const f of fields) {
      this.stateManager.setMetaField(question.id, f, question[f]);
    }
  }

  /**
   * M6: 把内存中捕获的 meta 覆盖层逐字段写回 StateManager。
   * getMeta() 返回内部引用无法整体替换，故逐条 setMetaField 重建；
   * 磁盘上有而内存中不存在的条目保留（外部新增），内存有而磁盘无的条目会被写回。
   */
  private restoreMetaFrom(source: Record<string, SidecarMeta>): void {
    for (const [id, entry] of Object.entries(source)) {
      if (!entry) continue;
      for (const [field, value] of Object.entries(entry) as Array<
        [keyof SidecarMeta, string]
      >) {
        if (value !== undefined) {
          this.stateManager.setMetaField(id, field, value);
        }
      }
    }
  }

  /** Fresh start: keep filters from savedState if present (else defaults), reset progress. */
  private applyFreshStart(
    settings: PluginSettings,
    savedState: QuizSessionState | null
  ): void {
    if (savedState) {
      this.filterText = savedState.filterText || "";
      this.filterTags = savedState.filterTags || "";
      this.filterCat1 = savedState.filterCat1 || "";
      this.filterCat2 = savedState.filterCat2 || "";
      this.filterCat3 = savedState.filterCat3 || "";
      this.filterFavorite = savedState.filterFavorite || "";
      this.filterMastered = savedState.filterMastered || "";
      this.filterRepeat = savedState.filterRepeat || "";
      this.filterWrong = savedState.filterWrong || "";
      this.filterUnanswered = savedState.filterUnanswered || "";
    } else {
      const s = this.getSettings();
      this.filterFavorite = s.defaultFilterFavorite;
      this.filterMastered = s.defaultFilterMastered;
      this.filterRepeat = s.defaultFilterRepeat;
      this.filterWrong = s.defaultFilterWrong;
      this.filterUnanswered = "";
    }

    this.displayOrder = buildDisplayOrder(this.allQuestions, settings.randomOrder);
    this.orderedQuestions = sortByDisplayOrder(this.allQuestions, this.displayOrder);
    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    this.currentIndex = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.answeredQuestions = {};
    this.memoryCards = {};
    this.memoryNewDate = "";
    this.memoryNewCountToday = 0;
    this.memoryPendingNew = [];
    this.memoryInitialized = false;
    this.currentShuffledQId = null;
    this.selectedOption = null;
    this.selectedOptions = [];
  }

  /** Restore a full session state whose csvPath matches the current CSV. */
  private applyRestore(
    settings: PluginSettings,
    savedState: QuizSessionState
  ): void {
    this.filterText = savedState.filterText || "";
    this.filterTags = savedState.filterTags || "";
    this.filterCat1 = savedState.filterCat1 || "";
    this.filterCat2 = savedState.filterCat2 || "";
    this.filterCat3 = savedState.filterCat3 || "";
    this.filterFavorite = savedState.filterFavorite || "";
    this.filterMastered = savedState.filterMastered || "";
    this.filterRepeat = savedState.filterRepeat || "";
    this.filterWrong = savedState.filterWrong || "";
    this.filterUnanswered = savedState.filterUnanswered || "";

    this.displayOrder = buildDisplayOrder(
      this.allQuestions,
      settings.randomOrder,
      savedState.displayOrder
    );
    this.orderedQuestions = sortByDisplayOrder(this.allQuestions, this.displayOrder);
    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);

    this.currentIndex = Math.min(
      savedState.currentIndex,
      this.filteredQuestions.length - 1
    );
    if (this.currentIndex < 0) this.currentIndex = 0;

    this.correctCount = savedState.correctCount;
    this.wrongCount = savedState.wrongCount;
    this.answeredQuestions = savedState.answeredQuestions || {};
    this.memoryCards = savedState.memoryCards || {};
    // M1: 每日新题配额跨会话恢复
    this.memoryNewDate = savedState.memoryNewDate || "";
    this.memoryNewCountToday = savedState.memoryNewCountToday || 0;
    // A1: 当日已选未答的新题 id 跨会话恢复
    this.memoryPendingNew = savedState.memoryPendingNew || [];
    // C-1: 记忆练习初始化标记跨会话恢复
    this.memoryInitialized = !!savedState.memoryInitialized;
    // M4: 清理题库中已不存在的僵尸记忆卡片（applyRestore 在 loadQuestions 之后调用，allQuestions 已填充）
    this.pruneMemoryCards();
  }

  /** 清理题库中已不存在的僵尸记忆卡片（CSV 删题后保持计数一致）。 */
  private pruneMemoryCards(): void {
    const ids = new Set(this.allQuestions.map((q) => q.id));
    let changed = false;
    for (const k of Object.keys(this.memoryCards)) {
      if (!ids.has(k)) {
        delete this.memoryCards[k];
        changed = true;
      }
    }
    if (changed) {
      void this.stateManager.saveStateImmediately(this.buildCurrentState());
      // A2: 清理僵尸卡后立即刷新状态栏提醒（实际实例为 CSVQuizPlugin，故 cast 调用）
      (this.plugin as unknown as { refreshMemoryReminder?: () => void })
        .refreshMemoryReminder?.();
    }
  }

  /** Periodic auto-save every 5s to protect against sudden app close. */
  private startAutoSave(): void {
    // V2: 视图已关闭时不再启动心跳（onClose 只执行一次，关闭后重启的心跳将无法被清除）
    if (this.isClosed) return;
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
    }
    this.autoSaveTimer = window.setInterval(() => {
      // V2: 关闭后残留的心跳（若有）不得再写盘
      if (!this.isClosed && this.canPersistState && this.stateManager.getState()) {
        // F4: 心跳脏检查——状态未变化时跳过写盘，避免 5 秒无条件全量写 data.json
        const state = this.buildCurrentState();
        if (
          this.lastSavedState !== null &&
          quizStateEquals(state, this.lastSavedState)
        ) {
          return;
        }
        this.lastSavedState = this.snapshotState(state);
        this.stateManager.scheduleSave(state, 0);
      }
    }, 5000);
    // 4B: 面板活跃期间每 30 分钟备份当前 sidecar 到 .bak
    // （BackupTimer.start 内部先 stop 再 start，refresh 重复调用安全）
    this.backupTimer.start(() => {
      void this.stateManager.backupCurrentSidecar();
    }, 30 * 60 * 1000);
  }

  /** Ask the user whether to keep the in-memory progress or the externally-modified one. */
  private async askExternalModificationChoice(
    diskIsEmpty: boolean
  ): Promise<"current" | "external" | null> {
    const modal = new ChoiceModal(this.app, {
      title: "检测到刷题进度被外部修改",
      message:
        "刷题进度数据（题库状态文件）已被外部编辑或同步，与当前进度不一致。请选择要使用的进度。",
      options: [
        {
          label: "使用当前进度",
          value: "current",
          description: "使用本次会话中内存里保留的进度",
          cta: true,
        },
        {
          label: diskIsEmpty ? "使用外部进度（已清空）" : "使用外部修改的进度",
          value: "external",
          description: "使用外部修改后的进度数据",
        },
      ],
    });
    modal.open();
    const res = await modal.promise;
    if (res === "current") return "current";
    if (res === "external") return "external";
    return null;
  }

  /**
   * 当前题库是否已载入「有实际进度」的状态（用于切换确认判断）。
   * 无状态/新题库首次使用（空计数、无答题记录、无 meta 覆盖）直接切换不弹确认。
   */
  hasLoadedState(): boolean {
    if (!this.canPersistState) return false;
    const st = this.stateManager.getState();
    if (!st) return false;
    return (
      Object.keys(st.answeredQuestions).length > 0 ||
      (st.correctCount ?? 0) > 0 ||
      (st.wrongCount ?? 0) > 0 ||
      // L2: 纯记忆练习进度（有卡片但无答题记录/计数）也视为「有状态」，切换弹确认
      Object.keys(st.memoryCards || {}).length > 0 ||
      Object.keys(this.stateManager.getMeta()).length > 0
    );
  }

  /** 轻量确认弹窗：信息性确认防误切（确认后才切换题库）。 */
  async confirmQuizSwitch(newPath: string): Promise<boolean> {
    const modal = new ChoiceModal(this.app, {
      title: "切换题库",
      message: `当前题库的进度已保存，确定切换到「${newPath}」吗？`,
      options: [
        { label: "确认切换", value: "confirm", cta: true },
        { label: "取消", value: "cancel" },
      ],
    });
    modal.open();
    const res = await modal.promise;
    return res === "confirm";
  }

  private buildFilterPanel(settings: PluginSettings): void {
    this.filterContainer.empty();

    const toggleHeader = this.filterContainer.createDiv(
      "csv-quiz-filter-toggle"
    );
    const toggleIcon = toggleHeader.createSpan("csv-quiz-filter-icon");
    toggleHeader.createEl("span", { text: "筛选条件" });

    const panelOpen = settings.filterPanelOpen;
    const filterBody = this.filterContainer.createDiv(
      "csv-quiz-filter-body"
    );

    toggleHeader.addEventListener("click", () => {
      const isHidden = filterBody.classList.contains("csv-quiz-filter-body-hidden");
      filterBody.classList.toggle("csv-quiz-filter-body-hidden");
      toggleIcon.textContent = isHidden ? "▼" : "▶";
    });

    filterBody.classList.toggle("csv-quiz-filter-body-hidden", !panelOpen);
    toggleIcon.textContent = panelOpen ? "▼" : "▶";

    // Free-text filter: 匹配题干与选项（子串包含，不区分大小写）
    const textRow = filterBody.createDiv("csv-quiz-filter-row");
    textRow.createEl("label", { text: "文本: ", cls: "csv-quiz-filter-label" });
    this.filterTextInput = textRow.createEl("input", {
      type: "text",
      cls: "csv-quiz-input csv-quiz-filter-text-input",
      attr: { placeholder: "匹配题干与选项" },
    });
    this.filterTextInput.value = this.filterText;
    this.filterTextInput.addEventListener("input", () => {
      this.scheduleTextFilter();
    });

    // Tag filter
    const tagRow = filterBody.createDiv("csv-quiz-filter-row");
    tagRow.createEl("label", { text: "标签: ", cls: "csv-quiz-filter-label" });
    this.tagsContainer = tagRow.createDiv("csv-quiz-tags-container");

    // Category filters placeholder - will be populated after CSV load
    const catRow = filterBody.createDiv("csv-quiz-filter-row");
    catRow.createEl("label", { text: "分类: ", cls: "csv-quiz-filter-label" });

    const catSelectors = catRow.createDiv("csv-quiz-filter-selectors");
    this.cat1Select = catSelectors.createEl("select", {
      cls: "csv-quiz-select csv-quiz-filter-select",
    });
    this.cat2Select = catSelectors.createEl("select", {
      cls: "csv-quiz-select csv-quiz-filter-select",
    });
    this.cat3Select = catSelectors.createEl("select", {
      cls: "csv-quiz-select csv-quiz-filter-select",
    });

    this.cat1Select.addEventListener("change", () => {
      void this.saveCurrentEdit().then(() => {
        this.filterCat1 = this.cat1Select.value;
        this.applyFiltersAndReset();
      });
    });
    this.cat2Select.addEventListener("change", () => {
      void this.saveCurrentEdit().then(() => {
        this.filterCat2 = this.cat2Select.value;
        this.applyFiltersAndReset();
      });
    });
    this.cat3Select.addEventListener("change", () => {
      void this.saveCurrentEdit().then(() => {
        this.filterCat3 = this.cat3Select.value;
        this.applyFiltersAndReset();
      });
    });

    // Boolean filters row
    const boolRow = filterBody.createDiv("csv-quiz-filter-row");
    boolRow.createEl("label", { text: "标记: ", cls: "csv-quiz-filter-label" });
    const boolFilters = [
      { key: "filterFavorite", label: "收藏", value: this.filterFavorite },
      { key: "filterMastered", label: "掌握", value: this.filterMastered },
      { key: "filterRepeat", label: "重复", value: this.filterRepeat },
      { key: "filterWrong", label: "错题", value: this.filterWrong },
      { key: "filterUnanswered", label: "未答", value: this.filterUnanswered },
    ];
    for (const bf of boolFilters) {
      const group = boolRow.createSpan({ cls: "csv-quiz-bool-group" });
      group.createSpan({ text: bf.label, cls: "csv-quiz-bool-label" });

      const posChip = group.createEl("span", {
        text: "是",
        cls: "csv-quiz-bool-chip" + (bf.value === "1" ? " csv-quiz-bool-chip-active" : ""),
        attr: { "data-bool-key": bf.key, "data-bool-val": "1" },
      });
      posChip.addEventListener("click", () => {
        void this.toggleBoolFilter(bf.key, "1");
      });

      const negChip = group.createEl("span", {
        text: "否",
        cls: "csv-quiz-bool-chip" + (bf.value === "0" ? " csv-quiz-bool-chip-active csv-quiz-bool-chip-inverse" : ""),
        attr: { "data-bool-key": bf.key, "data-bool-val": "0" },
      });
      negChip.addEventListener("click", () => {
        void this.toggleBoolFilter(bf.key, "0");
      });
    }

    // 随机练习：按当前筛选条件随机选未答题（最多 100 道，不足自适应）
    const practiceRow = filterBody.createDiv("csv-quiz-filter-row");
    this.practiceBtn = practiceRow.createEl("button", {
      text: "🎲 随机练习（100 题）",
      cls: "csv-quiz-btn csv-quiz-btn-sm csv-quiz-practice-btn",
    });
    this.practiceBtn.addEventListener("click", () => {
      this.toggleRandomPractice();
    });
    this.practiceCountEl = practiceRow.createSpan({
      cls: "csv-quiz-practice-count",
    });

    // 记忆练习：FSRS 间隔重复，到期题优先 + 每日新题（受当前筛选影响）。
    // M3: memoryEnabled 关闭时不创建按钮（memoryBtn 保持 undefined，updatePracticeButton 已有保护）
    if (settings.memoryEnabled) {
      this.memoryBtn = practiceRow.createEl("button", {
        text: "🧠 记忆练习",
        cls: "csv-quiz-btn csv-quiz-btn-sm csv-quiz-practice-btn",
      });
      this.memoryBtn.addEventListener("click", () => {
        this.toggleMemoryPractice();
      });
      this.memoryCountEl = practiceRow.createSpan({
        cls: "csv-quiz-practice-count",
      });
    }
  }

  private cat1Select!: HTMLSelectElement;
  private cat2Select!: HTMLSelectElement;
  private cat3Select!: HTMLSelectElement;
  private tagsContainer!: HTMLElement;
  private filterTextInput!: HTMLInputElement;
  private textFilterTimer: number | null = null;
  private practiceBtn!: HTMLButtonElement;
  private practiceCountEl!: HTMLElement;
  private memoryBtn!: HTMLButtonElement;
  private memoryCountEl!: HTMLElement;
  /** 随机练习模式：练习集为临时会话，不持久化，重开面板回到常规模式。 */
  private practiceActive: boolean = false;
  private practiceIds: string[] = [];
  /** 进入练习前的常规模式定位题号，退出时据此恢复位置。 */
  private practiceFocusId: string | null = null;
  /** 记忆练习模式：练习集为临时会话，不持久化，重开面板回到常规模式。 */
  private memoryActive: boolean = false;
  private memoryIds: string[] = [];
  /** 记忆练习的记忆卡片（题 id → 卡片），随答题进度一起持久化。 */
  private memoryCards: Record<string, MemoryCard> = {};
  /** 防双开：首次重置确认框 await 期间禁止重复进入（M2）。 */
  private memoryEnabling: boolean = false;
  /** 每日新题配额：最近一次启用记忆练习的自然日（本地日期 "YYYY-MM-DD"）。 */
  private memoryNewDate: string = "";
  /** 每日新题配额：当日已取的新题数量。 */
  private memoryNewCountToday: number = 0;
  /** 当日已选取但尚未作答的新题 id（退出再进仍保留，不重复扣配额）。 */
  private memoryPendingNew: string[] = [];
  /** 记忆练习是否已初始化过（至少判分一次）；仅删除记忆卡片时保留，避免重复触发首次启用重置提示。 */
  private memoryInitialized: boolean = false;
  /** 练习模式内本次会话已答的题 id 集合（练习内已答判断/渲染/计数均基于它）。 */
  private practiceAnswered: Set<string> = new Set();
  /** 练习模式本次会话的答题统计（不累加全局统计） */
  private practiceCorrect: number = 0;
  private practiceWrong: number = 0;
  /** 记忆练习集中每题的来源（复习/新题），用于题目页眉显著标注。 */
  private practiceSource: Record<string, "new" | "review"> = {};
  /** 记忆卡片信息栏折叠状态（默认收起，仅影响本栏显示，不重渲染题目）。 */
  private cardPanelOpen: boolean = false;
  /** 滑动切题手势状态 */
  private swipeX0: number = 0;
  private swipeY0: number = 0;
  private swipeActive: boolean = false;
  private swipeDecided: boolean = false;
  private swipeHorizontal: boolean = false;
  private swipeLastTrigger: number = 0;
  private swipeBound: boolean = false;
  /** L4: 刷题进度弹窗是否已打开（防重入：连续点击不重复弹窗）。 */
  private progressModalOpen: boolean = false;

  private updateFilterUI(): void {
    if (!this.cat1Select) return;

    const cats = getUniqueCategories(this.allQuestions);

    this.populateSelect(this.cat1Select, cats.cat1, this.filterCat1);
    this.populateSelect(this.cat2Select, cats.cat2, this.filterCat2);
    this.populateSelect(this.cat3Select, cats.cat3, this.filterCat3);

    if (this.filterTextInput) {
      this.filterTextInput.value = this.filterText;
    }

    this.populateTagChips();

    this.syncBoolChips();

    this.updatePracticeButton();
  }

  /** 自由文本筛选：输入防抖 200ms 后应用（与其它筛选一致的 applyFiltersAndReset 行为）。 */
  private scheduleTextFilter(): void {
    if (this.textFilterTimer !== null) {
      window.clearTimeout(this.textFilterTimer);
    }
    this.textFilterTimer = window.setTimeout(() => {
      // 回调不得返回 Promise（setTimeout 期望 void 回调），用 IIFE + void 包裹
      void (async () => {
        this.textFilterTimer = null;
        if (this.isClosed) return;
        try {
          // F5: 先保存编辑区未提交的标签/分类修改，避免筛选时静默丢失。
          // saveCurrentEdit 无变化时立即返回；有变化时写 CSV 并 reFilter，
          // 之后 applyFiltersAndReset 会再以新 filterText 重筛（与其它筛选入口一致）。
          await this.saveCurrentEdit();
        } catch (e) {
          // L-1: 捕获保存失败，避免 setTimeout 回调产生未处理的 Promise rejection
          console.error("CSV Quiz: 文本筛选前保存编辑失败", e);
          return;
        }
        if (this.isClosed) return;
        this.filterText = this.filterTextInput.value;
        this.applyFiltersAndReset();
      })();
    }, 200);
  }

  private syncBoolChips(): void {
    const chips = this.filterContainer?.querySelectorAll<HTMLElement>(".csv-quiz-bool-chip");
    if (!chips) return;
    const map: Record<string, string> = {
      filterFavorite: this.filterFavorite,
      filterMastered: this.filterMastered,
      filterRepeat: this.filterRepeat,
      filterWrong: this.filterWrong,
      filterUnanswered: this.filterUnanswered,
    };
    Array.from(chips).forEach((chip) => {
      const key = chip.getAttribute("data-bool-key") || "";
      const val = chip.getAttribute("data-bool-val") || "";
      const active = map[key] === val;
      chip.classList.toggle("csv-quiz-bool-chip-active", active);
      chip.classList.toggle("csv-quiz-bool-chip-inverse", active && val === "0");
    });
  }

  private async toggleBoolFilter(key: string, val: string): Promise<void> {
    await this.saveCurrentEdit();
    const self = this as unknown as Record<string, string>;
    self[key] = self[key] === val ? "" : val;
    this.syncBoolChips();
    this.applyFiltersAndReset();
  }

  /** 随机练习：按当前筛选条件筛出未答题，随机取最多 100 道作为练习集（不足自适应）。 */
  private enableRandomPractice(): void {
    // F3: 记忆练习确认弹窗 await 期间禁止进入随机练习，避免双模式并存
    if (this.practiceActive || this.memoryEnabling) return;
    // 进入任一练习模式前互斥退出另一个
    if (this.memoryActive) this.exitMemoryPractice();

    const pool = this.applyFiltersTo(this.orderedQuestions);
    const unanswered = pool.filter(
      (q) => this.answeredQuestions[q.id] === undefined
    );
    if (unanswered.length === 0) {
      new Notice("没有未答题，无法开始随机练习");
      return;
    }

    const picked = shuffle(unanswered).slice(0, 100);
    this.practiceFocusId = this.filteredQuestions[this.currentIndex]?.id ?? null;
    this.practiceIds = picked.map((q) => q.id);
    this.practiceActive = true;
    // 练习内已答集合：本次会话从零开始
    this.practiceAnswered = new Set();
    this.practiceCorrect = 0;
    this.practiceWrong = 0;
    // 练习集即当前显示列表（已随机序），常规 displayOrder/筛选/进度原样保留
    this.filteredQuestions = picked;
    this.currentIndex = 0;
    this.currentShuffledQId = null;
    this.cancelAutoNext();
    this.renderQuestion();
    this.saveState();
    new Notice(`随机练习开始：${picked.length} 题`);
  }

  /** 退出练习模式：恢复常规筛选结果并定位到进入前的位置。不渲染、不保存，由调用方决定。 */
  private exitRandomPractice(): void {
    if (!this.practiceActive) return;
    this.practiceActive = false;
    this.practiceIds = [];
    this.practiceAnswered.clear();

    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    if (this.practiceFocusId) {
      const idx = this.filteredQuestions.findIndex(
        (q) => q.id === this.practiceFocusId
      );
      if (idx >= 0) {
        this.currentIndex = idx;
      } else if (this.filteredQuestions.length > 0) {
        this.currentIndex = 0;
      } else {
        this.currentIndex = -1;
      }
    } else {
      this.currentIndex = this.filteredQuestions.length > 0 ? 0 : -1;
    }
    this.practiceFocusId = null;
    this.currentShuffledQId = null;
    this.cancelAutoNext();
  }

  private toggleRandomPractice(): void {
    if (this.practiceActive) {
      this.exitRandomPractice();
      this.renderQuestion();
      this.saveState();
      new Notice("已退出随机练习");
    } else {
      this.enableRandomPractice();
    }
  }

  /**
   * 记忆练习：到期题（FSRS due 已到）按紧迫度优先 + 每日新题（随机取），
   * 均受当前筛选条件影响。练习集为临时会话，不持久化。
   */
  private async enableMemoryPractice(): Promise<void> {
    // M3: memoryEnabled 设置项必须 gate 行为
    if (!this.getSettings().memoryEnabled) {
      new Notice("记忆练习已关闭，请在设置中开启");
      return;
    }
    // M2: 防双开——确认框 await 期间禁止重复进入
    if (this.memoryActive || this.memoryEnabling) return;
    this.memoryEnabling = true;
    try {
      // 进入任一练习模式前互斥退出另一个
      if (this.practiceActive) this.exitRandomPractice();

      // 首次启用检测：已有答题进度但无记忆数据 → 需重置进度才能开始。
      // C-1: memoryInitialized 已置位（用户显式删过卡片或已判分过）则不再弹提示
      if (
        !this.memoryInitialized &&
        Object.keys(this.memoryCards).length === 0 &&
        Object.keys(this.answeredQuestions).length > 0
      ) {
        const modal = new ChoiceModal(this.app, {
          title: "启用记忆练习需要重置进度",
          message:
            "检测到已有答题记录但没有记忆数据，记忆练习需要重置进度（清除答题记录/统计/记忆卡片）后重新开始。是否重置并开始？",
          options: [
            { label: "重置并开始", value: "reset", cta: true },
            { label: "取消", value: "cancel" },
          ],
        });
        modal.open();
        const res = await modal.promise;
        // L2: 弹窗期间视图被关闭 → 中止（finally 会复位 memoryEnabling）
        if (this.isClosed) return;
        if (res !== "reset") return;
        // F3: 弹窗 await 期间用户可能已进入随机练习（当时 practiceActive 仍为 false），
        // 确认后退出它，由记忆练习接管（与"进入任一练习模式前互斥退出另一个"语义一致）
        if (this.practiceActive) this.exitRandomPractice();
        // 清空进度（与 resetProgress 的清空逻辑等价；不弹提示、不退出面板）
        // L5: 此重置仅清内存进度字段；sidecar 中历史 wrong 覆盖保留（这些题确实答错过，
        // 错题筛选仍应命中），如需全清请用设置页「全部重置」
        this.correctCount = 0;
        this.wrongCount = 0;
        this.answeredQuestions = {};
        this.memoryCards = {};
        this.memoryNewDate = "";
        this.memoryNewCountToday = 0;
        this.memoryPendingNew = [];
        this.memoryInitialized = false;
        this.currentIndex = 0;
        this.currentShuffledQId = null;
        this.selectedOption = null;
        this.selectedOptions = [];
        this.cancelAutoNext();
      }

      const pool = this.applyFiltersTo(this.orderedQuestions);
      const now = new Date();
      // 到期题：有卡片且 due <= 当前时间（非法 due 视为未到期），按 due 升序（最紧迫在前）
      const due = pool
        .filter((q) => {
          const card = this.memoryCards[q.id];
          const t = card ? this.parseDueTime(card) : null;
          return t !== null && t <= now.getTime();
        })
        .sort(
          (a, b) =>
            (this.parseDueTime(this.memoryCards[a.id]) ?? 0) -
            (this.parseDueTime(this.memoryCards[b.id]) ?? 0)
        );
      // M1: 每日新题配额按自然日累计（跨天自动重置计数）
      const today = (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      })();
      if (this.memoryNewDate !== today) {
        this.memoryNewDate = today;
        this.memoryNewCountToday = 0;
        // A1: 跨天后上一日的"已选未答"新题作废
        this.memoryPendingNew = [];
      }
      // A1: 新题——当日已选未答的优先保留（不重复扣配额），其余按剩余配额随机补充
      const noCard = pool.filter((q) => this.memoryCards[q.id] === undefined);
      const pendingSet = new Set(this.memoryPendingNew);
      const pendingFresh = noCard.filter((q) => pendingSet.has(q.id));
      const quota = Math.max(
        0,
        this.getSettings().memoryDailyNew - (this.memoryNewCountToday || 0)
      );
      const freshNew = shuffle(
        noCard.filter((q) => !pendingSet.has(q.id))
      ).slice(0, quota);
      const fresh = [...pendingFresh, ...freshNew];
      this.memoryNewCountToday = (this.memoryNewCountToday || 0) + freshNew.length;
      this.memoryPendingNew = fresh.map((q) => q.id);

      if (due.length === 0 && fresh.length === 0) {
        new Notice("今日没有待复习或可学习的新题");
        return;
      }

      this.practiceFocusId = this.filteredQuestions[this.currentIndex]?.id ?? null;
      this.memoryIds = [...due.map((q) => q.id), ...fresh.map((q) => q.id)];
      this.filteredQuestions = [...due, ...fresh];
      this.currentIndex = 0;
      this.memoryActive = true;
      // 练习内已答集合：本次会话从零开始
      this.practiceAnswered = new Set();
      this.practiceCorrect = 0;
      this.practiceWrong = 0;
      // 练习集来源标记：到期题=复习，新题=新
      this.practiceSource = {};
      for (const q of due) this.practiceSource[q.id] = "review";
      for (const q of fresh) this.practiceSource[q.id] = "new";
      this.currentShuffledQId = null;
      this.cancelAutoNext();
      this.renderQuestion();
      this.saveState();
      new Notice(`记忆练习：到期 ${due.length} 题 + 新题 ${fresh.length} 题`);
    } finally {
      // M2: 无论任何分支返回，都复位防双开标志
      this.memoryEnabling = false;
    }
  }

  /** 退出记忆练习模式：恢复常规筛选结果并定位到进入前的位置。不渲染、不保存，由调用方决定。 */
  private exitMemoryPractice(): void {
    if (!this.memoryActive) return;
    this.memoryActive = false;
    this.memoryIds = [];
    this.practiceAnswered.clear();
    this.practiceSource = {};

    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    if (this.practiceFocusId) {
      const idx = this.filteredQuestions.findIndex(
        (q) => q.id === this.practiceFocusId
      );
      if (idx >= 0) {
        this.currentIndex = idx;
      } else if (this.filteredQuestions.length > 0) {
        this.currentIndex = 0;
      } else {
        this.currentIndex = -1;
      }
    } else {
      this.currentIndex = this.filteredQuestions.length > 0 ? 0 : -1;
    }
    this.practiceFocusId = null;
    this.currentShuffledQId = null;
    this.cancelAutoNext();
  }

  private toggleMemoryPractice(): void {
    if (this.memoryActive) {
      this.exitMemoryPractice();
      this.renderQuestion();
      this.saveState();
      new Notice("已退出记忆练习");
    } else {
      void this.enableMemoryPractice();
    }
  }

  /** 同步练习按钮（随机/记忆）的文案/高亮与完成计数。 */
  private updatePracticeButton(): void {
    if (!this.practiceBtn) return;
    if (this.practiceActive) {
      this.practiceBtn.setText("退出随机练习");
      this.practiceBtn.addClass("csv-quiz-practice-btn-active");
      const answered = this.practiceIds.filter((id) =>
        this.practiceAnswered.has(id)
      ).length;
      this.practiceCountEl.setText(` 已完成 ${answered}/${this.practiceIds.length}`);
    } else {
      this.practiceBtn.setText("🎲 随机练习（100 题）");
      this.practiceBtn.removeClass("csv-quiz-practice-btn-active");
      this.practiceCountEl.setText("");
    }

    // 记忆练习按钮：活动时显示完成计数，非活动时显示今日待复习题数（纯全局计数，不受筛选影响）
    if (!this.memoryBtn) return;
    if (this.memoryActive) {
      this.memoryBtn.setText("退出记忆练习");
      this.memoryBtn.addClass("csv-quiz-practice-btn-active");
      const answered = this.memoryIds.filter((id) =>
        this.practiceAnswered.has(id)
      ).length;
      this.memoryCountEl.setText(` 已完成 ${answered}/${this.memoryIds.length}`);
    } else {
      this.memoryBtn.setText("🧠 记忆练习");
      this.memoryBtn.removeClass("csv-quiz-practice-btn-active");
      // L4/A3: 非法 due 不计入"今日待复习"（公共到期计数函数）
      const dueCount = countDueCards(this.memoryCards);
      this.memoryCountEl.setText(dueCount > 0 ? ` 今日待复习 ${dueCount} 题` : "");
    }
  }

  private populateTagChips(): void {
    if (!this.tagsContainer) return;
    this.tagsContainer.empty();

    const selectedSet = new Set(
      this.filterTags
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
    );

    const allTags = getUniqueTags(this.allQuestions);
    if (allTags.length === 0) {
      this.tagsContainer.createEl("span", {
        text: "无标签",
        cls: "csv-quiz-tag-chip csv-quiz-tag-chip-empty",
      });
      return;
    }

    for (const tag of allTags) {
      const chip = this.tagsContainer.createEl("span", {
        text: tag,
        cls: "csv-quiz-tag-chip" + (selectedSet.has(tag) ? " csv-quiz-tag-chip-selected" : ""),
      });
      chip.dataset.tag = tag;
      chip.addEventListener("click", () => {
        void (async () => {
          await this.saveCurrentEdit();
          const tagStr = chip.dataset.tag!;
          const current = this.filterTags
            .trim()
            .split(/\s+/)
            .filter((t) => t.length > 0);
          const idx = current.indexOf(tagStr);
          if (idx >= 0) {
            current.splice(idx, 1);
          } else {
            current.push(tagStr);
          }
          this.filterTags = current.join(" ");
          this.populateTagChips();
          this.applyFiltersAndReset();
        })();
      });
    }
  }

  private populateSelect(
    select: HTMLSelectElement,
    options: string[],
    currentValue: string
  ): void {
    select.empty();
    const allOpt = select.createEl("option", { text: "全部" });
    allOpt.value = "";

    for (const opt of options) {
      const el = select.createEl("option", { text: opt });
      el.value = opt;
    }

    if (currentValue && options.includes(currentValue)) {
      select.value = currentValue;
    } else {
      select.value = "";
    }
  }

  /** 按当前全部筛选条件（含自由文本）过滤题目。 */
  private applyFiltersTo(questions: Question[]): Question[] {
    return filterQuestions(
      questions,
      this.filterTags,
      this.filterCat1,
      this.filterCat2,
      this.filterCat3,
      this.filterFavorite,
      this.filterMastered,
      this.filterRepeat,
      this.filterWrong,
      this.filterText,
      this.filterUnanswered,
      this.answeredQuestions
    );
  }

  private reFilterForNavigation(): void {
    // 练习模式：练习集为固定随机快照（≤100 题），导航时不得重建为完整筛选结果
    if (this.practiceActive || this.memoryActive) return;
    const prevId = this.filteredQuestions[this.currentIndex]?.id;
    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    if (prevId) {
      const newIdx = this.filteredQuestions.findIndex((q) => q.id === prevId);
      if (newIdx >= 0) {
        this.currentIndex = newIdx;
      } else if (this.currentIndex >= this.filteredQuestions.length) {
        this.currentIndex = Math.max(0, this.filteredQuestions.length - 1);
      }
    }
  }

  private applyFiltersAndReset(): void {
    // 练习模式下修改筛选条件 → 自动退出练习，再按新筛选正常应用
    if (this.practiceActive) {
      this.exitRandomPractice();
    }
    if (this.memoryActive) {
      this.exitMemoryPractice();
    }
    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    this.currentIndex = this.filteredQuestions.length > 0 ? 0 : -1;
    this.currentShuffledQId = null;
    this.cancelAutoNext();
    this.renderQuestion();
    this.saveState();
  }

  /** 正确答案列包含多个字母（如 ABCD）时视为多选题。 */
  private isMultiChoice(question: Question): boolean {
    return question.answer.length > 1;
  }

  /** 忽略字母顺序与重复，归一化答案字符串用于比较。 */
  private normalizeAnswer(value: string): string {
    // F7: 先过滤非 A-D 字符（答案列可能含空格/逗号/小写等脏数据）再归一化，
    // 避免如答案 "A B" 归一化后带空格、与用户选择 "AB" 永不相等
    return normalizeAnswerValue(value);
  }

  private renderQuestion(): void {
    // 滑动切题开关：同步 data-ignore-swipe（Obsidian 手势识别器对该区域跳过），开关变化即时生效
    this.syncSwipeNavigation();
    this.questionArea.empty();
    this.feedbackArea.empty();
    this.editArea.empty();
    this.updateProgress();

    if (
      this.filteredQuestions.length === 0 ||
      this.currentIndex < 0 ||
      this.currentIndex >= this.filteredQuestions.length
    ) {
      this.questionArea.createEl("p", {
        text: "没有匹配的题目",
        cls: "csv-quiz-empty",
      });
      this.updateNavigation();
      return;
    }

    const question = this.filteredQuestions[this.currentIndex];
    const multi = this.isMultiChoice(question);

    // Restore answer state if this question was previously answered
    // 注意：判错时 answeredQuestions[id] 可能为空字符串（空选判错），
    // 必须用 !== undefined 判断，否则空字符串会被当作"未答"导致判错状态丢失。
    // 练习模式：旧题（本次会话未答）按未答状态渲染，允许继续练习；
    // 本次会话已答的题才恢复判定展示。常规模式维持原行为。
    const inPractice = this.practiceActive || this.memoryActive;
    const prevAnswer = inPractice
      ? this.practiceAnswered.has(question.id)
        ? this.answeredQuestions[question.id]
        : undefined
      : this.answeredQuestions[question.id];
    if (prevAnswer !== undefined) {
      if (multi) {
        this.selectedOptions = prevAnswer.split("");
      } else {
        this.selectedOption = prevAnswer;
      }
      this.showingAnswer = true;
      this.answering = true;
    } else {
      this.selectedOption = null;
      this.selectedOptions = [];
      this.showingAnswer = false;
      this.answering = false;
    }

    // 多选题在题干前标注 (多选)
    if (multi) {
      this.questionArea.createEl("span", {
        text: "(多选)",
        cls: "csv-quiz-multi-badge",
      });
    }

    // 记忆练习：显著标明题目来源（复习/新题），与 (多选) 标记并排
    if (this.memoryActive && this.practiceSource[question.id]) {
      const srcNew = this.practiceSource[question.id] === "new";
      this.questionArea.createEl("span", {
        text: srcNew ? "🆕 新题" : "🔁 复习",
        cls:
          "csv-quiz-source-badge" +
          (srcNew
            ? " csv-quiz-source-badge-new"
            : " csv-quiz-source-badge-review"),
      });
    }

    // Stem with Markdown rendering
    const stemDiv = this.questionArea.createDiv("csv-quiz-stem");
    MarkdownRenderer.render(this.app, question.stem, stemDiv, "", this).catch(
      (e: unknown) => console.error("CSV Quiz: markdown render failed", e)
    );

    // 题目页眉底部：可折叠的记忆卡片信息栏（所有模式都显示）
    this.renderCardPanel(question);

    // Options
    const optionsDiv = this.questionArea.createDiv("csv-quiz-options");
    const optionKeys: Array<{ key: string; text: string }> = [
      { key: "A", text: question.optionA },
      { key: "B", text: question.optionB },
      { key: "C", text: question.optionC },
      { key: "D", text: question.optionD },
    ];

    const settings = this.getSettings();

    let displayOptions = optionKeys;
    if (settings.randomOptions) {
      if (this.currentShuffledQId === question.id) {
        displayOptions = this.currentShuffledOptions;
      } else {
        displayOptions = shuffle(optionKeys);
        this.currentShuffledQId = question.id;
        this.currentShuffledOptions = displayOptions;
      }
    }

    // 显示字母按展示位置顺序排列（A、B、C、D…），这样打乱选项时不会泄露
    // 原始字母映射。内部判题仍使用原始 opt.key（与 question.answer 比对）。
    const answerKeys = multi ? question.answer.split("") : [question.answer];

    for (let i = 0; i < displayOptions.length; i++) {
      const opt = displayOptions[i];
      const displayLetter = String.fromCharCode(65 + i);
      const isSelected = multi
        ? this.selectedOptions.includes(opt.key)
        : this.selectedOption === opt.key;
      const isAnswerKey = answerKeys.includes(opt.key);

      const optDiv = optionsDiv.createDiv(
        "csv-quiz-option" +
          (isSelected ? " csv-quiz-option-selected" : "") +
          (this.showingAnswer && isAnswerKey
            ? " csv-quiz-option-correct"
            : "") +
          (this.showingAnswer && isSelected && !isAnswerKey
            ? " csv-quiz-option-wrong"
            : "")
      );

      const input = optDiv.createEl("input", {
        type: multi ? "checkbox" : "radio",
        attr: {
          name: multi ? "quiz-option-multi" : "quiz-option",
          id: `opt-${opt.key}`,
        },
      });
      input.value = opt.key;
      input.checked = isSelected;

      const label = optDiv.createEl("label", {
        attr: { for: `opt-${opt.key}` },
      });
      label.createSpan({
        text: `${displayLetter}. ${opt.text}`,
      });

      if (!this.answering && !this.showingAnswer) {
        optDiv.addEventListener("click", (e: MouseEvent) => {
          // 阻止 label 默认行为：否则点击文本会派发 label + 合成 checkbox 两个
          // click 事件，导致 toggleMultiOption 被调用两次、选中状态被抵消。
          e.preventDefault();
          if (multi) {
            this.toggleMultiOption(opt.key);
          } else {
            void this.handleAnswer(opt.key);
          }
        });
      }
    }

    // Feedback
    this.renderFeedback(question, displayOptions);

    // Checkbox area
    this.renderCheckboxArea(question);

    // Read-only tags/categories
    this.readOnlyArea.empty();
    const tagsChips = this.readOnlyArea.createSpan({ cls: "csv-quiz-readonly-tags" });
    tagsChips.createEl("strong", { text: "标签:  " });
    const tagText = question.tags || "（无）";
    if (tagText !== "（无）") {
      for (const tag of tagText.split(/\s+/).filter(Boolean)) {
        tagsChips.createEl("span", { text: tag, cls: "csv-quiz-tag-chip csv-quiz-tag-chip-selected" });
      }
    } else {
      tagsChips.createEl("span", { text: "（无）", cls: "csv-quiz-tag-chip csv-quiz-tag-chip-empty" });
    }

    // Click handler to open tag picker modal
    tagsChips.addEventListener("click", () => {
      void this.openTagPicker(question);
    });

    const catText = `  |  一级: ${question.category1 || "（无）"}  |  二级: ${question.category2 || "（无）"}  |  三级: ${question.category3 || "（无）"}`;
    this.readOnlyArea.createSpan({ text: catText, cls: "csv-quiz-readonly-cats" });

    // Edit area for tags/categories (moved below filter)
    this.renderEditArea(question);

    // Navigation
    this.updateNavigation();

    // 练习模式：同步按钮完成计数
    this.updatePracticeButton();
  }

  /** 题目页眉底部：可折叠的记忆卡片信息栏（仅展示，不编辑）。 */
  private renderCardPanel(question: Question): void {
    const panel = this.questionArea.createDiv("csv-quiz-card-panel");
    const header = panel.createDiv("csv-quiz-card-toggle");
    header.createEl("span", { text: this.cardPanelOpen ? "▼" : "▶" });
    header.createEl("span", { text: "记忆卡片" });
    const body = panel.createDiv("csv-quiz-card-body");
    body.classList.toggle("csv-quiz-card-body-hidden", !this.cardPanelOpen);
    // 切换折叠只改本栏，不重渲染题目（避免丢失当前答题状态）
    header.addEventListener("click", () => {
      this.cardPanelOpen = !this.cardPanelOpen;
      body.classList.toggle("csv-quiz-card-body-hidden", !this.cardPanelOpen);
    });
    const card = this.memoryCards[question.id];
    if (!card) {
      body.createEl("span", {
        text: "该题暂无记忆卡片",
        cls: "csv-quiz-card-empty",
      });
      return;
    }
    const stateNames: Record<number, string> = {
      0: "新题",
      1: "学习中",
      2: "复习",
      3: "再学习",
    };
    const fmtDate = (iso: string): string => {
      if (!iso) return "—";
      const t = new Date(iso).getTime();
      return Number.isNaN(t) ? "—" : new Date(iso).toLocaleString();
    };
    const rows: Array<[string, string]> = [
      ["状态", stateNames[card.state] ?? String(card.state)],
      ["稳定性", `${card.stability.toFixed(2)} 天`],
      ["难度", card.difficulty.toFixed(2)],
      ["下次复习", fmtDate(card.due)],
      ["复习次数", String(card.reps)],
      ["遗忘次数", String(card.lapses)],
      ["上次复习", fmtDate(card.lastReview)],
    ];
    for (const [label, value] of rows) {
      const row = body.createDiv("csv-quiz-card-row");
      row.createEl("span", { text: label, cls: "csv-quiz-card-label" });
      row.createEl("span", { text: value, cls: "csv-quiz-card-value" });
    }
  }

  private renderFeedback(
    question: Question,
    displayOptions: Array<{ key: string; text: string }>
  ): void {
    this.feedbackArea.empty();

    if (!this.showingAnswer) return;

    const multi = this.isMultiChoice(question);
    const answerKeys = multi ? question.answer.split("") : [question.answer];
    const isCorrect = multi
      ? this.normalizeAnswer(this.selectedOptions.join("")) ===
        this.normalizeAnswer(question.answer)
      : this.selectedOption === question.answer;

    const feedbackDiv = this.feedbackArea.createDiv(
      `csv-quiz-feedback-text ${
        isCorrect ? "csv-quiz-correct" : "csv-quiz-incorrect"
      }`
    );
    feedbackDiv.createEl("strong", {
      text: isCorrect ? "✓ 正确!" : "✗ 错误!",
    });

    if (!isCorrect) {
      const correctLetters = displayOptions
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => answerKeys.includes(o.key))
        .map(({ i }) => String.fromCharCode(65 + i))
        .join("");
      feedbackDiv.createEl("span", {
        text: ` 正确答案: ${correctLetters}`,
      });
    }
  }

  /** 多选题：切换某个选项的勾选状态（仅本地 DOM 更新）。 */
  private toggleMultiOption(key: string): void {
    if (this.answering || this.showingAnswer) return;
    const idx = this.selectedOptions.indexOf(key);
    if (idx >= 0) {
      this.selectedOptions.splice(idx, 1);
    } else {
      this.selectedOptions.push(key);
    }
    const input = this.questionArea.querySelector<HTMLInputElement>(
      `input[value="${key}"]`
    );
    if (input) {
      input.checked = idx < 0;
      const optDiv = input.closest<HTMLElement>(".csv-quiz-option");
      if (optDiv) {
        optDiv.classList.toggle("csv-quiz-option-selected", idx < 0);
      }
    }
  }

  /** 多选题：点击「下一题」时判定对错。 */
  private async evaluateMultiAnswer(): Promise<void> {
    if (this.answering || this.showingAnswer) return;

    const origQuestion = this.filteredQuestions[this.currentIndex];
    if (!origQuestion) return;

    this.answering = true;
    await this.saveCurrentEdit();

    // H2: 同 handleAnswer，重新定位用户实际作答的题目
    let question = this.filteredQuestions[this.currentIndex];
    if (!question || question.id !== origQuestion.id) {
      const idx = this.filteredQuestions.findIndex((q) => q.id === origQuestion.id);
      if (idx >= 0) {
        this.currentIndex = idx;
        question = this.filteredQuestions[idx];
      } else {
        const selectedStr = this.normalizeAnswer(this.selectedOptions.join(""));
        await this.recordAnswer(
          origQuestion,
          selectedStr,
          selectedStr === this.normalizeAnswer(origQuestion.answer)
        );
        this.renderQuestion();
        this.saveState();
        new Notice("题目已因筛选条件变化被移出当前列表，答案已记录");
        return;
      }
    }

    const selectedStr = this.normalizeAnswer(this.selectedOptions.join(""));
    const isCorrect = selectedStr === this.normalizeAnswer(question.answer);
    this.showingAnswer = true;
    await this.recordAnswer(question, selectedStr, isCorrect);
    // 更新 FSRS 卡片：记忆练习始终更新；常规/随机练习按设置（非记忆模式参与 FSRS）
    if (this.memoryActive || this.getSettings().memoryUpdateInNormalMode) {
      this.applyMemoryReview(question.id, isCorrect);
    }

    this.renderQuestion();
    this.updateProgress();

    const settings = this.getSettings();
    if (isCorrect) {
      if (settings.autoNextDelay > 0) {
        // M1: 记录本次作答题 id，计时器回调校验题目未变化才跳转，防止
        // saveCurrentEdit 的 await 窗口内用户滑动切题后出现"幽灵自动跳题"
        this.autoNextQuestionId = question.id;
        this.autoNextTimer = window.setTimeout(() => {
          if (
            this.filteredQuestions[this.currentIndex]?.id !==
            this.autoNextQuestionId
          ) {
            this.autoNextQuestionId = null;
            return;
          }
          this.autoNextQuestionId = null;
          void this.nextQuestion();
        }, settings.autoNextDelay * 1000);
      } else {
        this.answering = false;
      }
    } else {
      this.answering = false;
    }
    this.saveState();
  }

  /** 记录答题结果：计数、答题记录、错题标记（答对清除、答错置位）写入 sidecar meta。不负责渲染。 */
  private async recordAnswer(
    question: Question,
    selectedStr: string,
    isCorrect: boolean
  ): Promise<void> {
    this.answeredQuestions[question.id] = selectedStr;
    // 练习模式：记录本次会话已答（渲染/计数/完成检测均基于 practiceAnswered）
    if (this.practiceActive || this.memoryActive) {
      this.practiceAnswered.add(question.id);
    }

    if (isCorrect) {
      // 练习模式只累计本次会话统计，不污染全局统计
      if (this.practiceActive || this.memoryActive) {
        this.practiceCorrect++;
      } else {
        this.correctCount++;
      }
      if (question.wrong === "1") {
        question.wrong = "";
        this.saveQuestionMeta(question, ["wrong"]);
      }
    } else {
      if (this.practiceActive || this.memoryActive) {
        this.practiceWrong++;
      } else {
        this.wrongCount++;
      }
      if (question.wrong !== "1") {
        question.wrong = "1";
        this.saveQuestionMeta(question, ["wrong"]);
      }
    }
  }

  /** 解析卡片的 due 时间戳；非法字符串返回 null（视为未到期，不计入复习/计数）。 */
  private parseDueTime(card: MemoryCard): number | null {
    const t = new Date(card.due).getTime();
    return Number.isNaN(t) ? null : t;
  }

  /** 记忆练习判分：用 FSRS 更新卡片；答错时把 wrong 标记置 "1" 并写回 CSV（写失败回滚并提示）。 */
  private applyMemoryReview(id: string, correct: boolean): void {
    // C-1: 一次记忆练习判分即视为已初始化（放方法最前，任何分支都置位）
    this.memoryInitialized = true;
    const now = new Date();
    const saved = this.memoryCards[id];
    // F2: 防御非法持久化数据（如手工编辑 data.json）：state 越界、lastReview 不可解析、
    // 或 due 存在但不可解析时跳过该题（非法 due 会让 FSRS 产出 NaN 间隔 → toISOString 抛异常）
    if (
      saved &&
      (![0, 1, 2, 3].includes(saved.state) ||
        (saved.lastReview !== "" &&
          Number.isNaN(new Date(saved.lastReview).getTime())) ||
        (saved.due && Number.isNaN(new Date(saved.due).getTime())))
    ) {
      console.warn(`CSV Quiz: memory card data invalid for question "${id}", skipped`);
      new Notice("记忆练习：卡片数据异常，已跳过该题");
      return;
    }
    try {
      // 评分所需的题目对象（答错分支写 wrong 也复用）
      const q = this.filteredQuestions.find((x) => x.id === id) ?? null;
      let card: Card;
      if (saved) {
        card = {
          due: new Date(saved.due),
          stability: saved.stability,
          difficulty: saved.difficulty,
          reps: saved.reps,
          lapses: saved.lapses,
          learning_steps: saved.learningSteps,
          // ts-fsrs 的 State 为数字枚举，可直接赋值 number（已在 applyMemoryReview 校验过 0-3 范围）
          state: saved.state,
          elapsed_days: 0,
          scheduled_days: 0,
          // B1: 必须 round-trip last_review，否则 FSRS 认为从未复习，间隔不会增长
          last_review: saved.lastReview
            ? new Date(saved.lastReview)
            : undefined,
        };
      } else {
        card = createEmptyCard();
      }
      // 评分映射：答错一律 Again；答对按掌握标记选档（设置可关）。
      // 收藏不参与评分——用 Hard 表达"想多复习"会持续推高难度并压缩间隔（难度虚高、
      // 复习越来越频繁），故收藏只用于筛选/练习集，不干预 FSRS 调度。
      let rating: Rating;
      if (!correct) {
        rating = Rating.Again;
      } else if (
        this.getSettings().memoryMarkRating &&
        q &&
        q.mastered === "1"
      ) {
        rating = Rating.Easy;
      } else {
        rating = Rating.Good;
      }
      const result = memoryScheduler.next(card, now, rating);
      const c = result.card;
      this.memoryCards[id] = {
        state: c.state,
        stability: c.stability,
        difficulty: c.difficulty,
        due: c.due.toISOString(),
        reps: c.reps,
        lapses: c.lapses,
        learningSteps: c.learning_steps,
        lastReview: c.last_review ? c.last_review.toISOString() : "",
      };
      if (!correct) {
        // 答错计入 wrong 标记并写入 sidecar meta（内存操作 + 调度保存，无失败路径）
        if (q && q.wrong !== "1") {
          q.wrong = "1";
          this.saveQuestionMeta(q, ["wrong"]);
        }
      }
      this.saveState();
      // L1/L3: 判分后立即刷新状态栏提醒（实际实例为 CSVQuizPlugin，故 cast 调用）
      (this.plugin as unknown as { refreshMemoryReminder?: () => void })
        .refreshMemoryReminder?.();
    } catch (e: unknown) {
      // F2: 任何异常（如未预期损坏的卡片数据）不外泄、不打断调用方，
      // answering 复位逻辑在调用方（handleAnswer/evaluateMultiAnswer）正常执行
      console.error("CSV Quiz: applyMemoryReview failed", e);
      new Notice("记忆卡片更新失败，已跳过该题");
    }
  }

  /** 「下一题」按钮：多选题未判定时先判定，否则跳转。 */
  private async onNextClick(): Promise<void> {
    if (this.navigating) return;
    const question = this.filteredQuestions[this.currentIndex];
    if (question && this.isMultiChoice(question) && !this.showingAnswer) {
      this.navigating = true;
      try {
        await this.evaluateMultiAnswer();
      } finally {
        this.navigating = false;
      }
      return;
    }
    await this.nextQuestion();
  }

  /** 按指定随机开关重建显示顺序，并按当前题 id 定位（找不到或 id 为空回第一题/空状态）。 */
  private rebuildOrderAndLocate(random: boolean, currentId: string | null): void {
    this.displayOrder = buildDisplayOrder(this.allQuestions, random);
    this.orderedQuestions = sortByDisplayOrder(
      this.allQuestions,
      this.displayOrder
    );
    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    if (currentId) {
      const idx = this.filteredQuestions.findIndex((q) => q.id === currentId);
      this.currentIndex = idx >= 0 ? idx : 0;
    } else {
      this.currentIndex = this.filteredQuestions.length > 0 ? 0 : -1;
    }
  }

  /** 每日新题设置变更后重置当日配额状态（日期/计数/已选未答），使新设置立即生效。 */
  async resetDailyNewQuota(): Promise<void> {
    this.memoryNewDate = "";
    this.memoryNewCountToday = 0;
    this.memoryPendingNew = [];
    this.saveState();
  }

  /** 随机题目顺序开关变更：保留答题进度，按当前设置重建显示顺序并重新定位当前题。 */
  async reorderForRandomSetting(): Promise<void> {
    // L7: 视图未就绪（已关闭/初始化中止）时回退到清空磁盘顺序，
    // 由 main.ts 的重建兜底处理，避免未就绪时重建+渲染导致状态不一致
    if (this.isClosed || !this.canPersistState) {
      const st = this.stateManager.getState();
      if (st) {
        st.displayOrder = [];
        void this.stateManager.saveStateImmediately(st);
      }
      return;
    }
    if (this.practiceActive) this.exitRandomPractice();
    if (this.memoryActive) this.exitMemoryPractice();
    const currentId = this.filteredQuestions[this.currentIndex]?.id ?? null;
    this.rebuildOrderAndLocate(this.getSettings().randomOrder, currentId);
    this.currentShuffledQId = null;
    this.cancelAutoNext();
    this.renderQuestion();
    this.saveState();
  }

  /** 按用户选择清理进度：records=刷题记录，cards=记忆卡片，order=仅重置题目顺序，all=全部。保留筛选条件。 */
  async applyResetChoice(
    choice: "records" | "cards" | "order" | "all"
  ): Promise<void> {
    // C-3: 视图未就绪（已关闭/初始化中止）时回退到直接改状态并落盘，避免"弹了提示但磁盘未动"
    if (this.isClosed || !this.canPersistState) {
      const state = this.stateManager.getState();
      if (state) {
        if (choice === "order") {
          // 顺序下次打开面板时按设置重建；随机设置开启时自动关闭（与就绪分支一致）
          state.displayOrder = [];
          if (this.getSettings().randomOrder) {
            this.getSettings().randomOrder = false;
            await (this.plugin as unknown as {
              saveSettings?: () => Promise<void>;
            }).saveSettings?.();
            // M-2: auto-off 后同步设置页开关显示值（声明式设置路径不会自动跟随）
            (this.plugin as unknown as {
              syncSettingsUI?: () => void;
            }).syncSettingsUI?.();
          }
        } else {
          if (choice !== "cards") {
            state.correctCount = 0;
            state.wrongCount = 0;
            state.answeredQuestions = {};
          }
          if (choice !== "records") {
            state.memoryCards = {};
            state.memoryNewDate = "";
            state.memoryNewCountToday = 0;
            state.memoryPendingNew = [];
          }
          // L6: 全部重置语义与就绪分支一致——复位「已初始化」标记，避免再次触发首次启用提示
          if (choice === "all") {
            state.memoryInitialized = false;
          }
        }
        await this.stateManager.saveStateImmediately(state);
      }
      new Notice(
        choice === "all"
          ? "进度已重置"
          : choice === "order"
            ? "题目顺序已重置，重新打开面板时生效"
            : choice === "records"
              ? "刷题记录已清理"
              : "记忆卡片已删除"
      );
      return;
    }
    await this.saveCurrentEdit();
    // order：仅重置题目顺序为 CSV 原始顺序（不清理任何记录/卡片）
    if (choice === "order") {
      // 退出练习模式（与 records/cards/all 分支一致），避免练习标志残留
      if (this.practiceActive) this.exitRandomPractice();
      if (this.memoryActive) this.exitMemoryPractice();
      // 随机题目顺序开启时重置为 CSV 顺序会与之冲突：自动关闭该设置并保存
      let autoOff = false;
      if (this.getSettings().randomOrder) {
        this.getSettings().randomOrder = false;
        await (this.plugin as unknown as {
          saveSettings?: () => Promise<void>;
        }).saveSettings?.();
        // M-2: auto-off 后同步设置页开关显示值（声明式设置路径不会自动跟随）
        (this.plugin as unknown as {
          syncSettingsUI?: () => void;
        }).syncSettingsUI?.();
        autoOff = true;
      }
      this.rebuildOrderAndLocate(false, null);
      this.currentShuffledQId = null;
      this.cancelAutoNext();
      this.renderQuestion();
      this.saveState();
      new Notice(
        autoOff
          ? "题目顺序已重置为 CSV 原始顺序，并已自动关闭随机题目顺序"
          : "题目顺序已重置为 CSV 原始顺序"
      );
      return;
    }
    // 重置进度时退出练习模式（记忆/随机均为临时会话），避免残留练习集状态
    if (this.practiceActive) this.exitRandomPractice();
    if (this.memoryActive) this.exitMemoryPractice();
    // M2: 全部重置对齐设置页语义（main.ts clearState + refreshQuiz）：清 sidecar 的
    // state 与 meta（保留文件）并重读内容源，meta 覆盖失效、筛选回默认值。
    // refresh 内部已含 clearState → loadSidecar → applyMetaToQuestions → applyFreshStart
    // 完整重置流；确认弹窗仅存在于 resetProgress/enableMemoryPractice，此处不会重复弹出。
    if (choice === "all") {
      await this.refresh();
      return;
    }
    if (choice !== "cards") {
      this.correctCount = 0;
      this.wrongCount = 0;
      this.answeredQuestions = {};
    }
    if (choice !== "records") {
      this.memoryCards = {};
      this.memoryNewDate = "";
      this.memoryNewCountToday = 0;
      this.memoryPendingNew = [];
    }
    // 重置后按当前设置重建题目顺序（随机开启则重排，关闭则恢复 CSV 默认顺序）
    this.rebuildOrderAndLocate(this.getSettings().randomOrder, null);
    this.currentIndex = 0;
    this.currentShuffledQId = null;
    this.selectedOption = null;
    this.selectedOptions = [];
    this.cancelAutoNext();
    this.renderQuestion();
    this.saveState();
    // 清理卡片后立即刷新状态栏提醒
    (this.plugin as unknown as { refreshMemoryReminder?: () => void })
      .refreshMemoryReminder?.();
    new Notice(choice === "records" ? "刷题记录已清理" : "记忆卡片已删除");
  }

  /** 重置答题进度：让用户选择清理刷题记录/记忆卡片，保留筛选条件。 */
  private async resetProgress(): Promise<void> {
    const res = await askResetChoice(this.app);
    if (this.isClosed) return;
    if (!res) return;
    await this.applyResetChoice(res);
  }

  private renderCheckboxArea(question: Question): void {
    this.checkboxArea.empty();

    const fields = [
      { key: "favorite", label: "收藏", value: question.favorite },
      { key: "mastered", label: "掌握", value: question.mastered },
      { key: "repeat", label: "重复", value: question.repeat },
      { key: "wrong", label: "错题", value: question.wrong },
    ];

    for (const f of fields) {
      const labelEl = this.checkboxArea.createEl("label");
      const cb = labelEl.createEl("input", {
        type: "checkbox",
        attr: { "data-field": f.key },
      });
      cb.checked = f.value === "1";
      labelEl.createSpan({ text: " " + f.label });

      cb.addEventListener("change", () => {
        const q = question as unknown as Record<string, string>;
        const newValue = cb.checked ? "1" : "";
        q[f.key] = newValue;
        // 只写用户改动的这一个字段（f.key 为 favorite/mastered/repeat/wrong 之一）
        this.saveQuestionMeta(question, [
          f.key as "favorite" | "mastered" | "repeat" | "wrong",
        ]);
        // M7: 标记变化可能影响筛选（如「错题=是」），重新筛选并定位当前题
        this.reFilterAndLocate(question.id);
        this.renderQuestion();
        this.saveState();
      });
    }
  }

  private async openTagPicker(question: Question): Promise<void> {
    // M6: 先把编辑区未提交的内容保存，避免被弹窗覆盖丢失
    await this.saveCurrentEdit();

    // Collect all unique tags from all questions
    const allTags = getUniqueTags(this.allQuestions);
    // Parse current question tags into a space-separated string
    const currentTags = question.tags || "";

    const modal = new TagPickerModal(this.app, allTags, currentTags);
    modal.open();
    const result = await modal.promise;

    if (result !== null) {
      // Save selected tags to the question (always the original question, even if user navigated away)
      question.tags = result;
      this.saveQuestionMeta(question, ["tags"]);

      // Remember which question is currently displayed before re-filtering
      const currentDisplayedId = this.filteredQuestions[this.currentIndex]?.id;

      // Re-apply filters since tags changed
      this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);

      // Restore the currently displayed question, not the saved one
      // (the user may have auto-advanced or manually navigated while the modal was open)
      if (currentDisplayedId) {
        const newIndex = this.filteredQuestions.findIndex(
          (q) => q.id === currentDisplayedId
        );
        if (newIndex >= 0) {
          this.currentIndex = newIndex;
        } else if (this.filteredQuestions.length > 0) {
          this.currentIndex = 0;
        } else {
          this.currentIndex = -1;
        }
      } else {
        this.currentIndex = this.filteredQuestions.length > 0 ? 0 : -1;
      }

      this.saveState();

      // Refresh filter panel tag chips
      this.populateTagChips();

      // Re-render the current question
      if (this.filteredQuestions.length > 0) {
        this.renderQuestion();
      }

      new Notice("标签已保存");
    }
  }

  private renderEditArea(question: Question): void {
    this.editArea.empty();

    const settings = this.getSettings();

    // Toggle header
    const toggleHeader = this.editArea.createDiv("csv-quiz-filter-toggle");
    const toggleIcon = toggleHeader.createSpan("csv-quiz-filter-icon");
    toggleHeader.createEl("span", { text: "标签 / 分类 (编辑后自动保存)" });

    const editBody = this.editArea.createDiv("csv-quiz-edit-grid");

    const panelOpen = settings.editPanelOpen;
    editBody.classList.toggle("csv-quiz-edit-grid-hidden", !panelOpen);
    toggleIcon.textContent = panelOpen ? "▼" : "▶";

    toggleHeader.addEventListener("click", () => {
      const isHidden = editBody.classList.contains("csv-quiz-edit-grid-hidden");
      editBody.classList.toggle("csv-quiz-edit-grid-hidden");
      toggleIcon.textContent = isHidden ? "▼" : "▶";
    });

    // Tags
    const tagRow = editBody.createDiv("csv-quiz-edit-row");
    tagRow.createEl("label", { text: "标签: ", cls: "csv-quiz-edit-label" });
    const tagInput = tagRow.createEl("input", {
      type: "text",
      cls: "csv-quiz-input csv-quiz-edit-input",
    });
    tagInput.value = question.tags;
    tagInput.dataset.field = "tags";

    // Category 1
    const cat1Row = editBody.createDiv("csv-quiz-edit-row");
    cat1Row.createEl("label", {
      text: "一级分类: ",
      cls: "csv-quiz-edit-label",
    });
    const cat1Input = cat1Row.createEl("input", {
      type: "text",
      cls: "csv-quiz-input csv-quiz-edit-input",
    });
    cat1Input.value = question.category1;
    cat1Input.dataset.field = "category1";

    // Category 2
    const cat2Row = editBody.createDiv("csv-quiz-edit-row");
    cat2Row.createEl("label", {
      text: "二级分类: ",
      cls: "csv-quiz-edit-label",
    });
    const cat2Input = cat2Row.createEl("input", {
      type: "text",
      cls: "csv-quiz-input csv-quiz-edit-input",
    });
    cat2Input.value = question.category2;
    cat2Input.dataset.field = "category2";

    // Category 3
    const cat3Row = editBody.createDiv("csv-quiz-edit-row");
    cat3Row.createEl("label", {
      text: "三级分类: ",
      cls: "csv-quiz-edit-label",
    });
    const cat3Input = cat3Row.createEl("input", {
      type: "text",
      cls: "csv-quiz-input csv-quiz-edit-input",
    });
    cat3Input.value = question.category3;
    cat3Input.dataset.field = "category3";

    // Save button
    const saveBtn = editBody.createEl("button", {
      text: "保存修改",
      cls: "csv-quiz-btn csv-quiz-btn-primary",
    });
    saveBtn.addEventListener("click", () => { void this.saveCurrentEdit(); });
  }

  private async handleAnswer(selectedKey: string): Promise<void> {
    if (this.answering || this.showingAnswer) return;

    const origQuestion = this.filteredQuestions[this.currentIndex];
    if (!origQuestion) return;

    this.answering = true;
    this.selectedOption = selectedKey;

    await this.saveCurrentEdit();

    // H2: saveCurrentEdit 可能重新筛选并移动 currentIndex，重新定位用户实际作答的题目
    let question = this.filteredQuestions[this.currentIndex];
    if (!question || question.id !== origQuestion.id) {
      const idx = this.filteredQuestions.findIndex((q) => q.id === origQuestion.id);
      if (idx >= 0) {
        this.currentIndex = idx;
        question = this.filteredQuestions[idx];
      } else {
        // 题目被刚保存的编辑移出当前筛选：仍按正确题目记录答案
        await this.recordAnswer(
          origQuestion,
          selectedKey,
          // L3: 与弹窗统计口径一致（normalizeAnswerValue 大小写不敏感）
          normalizeAnswerValue(selectedKey) ===
            normalizeAnswerValue(origQuestion.answer)
        );
        this.renderQuestion();
        this.saveState();
        new Notice("题目已因筛选条件变化被移出当前列表，答案已记录");
        return;
      }
    }

    // L3: 单选判分统一用 normalizeAnswerValue（大小写不敏感），与弹窗统计口径一致
    const isCorrect =
      normalizeAnswerValue(selectedKey) ===
      normalizeAnswerValue(question.answer);
    this.showingAnswer = true;
    await this.recordAnswer(question, selectedKey, isCorrect);
    // 更新 FSRS 卡片：记忆练习始终更新；常规/随机练习按设置（非记忆模式参与 FSRS）
    if (this.memoryActive || this.getSettings().memoryUpdateInNormalMode) {
      this.applyMemoryReview(question.id, isCorrect);
    }

    this.renderQuestion();
    this.updateProgress();

    const settings = this.getSettings();
    if (isCorrect) {
      if (settings.autoNextDelay > 0) {
        // M1: 记录本次作答题 id，计时器回调校验题目未变化才跳转。
        // 注意：此调度位于 saveCurrentEdit 的 await 之后，若用户在等待窗口内
        // 滑动切题，nextQuestion 的 cancelAutoNext 会先于计时器创建执行（空操作），
        // 因此必须用 autoNextQuestionId 兜底校验，防止刚滑到的新题被自动跳过。
        this.autoNextQuestionId = question.id;
        this.autoNextTimer = window.setTimeout(() => {
          if (
            this.filteredQuestions[this.currentIndex]?.id !==
            this.autoNextQuestionId
          ) {
            this.autoNextQuestionId = null;
            return;
          }
          this.autoNextQuestionId = null;
          void this.nextQuestion();
        }, settings.autoNextDelay * 1000);
      } else {
        this.answering = false;
      }
    } else {
      this.answering = false;
    }
    this.saveState();
  }

  private cancelAutoNext(): void {
    if (this.autoNextTimer !== null) {
      window.clearTimeout(this.autoNextTimer);
      this.autoNextTimer = null;
    }
    // M1: 同时清空对应作答题 id，保证取消后残留的计时器回调校验必然失败
    this.autoNextQuestionId = null;
  }

  private async nextQuestion(): Promise<void> {
    // 防重入：自动跳转 timer 与用户手动点击可能并发调用（saveCurrentEdit
    // 的 await 会让出事件循环），若不加守卫会各自前进一题导致跳过头。
    if (this.isClosed || this.navigating) return;
    this.navigating = true;
    try {
      await this.saveCurrentEdit();
      const origId = this.filteredQuestions[this.currentIndex]?.id;
      this.reFilterForNavigation();
      if (!origId) return;
      const found = this.filteredQuestions.some((q) => q.id === origId);
      if (found) {
        const newIdx = this.filteredQuestions.findIndex((q) => q.id === origId);
        if (newIdx < this.filteredQuestions.length - 1) {
          this.currentIndex = newIdx + 1;
        } else {
          this.currentIndex = newIdx;
          // 练习模式：练习集全部答完时提示完成（按本次会话已答集合判断）
          if (
            (this.practiceActive || this.memoryActive) &&
            this.filteredQuestions.every((q) => this.practiceAnswered.has(q.id))
          ) {
            new Notice(`练习完成！共 ${this.filteredQuestions.length} 题`);
          }
          return;
        }
      }
      this.currentShuffledQId = null;
      this.cancelAutoNext();
      this.renderQuestion();
      this.saveState();
    } finally {
      this.navigating = false;
    }
  }

  private async prevQuestion(): Promise<void> {
    if (this.navigating) return;
    this.navigating = true;
    try {
      await this.saveCurrentEdit();
      const origId = this.filteredQuestions[this.currentIndex]?.id;
      this.reFilterForNavigation();
      if (!origId) return;
      const found = this.filteredQuestions.some((q) => q.id === origId);
      if (found) {
        const newIdx = this.filteredQuestions.findIndex((q) => q.id === origId);
        if (newIdx > 0) {
          this.currentIndex = newIdx - 1;
        } else {
          return;
        }
      } else {
        if (this.currentIndex > 0) {
          this.currentIndex--;
        } else {
          return;
        }
      }
      this.currentShuffledQId = null;
      this.cancelAutoNext();
      this.renderQuestion();
      this.saveState();
    } finally {
      this.navigating = false;
    }
  }

  private updateNavigation(): void {
    this.navigationArea.empty();

    const navInner = this.navigationArea.createDiv("csv-quiz-nav-inner");

    // Previous button
    const prevBtn = navInner.createEl("button", {
      text: "◀ 上一题",
      cls: "csv-quiz-btn",
    });
    prevBtn.disabled = this.currentIndex <= 0;
    prevBtn.addEventListener("click", () => { void this.prevQuestion(); });

    // Jump input
    const jumpGroup = navInner.createDiv("csv-quiz-nav-jump");
    jumpGroup.createEl("label", { text: "第 " });
    const jumpInput = jumpGroup.createEl("input", {
      type: "text",
      placeholder: "位置",
      cls: "csv-quiz-input csv-quiz-jump-input",
    });
    jumpGroup.createEl("label", { text: " / " + this.filteredQuestions.length + " 题 " });
    const jumpBtn = jumpGroup.createEl("button", {
      text: "跳转",
      cls: "csv-quiz-btn",
    });

    jumpBtn.addEventListener("click", () => {
      void (async () => {
        if (this.navigating) return;
        this.navigating = true;
        try {
          await this.saveCurrentEdit();
          const targetStr = jumpInput.value.trim();
          if (!targetStr) return;
          const targetNum = parseInt(targetStr, 10);
          if (
            isNaN(targetNum) ||
            targetNum < 1 ||
            targetNum > this.filteredQuestions.length
          ) {
            new Notice("题号不存在或已被筛选");
            return;
          }
          this.currentIndex = targetNum - 1;
          this.currentShuffledQId = null;
          this.cancelAutoNext();
          this.renderQuestion();
          this.saveState();
        } finally {
          this.navigating = false;
        }
      })();
    });

    // Next button
    const nextBtn = navInner.createEl("button", {
      text: "下一题 ▶",
      cls: "csv-quiz-btn",
    });
    const curQ = this.filteredQuestions[this.currentIndex];
    const needJudge =
      !!curQ && this.isMultiChoice(curQ) && !this.showingAnswer;
    nextBtn.disabled =
      this.currentIndex >= this.filteredQuestions.length - 1 && !needJudge;
    nextBtn.addEventListener("click", () => { void this.onNextClick(); });

    // Bottom bar: 下一个未答题 + 题号
    this.bottomBar.empty();
    const bottomRow = this.bottomBar.createDiv("csv-quiz-bottom-row");

    const nextUnansweredBtn = bottomRow.createEl("button", {
      text: "下一个未答题",
      cls: "csv-quiz-btn csv-quiz-btn-sm",
    });
    nextUnansweredBtn.addEventListener("click", () => this.goToNextUnanswered());

    const resetBtn = bottomRow.createEl("button", {
      text: "重置答题进度",
      cls: "csv-quiz-btn csv-quiz-btn-sm",
    });
    resetBtn.addEventListener("click", () => { void this.resetProgress(); });

    const qId = this.filteredQuestions[this.currentIndex]?.id;
    bottomRow.createEl("span", {
      text: qId ? `题号: ${qId}` : "",
      cls: "csv-quiz-q-id-bottom",
    });
  }

  private goToNextUnanswered(): void {
    if (this.filteredQuestions.length === 0) return;
    for (let i = this.currentIndex + 1; i < this.filteredQuestions.length; i++) {
      const id = this.filteredQuestions[i].id;
      // 练习模式：本次会话未答的题才算未答（旧题允许继续练习）；常规模式按答题记录判断
      const unanswered =
        this.practiceActive || this.memoryActive
          ? !this.practiceAnswered.has(id)
          : this.answeredQuestions[id] === undefined;
      if (unanswered) {
        this.currentIndex = i;
        this.currentShuffledQId = null;
        this.cancelAutoNext();
        this.renderQuestion();
        this.saveState();
        return;
      }
    }
    if (
      (this.practiceActive || this.memoryActive) &&
      this.filteredQuestions.every((q) => this.practiceAnswered.has(q.id))
    ) {
      new Notice(`练习完成！共 ${this.filteredQuestions.length} 题`);
    } else {
      new Notice("没有更多未答题");
    }
  }

  /** 同步 data-ignore-swipe 属性（Obsidian 手势识别器对该区域跳过）；设置页开关变更后即时调用。 */
  syncSwipeNavigation(): void {
    if (this.getSettings().swipeNavigation) {
      this.contentEl.setAttribute("data-ignore-swipe", "true");
    } else {
      this.contentEl.removeAttribute("data-ignore-swipe");
    }
  }

  /** 滑动切题：touchstart 记录起点；边缘让位、可交互元素豁免。 */
  private handleSwipeStart(e: TouchEvent): void {
    // M-1: 每次 touchstart 先复位状态,避免被取消的手势(touchcancel)残留污染后续点击
    this.swipeActive = false;
    this.swipeDecided = false;
    if (!this.getSettings().swipeNavigation) return;
    if (e.touches.length !== 1) return;
    const tc = e.touches[0];
    // 距屏幕边缘 <12px 让位给系统手势（如 iOS 边缘返回）
    if (Math.min(tc.clientX, window.innerWidth - tc.clientX) < 12) return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      target.closest(
        "a, button, input, textarea, select, label, [contenteditable]"
      )
    ) {
      return;
    }
    this.swipeX0 = tc.clientX;
    this.swipeY0 = tc.clientY;
    this.swipeActive = true;
    this.swipeDecided = false;
    this.swipeHorizontal = false;
  }

  /** 滑动切题：方向判定；确定为水平后拦截事件（Obsidian 手势识别器不看 preventDefault，需 stopPropagation）。 */
  private handleSwipeMove(e: TouchEvent): void {
    if (!this.swipeActive) return;
    if (e.touches.length !== 1) {
      this.swipeActive = false;
      return;
    }
    const tc = e.touches[0];
    const dx = tc.clientX - this.swipeX0;
    const dy = tc.clientY - this.swipeY0;
    if (!this.swipeDecided) {
      // M3: 判定为水平滑动的条件：dx 超过 10px 且为 |dy| 的 1.5 倍以上
      // （与 handleSwipeEnd 口径统一）。45° 斜向滚动 dx≈dy 不会被劫持，
      // 避免中断页面滚动。
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.swipeDecided = true;
        this.swipeHorizontal = true;
      } else if (Math.abs(dy) > Math.abs(dx)) {
        // 纵向位移更大 → 视为滚动，放行
        this.swipeActive = false;
        return;
      }
    }
    if (this.swipeHorizontal) {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    }
  }

  /** 滑动切题：touchend 判定是否触发切题（阈值 45px、横向 > 纵向 1.5 倍、400ms 冷却）。 */
  private handleSwipeEnd(e: TouchEvent): void {
    if (!this.swipeActive) return;
    this.swipeActive = false;
    if (!this.swipeDecided) return;
    // M1/L9: 判分进行中（answering 且尚未展示答案——handleAnswer/evaluateMultiAnswer
    // 的 await saveCurrentEdit 窗口）或导航 in-flight（navigating）时忽略本次滑动。
    // 注意：已答题展示答案状态下 answering 恒为 true（renderQuestion 恢复已答时置位，
    // 语义是"禁止再选选项"），必须用 !showingAnswer 排除，否则已答题无法滑动切题。
    if ((this.answering && !this.showingAnswer) || this.navigating) return;
    const tc = e.changedTouches[0];
    const dx = tc.clientX - this.swipeX0;
    const dy = tc.clientY - this.swipeY0;
    if (Math.abs(dx) < 45 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    const now = Date.now();
    if (now - this.swipeLastTrigger < 400) return;
    this.swipeLastTrigger = now;
    if (dx < 0) {
      void this.nextQuestion();
    } else {
      void this.prevQuestion();
    }
  }

  /** 打开刷题进度弹窗：列表顺序/筛选与当前视图一致，点击行跳转。 */
  private openProgressModal(): void {
    // L4: 防重入——弹窗已打开时忽略再次点击
    if (this.progressModalOpen) return;
    this.progressModalOpen = true;
    const modal = new ProgressModal(this.app, {
      questions: this.filteredQuestions,
      answeredQuestions: this.answeredQuestions,
      memoryCards: this.memoryCards,
      currentId: this.filteredQuestions[this.currentIndex]?.id ?? null,
      onJump: (id: string) => {
        const idx = this.filteredQuestions.findIndex((q) => q.id === id);
        if (idx < 0) {
          new Notice("该题不在当前列表");
          return;
        }
        this.currentIndex = idx;
        this.currentShuffledQId = null;
        this.cancelAutoNext();
        this.renderQuestion();
        this.saveState();
      },
    });
    // L4: ProgressModal 未自定义 onClose（基类 onClose 无副作用），
    // 覆盖实例 onClose 在任意关闭路径（点空白/Esc/点击行）后复位防重入标志
    modal.onClose = () => {
      this.progressModalOpen = false;
    };
    modal.open();
  }

  private updateProgress(): void {
    const total = this.filteredQuestions.length;
    const current =
      total > 0 && this.currentIndex >= 0
        ? this.currentIndex + 1
        : 0;
    this.progressEl.textContent = `进度: ${current}/${total}`;

    // 练习模式：显示本次会话统计（不展示全局统计）
    if (this.practiceActive || this.memoryActive) {
      this.statsEl.textContent = `✅ ${this.practiceCorrect}  ❌ ${this.practiceWrong}`;
      const answered = this.practiceCorrect + this.practiceWrong;
      if (answered > 0) {
        const rate = ((this.practiceCorrect / answered) * 100).toFixed(1);
        this.statsEl.textContent += `  (${rate}%)`;
      }
      return;
    }

    this.statsEl.textContent = `✅ ${this.correctCount}  ❌ ${this.wrongCount}`;
    const totalAnswered = this.correctCount + this.wrongCount;
    if (totalAnswered > 0) {
      const rate = ((this.correctCount / totalAnswered) * 100).toFixed(1);
      this.statsEl.textContent += `  (${rate}%)`;
    }
  }

  /** 重新计算筛选结果并定位指定题目的新位置（题目被筛掉时回退到第一题/空状态）。 */
  private reFilterAndLocate(questionId: string): void {
    // 练习模式：练习集为固定随机快照，只在练习集内定位，不重建列表
    if (this.practiceActive || this.memoryActive) {
      const idx = this.filteredQuestions.findIndex((q) => q.id === questionId);
      this.currentIndex = idx >= 0 ? idx : 0;
      return;
    }
    this.filteredQuestions = this.applyFiltersTo(this.orderedQuestions);
    const idx = this.filteredQuestions.findIndex((q) => q.id === questionId);
    if (idx >= 0) {
      this.currentIndex = idx;
    } else if (this.filteredQuestions.length > 0) {
      this.currentIndex = 0;
    } else {
      this.currentIndex = -1;
    }
  }

  private async saveCurrentEdit(): Promise<void> {
    if (this.filteredQuestions.length === 0 || this.currentIndex < 0) return;

    const question = this.filteredQuestions[this.currentIndex];
    const previousId = question.id;
    const editInputs = Array.from(
      this.editArea.querySelectorAll<HTMLInputElement>(".csv-quiz-edit-input")
    );

    const q = question as unknown as Record<string, string>;
    const changedFields: Array<{ field: string; oldValue: string }> = [];

    for (const input of editInputs) {
      const field = input.dataset.field;
      if (!field) continue;

      const value = input.value;
      if (q[field] !== value) {
        changedFields.push({ field, oldValue: q[field] });
        q[field] = value;
      }
    }

    if (changedFields.length === 0) return;

    // 写入 sidecar meta（内存操作 + 调度保存，无失败路径）；只写实际变更的字段
    // （编辑区字段均为 tags/category1-3，属于合法 meta 字段名）
    this.saveQuestionMeta(
      question,
      changedFields.map((c) => c.field) as Array<
        | "repeat"
        | "tags"
        | "category1"
        | "category2"
        | "category3"
        | "favorite"
        | "mastered"
        | "wrong"
      >
    );

    // Re-apply filters since tags/categories may have changed
    this.reFilterAndLocate(previousId);

    this.saveState();
    new Notice("修改已保存");
  }

  /**
   * 导出合并：把 sidecar meta 中 B 类覆盖（repeat/tags/category1-3）下沉写回 CSV 列，
   * 写成功后清除对应 sidecar 的 B 类覆盖（合并即同步）。C 类（favorite/mastered/wrong）
   * 永不导出（无 CSV 落点，只存 sidecar）。仅 CSV 模式可用。返回成功与否。
   */
  async exportMetaToCsv(): Promise<boolean> {
    // 1. 仅 CSV 模式
    if (this.csvPath.toLowerCase().endsWith(".cqv")) {
      new Notice("编译产物模式不支持导出合并");
      return false;
    }

    // 2. 收集含 B 类覆盖（repeat/tags/category1-3 任一存在）且存在于当前题库的题
    const meta = this.stateManager.getMeta();
    const exported: Array<{ id: string; question: Question }> = [];
    for (const [id, entry] of Object.entries(meta)) {
      if (!entry) continue;
      const hasB =
        entry.repeat !== undefined ||
        entry.tags !== undefined ||
        entry.category1 !== undefined ||
        entry.category2 !== undefined ||
        entry.category3 !== undefined;
      if (!hasB) continue;
      const q = this.allQuestions.find((x) => x.id === id);
      if (!q) continue; // 当前题库不存在的题跳过
      exported.push({ id, question: q });
    }
    if (exported.length === 0) {
      new Notice("没有需要导出的修改");
      return true;
    }

    // 3. 单次入队：解析当前 CSV，仅下沉 B 类列（tags=7/cat1=8/cat2=9/cat3=10/repeat=13），
    //    C 类列（favorite=11/mastered=12/wrong=14）保持原样，不写入。
    try {
      await this.csvWriteQueue.enqueue(this.csvPath, (csvContent: string) => {
        const result = Papa.parse(csvContent, {
          header: false,
          skipEmptyLines: true,
        });
        if (result.errors.length > 0) {
          console.warn(
            "CSV 解析警告: 检测到解析错误",
            result.errors.slice(0, 3)
          );
        }
        const rows = result.data as string[][];
        if (rows.length < 2) throw new Error("CSV 中未找到对应题号");
        const header = rows[0];
        if (header.length > 0) {
          header[0] = header[0].replace(/^\uFEFF/, "");
        }
        const dataRows = rows.slice(1);
        const rowById = new Map<string, number>();
        for (let i = 0; i < dataRows.length; i++) {
          const id = String(dataRows[i][0] || "").trim();
          if (id === "") continue;
          if (rowById.has(id)) {
            throw new Error("CSV 中题号重复，已拒绝写入，请检查题库");
          }
          rowById.set(id, i);
        }
        for (const { id, question } of exported) {
          const idx = rowById.get(id);
          if (idx === undefined) {
            throw new Error(`CSV 中未找到对应题号: ${id}`);
          }
          const row = dataRows[idx];
          if (row.length < 14) row.length = 14; // 补齐缺失列，避免写入越界
          row[7] = question.tags;
          row[8] = question.category1;
          row[9] = question.category2;
          row[10] = question.category3;
          row[13] = question.repeat;
        }
        return Papa.unparse([header, ...dataRows], { delimiter: "," });
      });
    } catch (e: unknown) {
      console.error("CSV Quiz: Failed to export meta to CSV", e);
      new Notice(`导出失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }

    // 4. 成功后清除 B 类覆盖（保留 C 类）；条目为空则删除整条。直接改 meta 内部引用。
    let cleared = 0;
    for (const { id } of exported) {
      const entry = meta[id];
      if (!entry) continue;
      delete entry.repeat;
      delete entry.tags;
      delete entry.category1;
      delete entry.category2;
      delete entry.category3;
      if (Object.keys(entry).length === 0) {
        delete meta[id];
      }
      cleared++;
    }
    // 落盘（绕过视图守卫，确保 meta 清理持久化）
    this.stateManager.scheduleSave(this.buildCurrentState(), 0);

    new Notice(`已导出 ${cleared} 题的修改到 CSV`);
    return true;
  }

  /**
   * 编译当前 CSV 题库为 .cqv 分发产物（编辑者工具）。校验失败拒编。
   * 需先输入备注（随产物头部分发，可为空）。返回成功与否。
   */
  async compileToCqv(): Promise<boolean> {
    // 1. 仅 CSV 模式
    if (this.csvPath.toLowerCase().endsWith(".cqv")) {
      new Notice("仅 CSV 题库可编译为产物");
      return false;
    }

    // 2. 读当前 CSV（直接读文件，不做 meta 合并——产物含 A + B 类默认值）
    let questions: Question[];
    try {
      const csvContent = await readCSVFile(this.vault, this.csvPath);
      questions = parseCSV(csvContent);
    } catch (e: unknown) {
      console.error("CSV Quiz: Failed to read CSV for compile", e);
      new Notice(`读取题库失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }

    // 3. 校验 id 质量：空/重复题号拒编
    const { emptyIds, duplicateIds } = checkIdQuality(questions);
    if (emptyIds.length > 0 || duplicateIds.length > 0) {
      const parts: string[] = [];
      if (emptyIds.length > 0) parts.push(`空题号 ${emptyIds.length} 个`);
      if (duplicateIds.length > 0) {
        parts.push(
          `重复题号: ${duplicateIds.slice(0, 5).join(", ")}${duplicateIds.length > 5 ? "…" : ""}`
        );
      }
      new Notice(`编译已拒绝：题库存在${parts.join("、")}，请修改 CSV 后重试`);
      return false;
    }
    if (questions.length === 0) {
      new Notice("题库为空，无法编译");
      return false;
    }

    // 4. 请求备注（可为空；取消则中止）
    const note = await askPrompt(this.app, {
      title: "优化题库",
      message: "为编译产物添加一句备注（随产物分发，可为空）：",
      placeholder: "例如：v2 修订部分答案",
    });
    if (note === null) return false;

    // 5. 产物路径：扩展名 .csv（大小写不敏感，如 .CSV/.Csv）替换为 .cqv；
    //    无扩展名路径直接拼接（"题库" → "题库.cqv"）
    const lower = this.csvPath.toLowerCase();
    const cqvPath = lower.endsWith(".csv")
      ? this.csvPath.slice(0, this.csvPath.length - 4) + ".cqv"
      : this.csvPath + ".cqv";

    // 6. 编码 + 7. 写入（原子写：先写 tmp，rename 覆盖；Obsidian rename 不覆盖目标，需先删旧文件）
    try {
      const buffer = encodeCqv(questions, {
        sourceCsv: this.csvPath,
        note,
      });
      const tmpPath = cqvPath + ".tmp";
      await this.vault.adapter.writeBinary(tmpPath, buffer);
      // L10: remove 后 rename 失败的极端窗口内旧产物丢失（产物无 .bak 兜底，
      // 与 sidecar 写路径同款风险，接受）
      if (await this.vault.adapter.exists(cqvPath)) {
        await this.vault.adapter.remove(cqvPath);
      }
      await this.vault.adapter.rename(tmpPath, cqvPath);
    } catch (e: unknown) {
      console.error("CSV Quiz: Failed to compile .cqv", e);
      new Notice(`编译失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }

    new Notice(
      `已生成 ${cqvPath}（${questions.length} 题），可在设置中选择该文件切换为题库来源`
    );
    return true;
  }

  async refresh(): Promise<void> {
    // M2: 记录本次加载世代号（新流程开始会自增，使本流程过期）
    const epoch = ++this.loadEpoch;
    this.canPersistState = false;
    await this.saveCurrentEdit();
    // F1: 保存编辑期间视图被关闭 → 中止。onClose 已保存进度；恢复
    // canPersistState 为刷新前的值（true），已关闭视图不会因此触发任何写盘。
    if (this.isClosed) {
      this.canPersistState = true;
      return;
    }
    // M2: 期间已开始新加载流程 → 本流程过期
    if (epoch !== this.loadEpoch) return;
    this.cancelAutoNext();
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    const settings = this.getSettings();
    this.csvPath = settings.csvPath;

    // S1: 判定本次刷新语义——切换题库（内容源变了，含 changeQuizPath 已 unloadSidecar
    // 使 contentPath 为 null 的情况）或同一题库的重置刷新。
    // 注意：不能用 task 提示的 `!== null && !== csvPath` 公式——changeQuizPath 先调用
    // unloadSidecar 把 contentPath 置 null，按旧公式会漏判主切换流导致目标题库进度被清空。
    const wasSwitching =
      this.stateManager.getContentPath() !== this.csvPath;
    // T4: 切换题库时 contentMtimeMs 是旧题库的 mtime，先清空避免跨文件误报
    // 「题库文件已更新」；切换后首次加载只记录新题库 mtime（不对比）。
    if (wasSwitching) {
      this.contentMtimeMs = null;
    }

    try {
      const questions = await this.readQuestionsFromSource();
      // F1: 读文件期间视图被关闭 → 中止，阻止后续 clearState 覆盖 onClose 已保存的进度
      if (this.isClosed) {
        this.canPersistState = true;
        return;
      }
      // M2: 读文件期间已切换 → 本流程过期
      if (epoch !== this.loadEpoch) return;
      if (!questions) {
        // 读取失败：readQuestionsFromSource 已提示；保持只读 + 重启心跳
        this.startAutoSave();
        return;
      }
      this.allQuestions = questions;
      // id 质量门槛：空/重复题号拒绝刷新（不清除已有 sidecar 状态）
      const { emptyIds, duplicateIds } = checkIdQuality(this.allQuestions);
      if (emptyIds.length > 0 || duplicateIds.length > 0) {
        const parts: string[] = [];
        if (emptyIds.length > 0) parts.push(`空题号 ${emptyIds.length} 个`);
        if (duplicateIds.length > 0) {
          parts.push(
            `重复题号: ${duplicateIds.slice(0, 5).join(", ")}${duplicateIds.length > 5 ? "…" : ""}`
          );
        }
        this.showError(`题库存在${parts.join("、")}，请修改 CSV 后重试`);
        this.startAutoSave();
        return;
      }
      if (this.allQuestions.length === 0) {
        // V1: 题库为空时不清除已保存的进度（与 loadQuestions 的空题库路径保持一致），
        // 避免用户误触「重置」或更换到空文件时静默清空旧进度。
        this.showError("题库文件中没有找到题目数据");
        // F6: 空题库 early-return 路径也重启心跳（canPersistState 仍为 false，保持只读，
        // 避免把半重置状态写回磁盘；startAutoSave 内部有 isClosed/canPersistState 守卫）
        this.startAutoSave();
        return;
      }
      this.canPersistState = true;

      // 3B: 内容源 mtime 变更检测（refresh 同样记录/对比，变化则提示）
      const stat = await this.vault.adapter.stat(this.csvPath);
      const newMtime = stat?.mtime ?? null;
      if (
        this.contentMtimeMs !== null &&
        newMtime !== null &&
        newMtime !== this.contentMtimeMs
      ) {
        new Notice("题库文件已更新，状态已按题目对齐");
      }
      this.contentMtimeMs = newMtime;
      // M2: stat 期间已切换 → 本流程过期
      if (epoch !== this.loadEpoch) return;

      // 载入目标题库的 sidecar 状态（切换语义：恢复其已有进度；重置语义：重新载入空状态）。
      // 切换时旧题库状态已在 changeQuizPath 的 unloadSidecar 落盘，无需 clearState。
      if (!wasSwitching && this.stateManager.getContentPath() === this.csvPath) {
        // 同一题库的重置刷新（全部重置语义）：写空 sidecar 保留文件 + 清 meta/state
        await this.stateManager.clearState();
        // F1: clearState 期间视图被关闭 → 中止（onClose 已保存进度）
        if (this.isClosed) {
          this.canPersistState = true;
          return;
        }
        // M2: clearState 期间已切换 → 本流程过期
        if (epoch !== this.loadEpoch) return;
      }

      const loadResult = await this.stateManager.loadSidecar(this.csvPath, {
        favorite: settings.defaultFilterFavorite,
        mastered: settings.defaultFilterMastered,
        repeat: settings.defaultFilterRepeat,
        wrong: settings.defaultFilterWrong,
      });
      // F1: loadSidecar 期间视图被关闭 → 中止
      if (this.isClosed) {
        this.canPersistState = true;
        return;
      }
      // M2: loadSidecar 期间已切换 → 本流程过期
      if (epoch !== this.loadEpoch) return;
      // S3: corrupt 不静默重建（对齐 initializeFromState）：提示、保持只读、不落盘
      if (loadResult.status === "corrupt") {
        this.showError("状态文件与备份均损坏，请重置刷题进度或删除状态文件后重试");
        this.canPersistState = false;
        this.startAutoSave();
        return;
      }

      // 对齐清理 sidecar meta 中已不存在的僵尸条目（替换产物后 id 变化时）
      this.pruneMetaEntries();
      // 合并 meta 覆盖层到题目（meta 优先，永久遮蔽语义）
      this.applyMetaToQuestions();

      // H1: 刷新会重建题库与进度，必须复位练习模式标志，避免常规模式答题误写记忆卡片
      // （exit* 内部有 active 检查，未激活时无副作用；此处 orderedQuestions 已重建，applyFiltersTo 结果会被下方重置覆盖）
      this.exitRandomPractice();
      this.exitMemoryPractice();

      if (wasSwitching) {
        // S1: 切换题库 → 恢复新题库已存进度（含已存筛选；无 sidecar 时为空状态+默认筛选）
        this.applyRestore(settings, loadResult.state);
      } else {
        // 同一题库重置刷新：Fresh start（重置进度，筛选回到默认值）
        this.applyFreshStart(settings, loadResult.state);
      }

      // Update filter UI
      this.updateFilterUI();

      this.renderQuestion();
      // M2: saveState 前最后检查，防止过期流程把空状态写入已切换的题库
      if (epoch !== this.loadEpoch) return;
      this.saveState();
      this.startAutoSave();
      // 3D: 状态栏立即刷新为新题库的待复习数
      (this.plugin as unknown as { refreshMemoryReminder?: () => void })
        .refreshMemoryReminder?.();
      new Notice(wasSwitching ? "已切换题库" : "已刷新，重新开始");
    } catch (e: unknown) {
      console.error("CSV Quiz: Refresh failed", e);
      this.showError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`);
      // F6: 刷新失败后视图保持只读（不恢复 canPersistState，避免把陈旧/半重置状态
      // 写回磁盘），但重启心跳以维持视图可响应
      this.startAutoSave();
    }
  }

  private showError(message: string): void {
    this.questionArea.empty();
    this.questionArea.createEl("p", {
      text: message,
      cls: "csv-quiz-error",
    });
  }

  private getSettings(): PluginSettings {
    return (this.plugin as { settings: PluginSettings }).settings;
  }

  private buildCurrentState(): QuizSessionState {
    // 练习模式为临时会话：保存时把 currentIndex 换算回常规模式的位置，
    // 重开面板后恢复到练习前的位置
    let savedIndex = this.currentIndex;
    if (this.practiceActive || this.memoryActive) {
      if (this.practiceFocusId) {
        const idx = this.applyFiltersTo(this.orderedQuestions).findIndex(
          (q) => q.id === this.practiceFocusId
        );
        savedIndex = idx >= 0 ? idx : 0;
      } else {
        savedIndex = 0;
      }
    }
    return {
      csvPath: this.csvPath,
      currentIndex: savedIndex,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      displayOrder: this.displayOrder,
      filterText: this.filterText,
      filterTags: this.filterTags,
      filterCat1: this.filterCat1,
      filterCat2: this.filterCat2,
      filterCat3: this.filterCat3,
      filterFavorite: this.filterFavorite,
      filterMastered: this.filterMastered,
      filterRepeat: this.filterRepeat,
      filterWrong: this.filterWrong,
      filterUnanswered: this.filterUnanswered,
      answeredQuestions: this.answeredQuestions,
      memoryCards: this.memoryCards,
      // M1: 每日新题配额随进度持久化（跨会话/跨天保持一致）
      memoryNewDate: this.memoryNewDate,
      memoryNewCountToday: this.memoryNewCountToday,
      // A1: 当日已选未答的新题 id 随进度持久化
      memoryPendingNew: this.memoryPendingNew,
      // C-1: 记忆练习初始化标记随进度持久化
      memoryInitialized: this.memoryInitialized,
    };
  }

  /** 引用字段浅拷贝快照：供脏检查基准使用。
   *  buildCurrentState 对 memoryCards/answeredQuestions/displayOrder 是引用传递，
   * 若基准直接保存引用会与实时状态共享对象，quizStateEquals 深比较同一对象恒等，
   * 心跳兜底写盘将永远跳过（仅记忆卡片/答题记录变化时进度丢失且无法自愈）。 */
  private snapshotState(state: QuizSessionState): QuizSessionState {
    return {
      ...state,
      displayOrder: [...state.displayOrder],
      answeredQuestions: { ...state.answeredQuestions },
      memoryCards: state.memoryCards ? { ...state.memoryCards } : state.memoryCards,
    };
  }

  private saveState(): void {
    // V2: 视图关闭后（含 in-flight 的 initializeFromState 迟到完成）禁止写盘，
    // 避免用陈旧状态覆盖磁盘进度。onClose 走的是 saveStateImmediately，不受影响。
    if (this.isClosed) return;
    if (!this.canPersistState) return;
    const state = this.buildCurrentState();
    // F4: 记录脏检查基准（已排队或已写入磁盘的状态快照）
    this.lastSavedState = this.snapshotState(state);
    this.stateManager.scheduleSave(state, 300);
  }
}
