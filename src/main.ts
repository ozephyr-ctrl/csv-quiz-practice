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

    this.addSettingTab(new CSVQuizSettingTab(this.app, this));

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
        void view.onClose();
      }
    }
    void this.stateManager.flushSettingsSave();
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
        },
        quizState: null,
      };

    this.settings = {
      csvPath: data.settings.csvPath || "题库.csv",
      randomOrder: data.settings.randomOrder ?? false,
      randomOptions: data.settings.randomOptions ?? false,
      autoNextDelay: data.settings.autoNextDelay ?? 1,
      filterPanelOpen: data.settings.filterPanelOpen ?? true,
      editPanelOpen: data.settings.editPanelOpen ?? true,
      defaultFilterFavorite: data.settings.defaultFilterFavorite ?? "",
      defaultFilterMastered: data.settings.defaultFilterMastered ?? "",
      defaultFilterRepeat: data.settings.defaultFilterRepeat ?? "",
      defaultFilterWrong: data.settings.defaultFilterWrong ?? "",
      memoryEnabled: data.settings.memoryEnabled ?? true,
      memoryDailyNew: data.settings.memoryDailyNew ?? 20,
      memoryReminder: data.settings.memoryReminder ?? true,
      memoryMarkRating: data.settings.memoryMarkRating ?? true,
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
   * 重读题库，用于设置页「全部重置」与开启「随机题目顺序」等场景）；
   * 传入 "records"/"cards" 时为设置页的分项清理（不重载题库、保留筛选）。
   */
  async resetQuizProgress(
    choice?: "records" | "cards" | "all"
  ): Promise<void> {
    // 分项清理（仅刷题记录 / 仅记忆卡片）：不重载题库、保留筛选
    if (choice === "records" || choice === "cards") {
      const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
      const view = leaf?.view as QuizView | undefined;
      if (view) {
        await view.applyResetChoice(choice);
      } else {
        const state = this.stateManager.getState();
        if (state) {
          if (choice === "records") {
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
            choice === "records" ? "刷题记录已清理" : "记忆卡片已删除"
          );
        }
        this.refreshMemoryReminder();
      }
      return;
    }
    // 全部重置（choice 省略或 "all"）：清空 data.json 并刷新面板（重读题库），
    // 供设置页「全部重置」与随机题目顺序开关使用
    await this.stateManager.clearState();
    this.refreshQuiz();
  }
}
