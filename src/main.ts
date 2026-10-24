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
import type { MergedArchiveRecoveryResult } from "./stateManager";
import { CSVWriteQueue } from "./csvHandler";
import { countDueCards } from "./utils";
import { normalizeVaultFolder } from "./contentSource";
import {
  createLegacyManifest,
  manifestAnchorForBank,
  normalizeBankFolder,
  resolveBankSource,
  resolveConfiguredSource,
  ROOT_IMAGE_ANCHOR,
  type BankResolution,
  type ResolvedBankSource,
  type SourceType,
} from "./bankResolver";

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

/** 把任意值收敛为合法的显式来源类型（未知值视为未设置）。 */
function normalizeSourceType(raw: unknown): SourceType | "" {
  return raw === "csv" || raw === "image" || raw === "manifest" ? raw : "";
}

/**
 * 归一化「manifest 组成 sidecar 已合并」标记：只保留 value === true 且 key 非空
 * （trim 后）的项；类型不对返回 {}。
 */
function normalizeManifestMerged(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const anchor = key.trim();
    if (anchor === "" || value !== true) continue;
    out[anchor] = true;
  }
  return out;
}

/**
 * 归一化「manifest 重置闸门」：只保留 key trim 非空、value 为有限正数的项；
 * 类型不对返回 {}。闸门值用于过滤重置前写入的组成 sidecar 进度。
 */
function normalizeManifestResetAt(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const anchor = key.trim();
    if (anchor === "") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    out[anchor] = value;
  }
  return out;
}

/**
 * 归一化「导出清理的 B 类 meta 字段」记录：key 必须是
 * `${anchor}\u0000${id}\u0000${field}`（含两个分隔符），value 为有限正数；
 * 其余丢弃。用于 manifest 合并时过滤组件 sidecar 的旧字段。
 */
function normalizeManifestMetaClears(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.split("\u0000").length !== 3) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * 归一化来源路径：
 * - csv：文件路径 trim / 反斜杠转 `/` / 去掉前导 `/`；
 * - image、manifest：文件夹路径（允许 `/` 表示 vault 根）；
 * - 未设置：仅 trim。
 */
function normalizeSourcePath(type: SourceType | "", raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (type === "image" || type === "manifest") return normalizeBankFolder(value);
  if (type === "csv")
    return value
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^\/+/, "");
  return value;
}

export default class CSVQuizPlugin extends Plugin {
  settings: PluginSettings;
  stateManager: StateManager;
  csvWriteQueue: CSVWriteQueue;
  statusBar: HTMLElement;
  memoryReminderTimer: number | null = null;
  /** 最近一次题库来源解析结果（设置页同步读取）。 */
  bankStatus: BankResolution | null = null;
  /** loadSettings 检测到旧来源配置、等待 onload 异步迁移（只执行一次）。 */
  private needsSourceMigration = false;
  /** 迁移前的旧配置快照（迁移完成后 settings 中的 legacy 字段会清空）。 */
  private legacyCsvPath = "";
  private legacyImageFolder = "";
  private legacyBankFolder = "";
  private legacyBankSingleSources: Record<string, "csv"> = {};
  private settingTab: CSVQuizSettingTab | null = null;
  /** manifest 组成 sidecar 合并的并发锁：同锚点复用同一 promise，避免重复合并导致统计翻倍。 */
  private manifestMergePromises = new Map<string, Promise<void>>();

