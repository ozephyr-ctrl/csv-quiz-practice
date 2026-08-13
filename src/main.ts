import { Plugin, Notice, addIcon } from "obsidian";
import {
  PluginSettings,
  PluginData,
  VIEW_TYPE_QUIZ,
  DEFAULT_SETTINGS,
} from "./types";
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

    // 阶段 4：迁移旧版进度——data.json.quizState → 当前 csvPath 的 sidecar（无视图场景）
    try {
      const result = await this.stateManager.migrateLegacyState(
        this.settings.csvPath,
        {
          favorite: this.settings.defaultFilterFavorite,
          mastered: this.settings.defaultFilterMastered,
          repeat: this.settings.defaultFilterRepeat,
          wrong: this.settings.defaultFilterWrong,
        }
      );
      if (result.status === "migrated") {
        new Notice("旧版刷题进度已迁移至新格式");
      } else if (result.status === "rejected") {
        const tips: Record<string, string> = {
          "csv-missing": "题库文件不存在，无法迁移旧进度",
          "csv-read-error": "题库文件读取失败，无法迁移旧进度",
          "bad-id": "题库文件存在空题号或重复题号，无法迁移旧进度，请修正后重试",
          "path-mismatch": "旧进度所属题库与当前设置不一致，无法迁移（可恢复旧路径后重试）",
          "bad-state": "旧版进度数据损坏，无法迁移，已跳过",
        };
        new Notice(`旧版刷题进度迁移被拒绝：${tips[result.reason]}`);
      }
    } catch (e) {
      console.error("CSV Quiz: 迁移旧进度失败", e);
    }

    this.registerView(VIEW_TYPE_QUIZ, (leaf) => {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ);
      if (existing.length > 0 && existing[0] !== leaf) {
        leaf.detach();
        this.app.workspace.setActiveLeaf(existing[0], { focus: true });
        return new QuizView(leaf, this, this.stateManager, this.app.vault, this.csvWriteQueue);
      }
      return new QuizView(leaf, this, this.stateManager, this.app.vault, this.csvWriteQueue);
    });

    // 自定义「题」字图标（addIcon 注册的 SVG 随主题 currentColor 着色）
    addIcon(
      "cqv-ti",
      '<text x="50" y="70" text-anchor="middle" font-size="76" font-weight="700" font-family="sans-serif" fill="currentColor">题</text>'
    );
    const ribbonIconEl = this.addRibbonIcon("cqv-ti", "刷题啊", () => {
      void this.activateView();
    });
    // 常驻柔和彩色（styles.css 中 .cqv-ribbon-icon 定义）
    ribbonIconEl.addClass("cqv-ribbon-icon");

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
    // L7: 迁移会清空内存状态（currentState 为 null）；异步载入当前题库 sidecar
    // 后刷新状态栏提醒，避免迁移后提醒失效直到首次打开面板
    void this.ensureSidecarLoaded().then(() => this.updateMemoryReminder());
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
   * 题库路径变更入口：当前视图有 sidecar 状态时弹轻量确认（信息性，防误切），
   * 确认后切换（切换即落盘：unloadSidecar flush 当前 sidecar 再重载新题库）。
   * 无状态（新题库首次使用）直接切换。未变化时直接忽略。
   */
  async changeQuizPath(newPath: string): Promise<void> {
    if (newPath === this.settings.csvPath) return;
    const prevPath = this.settings.csvPath;
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view && view.hasLoadedState()) {
      const confirmed = await view.confirmQuizSwitch(newPath);
      if (!confirmed) return;
    }
    this.settings.csvPath = newPath;
    await this.saveSettings();
    // 切换即落盘：flush 当前 sidecar 并清空 contentPath，避免刷新时误清旧题库状态
    try {
      await this.stateManager.unloadSidecar();
    } catch (e) {
      // T1: 旧题库状态保存失败时中止切换并回滚设置，避免「设置指向新路径、
      // 视图停留旧题库」的不一致状态
      console.error("CSV Quiz: 切换题库前保存当前进度失败", e);
      new Notice("当前进度保存失败，已中止切换题库");
      this.settings.csvPath = prevPath;
      await this.saveSettings();
      return;
    }
    this.refreshQuiz();
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
        settings: { ...DEFAULT_SETTINGS },
        quizState: null,
      };

    const raw = (data.settings &&
      typeof data.settings === "object"
      ? data.settings
      : {}) as Partial<PluginSettings>;

    // 数值字段用 Number() + isNaN 校验，类型错误（如 "abc"）回退默认值；
    // null/undefined 保持原有 ?? 语义回退默认值。
    const toNumber = (v: unknown, fallback: number): number => {
      if (v === null || v === undefined) return fallback;
      const n = Number(v);
      return Number.isNaN(n) ? fallback : n;
    };

    // L3: 以 DEFAULT_SETTINGS 为基座合并（单一默认值来源）；过滤 null/undefined
    // 值，使布尔/字符串字段保持原有「?? 默认值」语义（与手写默认值行为等价）。
    const clean: Partial<PluginSettings> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== null && v !== undefined) {
        Object.assign(clean, { [k]: v });
      }
    }

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...clean,
      csvPath: (raw.csvPath as string | undefined) || DEFAULT_SETTINGS.csvPath,
      autoNextDelay: toNumber(
        raw.autoNextDelay,
        DEFAULT_SETTINGS.autoNextDelay
      ),
      memoryDailyNew: toNumber(
        raw.memoryDailyNew,
        DEFAULT_SETTINGS.memoryDailyNew
      ),
      swipeNavigation:
        typeof raw.swipeNavigation === "boolean"
          ? raw.swipeNavigation
          : DEFAULT_SETTINGS.swipeNavigation,
    };
  }

  async saveSettings(): Promise<void> {
    this.updateMemoryReminder();
    await this.stateManager.saveSettings(this.settings);
  }

  async flushSettingsSave(): Promise<void> {
    await this.stateManager.flushSettingsSave();
  }

  /** 确保当前题库的 sidecar 状态已载入内存（无视图时面板未载入）。返回是否可用。 */
  private async ensureSidecarLoaded(): Promise<boolean> {
    const st = this.stateManager.getState();
    if (st !== null && this.stateManager.getContentPath() === this.settings.csvPath) {
      return true;
    }
    // 未载入或路径不匹配（含面板从未打开 contentPath=null）：按当前设置载入。
    // loadSidecar 会正确设置 contentPath/currentState；corrupt 仍安全拒绝。
    const res = await this.stateManager.loadSidecar(this.settings.csvPath, {
      favorite: this.settings.defaultFilterFavorite,
      mastered: this.settings.defaultFilterMastered,
      repeat: this.settings.defaultFilterRepeat,
      wrong: this.settings.defaultFilterWrong,
    });
    return res.status !== "corrupt";
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
        // M5: 无视图时 sidecar 状态未载入（currentState 为 null），先确保载入
        if (!(await this.ensureSidecarLoaded())) {
          new Notice("无法加载题库状态，请先打开刷题面板");
          return;
        }
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
    // 全部重置（choice 省略或 "all"）：清空 sidecar 并刷新面板（重读题库），
    // 供设置页「全部重置」使用
    // W1: 无视图时先确保 sidecar 状态已载入，否则 clearState() 走兼容分支
    // 写 data.json.quizState（而非 sidecar），磁盘 sidecar 原样保留、静默无效
    if (!(await this.ensureSidecarLoaded())) {
      new Notice("无法加载题库状态，请先打开刷题面板");
      return;
    }
    await this.stateManager.clearState();
    this.refreshMemoryReminder();
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
      // M5: 无视图时先确保 sidecar 状态已载入，避免静默 no-op
      if (!(await this.ensureSidecarLoaded())) {
        new Notice("无法加载题库状态，请先打开刷题面板");
        return;
      }
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

  /** 编译当前题库为 .cqv 分发产物（需面板已打开）。 */
  async compileQuizToCqv(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (!view) {
      new Notice("请先打开刷题面板再编译题库");
      return;
    }
    await view.compileToCqv();
  }

  /** 导出 sidecar B 类覆盖到 CSV（需面板已打开）。 */
  async exportQuizMetaToCsv(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (!view) {
      new Notice("请先打开刷题面板再导出");
      return;
    }
    await view.exportMetaToCsv();
  }
}
