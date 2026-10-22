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
import { normalizeVaultFolder } from "./contentSource";
import {
  manifestAnchorForBank,
  migrateLegacySettings,
  normalizeBankFolder,
  resolveBankSource,
  type BankResolution,
  type ResolvedBankSource,
} from "./bankResolver";
import { sidecarPathFor } from "./sidecar";

/**
 * 归一化「仅用 CSV」记录：只保留 value === "csv" 的字符串键，
 * key 用 normalizeBankFolder 归一（vault 根保留 "/"，空串/非法键丢弃）。
 */
function normalizeBankSingleSources(raw: unknown): Record<string, "csv"> {
  const out: Record<string, "csv"> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== "csv") continue;
    const folder = normalizeBankFolder(key);
    if (folder === "") continue;
    out[folder] = "csv";
  }
  return out;
}

export default class CSVQuizPlugin extends Plugin {
  settings: PluginSettings;
  stateManager: StateManager;
  csvWriteQueue: CSVWriteQueue;
  statusBar: HTMLElement;
  memoryReminderTimer: number | null = null;
  /** 最近一次题库来源解析结果（设置页同步读取）。 */
  bankStatus: BankResolution | null = null;
  private bankMigrated = false;
  private settingTab: CSVQuizSettingTab | null = null;

  async onload(): Promise<void> {
    this.stateManager = new StateManager(this);
    this.csvWriteQueue = new CSVWriteQueue(this.app);

    await this.loadSettings();
    // 3.6.x → 题库文件夹：迁移结果需立即落盘，避免下次启动重复迁移/提示
    if (this.bankMigrated) {
      await this.saveSettings();
      new Notice(
        "已迁移为题库文件夹模式；旧混合配置按仅 CSV 加载，如需图片混排请创建 manifest.json"
      );
    }
    await this.stateManager.loadLegacyQuizState();

    // 阶段 4：迁移旧版进度——data.json.quizState → 旧 csvPath 的 sidecar（无视图场景）
    // 仅图片模式没有 CSV 内容源，旧版 CSV 进度无可迁移目标，直接跳过。
    try {
      if (this.settings.csvPath) {
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
      }
    } catch (e) {
      console.error("CSV Quiz: 迁移旧进度失败", e);
    }

    // 题库来源解析 + 旧内容源 sidecar → 新锚点（manifest/唯一 CSV/图片文件夹）
    await this.migrateContentSidecarToBank();
    // 迁移完成后清空 legacy 路径，避免之后每次启动把旧 sidecar 再次迁移到
    // 当前（可能已切换的）题库锚点。
    if (this.bankMigrated) {
      this.settings.csvPath = "";
      this.settings.imageFolder = "";
      await this.saveSettings();
      this.bankMigrated = false;
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
    void this.ensureSidecarLoaded(false).then(() => this.updateMemoryReminder());
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
   * 解析当前题库文件夹的来源（缓存到 this.bankStatus；force=true 重新扫描）。
   * 解析异常统一转为 error 结果，避免设置页/视图因 IO 异常中断。
   */
  private async resolveBank(force = false): Promise<BankResolution> {
    if (!force && this.bankStatus !== null) return this.bankStatus;
    let res: BankResolution;
    try {
      res = await resolveBankSource(this.app.vault, {
        bankFolder: this.settings.bankFolder,
        bankSingleSources: this.settings.bankSingleSources,
      });
    } catch (e) {
      console.error("CSV Quiz: 解析题库来源失败", e);
      res = {
        status: "error",
        reason: "resolve-failed",
        message: `解析题库来源失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
    this.bankStatus = res;
    return res;
  }

  /**
   * 题库文件夹变更入口：有 sidecar 状态时轻量确认；切换即落盘并刷新。
   * 锚点变化（manifest/唯一 CSV/图片文件夹）时把旧锚点 sidecar 转移到新锚点
   * （保留旧文件，便于回退）。
   * 返回 false 表示用户取消或保存失败（设置已回滚）。
   */
  async changeBankFolder(newFolder: string): Promise<boolean> {
    const next = normalizeBankFolder(newFolder);
    if (next === this.settings.bankFolder && next !== "") return true;

    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view && view.hasLoadedState()) {
      const confirmed = await view.confirmQuizSwitch(next || "（未设置）");
      if (!confirmed) return false;
    }

    const prevFolder = this.settings.bankFolder;

    this.settings.bankFolder = next;
    await this.saveSettings();
    // 切换即落盘：flush 当前 sidecar 并清空 contentPath，避免刷新时误清旧题库状态
    try {
      await this.stateManager.unloadSidecar();
    } catch (e) {
      // 旧题库状态保存失败时中止切换并回滚设置，避免「设置指向新题库、
      // 视图停留旧题库」的不一致状态
      console.error("CSV Quiz: 切换题库前保存当前进度失败", e);
      new Notice("当前进度保存失败，已中止切换题库");
      this.settings.bankFolder = prevFolder;
      await this.saveSettings();
      return false;
    }

    const res = await this.resolveBank(true);
    // 切换题库文件夹 = 切换题库：不把旧库 sidecar 迁移到新库，避免题号重叠时
    // 污染新库的答题/FSRS；同一文件夹内 manifest 增删由视图/启动路径的
    // 正向/反向锚点迁移处理。
    this.refreshQuiz();
    this.syncSettingsUI();
    if (res.status !== "ok") new Notice(res.message);
    return true;
  }

  /**
   * 当前题库同时含 CSV/CQV 与图片（prompt/both）时，记住「该文件夹仅用 CSV」，
   * 重新解析并刷新视图。
   */
  async useCsvOnly(): Promise<void> {
    // 重新解析，避免设置页使用外部文件变化前的陈旧 both 缓存
    const status = await this.resolveBank(true);
    if (
      status !== null &&
      status.status === "prompt" &&
      status.reason === "both" &&
      !!status.csvCandidate
    ) {
      const folder = normalizeBankFolder(this.settings.bankFolder);
      if (folder !== "") {
        this.settings.bankSingleSources[folder] = "csv";
        await this.saveSettings();
        await this.resolveBank(true);
        this.refreshQuiz();
        this.syncSettingsUI();
        return;
      }
    }
    new Notice("当前题库没有可选的 CSV/CQV 或无需选择");
  }

  /**
   * 启动时把旧内容源（settings.csvPath）的 sidecar 迁移到新题库锚点
   * （manifest / 唯一 CSV / 图片文件夹）。仅在两者不同且旧路径已配置时执行；
   * 保留旧文件以便回退。
   */
  private async migrateContentSidecarToBank(): Promise<void> {
    const res = await this.resolveBank(true);
    if (res.status !== "ok") return;
    // manifest 删除后 manifest.sidecar.json 的反向迁移（启动路径）
    await this.migrateManifestSidecarBack(res.source);
    const legacyPath = this.settings.csvPath.trim();
    if (legacyPath === "" || legacyPath === res.source.anchor) return;
    try {
      const transfer = await this.stateManager.transferSidecar(
        legacyPath,
        res.source.anchor
      );
      if (transfer.status === "error") {
        console.error(
          "CSV Quiz: 旧内容源 sidecar 迁移失败",
          legacyPath,
          "→",
          res.source.anchor,
          transfer.reason
        );
      }
    } catch (e) {
      console.error("CSV Quiz: 旧内容源 sidecar 迁移失败", e);
    }
  }

  /**
   * 根据当前状态栏显示「待复习」卡片数提醒；无到期卡片、
   * 无状态或设置关闭时清空文本。
   */
  updateMemoryReminder(): void {
    // onload 早期（loadSettings 迁移后立即 saveSettings）状态栏尚未创建
    if (!this.statusBar) return;
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
    // 键盘绑定为单字符串：非字符串（类型损坏）回退默认值；空串合法（= 不绑定）
    const toBinding = (v: unknown, fallback: string): string =>
      typeof v === "string" ? v : fallback;

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
      csvPath:
        typeof raw.csvPath === "string"
          ? raw.csvPath.trim()
          : DEFAULT_SETTINGS.csvPath,
      imageFolder:
        typeof raw.imageFolder === "string"
          ? normalizeVaultFolder(raw.imageFolder)
          : DEFAULT_SETTINGS.imageFolder,
      bankFolder:
        typeof raw.bankFolder === "string"
          ? normalizeBankFolder(raw.bankFolder)
          : DEFAULT_SETTINGS.bankFolder,
      bankSingleSources: normalizeBankSingleSources(raw.bankSingleSources),
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
      keyboardBindingsEnabled:
        typeof raw.keyboardBindingsEnabled === "boolean"
          ? raw.keyboardBindingsEnabled
          : DEFAULT_SETTINGS.keyboardBindingsEnabled,
      keyOptionA: toBinding(raw.keyOptionA, DEFAULT_SETTINGS.keyOptionA),
      keyOptionB: toBinding(raw.keyOptionB, DEFAULT_SETTINGS.keyOptionB),
      keyOptionC: toBinding(raw.keyOptionC, DEFAULT_SETTINGS.keyOptionC),
      keyOptionD: toBinding(raw.keyOptionD, DEFAULT_SETTINGS.keyOptionD),
      keyFavorite: toBinding(raw.keyFavorite, DEFAULT_SETTINGS.keyFavorite),
      keyMastered: toBinding(raw.keyMastered, DEFAULT_SETTINGS.keyMastered),
      keyRepeat: toBinding(raw.keyRepeat, DEFAULT_SETTINGS.keyRepeat),
    };

    // 3.6.x → 题库文件夹迁移：只迁移用户显式保存过的旧路径，不用默认 csvPath
    // （避免新用户被自动绑定到根目录的 题库.csv）。若 data 已有 bankFolder 字段
    // （包括用户主动清空后的 ""），说明已进入新模型，不再重复迁移。
    if (!Object.prototype.hasOwnProperty.call(raw, "bankFolder")) {
      const migrated = migrateLegacySettings({
        bankFolder: this.settings.bankFolder,
        csvPath: typeof raw.csvPath === "string" ? raw.csvPath : "",
        imageFolder: typeof raw.imageFolder === "string" ? raw.imageFolder : "",
        bankSingleSources: this.settings.bankSingleSources,
      });
      if (migrated.changed) {
        this.settings.bankFolder = migrated.bankFolder;
        this.settings.bankSingleSources = migrated.bankSingleSources;
        this.bankMigrated = true;
      }
    }
  }

  async saveSettings(): Promise<void> {
    this.updateMemoryReminder();
    await this.stateManager.saveSettings(this.settings);
  }

  async flushSettingsSave(): Promise<void> {
    await this.stateManager.flushSettingsSave();
  }

  /** 当前题库的 sidecar 锚点（解析成功时）；未解析/未配置返回 ""。 */
  private getContentPath(): string {
    return this.bankStatus?.status === "ok" ? this.bankStatus.source.anchor : "";
  }

  /**
   * manifest 已删除但 manifest.sidecar.json 仍在时，把状态反向迁移到当前
   * 单源锚点（CSV/图片文件夹），避免重启后加载陈旧 sidecar 造成进度回退。
   * 迁移成功后归档 manifest sidecar，防止重复合并旧快照。
   */
  private async migrateManifestSidecarBack(
    source: ResolvedBankSource
  ): Promise<void> {
    if (source.mode === "manifest") return;
    const manifestAnchor = manifestAnchorForBank(source.bankFolder);
    if (manifestAnchor === source.anchor) return;
    const manifestSidecar = sidecarPathFor(manifestAnchor);
    try {
      if (!(await this.app.vault.adapter.exists(manifestSidecar))) return;
      const transfer = await this.stateManager.transferSidecar(
        manifestAnchor,
        source.anchor
      );
      if (transfer.status === "copied" || transfer.status === "merged") {
        await this.stateManager.archiveSidecar(manifestAnchor);
      }
    } catch (e) {
      console.error("CSV Quiz: manifest sidecar 反向迁移失败", e);
    }
  }

  /** 确保当前题库的 sidecar 状态已载入内存（无视图时面板未载入）。返回是否可用。 */
  private async ensureSidecarLoaded(notice: boolean = true): Promise<boolean> {
    const res = await this.resolveBank();
    if (res.status !== "ok") {
      if (notice) new Notice(res.message);
      return false;
    }
    // manifest 删除后的反向迁移（启动/无视图重置也覆盖）
    await this.migrateManifestSidecarBack(res.source);
    const anchor = res.source.anchor;
    const st = this.stateManager.getState();
    if (st !== null && this.stateManager.getContentPath() === anchor) {
      return true;
    }
    // manifest 模式：`<folder>/manifest.sidecar.json` 尚未建立时，把旧内容文件
    // 的 sidecar 一次性迁移过来（保留旧文件），避免复合题库首个会话丢进度。
    if (res.source.mode === "manifest" && res.source.contentPath !== "") {
      try {
        const manifestSidecar = sidecarPathFor(anchor);
        const legacySidecar = sidecarPathFor(res.source.contentPath);
        const manifestExists = await this.app.vault.adapter.exists(
          manifestSidecar
        );
        if (!manifestExists) {
          const legacyExists = await this.app.vault.adapter.exists(
            legacySidecar
          );
          if (legacyExists) {
            const transfer = await this.stateManager.transferSidecar(
              res.source.contentPath,
              anchor
            );
            if (transfer.status === "error") {
              console.error(
                "CSV Quiz: 迁移旧内容 sidecar 到 manifest 锚点失败",
                transfer.reason
              );
            }
          }
        }
      } catch (e) {
        console.error("CSV Quiz: 检查 manifest sidecar 失败", e);
      }
    }
    // 未载入或路径不匹配（含面板从未打开 contentPath=null）：按当前锚点载入。
    // loadSidecar 会正确设置 contentPath/currentState；corrupt 仍安全拒绝。
    const load = await this.stateManager.loadSidecar(anchor, {
      favorite: this.settings.defaultFilterFavorite,
      mastered: this.settings.defaultFilterMastered,
      repeat: this.settings.defaultFilterRepeat,
      wrong: this.settings.defaultFilterWrong,
    });
    return load.status !== "corrupt";
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
          new Notice("无法加载题库状态：请先设置题库文件夹并打开刷题面板");
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
            // 与 quizView.applyResetChoice 的 records 路径同口径：每日答题量一并清理，
            // 否则面板关闭时清理后练习图表的每日统计仍残留
            state.dailyAnswers = {};
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
      new Notice("无法加载题库状态：请先设置题库文件夹并打开刷题面板");
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
        new Notice("无法加载题库状态：请先设置题库文件夹并打开刷题面板");
        return;
      }
      const state = this.stateManager.getState();
      if (state) {
        state.displayOrder = [];
        await this.stateManager.saveStateImmediately(state);
      }
    }
  }

  /** 「每日新题数」设置变更后重置当日配额（面板打开由视图就地重置，未打开直接改状态并落盘）。 */
  async resetDailyNewQuota(): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view) {
      await view.resetDailyNewQuota();
    } else {
      // M5: 无视图时先确保 sidecar 状态已载入，避免静默 no-op
      // （未开过面板且切换过题库路径时 currentState 为 null）
      if (!(await this.ensureSidecarLoaded())) {
        new Notice("无法加载题库状态：请先设置题库文件夹并打开刷题面板");
        return;
      }
      const state = this.stateManager.getState();
      if (state) {
        state.memoryNewDate = "";
        state.memoryNewCountToday = 0;
        state.memoryPendingNew = [];
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

  /**
   * 手动刷新题库：重新解析题库文件夹（manifest/CSV/图片），并保留当前答题/FSRS 进度。
   * 面板未打开时仅重新解析，下次打开会自然重新扫描。
   */
  async refreshBank(): Promise<void> {
    const res = await this.resolveBank(true);
    if (res.status !== "ok") {
      new Notice(res.message);
      return;
    }
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (!view) {
      new Notice("刷题面板未打开：题库将在下次打开时重新扫描");
      return;
    }
    try {
      await view.refresh(true);
      this.syncSettingsUI();
    } catch (e) {
      console.error("CSV Quiz: 刷新题库失败", e);
      new Notice("刷新题库失败");
    }
  }

  /** @deprecated 旧名称，保留为 refreshBank 的别名。 */
  async refreshImageBank(): Promise<void> {
    await this.refreshBank();
  }

  /** 「随机考试题数」设置变更后同步视图按钮文案（即时生效）。 */
  syncRandomExamCount(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view) {
      view.syncRandomExamCount();
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