  async onload(): Promise<void> {
    this.stateManager = new StateManager(this);
    this.csvWriteQueue = new CSVWriteQueue(this.app);

    await this.loadSettings();
    // 记录迁移前的旧 csvPath：来源迁移会清空 legacy 字段，旧 quizState 迁移
    // 仍以迁移前的路径为准（顺序：loadSettings → 记录 → 旧 quizState → 来源）。
    const legacyCsvPath = this.settings.csvPath;
    await this.stateManager.loadLegacyQuizState();

    // 阶段 4：迁移旧版进度——data.json.quizState → 旧 csvPath 的 sidecar（无视图场景）
    // 仅图片模式没有 CSV 内容源，旧版 CSV 进度无可迁移目标，直接跳过。
    try {
      if (legacyCsvPath) {
        const result = await this.stateManager.migrateLegacyState(
          legacyCsvPath,
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

    // 旧来源配置 → 显式 sourceType/sourcePath（只迁移一次；manifest 分支在此完成
    // sidecar 迁移）。迁移后清空 legacy 字段，避免之后每次启动重复迁移。
    if (this.needsSourceMigration) {
      try {
        await this.migrateLegacySource();
      } catch (e) {
        console.error("CSV Quiz: 迁移旧题库来源失败", e);
        new Notice("旧题库来源自动迁移失败，请在设置中手动选择题库来源。");
      }
      this.settings.csvPath = "";
      this.settings.imageFolder = "";
      this.settings.bankFolder = "";
      this.settings.bankSingleSources = {};
      this.needsSourceMigration = false;
      await this.saveSettings();
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

    this.addCommand({
      id: "recover-merged-sidecars",
      name: "从已归档冲突副本恢复进度",
      callback: () => {
        void this.recoverMergedSidecarsCommand();
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
   * 解析当前显式来源（缓存到 this.bankStatus；force=true 重新扫描）。
   * 解析异常统一转为 error 结果，避免设置页/视图因 IO 异常中断。
   */
  private async resolveBank(force = false): Promise<BankResolution> {
    if (!force && this.bankStatus !== null) return this.bankStatus;
    let res: BankResolution;
    try {
      res = await resolveConfiguredSource(this.app.vault, {
        sourceType: this.settings.sourceType,
        sourcePath: this.settings.sourcePath,
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
   * onload 一次性迁移：旧配置（3.6.x csvPath/imageFolder → 4.0.0 bankFolder）
   * 转为显式 sourceType/sourcePath。只改设置，不清理 legacy 字段（由调用方清空）。
   */
  private async migrateLegacySource(): Promise<void> {
    const csvPath = this.legacyCsvPath;
    const imageFolder = this.legacyImageFolder;

    // 优先 3.6.x 旧配置（CSV 文件 / 图片文件夹）
    if (csvPath !== "" || imageFolder !== "") {
      if (csvPath !== "" && imageFolder === "") {
        this.settings.sourceType = "csv";
        this.settings.sourcePath = csvPath;
        return;
      }
      if (csvPath === "" && imageFolder !== "") {
        this.settings.sourceType = "image";
        this.settings.sourcePath = normalizeBankFolder(imageFolder);
        return;
      }

      // CSV 与图片并存：在两者的最低公共祖先生成/复用 manifest.json
      const result = await createLegacyManifest(
        this.app.vault,
        csvPath,
        imageFolder
      );
      if (
        (result.status === "created" || result.status === "reused") &&
        result.bankFolder
      ) {
        const bankFolder = result.bankFolder;
        this.settings.sourceType = "manifest";
        this.settings.sourcePath = bankFolder;
        // 旧 CSV sidecar → manifest sidecar（保留旧文件，便于回退）
        try {
          const transfer = await this.stateManager.transferSidecar(
            csvPath,
            manifestAnchorForBank(bankFolder)
          );
          if (transfer.status === "error") {
            console.error(
              "CSV Quiz: 旧 CSV sidecar 迁移到 manifest 锚点失败",
              transfer.reason
            );
          }
        } catch (e) {
          console.error("CSV Quiz: 旧 CSV sidecar 迁移到 manifest 锚点失败", e);
        }
        new Notice(
          `已${
            result.status === "created" ? "创建" : "复用"
          }复合题库 manifest.json（${
            bankFolder === "/" ? "vault 根" : bankFolder
          }），旧进度已合并`
        );
        return;
      }
      new Notice(
        `自动迁移为复合题库失败：${
          result.message ?? "未知错误"
        }。请在设置中手动选择题库来源。`
      );
      return;
    }

    // 其次 4.0.0 题库文件夹配置
    const bankFolder = this.legacyBankFolder;
    if (bankFolder === "") return;
    const res = await resolveBankSource(this.app.vault, {
      bankFolder,
      bankSingleSources: this.legacyBankSingleSources,
    });
    if (res.status === "ok") {
      const source = res.source;
      if (source.mode === "manifest") {
        this.settings.sourceType = "manifest";
        this.settings.sourcePath = source.bankFolder;
      } else if (source.mode === "csv") {
        this.settings.sourceType = "csv";
        this.settings.sourcePath = source.contentPath;
      } else {
        this.settings.sourceType = "image";
        this.settings.sourcePath = source.imageFolder || "/";
      }
      return;
    }

    // CSV 与图片并存且能确定唯一 CSV：为该题库生成 manifest.json
    if (res.status === "prompt" && res.reason === "both" && res.csvCandidate) {
      const manifest = await createLegacyManifest(
        this.app.vault,
        res.csvCandidate,
        bankFolder
      );
      if (
        (manifest.status === "created" || manifest.status === "reused") &&
        manifest.bankFolder
      ) {
        this.settings.sourceType = "manifest";
        this.settings.sourcePath = manifest.bankFolder;
        // 旧库若曾以 CSV 为锚点，迁移其 sidecar 到 manifest 锚点（保留旧文件）
        try {
          const transfer = await this.stateManager.transferSidecar(
            res.csvCandidate,
            manifestAnchorForBank(manifest.bankFolder)
          );
          if (transfer.status === "error") {
            console.error(
              "CSV Quiz: 旧 CSV sidecar 迁移到 manifest 锚点失败",
              transfer.reason
            );
          }
        } catch (e) {
          console.error("CSV Quiz: 旧 CSV sidecar 迁移到 manifest 锚点失败", e);
        }
        new Notice(
          `已${
            manifest.status === "created" ? "创建" : "复用"
          }复合题库 manifest.json（${
            manifest.bankFolder === "/" ? "vault 根" : manifest.bankFolder
          }），旧进度已合并`
        );
        return;
      }
      new Notice(
        `自动迁移为复合题库失败：${
          manifest.message ?? "未知错误"
        }。请在设置中手动选择题库来源。`
      );
      return;
    }

    new Notice(
      `无法自动确定旧题库来源：${res.message} 请在设置中手动选择题库来源类型与路径。`
    );
  }

  /**
   * 显式来源变更入口：有 sidecar 状态时轻量确认；切换即落盘并刷新。
   * 换来源 = 换题库，不做跨来源 sidecar 迁移（旧设置迁移除外）。
   * 返回 false 表示用户取消或保存失败（设置已回滚）。
   */
  async changeSource(
    type: SourceType | "",
    path: string
  ): Promise<boolean> {
    const nextType = normalizeSourceType(type);
    const nextPath = normalizeSourcePath(nextType, path);
    const currentPath = normalizeSourcePath(
      this.settings.sourceType,
      this.settings.sourcePath
    );
    if (
      nextType === this.settings.sourceType &&
      nextPath === currentPath
    ) {
      return true;
    }

    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view && view.hasLoadedState()) {
      const confirmed = await view.confirmQuizSwitch(
        nextPath || "（未设置）"
      );
      if (!confirmed) return false;
    }

    const prevType = this.settings.sourceType;
    const prevPath = this.settings.sourcePath;

    this.settings.sourceType = nextType;
    this.settings.sourcePath = nextPath;
    await this.saveSettings();
    // 切换即落盘：flush 当前 sidecar 并清空 contentPath，避免刷新时误清旧题库状态
    try {
      await this.stateManager.unloadSidecar();
    } catch (e) {
      // 旧题库状态保存失败时中止切换并回滚设置，避免「设置指向新题库、
      // 视图停留旧题库」的不一致状态
      console.error("CSV Quiz: 切换题库前保存当前进度失败", e);
      new Notice("当前进度保存失败，已中止切换题库");
      this.settings.sourceType = prevType;
      this.settings.sourcePath = prevPath;
      await this.saveSettings();
      return false;
    }

    const res = await this.resolveBank(true);
    // 换来源 = 换题库：不把旧库 sidecar 迁移到新库，避免题号重叠时污染新库。
    this.refreshQuiz();
    this.syncSettingsUI();
    if (res.status !== "ok") new Notice(res.message);
    return true;
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

    // 旧字段仅供迁移读取；显式来源类型未知值一律视为未设置。
    // 4.0.0 的 data.json 也会持久化默认 csvPath（题库.csv），因此只有从未
    // 写过 bankFolder 字段的旧数据才把 csvPath/imageFolder 当作 3.6.x 配置。
    const hasBankFolderField = Object.prototype.hasOwnProperty.call(
      raw,
      "bankFolder"
    );
    const legacyCsvPath =
      !hasBankFolderField && typeof raw.csvPath === "string"
        ? raw.csvPath.trim()
        : "";
    const legacyImageFolder =
      !hasBankFolderField && typeof raw.imageFolder === "string"
        ? normalizeVaultFolder(raw.imageFolder)
        : "";
    const legacyBankFolder =
      typeof raw.bankFolder === "string"
        ? normalizeBankFolder(raw.bankFolder)
        : "";
    const sourceType = normalizeSourceType(raw.sourceType);
    const sourcePath =
      typeof raw.sourcePath === "string" ? raw.sourcePath.trim() : "";

    this.legacyCsvPath = legacyCsvPath;
    this.legacyImageFolder = legacyImageFolder;
    this.legacyBankFolder = legacyBankFolder;
    this.legacyBankSingleSources = normalizeBankSingleSources(
      raw.bankSingleSources
    );
    // 只对「用户显式保存过」的旧路径做迁移，避免新用户被默认 csvPath
    // （题库.csv）自动绑定；实际迁移在 onload 异步执行一次。
    this.needsSourceMigration =
      sourceType === "" &&
      (legacyCsvPath !== "" ||
        legacyImageFolder !== "" ||
        legacyBankFolder !== "");

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...clean,
      sourceType,
      sourcePath,
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
      manifestMerged: normalizeManifestMerged(raw.manifestMerged),
      manifestResetAt: normalizeManifestResetAt(raw.manifestResetAt),
      manifestMetaClears: normalizeManifestMetaClears(raw.manifestMetaClears),
    };
  }

  async saveSettings(): Promise<void> {
    this.updateMemoryReminder();
    await this.stateManager.saveSettings(this.settings);
  }

  /**
   * 标记某个 manifest 锚点刚刚完成「重置进度」：组成 sidecar 合并时只并入
   * 写入时间晚于此刻的组件进度，防止重置后旧组件 sidecar 被自动并回复活。
   * anchor 省略时取当前解析出的内容源锚点；锚点为空则忽略。
   */
  async markManifestReset(anchor?: string): Promise<void> {
    const key = (anchor ?? this.getContentPath()).trim();
    if (key === "") return;
    this.settings.manifestResetAt[key] = Date.now();
    await this.saveSettings();
    // 重置闸门必须在关闭/崩溃前真正落盘，否则下次启动旧组成 sidecar 会复活。
    await this.flushSettingsSave();
  }

  /**
   * 记录某些 B 类 meta 字段已被导出清理（写入时间戳 = 清除时刻）。
   * manifest 组成 sidecar 合并时据此丢弃组件里不晚于该时刻的旧字段，
   * 避免「导出到 CSV 并清除覆盖」后又被组件 sidecar 回填。
   * anchor/id 为空或 fields 全为空时不做任何写入。
   */
  async markManifestMetaCleared(
    anchor: string,
    entries: Array<{ id: string; fields: string[] }>
  ): Promise<void> {
    const key = (anchor ?? "").trim();
    if (key === "") return;
    const ts = Date.now();
    let changed = false;
    for (const entry of entries) {
      const id = typeof entry?.id === "string" ? entry.id : "";
      if (id === "") continue;
      for (const rawField of entry.fields ?? []) {
        if (typeof rawField !== "string" || rawField === "") continue;
        this.settings.manifestMetaClears[
          `${key}\u0000${id}\u0000${rawField}`
        ] = ts;
        changed = true;
      }
    }
    if (!changed) return;
    await this.saveSettings();
    // 导出清理记录跨会话生效，必须显式 flush，避免导出后立刻关闭导致旧字段回填。
    await this.flushSettingsSave();
  }

  /**
   * 取出某 manifest 锚点的清理记录：id → field → 清除时刻。
   * 供 mergeManifestComponentSidecars 过滤组件 sidecar 的旧 B 类字段。
   */
  getManifestMetaClears(
    anchor: string
  ): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    const key = (anchor ?? "").trim();
    if (key === "") return out;
    const prefix = `${key}\u0000`;
    for (const [rawKey, ts] of Object.entries(
      this.settings.manifestMetaClears
    )) {
      if (!rawKey.startsWith(prefix)) continue;
      const rest = rawKey.slice(prefix.length);
      const sep = rest.indexOf("\u0000");
      if (sep <= 0) continue;
      const id = rest.slice(0, sep);
      const field = rest.slice(sep + 1);
      if (id === "" || field === "" || field.includes("\u0000")) continue;
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
      let fields = out.get(id);
      if (!fields) {
        fields = new Map<string, number>();
        out.set(id, fields);
      }
      // 同一字段多次导出清理：保留最新（最大）时间戳
      fields.set(field, Math.max(fields.get(field) ?? 0, ts));
    }
    return out;
  }

  async flushSettingsSave(): Promise<void> {
    await this.stateManager.flushSettingsSave();
  }

  /** 当前题库的 sidecar 锚点（解析成功时）；未解析/未配置返回 ""。 */
  private getContentPath(): string {
    return this.bankStatus?.status === "ok" ? this.bankStatus.source.anchor : "";
  }

  /**
   * manifest 复合题库：确保组成内容源的 sidecar 进度已并入 manifest 锚点 sidecar。
   * - 仅 manifest 模式；settings.manifestMerged 仅作诊断标记，不再阻止合并
   *   （旧 marker 可能是「目标已有进度就跳过」时期写入的，需允许修复）
   * - 同锚点并发调用复用同一 promise（onload 与视图可能同时触发）
   * - 任何失败都不抛出（合并失败不应变成题库加载失败）
   */
  async ensureManifestSidecarMerged(source: ResolvedBankSource): Promise<void> {
    if (source.mode !== "manifest") return;
    const key = source.anchor.trim();
    if (key === "") return;
    const pending = this.manifestMergePromises.get(key);
    if (pending) return pending;
    const task = this.runManifestSidecarMerge(source, key).finally(() => {
      this.manifestMergePromises.delete(key);
    });
    this.manifestMergePromises.set(key, task);
    return task;
  }

  /** ensureManifestSidecarMerged 的实际执行体（结果只记录日志/提示，不抛出）。 */
  private async runManifestSidecarMerge(
    source: ResolvedBankSource,
    key: string
  ): Promise<void> {
    const components: string[] = [];
    const seen = new Set<string>();
    const push = (anchor: string | undefined): void => {
      const value = (anchor ?? "").trim();
      if (value === "" || value === key || seen.has(value)) return;
      seen.add(value);
      components.push(value);
    };
    for (const contentPath of source.contentPaths) push(contentPath);
    const imageFolder = (source.imageFolder ?? "").trim();
    if (imageFolder !== "") {
      push(imageFolder === "/" ? ROOT_IMAGE_ANCHOR : imageFolder);
    }
    if (components.length === 0) {
      // 无任何组成内容源：无需合并，也不写 marker
      return;
    }

    /** 写诊断标记（已标记则跳过，避免每次载入都写设置）。 */
    const markMerged = async (): Promise<void> => {
      if (this.settings.manifestMerged[key] === true) return;
      this.settings.manifestMerged[key] = true;
      await this.saveSettings();
    };

    try {
      const result = await this.stateManager.mergeManifestComponentSidecars(
        key,
        components,
        {
          favorite: this.settings.defaultFilterFavorite,
          mastered: this.settings.defaultFilterMastered,
          repeat: this.settings.defaultFilterRepeat,
          wrong: this.settings.defaultFilterWrong,
        },
        this.settings.manifestResetAt[key] ?? 0,
        this.getManifestMetaClears(key)
      );
      if (result.status === "merged") {
        await markMerged();
        console.debug(
          `CSV Quiz: 已把 ${result.mergedComponents ?? 0} 个组成 sidecar 并入 manifest 进度` +
            `（新增答题 ${result.addedAnswers ?? 0} 条，✅${result.correctCount ?? 0} / ❌${result.wrongCount ?? 0}）`
        );
        return;
      }
      if (result.reason === "no-change") {
        // 合并结果与目标一致：视为已完成（不写盘）
        await markMerged();
        return;
      }
      if (result.reason === "no-component-progress") {
        // 组成暂无进度：不标记，以后新增组成仍有进度时可再尝试
        return;
      }
      console.error(
        "CSV Quiz: manifest 组成 sidecar 合并未完成",
        key,
        result.status,
        result.reason
      );
    } catch (e: unknown) {
      // 合并失败不阻塞题库加载
      console.error("CSV Quiz: manifest 组成 sidecar 合并失败", key, e);
    }
  }

  /** 确保当前题库的 sidecar 状态已载入内存（无视图时面板未载入）。返回是否可用。 */
  private async ensureSidecarLoaded(notice: boolean = true): Promise<boolean> {
    const res = await this.resolveBank();
    if (res.status !== "ok") {
      if (notice) new Notice(res.message);
      return false;
    }
    // manifest 复合题库：先把组成内容源 sidecar 进度并入 manifest 锚点（一次性；
    // 失败仅记录日志，不阻塞加载），再 loadSidecar 读取合并后的状态。
    await this.ensureManifestSidecarMerged(res.source);
    // 来源迁移已在 onload 完成；用户切换来源不自动串库（不做正/反向 manifest 迁移）。
    const anchor = res.source.anchor;
    const st = this.stateManager.getState();
    if (st !== null && this.stateManager.getContentPath() === anchor) {
      return true;
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
          new Notice("无法加载题库状态：请先设置题库来源并打开刷题面板");
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
          if (choice === "order") {
            await this.stateManager.saveStateImmediately(state);
          } else {
            // L2: records/cards 是用户显式重置且无视图（无 tombstone）：
            // 权威写直接覆盖磁盘，避免读改写合并把旧记录并回来。
            // 同时写入 manifest 重置闸门：重置前写入的组成 sidecar 不得再被并回。
            await this.markManifestReset();
            await this.stateManager.saveStateImmediately(state, {
              authoritative: true,
            });
          }
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
      new Notice("无法加载题库状态：请先设置题库来源并打开刷题面板");
      return;
    }
    // 重置闸门必须在 clearState 前写入：否则下次载入会自动把旧组成 sidecar 并回复活。
    await this.markManifestReset();
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
        new Notice("无法加载题库状态：请先设置题库来源并打开刷题面板");
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
        new Notice("无法加载题库状态：请先设置题库来源并打开刷题面板");
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
   * 手动刷新题库：重新解析当前来源（manifest/CSV/图片），并保留当前答题/FSRS 进度。
   * 面板未打开时仅重新解析，下次打开会自然重新扫描。
   */
  async refreshBank(): Promise<void> {
    const res = await this.resolveBank(true);
    // 解析缓存更新后立即同步设置页只读状态（无面板/解析失败也刷新）
    this.syncSettingsUI();
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
    } catch (e) {
      console.error("CSV Quiz: 刷新题库失败", e);
      new Notice("刷新题库失败");
    }
  }

  /** @deprecated 旧名称，保留为 refreshBank 的别名。 */
  async refreshImageBank(): Promise<void> {
    await this.refreshBank();
  }

  /**
   * 命令：把 `.merged` 归档（历史上冲突副本合并后保留的快照）重新并入当前题库进度。
   * 显式操作，不在启动/打开面板时自动执行；成功后把归档改名为 `.recovered`，
   * 因此重复执行只会得到「未找到可恢复归档」。
   */
  private async recoverMergedSidecarsCommand(): Promise<void> {
    const res = await this.resolveBank();
    if (res.status !== "ok") {
      new Notice(res.message);
      return;
    }
    const defaults = {
      favorite: this.settings.defaultFilterFavorite,
      mastered: this.settings.defaultFilterMastered,
      repeat: this.settings.defaultFilterRepeat,
      wrong: this.settings.defaultFilterWrong,
    };
    // 组件锚点 = manifest 组成内容源 + 图片文件夹（根哨兵 "/" 换 ROOT_IMAGE_ANCHOR）
    const components: string[] = [];
    const seen = new Set<string>();
    const push = (anchor: string | undefined): void => {
      const value = (anchor ?? "").trim();
      if (value === "" || seen.has(value)) return;
      seen.add(value);
      components.push(value);
    };
    for (const contentPath of res.source.contentPaths) push(contentPath);
    const imageFolder = (res.source.imageFolder ?? "").trim();
    if (imageFolder !== "") {
      push(imageFolder === "/" ? ROOT_IMAGE_ANCHOR : imageFolder);
    }

    let result: MergedArchiveRecoveryResult;
    try {
      // 先把内存中尚未落盘的进度写入磁盘：恢复后会卸载内存状态并按磁盘重载，
      // 不先落盘会丢掉防抖窗口内最近几秒的作答。
      const pendingState = this.stateManager.getState();
      if (pendingState !== null) {
        await this.stateManager.saveStateImmediately(pendingState);
      }
      result = await this.stateManager.recoverMergedSidecars(
        res.source.anchor,
        components,
        defaults,
        this.getManifestMetaClears(res.source.anchor)
      );
    } catch (e: unknown) {
      console.error("CSV Quiz: 从 .merged 归档恢复进度失败", e);
      new Notice("从已归档冲突副本恢复进度失败");
      return;
    }

    if (result.status === "error") {
      new Notice(
        result.reason === "target-corrupt"
          ? "当前题库状态文件损坏，未从归档恢复（请先处理损坏的状态文件）"
          : "写入恢复后的进度失败，归档文件未改动，可稍后重试"
      );
      return;
    }
    if (result.status === "none") {
      new Notice("未找到可恢复的已归档冲突副本（.merged）");
      return;
    }

    const renamedPart =
      result.renameFailed !== undefined && result.renameFailed > 0
        ? `，${result.renamed ?? 0} 个改名成功、${result.renameFailed} 个改名失败`
        : `，${result.renamed ?? 0} 个归档已改名保留`;
    new Notice(
      `已从 ${result.archives ?? 0} 个归档恢复进度：新增答题 ${result.addedAnswers ?? 0} 条${renamedPart}`
    );
    await this.reloadAfterMergedRecovery(res.source.anchor);
  }

  /**
   * .merged 恢复后的刷新：磁盘已是合并结果，但内存（视图/管理器）仍是恢复前的
   * 旧进度。面板打开时先卸载内存状态（currentState 为 null 时 unloadSidecar 不写盘，
   * 避免旧进度覆盖刚恢复的数据），再由 view.refresh(true) 从磁盘重新载入；
   * 面板未打开时直接重载 sidecar 到内存。
   */
  private async reloadAfterMergedRecovery(anchor: string): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    const view = leaf?.view as QuizView | undefined;
    if (view) {
      try {
        this.stateManager.setState(null);
        await this.stateManager.unloadSidecar();
        await view.refresh(true);
      } catch (e) {
        console.error("CSV Quiz: 恢复进度后刷新面板失败", e);
      }
      this.refreshMemoryReminder();
      return;
    }
    try {
      await this.stateManager.loadSidecar(anchor, {
        favorite: this.settings.defaultFilterFavorite,
        mastered: this.settings.defaultFilterMastered,
        repeat: this.settings.defaultFilterRepeat,
        wrong: this.settings.defaultFilterWrong,
      });
    } catch (e) {
      console.error("CSV Quiz: 恢复进度后重载状态失败", e);
    }
    this.refreshMemoryReminder();
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
