import { Plugin, Notice } from "obsidian";
import { PluginSettings, PluginData, VIEW_TYPE_QUIZ } from "./types";
import { CSVQuizSettingTab } from "./settings";
import { QuizView } from "./quizView";
import { StateManager } from "./stateManager";
import { CSVWriteQueue } from "./csvHandler";
import { countDueCards } from "./utils";

export default class CSVQuizPlugin extends Plugin {
  settings: PluginSettings;
  stateManager: StateManager;
  csvWriteQueue: CSVWriteQueue;
  statusBar: HTMLElement;
  memoryReminderTimer: number | null = null;
  private settingTab: CSVQuizSettingTab | null = null;

  async onload(): Promise<void> {
    this.stateManager = new StateManager(this);
    this.csvWriteQueue = new CSVWriteQueue(this.app);

    await this.loadSettings();
    await this.stateManager.loadPluginData(this.settings);

    this.registerView(VIEW_TYPE_QUIZ, (leaf) => {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ);
      if (existing.length > 0 && existing[0] !== leaf) {
        leaf.detach();
        this.app.workspace.setActiveLeaf(existing[0], { focus: true });
        return new QuizView(leaf, this, this.stateManager, this.app.vault, this.csvWriteQueue);
      }
      return new QuizView(leaf, this, this.stateManager, this.app.vault, this.csvWriteQueue);
    });

