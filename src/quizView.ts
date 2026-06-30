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
  VIEW_TYPE_QUIZ,
} from "./types";
import {
  parseCSV,
  generateCSVRow,
  findAndUpdateRow,
  readCSVFile,
  filterQuestions,
  getUniqueTags,
  getUniqueCategories,
  buildDisplayOrder,
  CSVWriteQueue,
} from "./csvHandler";
import { StateManager } from "./stateManager";
import { shuffle, sortByDisplayOrder, quizStateEquals } from "./utils";
import { ChoiceModal } from "./modals";

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

  private filterTags: string = "";
  private filterCat1: string = "";
  private filterCat2: string = "";
  private filterCat3: string = "";
  private filterFavorite: string = "";
  private filterMastered: string = "";
  private filterRepeat: string = "";
  private filterWrong: string = "";

  private csvPath: string = "";

  private answeredQuestions: Record<string, string> = {};
  private currentShuffledQId: string | null = null;
  private currentShuffledOptions: Array<{ key: string; text: string }> = [];
  private answering: boolean = false;
  private showingAnswer: boolean = false;
  private selectedOption: string | null = null;
  private autoNextTimer: number | null = null;
  private autoSaveTimer: number | null = null;
  private isClosed: boolean = false;

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
    this.contentEl.addClass("csv-quiz-container");
    this.contentEl.empty();
    this.buildLayout();

    await this.initializeFromState();
  }

  async onClose(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.cancelAutoNext();
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.stateManager.cancelScheduledSave();
    if (this.stateManager.getState()) {
      await this.stateManager.saveStateImmediately(this.buildCurrentState());
    }
    await this.csvWriteQueue.drain();
  }

  private buildLayout(): void {
    this.contentEl.empty();

    // Progress & stats
    const infoBar = this.contentEl.createDiv("csv-quiz-info-bar");
    this.progressEl = infoBar.createDiv("csv-quiz-progress");
    this.statsEl = infoBar.createDiv("csv-quiz-stats");

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
  }

  private async initializeFromState(): Promise<void> {
    // Capture in-memory progress BEFORE loadPluginData overwrites it with the
    // disk value. This is the "current progress" used to detect external edits.
    const inMemoryState = this.stateManager.getState();
    const pluginData = await this.stateManager.loadPluginData(this.getSettings());
    const settings = pluginData.settings;
    const diskState = pluginData.quizState;

    this.csvPath = settings.csvPath;

    // Build filter panel
    this.buildFilterPanel(settings);

    // 在任何弹窗 await 之前清空内存进度：若用户在弹窗期间关闭标签页，
    // onClose() 会因 getState() 为 null 而跳过保存，避免用默认值覆盖磁盘进度。
    // 成功加载路径末尾的 saveState() 会重新设置正确的 currentState。
    this.stateManager.setState(null);

    // --- 检测刷题进度被外部修改 (data.json) ---
    // 当内存中的当前进度与磁盘进度不一致时，说明 data.json 被外部编辑或同步。
    let effectiveSavedState: QuizSessionState | null = diskState;
    if (inMemoryState && !quizStateEquals(inMemoryState, diskState)) {
      const choice = await this.askExternalModificationChoice(diskState === null);
      if (choice === "current") {
        effectiveSavedState = inMemoryState;
      } else if (choice === "external") {
        effectiveSavedState = diskState;
      } else {
        // 用户取消：不加载题库（currentState 已在弹窗前清空，onClose 不会覆盖磁盘）
        this.showError("已取消加载题库。请重新打开刷题面板。");
        return;
      }
    }

    // --- 检测题库路径变更，需要重置刷题进度 ---
    if (effectiveSavedState && effectiveSavedState.csvPath !== this.csvPath) {
      const reset = await this.askResetChoice();
      if (reset === null) {
        this.showError("已取消加载题库。请重新打开刷题面板。");
        return;
      }
      if (reset === "keep") {
        // 保留旧进度会造成运行异常（题号属于另一个题库）→ 拒绝打开并再次询问
        const again = await this.askResetOrAbort();
        if (again !== "reset") {
          this.showError(
            "题库路径已变更，未重置进度无法正常打开题库。请在设置中点击「重置刷题进度」后重试。"
          );
          return;
        }
      }
      // 执行重置：重新开始刷题，保留筛选条件
      const status = await this.loadQuestions();
      if (status !== "ok") {
        if (status === "error") this.restoreFiltersOnly(effectiveSavedState);
        this.startAutoSave();
        return;
      }
      this.applyFreshStart(settings, effectiveSavedState);
      this.updateFilterUI();
      this.renderQuestion();
      this.saveState();
      this.startAutoSave();
      return;
    }

    // --- 正常加载：恢复进度 或 首次使用 ---
    const status = await this.loadQuestions();
    if (status !== "ok") {
      if (status === "error") this.restoreFiltersOnly(effectiveSavedState);
      this.startAutoSave();
      return;
    }

    if (effectiveSavedState && effectiveSavedState.csvPath === this.csvPath) {
      this.applyRestore(settings, effectiveSavedState);
    } else {
      this.applyFreshStart(settings, effectiveSavedState);
    }
    this.updateFilterUI();
    this.renderQuestion();
    this.saveState();
    this.startAutoSave();
  }

  /** Read and parse the CSV. Returns "ok", "empty" (no questions), or "error". */
  private async loadQuestions(): Promise<"ok" | "empty" | "error"> {
    try {
      const csvContent = await readCSVFile(this.vault, this.csvPath);
      this.allQuestions = parseCSV(csvContent);
      if (this.allQuestions.length === 0) {
        this.showError("CSV 文件中没有找到题目数据");
        return "empty";
      }
      return "ok";
    } catch (e: unknown) {
      console.error("CSV Quiz: Failed to load CSV", e);
      this.showError(`无法加载 CSV 文件: ${e instanceof Error ? e.message : String(e)}`);
      return "error";
    }
  }

  /** Fresh start: keep filters from savedState if present (else defaults), reset progress. */
  private applyFreshStart(
    settings: PluginSettings,
    savedState: QuizSessionState | null
  ): void {
    if (savedState) {
      this.filterTags = savedState.filterTags || "";
      this.filterCat1 = savedState.filterCat1 || "";
      this.filterCat2 = savedState.filterCat2 || "";
      this.filterCat3 = savedState.filterCat3 || "";
      this.filterFavorite = savedState.filterFavorite || "";
      this.filterMastered = savedState.filterMastered || "";
      this.filterRepeat = savedState.filterRepeat || "";
      this.filterWrong = savedState.filterWrong || "";
    } else {
      const s = this.getSettings();
      this.filterFavorite = s.defaultFilterFavorite;
      this.filterMastered = s.defaultFilterMastered;
      this.filterRepeat = s.defaultFilterRepeat;
      this.filterWrong = s.defaultFilterWrong;
    }

    this.displayOrder = buildDisplayOrder(this.allQuestions, settings.randomOrder);
    this.orderedQuestions = sortByDisplayOrder(this.allQuestions, this.displayOrder);
    this.filteredQuestions = filterQuestions(
      this.orderedQuestions,
      this.filterTags,
      this.filterCat1,
      this.filterCat2,
      this.filterCat3,
      this.filterFavorite,
      this.filterMastered,
      this.filterRepeat,
      this.filterWrong
    );
    this.currentIndex = 0;
    this.correctCount = 0;
    this.wrongCount = 0;
    this.answeredQuestions = {};
    this.currentShuffledQId = null;
  }

  /** Restore a full session state whose csvPath matches the current CSV. */
  private applyRestore(
    settings: PluginSettings,
    savedState: QuizSessionState
  ): void {
    this.filterTags = savedState.filterTags || "";
    this.filterCat1 = savedState.filterCat1 || "";
    this.filterCat2 = savedState.filterCat2 || "";
    this.filterCat3 = savedState.filterCat3 || "";
    this.filterFavorite = savedState.filterFavorite || "";
    this.filterMastered = savedState.filterMastered || "";
    this.filterRepeat = savedState.filterRepeat || "";
    this.filterWrong = savedState.filterWrong || "";

    this.displayOrder = buildDisplayOrder(
      this.allQuestions,
      settings.randomOrder,
      savedState.displayOrder
    );
    this.orderedQuestions = sortByDisplayOrder(this.allQuestions, this.displayOrder);
    this.filteredQuestions = filterQuestions(
      this.orderedQuestions,
      this.filterTags,
      this.filterCat1,
      this.filterCat2,
      this.filterCat3,
      this.filterFavorite,
      this.filterMastered,
      this.filterRepeat,
      this.filterWrong
    );

    this.currentIndex = Math.min(
      savedState.currentIndex,
      this.filteredQuestions.length - 1
    );
    if (this.currentIndex < 0) this.currentIndex = 0;

    this.correctCount = savedState.correctCount;
    this.wrongCount = savedState.wrongCount;
    this.answeredQuestions = savedState.answeredQuestions || {};
  }

  /** On CSV load failure: keep filters from saved state so the UI is not blank. */
  private restoreFiltersOnly(savedState: QuizSessionState | null): void {
    if (!savedState) return;
    this.filterTags = savedState.filterTags || "";
    this.filterCat1 = savedState.filterCat1 || "";
    this.filterCat2 = savedState.filterCat2 || "";
    this.filterCat3 = savedState.filterCat3 || "";
    this.filterFavorite = savedState.filterFavorite || "";
    this.filterMastered = savedState.filterMastered || "";
    this.filterRepeat = savedState.filterRepeat || "";
    this.filterWrong = savedState.filterWrong || "";
    this.updateFilterUI();
  }

  /** Periodic auto-save every 5s to protect against sudden app close. */
  private startAutoSave(): void {
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
    }
    this.autoSaveTimer = window.setInterval(() => {
      if (this.stateManager.getState()) {
        this.stateManager.scheduleSave(this.buildCurrentState(), 0);
      }
    }, 5000);
  }

  /** Ask the user whether to keep the in-memory progress or the externally-modified one. */
  private async askExternalModificationChoice(
    diskIsEmpty: boolean
  ): Promise<"current" | "external" | null> {
    const modal = new ChoiceModal(this.app, {
      title: "检测到刷题进度被外部修改",
      message:
        "刷题进度数据（data.json）已被外部编辑或同步，与当前进度不一致。请选择要使用的进度。",
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

  /** Ask the user whether to reset progress after a csvPath change. */
  private async askResetChoice(): Promise<"reset" | "keep" | null> {
    const modal = new ChoiceModal(this.app, {
      title: "题库路径已变更",
      message:
        "已保存的刷题进度属于另一个题库（路径不同）。保留旧进度会导致程序运行异常。是否重置刷题进度？",
      options: [
        {
          label: "重置进度",
          value: "reset",
          description: "清除旧进度，重新开始刷题",
          cta: true,
        },
        {
          label: "保留进度",
          value: "keep",
          description: "尝试保留旧进度（可能导致运行异常）",
        },
      ],
    });
    modal.open();
    const res = await modal.promise;
    if (res === "reset") return "reset";
    if (res === "keep") return "keep";
    return null;
  }

  /** Re-ask after the user insisted on keeping incompatible progress. */
  private async askResetOrAbort(): Promise<"reset" | "abort" | null> {
    const modal = new ChoiceModal(this.app, {
      title: "无法保留旧进度",
      message:
        "旧进度对应的是另一个题库，保留会导致程序运行异常。请重置进度，或取消打开题库。",
      options: [
        {
          label: "重置进度",
          value: "reset",
          description: "清除旧进度，重新开始刷题",
          cta: true,
        },
        {
          label: "取消打开",
          value: "abort",
          description: "不加载题库，保持当前状态",
          danger: true,
        },
      ],
    });
    modal.open();
    const res = await modal.promise;
    if (res === "reset") return "reset";
    if (res === "abort") return "abort";
    return null;
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
  }

  private cat1Select!: HTMLSelectElement;
  private cat2Select!: HTMLSelectElement;
  private cat3Select!: HTMLSelectElement;
  private tagsContainer!: HTMLElement;

  private updateFilterUI(): void {
    if (!this.cat1Select) return;

    const cats = getUniqueCategories(this.allQuestions);

    this.populateSelect(this.cat1Select, cats.cat1, this.filterCat1);
    this.populateSelect(this.cat2Select, cats.cat2, this.filterCat2);
    this.populateSelect(this.cat3Select, cats.cat3, this.filterCat3);

    this.populateTagChips();

    this.syncBoolChips();
  }

  private syncBoolChips(): void {
    const chips = this.filterContainer?.querySelectorAll<HTMLElement>(".csv-quiz-bool-chip");
    if (!chips) return;
    const map: Record<string, string> = {
      filterFavorite: this.filterFavorite,
      filterMastered: this.filterMastered,
      filterRepeat: this.filterRepeat,
      filterWrong: this.filterWrong,
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

  private reFilterForNavigation(): void {
    const prevId = this.filteredQuestions[this.currentIndex]?.id;
    this.filteredQuestions = filterQuestions(
      this.orderedQuestions,
      this.filterTags,
      this.filterCat1,
      this.filterCat2,
       this.filterCat3,
          this.filterFavorite,
          this.filterMastered,
          this.filterRepeat,
          this.filterWrong
       );
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
    this.filteredQuestions = filterQuestions(
      this.orderedQuestions,
      this.filterTags,
      this.filterCat1,
      this.filterCat2,
       this.filterCat3,
          this.filterFavorite,
          this.filterMastered,
          this.filterRepeat,
          this.filterWrong
       );
    this.currentIndex = this.filteredQuestions.length > 0 ? 0 : -1;
    this.currentShuffledQId = null;
    this.cancelAutoNext();
    this.renderQuestion();
    this.saveState();
  }

  private renderQuestion(): void {
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

    // Restore answer state if this question was previously answered
    const prevAnswer = this.answeredQuestions[question.id];
    if (prevAnswer) {
      this.selectedOption = prevAnswer;
      this.showingAnswer = true;
      this.answering = true;
    } else {
      this.selectedOption = null;
      this.showingAnswer = false;
      this.answering = false;
    }

    // Stem with Markdown rendering
    const stemDiv = this.questionArea.createDiv("csv-quiz-stem");
    MarkdownRenderer.render(this.app, question.stem, stemDiv, "", this).catch(
      (e: unknown) => console.error("CSV Quiz: markdown render failed", e)
    );

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
    const correctDisplayIdx = displayOptions.findIndex(
      (o) => o.key === question.answer
    );
    const correctDisplayLetter =
      correctDisplayIdx >= 0
        ? String.fromCharCode(65 + correctDisplayIdx)
        : question.answer;

    for (let i = 0; i < displayOptions.length; i++) {
      const opt = displayOptions[i];
      const displayLetter = String.fromCharCode(65 + i);

      const optDiv = optionsDiv.createDiv(
        "csv-quiz-option" +
          (this.selectedOption === opt.key ? " csv-quiz-option-selected" : "") +
          (this.showingAnswer && opt.key === question.answer
            ? " csv-quiz-option-correct"
            : "") +
          (this.showingAnswer &&
          this.selectedOption === opt.key &&
          opt.key !== question.answer
            ? " csv-quiz-option-wrong"
            : "")
      );

      const radio = optDiv.createEl("input", {
        type: "radio",
        attr: { name: "quiz-option", id: `opt-${opt.key}` },
      });
      radio.value = opt.key;
      radio.checked = this.selectedOption === opt.key;

      const label = optDiv.createEl("label", {
        attr: { for: `opt-${opt.key}` },
      });
      label.createSpan({
        text: `${displayLetter}. ${opt.text}`,
      });

      if (!this.answering && !this.showingAnswer) {
        optDiv.addEventListener("click", () => {
          void this.handleAnswer(opt.key);
        });
      }
    }

    // Feedback
    this.renderFeedback(question, correctDisplayLetter);

    // Checkbox area
    this.renderCheckboxArea(question);

    // Read-only tags/categories
    this.readOnlyArea.empty();
    const tagsChips = this.readOnlyArea.createSpan({ cls: "csv-quiz-readonly-tags" });
    tagsChips.createEl("strong", { text: "标签:  " });
    const tagText = question.tags || "（无）";
    for (const tag of tagText.split(/\s+/).filter(Boolean)) {
      tagsChips.createEl("span", { text: tag, cls: "csv-quiz-tag-chip csv-quiz-tag-chip-selected" });
    }
    const catText = `  |  一级: ${question.category1 || "（无）"}  |  二级: ${question.category2 || "（无）"}  |  三级: ${question.category3 || "（无）"}`;
    this.readOnlyArea.createSpan({ text: catText, cls: "csv-quiz-readonly-cats" });

    // Edit area for tags/categories (moved below filter)
    this.renderEditArea(question);

    // Navigation
    this.updateNavigation();
  }

  private renderFeedback(
    question: Question,
    correctDisplayLetter: string
  ): void {
    this.feedbackArea.empty();

    if (!this.showingAnswer) return;

    const isCorrect = this.selectedOption === question.answer;

    const feedbackDiv = this.feedbackArea.createDiv(
      `csv-quiz-feedback-text ${
        isCorrect ? "csv-quiz-correct" : "csv-quiz-incorrect"
      }`
    );
    feedbackDiv.createEl("strong", {
      text: isCorrect ? "✓ 正确!" : "✗ 错误!",
    });

    if (!isCorrect) {
      feedbackDiv.createEl("span", {
        text: ` 正确答案: ${correctDisplayLetter}`,
      });
    }
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
        q[f.key] = cb.checked ? "1" : "";
        void this.saveQuestionToCSV(question).then(() => { this.saveState(); });
      });
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

    this.answering = true;
    this.selectedOption = selectedKey;

    await this.saveCurrentEdit();

    const question = this.filteredQuestions[this.currentIndex];
    if (!question) {
      this.answering = false;
      return;
    }

    this.showingAnswer = true;

    this.answeredQuestions[question.id] = selectedKey;
    const isCorrect = selectedKey === question.answer;

    if (isCorrect) {
      this.correctCount++;
      this.renderQuestion();

      const settings = this.getSettings();
      if (settings.autoNextDelay > 0) {
        this.autoNextTimer = window.setTimeout(() => {
          void this.nextQuestion();
        }, settings.autoNextDelay * 1000);
      } else {
        this.answering = false;
      }
    } else {
      this.wrongCount++;
      if (question.wrong !== "1") {
        question.wrong = "1";
        await this.saveQuestionToCSV(question);
      }
      this.renderQuestion();
      this.answering = false;
    }

    // Update stats display
    this.updateProgress();
    this.saveState();
  }

  private cancelAutoNext(): void {
    if (this.autoNextTimer !== null) {
      window.clearTimeout(this.autoNextTimer);
      this.autoNextTimer = null;
    }
  }

  private async nextQuestion(): Promise<void> {
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
        return;
      }
    }
    this.currentShuffledQId = null;
    this.cancelAutoNext();
    this.renderQuestion();
    this.saveState();
  }

  private async prevQuestion(): Promise<void> {
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
      })();
    });

    // Next button
    const nextBtn = navInner.createEl("button", {
      text: "下一题 ▶",
      cls: "csv-quiz-btn",
    });
    nextBtn.disabled =
      this.currentIndex >= this.filteredQuestions.length - 1;
    nextBtn.addEventListener("click", () => { void this.nextQuestion(); });

    // Bottom bar: 下一个未答题 + 题号
    this.bottomBar.empty();
    const bottomRow = this.bottomBar.createDiv("csv-quiz-bottom-row");

    const nextUnansweredBtn = bottomRow.createEl("button", {
      text: "下一个未答题",
      cls: "csv-quiz-btn csv-quiz-btn-sm",
    });
    nextUnansweredBtn.addEventListener("click", () => this.goToNextUnanswered());

    const qId = this.filteredQuestions[this.currentIndex]?.id;
    bottomRow.createEl("span", {
      text: qId ? `题号: ${qId}` : "",
      cls: "csv-quiz-q-id-bottom",
    });
  }

  private goToNextUnanswered(): void {
    if (this.filteredQuestions.length === 0) return;
    for (let i = this.currentIndex + 1; i < this.filteredQuestions.length; i++) {
      if (!this.answeredQuestions[this.filteredQuestions[i].id]) {
        this.currentIndex = i;
        this.currentShuffledQId = null;
        this.cancelAutoNext();
        this.renderQuestion();
        this.saveState();
        return;
      }
    }
    new Notice("没有更多未答题");
  }

  private updateProgress(): void {
    const total = this.filteredQuestions.length;
    const current =
      total > 0 && this.currentIndex >= 0
        ? this.currentIndex + 1
        : 0;
    this.progressEl.textContent = `进度: ${current}/${total}`;

    this.statsEl.textContent = `✅ ${this.correctCount}  ❌ ${this.wrongCount}`;
    const totalAnswered = this.correctCount + this.wrongCount;
    if (totalAnswered > 0) {
      const rate = ((this.correctCount / totalAnswered) * 100).toFixed(1);
      this.statsEl.textContent += `  (${rate}%)`;
    }
  }

  private async saveCurrentEdit(): Promise<void> {
    if (this.filteredQuestions.length === 0 || this.currentIndex < 0) return;

    const question = this.filteredQuestions[this.currentIndex];
    const previousId = question.id;
    const editInputs = Array.from(
      this.editArea.querySelectorAll(".csv-quiz-edit-input")
    ) as HTMLInputElement[];

    let changed = false;
    const q = question as unknown as Record<string, string>;

    for (const input of editInputs) {
      const field = input.dataset.field;
      if (!field) continue;

      const value = input.value;
      if (q[field] !== value) {
        q[field] = value;
        changed = true;
      }
    }

    if (changed) {
      await this.saveQuestionToCSV(question);

      // Re-apply filters since tags/categories may have changed
      this.filteredQuestions = filterQuestions(
        this.orderedQuestions,
        this.filterTags,
        this.filterCat1,
        this.filterCat2,
        this.filterCat3,
          this.filterFavorite,
          this.filterMastered,
          this.filterRepeat,
          this.filterWrong
      );

      // Re-find current question position after re-filtering
      const newIndex = this.filteredQuestions.findIndex(
        (q) => q.id === previousId
      );
      if (newIndex >= 0) {
        this.currentIndex = newIndex;
      } else if (this.filteredQuestions.length > 0) {
        this.currentIndex = 0;
      } else {
        this.currentIndex = -1;
      }

      this.saveState();
      new Notice("修改已保存");
    }
  }

  private async saveQuestionToCSV(question: Question): Promise<void> {
    const newRow = generateCSVRow(question);
    try {
      await this.csvWriteQueue.enqueue(this.csvPath, (csvContent: string) => {
        const updatedContent = findAndUpdateRow(csvContent, question.id, newRow);
        if (updatedContent === null) {
          throw new Error("CSV 中未找到对应题号");
        }
        return updatedContent;
      });
    } catch (e: unknown) {
      console.error("CSV Quiz: Failed to save question to CSV", e);
      if (e instanceof Error && e.message === "CSV 中未找到对应题号") {
        new Notice("CSV 中未找到对应题号，修改未保存");
      } else {
        new Notice(`保存到 CSV 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  async refresh(): Promise<void> {
    await this.saveCurrentEdit();
    this.cancelAutoNext();
    if (this.autoSaveTimer !== null) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }

    const settings = this.getSettings();
    this.csvPath = settings.csvPath;

    try {
      const csvContent = await readCSVFile(this.vault, this.csvPath);
      this.allQuestions = parseCSV(csvContent);

      // Clear state completely
      await this.stateManager.clearState();

      // Fresh start
      this.displayOrder = buildDisplayOrder(
        this.allQuestions,
        settings.randomOrder
      );
      this.orderedQuestions = sortByDisplayOrder(
        this.allQuestions,
        this.displayOrder
      );

      this.filterTags = "";
      this.filterCat1 = "";
      this.filterCat2 = "";
      this.filterCat3 = "";
      this.filterFavorite = settings.defaultFilterFavorite;
      this.filterMastered = settings.defaultFilterMastered;
      this.filterRepeat = settings.defaultFilterRepeat;
      this.filterWrong = settings.defaultFilterWrong;

      this.filteredQuestions = filterQuestions(
        this.orderedQuestions,
        this.filterTags,
        this.filterCat1,
        this.filterCat2,
        this.filterCat3,
          this.filterFavorite,
          this.filterMastered,
          this.filterRepeat,
          this.filterWrong
      );

      this.currentIndex = 0;
      this.correctCount = 0;
      this.wrongCount = 0;
      this.answeredQuestions = {};
      this.currentShuffledQId = null;

      // Update filter UI
      this.updateFilterUI();

      this.renderQuestion();
      this.saveState();
      this.startAutoSave();
      new Notice("已刷新，重新开始");
    } catch (e: unknown) {
      console.error("CSV Quiz: Refresh failed", e);
      this.showError(`刷新失败: ${e instanceof Error ? e.message : String(e)}`);
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
    return {
      csvPath: this.csvPath,
      currentIndex: this.currentIndex,
      correctCount: this.correctCount,
      wrongCount: this.wrongCount,
      displayOrder: this.displayOrder,
      filterTags: this.filterTags,
      filterCat1: this.filterCat1,
      filterCat2: this.filterCat2,
      filterCat3: this.filterCat3,
      filterFavorite: this.filterFavorite,
      filterMastered: this.filterMastered,
      filterRepeat: this.filterRepeat,
      filterWrong: this.filterWrong,
      answeredQuestions: this.answeredQuestions,
    };
  }

  private saveState(): void {
    const state = this.buildCurrentState();
    this.stateManager.scheduleSave(state, 300);
  }
}