    this.addRibbonIcon("book-open", "刷题啊", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-quiz-practice",
      name: "打开刷题面板",
      callback: () => {
        void this.activateView();
      },
    });

    this.settingTab = new CSVQuizSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.statusBar = this.addStatusBarItem();
    this.updateMemoryReminder();
    this.memoryReminderTimer = window.setInterval(
      () => this.updateMemoryReminder(),
      5 * 60 * 1000,
    );
  }

  onunload(): void {
    if (this.memoryReminderTimer !== null) {
      window.clearInterval(this.memoryReminderTimer);
      this.memoryReminderTimer = null;
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ);
    for (const leaf of leaves) {
      const view = leaf.view as QuizView;
      if (view && view.onClose) {
        void view.onClose().catch((e: unknown) =>
          console.error("CSV Quiz: failed to close view", e)
        );
      }
    }
    void this.stateManager.flushSettingsSave().catch((e: unknown) =>
      console.error("CSV Quiz: flush settings failed", e)
    );
  }

  activateView(): void {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();

    if (!leaf) {
      leaf = workspace.getLeaf(true);
      void leaf.setViewState({ type: VIEW_TYPE_QUIZ, active: true });
    }

    workspace.setActiveLeaf(leaf, { focus: true });
  }

  refreshQuiz(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    if (leaf) {
      const view = leaf.view as QuizView;
      void view.refresh();
    }
  }

  /**
   * 根据当前状态栏显示「待复习」卡片数提醒；无到期卡片、
   * 无状态或设置关闭时清空文本。
   */
  updateMemoryReminder(): void {
    if (!this.settings || !this.settings.memoryReminder) {
      this.statusBar.setText("");
      return;
    }
    const state = this.stateManager.getState();
    if (!state) {
      this.statusBar.setText("");
      return;
    }
    const dueCount = countDueCards(state.memoryCards);
    this.statusBar.setText(dueCount > 0 ? "🧠 待复习 " + dueCount : "");
  }

  /** 供其他文件（如设置页）在设置变更后立即刷新状态栏提醒。 */
  refreshMemoryReminder(): void {
    this.updateMemoryReminder();
  }

  async loadSettings(): Promise<void> {
    const data: PluginData =
      ((await this.loadData()) as PluginData | null) || {
        settings: {
          csvPath: "题库.csv",
          randomOrder: false,
          randomOptions: false,
          autoNextDelay: 1,
          filterPanelOpen: true,
          editPanelOpen: true,
          defaultFilterFavorite: "",
          defaultFilterMastered: "",
          defaultFilterRepeat: "",
          defaultFilterWrong: "",
          memoryEnabled: true,
          memoryDailyNew: 20,
          memoryReminder: true,
          memoryMarkRating: true,
          swipeNavigation: true,
        },
        quizState: null,
      };

    const rawSettings = (
      data.settings && typeof data.settings === "object" ? data.settings : {}
    ) as Partial<PluginSettings>;

    // 数字字段用 Number() + isNaN 校验，类型错误（如 "abc"）回退默认值；
    // null/undefined 保持原有 ?? 语义回退默认值。
    const toNumber = (v: unknown, fallback: number): number => {
      if (v === null || v === undefined) return fallback;
      const n = Number(v);
      return Number.isNaN(n) ? fallback : n;
    };

    this.settings = {
      csvPath: rawSettings.csvPath || "题库.csv",
      randomOrder: rawSettings.randomOrder ?? false,
      randomOptions: rawSettings.randomOptions ?? false,
      autoNextDelay: toNumber(rawSettings.autoNextDelay, 1),
      filterPanelOpen: rawSettings.filterPanelOpen ?? true,
      editPanelOpen: rawSettings.editPanelOpen ?? true,
      defaultFilterFavorite: rawSettings.defaultFilterFavorite ?? "",
      defaultFilterMastered: rawSettings.defaultFilterMastered ?? "",
      defaultFilterRepeat: rawSettings.defaultFilterRepeat ?? "",
      defaultFilterWrong: rawSettings.defaultFilterWrong ?? "",
      memoryEnabled: rawSettings.memoryEnabled ?? true,
      memoryDailyNew: toNumber(rawSettings.memoryDailyNew, 20),
      memoryReminder: rawSettings.memoryReminder ?? true,
      memoryMarkRating: rawSettings.memoryMarkRating ?? true,
      swipeNavigation:
        typeof rawSettings.swipeNavigation === "boolean"
          ? rawSettings.swipeNavigation
          : true,
    };
  }

  async saveSettings(): Promise<void> {
    this.updateMemoryReminder();
    await this.stateManager.saveSettings(this.settings);
  }

  async flushSettingsSave(): Promise<void> {
    await this.stateManager.flushSettingsSave();
  }

  /**
   * 清除已保存的刷题进度；若面板已打开则立即重建会话。
   * choice 省略或为 "all" 时为「全部重置」语义（清空 data.json 并刷新面板、
   * 重读题库，用于设置页「全部重置」等场景）；
   * 传入 "records"/"cards"/"order" 时为设置页的分项清理（不重载题库、保留筛选）。
   */
  async resetQuizProgress(
    choice?: "records" | "cards" | "order" | "all"
  ): Promise<void> {
    // 分项清理（仅刷题记录 / 仅记忆卡片 / 仅重置顺序）：不重载题库、保留筛选
    if (choice === "records" || choice === "cards" || choice === "order") {
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
      const view = leaf?.view as QuizView | undefined;
      if (view) {
        await view.applyResetChoice(choice);
      } else {
        const state = this.stateManager.getState();
        // 重置顺序时若随机设置开启,自动关闭（避免与 CSV 原始顺序语义冲突）
        let autoOff = false;
        if (state) {
          if (choice === "order") {
            // 顺序下次打开面板时按设置重建
            state.displayOrder = [];
            if (this.settings.randomOrder) {
              this.settings.randomOrder = false;
              await this.saveSettings();
              autoOff = true;
              // M-2: auto-off 后重建设置页 UI，同步随机顺序开关的显示值
              this.syncSettingsUI();
            }
          } else if (choice === "records") {
            state.correctCount = 0;
            state.wrongCount = 0;
            state.answeredQuestions = {};
          } else {
            state.memoryCards = {};
            state.memoryNewDate = "";
            state.memoryNewCountToday = 0;
            state.memoryPendingNew = [];
          }
          await this.stateManager.saveStateImmediately(state);
          // C-2: 面板未打开时也要给用户反馈
          new Notice(
            choice === "order"
              ? autoOff
                ? "题目顺序已重置，重新打开面板时生效，并已自动关闭随机题目顺序"
                : "题目顺序已重置，重新打开面板时生效"
              : choice === "records"
                ? "刷题记录已清理"
                : "记忆卡片已删除"
          );
        }
        this.refreshMemoryReminder();
      }
      return;
    }
    // 全部重置（choice 省略或 "all"）：清空 data.json 并刷新面板（重读题库），
    // 供设置页「全部重置」使用
    await this.stateManager.clearState();
    this.refreshQuiz();
  }

  /**
   * 随机题目顺序开关变更后：保留答题进度重排顺序。
   * 面板打开时由视图就地重排并保存；未打开时清空已存顺序，
   * 下次打开面板时按当前设置重建（buildDisplayOrder 的 savedOrder 不匹配即重建）。
   */
  async reorderQuestions(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view) {
      await view.reorderForRandomSetting();
    } else {
      const state = this.stateManager.getState();
      if (state) {
        state.displayOrder = [];
        await this.stateManager.saveStateImmediately(state);
      }
    }
  }

  /** 「左右滑动切题」开关变更后同步视图（即时生效）。 */
  syncSwipeNavigation(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view) {
      view.syncSwipeNavigation();
    }
  }

  /** 设置被外部（如重置顺序时的 auto-off）改动后，重建设置页 UI 以同步控件显示值。 */
  syncSettingsUI(): void {
    this.settingTab?.display();
  }
}
