import {
  App,
  AbstractInputSuggest,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  TFolder,
  SettingDefinitionItem,
  TextComponent,
  ToggleComponent,
} from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS } from "./types";
import { askResetChoice } from "./modals";
import { sidecarPathFor } from "./sidecar";
import type { BankResolution } from "./bankResolver";

interface PluginHandle {
  settings: PluginSettings;
  /** 最近一次题库来源解析结果（只读展示）。 */
  bankStatus: BankResolution | null;
  refreshQuiz(): void;
  saveSettings(): Promise<void>;
  flushSettingsSave(): Promise<void>;
  resetQuizProgress(choice?: "records" | "cards" | "order" | "all"): Promise<void>;
  reorderQuestions(): Promise<void>;
  syncSwipeNavigation(): void;
  syncRandomExamCount(): void;
  resetDailyNewQuota(): Promise<void>;
  changeBankFolder(path: string): Promise<boolean>;
  useCsvOnly(): Promise<void>;
  refreshBank(): Promise<void>;
  compileQuizToCqv(): Promise<void>;
  exportQuizMetaToCsv(): Promise<void>;
}

/** 「题库文件夹」说明文案（声明式与命令式共用）。 */
const BANK_FOLDER_DESC =
  "vault 内的题库文件夹：文件夹内有 manifest.json 视为复合题库（CSV/CQV + 图片并用）；否则自动识别唯一的 CSV/CQV 或仅图片；vault 根用 / 表示。";

/** 声明式设置框架下的键位绑定键集合：写入前需归一化（见 setControlValue）。 */
const KEY_BINDING_SETTING_KEYS = new Set([
  "keyOptionA",
  "keyOptionB",
  "keyOptionC",
  "keyOptionD",
  "keyFavorite",
  "keyMastered",
  "keyRepeat",
]);

export class CSVQuizSettingTab extends PluginSettingTab {
  private plugin: PluginHandle;

  constructor(app: App, plugin: PluginHandle) {
    super(app, plugin as unknown as Plugin);
    this.plugin = plugin;
  }

  onClose(): void {
    void this.plugin.flushSettingsSave();
  }

  /**
   * Obsidian 1.13.0+: 声明式设置。Obsidian 调用此方法并跳过 display()。
   * 控件自动绑定到 this.plugin.settings[key]。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { name: "刷题啊 - 设置" },
      {
        name: "题库文件夹",
        desc: BANK_FOLDER_DESC,
        control: {
          type: "folder",
          key: "bankFolder",
          defaultValue: DEFAULT_SETTINGS.bankFolder,
          placeholder: "例如：题库/行测（根目录用 /）",
          includeRoot: true,
          filter: (folder: TFolder) =>
            !folder.path.split("/").some((segment) => segment.startsWith(".")),
        },
      },
      {
        name: "题库解析状态",
        render: (setting) => {
          this.renderBankStatus(setting.descEl);
        },
      },
      {
        name: "仅用 CSV",
        desc: "当前题库文件夹同时包含 CSV/CQV 与图片；选择后只加载 CSV/CQV（如需两者并用请在该文件夹创建 manifest.json）。",
        visible: () => this.isCsvChoicePrompt(),
        action: () => {
          void this.plugin.useCsvOnly();
        },
      },
      {
        name: "随机题目顺序",
        desc: "开启后每次加载时随机排列题目顺序",
        control: { type: "toggle", key: "randomOrder" },
      },
      {
        name: "随机选项顺序",
        desc: "开启后每个题目的选项顺序随机排列",
        control: { type: "toggle", key: "randomOptions" },
      },
      {
        name: "随机考试题数",
        desc: "「随机考试」每次随机抽取的题目数量（从当前筛选范围内的全部题目抽取，不限未答；不足时取全部）",
        control: {
          type: "number",
          key: "randomExamCount",
          min: 1,
          max: 1000,
          defaultValue: DEFAULT_SETTINGS.randomExamCount,
        },
      },
      {
        type: "group",
        heading: "记忆练习",
        items: [
          {
            name: "记忆练习",
            desc: "启用基于记忆曲线的练习（FSRS 间隔重复调度）",
            control: { type: "toggle", key: "memoryEnabled" },
          },
          {
            name: "每日新题数",
            desc: "记忆练习每天引入的新题数量上限（稳定后每日复习量约为该值的 2~3 倍）",
            control: {
              type: "number",
              key: "memoryDailyNew",
              min: 0,
              max: 500,
              defaultValue: DEFAULT_SETTINGS.memoryDailyNew,
            },
          },
          {
            name: "到期提醒",
            desc: "在状态栏显示今日待复习题数提醒",
            control: { type: "toggle", key: "memoryReminder" },
          },
          {
            name: "掌握参与评分",
            desc: "记忆练习答对时按标记评分：掌握=Easy（间隔拉长更快）、其余一律 Good；收藏不参与评分（避免难度虚高与间隔压缩）；答错一律 Again。",
            control: { type: "toggle", key: "memoryMarkRating" },
          },
          {
            name: "左右滑动切题",
            desc: "移动端在刷题面板内左右滑动切换题目（左滑下一题、右滑上一题）；开启时面板区域不触发 Obsidian 自身的侧边栏滑动",
            control: { type: "toggle", key: "swipeNavigation" },
          },
          {
            name: "非记忆模式答题参与FSRS",
            desc: "常规模式/随机考试中答题也更新记忆卡片（FSRS 间隔重复）；关闭后仅记忆练习更新卡片。图片题的四级评分始终写 FSRS（不受此开关影响）",
            control: { type: "toggle", key: "memoryUpdateInNormalMode" },
          },
        ],
      },
      {
        type: "group",
        heading: "键盘绑定",
        items: [
          {
            name: "键盘绑定",
            desc: "刷题面板内启用键盘快捷键（含左右方向键切题与下方选项/标记快捷键）；关闭后全部键盘操作禁用",
            control: { type: "toggle", key: "keyboardBindingsEnabled" },
          },
          {
            name: "选项快捷键：第 1 个显示选项",
            desc: "按下该键选择当前题第 1 个显示的选项（选项打乱时与屏幕显示的 A 位一致）；单个字符，大小写不敏感，留空不绑定",
            control: {
              type: "text",
              key: "keyOptionA",
              defaultValue: DEFAULT_SETTINGS.keyOptionA,
            },
          },
          {
            name: "选项快捷键：第 2 个显示选项",
            desc: "按下该键选择第 2 个显示的选项（屏幕 B 位）；单个字符，留空不绑定",
            control: {
              type: "text",
              key: "keyOptionB",
              defaultValue: DEFAULT_SETTINGS.keyOptionB,
            },
          },
          {
            name: "选项快捷键：第 3 个显示选项",
            desc: "按下该键选择第 3 个显示的选项（屏幕 C 位）；单个字符，留空不绑定",
            control: {
              type: "text",
              key: "keyOptionC",
              defaultValue: DEFAULT_SETTINGS.keyOptionC,
            },
          },
          {
            name: "选项快捷键：第 4 个显示选项",
            desc: "按下该键选择第 4 个显示的选项（屏幕 D 位）；单个字符，留空不绑定",
            control: {
              type: "text",
              key: "keyOptionD",
              defaultValue: DEFAULT_SETTINGS.keyOptionD,
            },
          },
          {
            name: "标记快捷键：收藏",
            desc: "按下该键切换当前题的收藏标记；单个字符，大小写不敏感，留空不绑定",
            control: {
              type: "text",
              key: "keyFavorite",
              defaultValue: DEFAULT_SETTINGS.keyFavorite,
            },
          },
          {
            name: "标记快捷键：掌握",
            desc: "按下该键切换当前题的掌握标记；单个字符，留空不绑定",
            control: {
              type: "text",
              key: "keyMastered",
              defaultValue: DEFAULT_SETTINGS.keyMastered,
            },
          },
          {
            name: "标记快捷键：重复",
            desc: "按下该键切换当前题的重复标记；单个字符，留空不绑定",
            control: {
              type: "text",
              key: "keyRepeat",
              defaultValue: DEFAULT_SETTINGS.keyRepeat,
            },
          },
        ],
      },
      {
        name: "答对自动跳转延迟（秒）",
        desc: "答对后自动跳转到下一题的等待时间，0 表示不自动跳转",
        control: {
          type: "number",
          key: "autoNextDelay",
          min: 0,
          max: 30,
          defaultValue: DEFAULT_SETTINGS.autoNextDelay,
        },
      },
      {
        name: "默认展开筛选栏",
        desc: "打开刷题面板时筛选栏默认是否展开",
        control: { type: "toggle", key: "filterPanelOpen" },
      },
      {
        name: "默认展开编辑栏",
        desc: "打开刷题面板时标签/分类编辑栏默认是否展开",
        control: { type: "toggle", key: "editPanelOpen" },
      },
      {
        name: "默认展开练习栏",
        desc: "打开刷题面板时练习栏（练习入口/分类统计/折线图）默认是否展开",
        control: { type: "toggle", key: "practicePanelOpen" },
      },
      {
        type: "group",
        heading: "标记筛选默认值",
        items: [
          {
            name: "默认筛选: 收藏",
            desc: "打开刷题面板时「收藏」筛选的默认状态",
            control: {
              type: "dropdown",
              key: "defaultFilterFavorite",
              options: { "": "不限", "1": "仅收藏", "0": "不收藏" },
            },
          },
          {
            name: "默认筛选: 掌握",
            desc: "打开刷题面板时「掌握」筛选的默认状态",
            control: {
              type: "dropdown",
              key: "defaultFilterMastered",
              options: { "": "不限", "1": "仅掌握", "0": "不掌握" },
            },
          },
          {
            name: "默认筛选: 重复",
            desc: "打开刷题面板时「重复」筛选的默认状态",
            control: {
              type: "dropdown",
              key: "defaultFilterRepeat",
              options: { "": "不限", "1": "仅重复", "0": "不重复" },
            },
          },
          {
            name: "默认筛选: 错题",
            desc: "打开刷题面板时「错题」筛选的默认状态",
            control: {
              type: "dropdown",
              key: "defaultFilterWrong",
              options: { "": "不限", "1": "仅错题", "0": "不错题" },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "管理",
        items: [
          {
            name: "重置刷题进度",
            desc: "按选择清理答题记录和/或记忆卡片；全部重置会重新加载题库",
            action: () => {
              void this.handleResetProgress();
            },
          },
          {
            name: "刷新题库",
            desc: "重新解析题库文件夹（manifest/CSV/图片的新增、删除或替换），保留答题记录与 FSRS 卡片；需面板已打开",
            action: () => {
              void this.plugin.refreshBank();
            },
          },
          {
            name: "优化题库",
            desc: "把当前 CSV 题库编译为分发产物 .cqv（需面板已打开）",
            action: () => {
              void this.plugin.compileQuizToCqv();
            },
          },
          {
            name: "导出修改到 CSV",
            desc: "把题库状态中的标签/分类/重复标记写回 CSV（需面板已打开）",
            action: () => {
              void this.plugin.exportQuizMetaToCsv();
            },
          },
        ],
      },
    ];
  }

  /**
   * 1.13.0+: 从 this.plugin.settings 读取控件值。
   */
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /**
   * 1.13.0+: 写入控件值并持久化。
   * 必须通过 saveSettings()（StateManager 写队列）保存，以合并方式保留
   * data.json 中的 quizState；默认实现会调用 saveData(this.plugin.settings)
   * 从而覆盖整个 data.json 并丢失 quizState。
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "bankFolder") {
      // 题库切换统一走 changeBankFolder（确认/落盘/锚点迁移/刷新）；
      // 绝不能直写 settings，否则会绕过 sidecar 切换流程。
      await this.plugin.changeBankFolder(String(value));
      return;
    }
    if (key === "randomOrder") {
      await this.handleRandomOrderToggle(value === true);
      return;
    }
    if (key === "swipeNavigation") {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
      await this.plugin.saveSettings();
      // L-1: 开关变更即时同步视图的 data-ignore-swipe 属性，无需重开面板
      this.plugin.syncSwipeNavigation();
      return;
    }
    if (key === "memoryDailyNew") {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
      await this.plugin.saveSettings();
      // 每日新题数变更：重置当日配额（日期/计数/已选未答），使新设置立即生效
      await this.plugin.resetDailyNewQuota();
      return;
    }
    if (key === "randomExamCount") {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
      await this.plugin.saveSettings();
      // 随机考试题数变更：即时刷新已打开面板的按钮文案
      this.plugin.syncRandomExamCount();
      return;
    }
    if (typeof value === "string" && KEY_BINDING_SETTING_KEYS.has(key)) {
      // 键位绑定归一化（与命令式 addKeyBindingSetting 同口径：trim 后首字符，空串=不绑定）。
      // 声明式框架把输入原样传入，多字符/带空格绑定在 resolveKeyBinding 的全串比较下静默失效
      const binding = value.trim().slice(0, 1);
      (this.plugin.settings as unknown as Record<string, unknown>)[key] =
        binding;
      await this.plugin.saveSettings();
      return;
    }
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  /**
   * 「重置刷题进度」按钮：弹分项选择框后按选择清理。
   */
  private async handleResetProgress(): Promise<void> {
    const res = await askResetChoice(this.app);
    if (!res) return;
    await this.plugin.resetQuizProgress(res);
  }

  /**
   * 「随机题目顺序」开关处理：切换后保留答题进度，仅重建显示顺序
   * （开启=随机排列，关闭=恢复 CSV 默认顺序），当前题按 id 重新定位。
   */
  private async handleRandomOrderToggle(
    newValue: boolean,
    toggle?: ToggleComponent
  ): Promise<void> {
    if (newValue === this.plugin.settings.randomOrder) return;
    this.plugin.settings.randomOrder = newValue;
    await this.plugin.saveSettings();
    await this.plugin.reorderQuestions();
    new Notice(
      newValue
        ? "已开启随机题目顺序，答题进度已保留"
        : "已关闭随机题目顺序，恢复默认顺序，答题进度已保留"
    );
  }

  /**
   * < 1.13.0: Obsidian 调用此方法，保持原有命令式实现不变。
   * 注意：新增或修改设置时，需同步更新 display() 与 getSettingDefinitions()。
   */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("刷题啊 - 设置").setHeading();

    this.addBankFolderSetting(containerEl);
    this.addBankStatusSetting(containerEl);
    this.addToggleSetting(
      containerEl,
      "随机题目顺序",
      "开启后每次加载时随机排列题目顺序",
      "randomOrder"
    );
    this.addToggleSetting(
      containerEl,
      "随机选项顺序",
      "开启后每个题目的选项顺序随机排列",
      "randomOptions"
    );
    this.addNumberSetting(
      containerEl,
      "随机考试题数",
      "「随机考试」每次随机抽取的题目数量（从当前筛选范围内的全部题目抽取，不限未答；不足时取全部）",
      "randomExamCount",
      1,
      1000
    );

    new Setting(containerEl).setName("记忆练习").setHeading();
    this.addToggleSetting(
      containerEl,
      "记忆练习",
      "启用基于记忆曲线的练习（FSRS 间隔重复调度）",
      "memoryEnabled"
    );
    this.addNumberSetting(
      containerEl,
      "每日新题数",
      "记忆练习每天引入的新题数量上限（稳定后每日复习量约为该值的 2~3 倍）",
      "memoryDailyNew",
      0,
      500
    );
    this.addToggleSetting(
      containerEl,
      "到期提醒",
      "在状态栏显示今日待复习题数提醒",
      "memoryReminder"
    );
    this.addToggleSetting(
      containerEl,
      "掌握参与评分",
      "记忆练习答对时按标记评分：掌握=Easy（间隔拉长更快）、其余一律 Good；收藏不参与评分（避免难度虚高与间隔压缩）；答错一律 Again。",
      "memoryMarkRating"
    );
    this.addToggleSetting(
      containerEl,
      "左右滑动切题",
      "移动端在刷题面板内左右滑动切换题目（左滑下一题、右滑上一题）；开启时面板区域不触发 Obsidian 自身的侧边栏滑动",
      "swipeNavigation"
    );
    this.addToggleSetting(
      containerEl,
      "非记忆模式答题参与FSRS",
      "常规模式/随机考试中答题也更新记忆卡片（FSRS 间隔重复）；关闭后仅记忆练习更新卡片。图片题的四级评分始终写 FSRS（不受此开关影响）",
      "memoryUpdateInNormalMode"
    );

    new Setting(containerEl).setName("键盘绑定").setHeading();
    this.addToggleSetting(
      containerEl,
      "键盘绑定",
      "刷题面板内启用键盘快捷键（含左右方向键切题与下方选项/标记快捷键）；关闭后全部键盘操作禁用",
      "keyboardBindingsEnabled"
    );
    this.addKeyBindingSetting(
      containerEl,
      "选项快捷键：第 1 个显示选项",
      "按下该键选择当前题第 1 个显示的选项（选项打乱时与屏幕显示的 A 位一致）；单个字符，大小写不敏感，留空不绑定",
      "keyOptionA"
    );
    this.addKeyBindingSetting(
      containerEl,
      "选项快捷键：第 2 个显示选项",
      "按下该键选择第 2 个显示的选项（屏幕 B 位）；单个字符，留空不绑定",
      "keyOptionB"
    );
    this.addKeyBindingSetting(
      containerEl,
      "选项快捷键：第 3 个显示选项",
      "按下该键选择第 3 个显示的选项（屏幕 C 位）；单个字符，留空不绑定",
      "keyOptionC"
    );
    this.addKeyBindingSetting(
      containerEl,
      "选项快捷键：第 4 个显示选项",
      "按下该键选择第 4 个显示的选项（屏幕 D 位）；单个字符，留空不绑定",
      "keyOptionD"
    );
    this.addKeyBindingSetting(
      containerEl,
      "标记快捷键：收藏",
      "按下该键切换当前题的收藏标记；单个字符，大小写不敏感，留空不绑定",
      "keyFavorite"
    );
    this.addKeyBindingSetting(
      containerEl,
      "标记快捷键：掌握",
      "按下该键切换当前题的掌握标记；单个字符，留空不绑定",
      "keyMastered"
    );
    this.addKeyBindingSetting(
      containerEl,
      "标记快捷键：重复",
      "按下该键切换当前题的重复标记；单个字符，留空不绑定",
      "keyRepeat"
    );

    this.addNumberSetting(
      containerEl,
      "答对自动跳转延迟（秒）",
      "答对后自动跳转到下一题的等待时间，0 表示不自动跳转",
      "autoNextDelay",
      0,
      30
    );
    this.addToggleSetting(
      containerEl,
      "默认展开筛选栏",
      "打开刷题面板时筛选栏默认是否展开",
      "filterPanelOpen"
    );
    this.addToggleSetting(
      containerEl,
      "默认展开编辑栏",
      "打开刷题面板时标签/分类编辑栏默认是否展开",
      "editPanelOpen"
    );
    this.addToggleSetting(
      containerEl,
      "默认展开练习栏",
      "打开刷题面板时练习栏（练习入口/分类统计/折线图）默认是否展开",
      "practicePanelOpen"
    );

    new Setting(containerEl).setName("标记筛选默认值").setHeading();

    this.addFilterDefaultSetting(
      containerEl,
      "收藏",
      "defaultFilterFavorite"
    );
    this.addFilterDefaultSetting(
      containerEl,
      "掌握",
      "defaultFilterMastered"
    );
    this.addFilterDefaultSetting(
      containerEl,
      "重复",
      "defaultFilterRepeat"
    );
    this.addFilterDefaultSetting(
      containerEl,
      "错题",
      "defaultFilterWrong"
    );

    new Setting(containerEl).setName("管理").setHeading();
    new Setting(containerEl)
      .setName("重置刷题进度")
      .setDesc("按选择清理答题记录和/或记忆卡片；全部重置会重新加载题库")
      .addButton((btn) =>
        btn.setButtonText("重置").onClick(() => {
          void this.handleResetProgress();
        })
      );
    new Setting(containerEl)
      .setName("刷新题库")
      .setDesc(
        "重新解析题库文件夹（manifest/CSV/图片的新增、删除或替换），保留答题记录与 FSRS 卡片；需面板已打开"
      )
      .addButton((btn) =>
        btn.setButtonText("刷新").onClick(() => {
          void this.plugin.refreshBank();
        })
      );
    new Setting(containerEl)
      .setName("优化题库")
      .setDesc("把当前 CSV 题库编译为分发产物 .cqv（需面板已打开）")
      .addButton((btn) =>
        btn.setButtonText("编译").onClick(() => {
          void this.plugin.compileQuizToCqv();
        })
      );
    new Setting(containerEl)
      .setName("导出修改到 CSV")
      .setDesc("把题库状态中的标签/分类/重复标记写回 CSV（需面板已打开）")
      .addButton((btn) =>
        btn.setButtonText("导出").onClick(() => {
          void this.plugin.exportQuizMetaToCsv();
        })
      );
  }

  /** 是否处于「CSV 与图片并存」的待选择状态。 */
  private isCsvChoicePrompt(): boolean {
    const status = this.plugin.bankStatus;
    return (
      status !== null &&
      status.status === "prompt" &&
      status.reason === "both" &&
      !!status.csvCandidate
    );
  }

  /** 解析结果的模式标签。 */
  private bankModeLabel(status: BankResolution | null): string {
    if (status === null) return "未解析";
    if (status.status === "error") return "错误";
    if (status.status === "prompt") return "未解析";
    switch (status.source.mode) {
      case "manifest":
        return "复合题库（manifest.json）";
      case "csv":
        return "文字题库（CSV/CQV）";
      case "image":
        return "图片题库";
      default:
        return "未解析";
    }
  }

  /** 把当前解析结果渲染为只读状态行（模式/内容文件/图片文件夹/状态文件）。 */
  private renderBankStatus(el: HTMLElement): void {
    el.empty();
    const status = this.plugin.bankStatus;
    const source = status?.status === "ok" ? status.source : null;
    const lines: Array<[string, string]> = [
      ["模式", this.bankModeLabel(status)],
      ["内容文件", source ? source.contentPath || "—" : "—"],
      ["图片文件夹", source ? source.imageFolder || "—" : "—"],
    ];
    if (source) lines.push(["状态文件", sidecarPathFor(source.anchor)]);
    for (const [label, value] of lines) {
      el.createDiv({ text: `${label}：${value}` });
    }
    if (status && status.status !== "ok") {
      el.createDiv({ text: status.message });
      if (status.status === "prompt" && status.reason === "type-mismatch") {
        el.createDiv({ text: "提示：manifest.json 类型不匹配，已忽略。" });
      }
    }
  }

  private addBankFolderSetting(containerEl: HTMLElement): void {
    let textComponent: TextComponent | null = null;
    const apply = async (raw: string): Promise<void> => {
      await this.plugin.changeBankFolder(raw);
      // 取消切换 / 归一化后不同：回写当前生效值，避免输入框显示未生效路径
      textComponent?.setValue(this.plugin.settings.bankFolder);
    };
    new Setting(containerEl)
      .setName("题库文件夹")
      .setDesc(BANK_FOLDER_DESC)
      .addText((text) => {
        textComponent = text;
        text
          .setPlaceholder("例如：题库/行测（根目录用 /）")
          .setValue(this.plugin.settings.bankFolder);
        // 输入框值即缓冲；失焦/回车（change 事件）时由 changeBankFolder 统一处理
        // 写入设置 + 确认 + 卸载/迁移 + 刷新。
        text.inputEl.addEventListener("change", () => {
          void apply(text.inputEl.value);
        });
        const suggest = new FolderSuggest(this.app, text.inputEl);
        suggest.onSelect((folder) => {
          const next = folder.path === "" ? "/" : folder.path;
          text.setValue(next);
          void apply(next);
        });
      });
  }

  private addBankStatusSetting(containerEl: HTMLElement): void {
    const setting = new Setting(containerEl).setName("题库解析状态");
    this.renderBankStatus(setting.descEl);
    if (this.isCsvChoicePrompt()) {
      setting.addButton((btn) =>
        btn.setButtonText("仅用 CSV").onClick(() => {
          void this.plugin.useCsvOnly();
        })
      );
    }
  }

  private addToggleSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: keyof PluginSettings
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) => {
        if (key === "randomOrder") {
          // 开启随机顺序需要用户确认重置进度（取消时回滚开关 UI）
          // key 已窄化为 "randomOrder"，settings[key] 类型即 boolean，无需断言
          return toggle
            .setValue(this.plugin.settings[key])
            .onChange((value) => {
              void this.handleRandomOrderToggle(value, toggle);
            });
        }
        return toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange((value) => {
            (this.plugin.settings as unknown as Record<string, boolean | string>)[key] = value;
            void this.plugin.saveSettings();
            // L-8: 左右滑动切题开关变更时即时同步视图的 data-ignore-swipe 属性，
            // 避免关闭后原生手势被压制到下次渲染
            if (key === "swipeNavigation") {
              this.plugin.syncSwipeNavigation();
            }
          });
      });
  }

  private addNumberSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: keyof PluginSettings,
    min: number,
    max: number
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS[key]))
          .setValue(String(this.plugin.settings[key]))
          .onChange((value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= min && num <= max) {
              (this.plugin.settings as unknown as Record<string, boolean | string | number>)[key] = num;
              void this.plugin.saveSettings();
              // 每日新题数变更：重置当日配额（日期/计数/已选未答），使新设置立即生效
              if (key === "memoryDailyNew") {
                void this.plugin.resetDailyNewQuota();
              }
              // 随机考试题数变更：即时刷新已打开面板的按钮文案
              if (key === "randomExamCount") {
                this.plugin.syncRandomExamCount();
              }
            }
          })
      );
  }

  /** 键盘绑定设置：单字符文本框，change 时写入（取输入的首个字符，trim 空串合法=不绑定）。 */
  private addKeyBindingSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    key: keyof PluginSettings
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        const original = this.plugin.settings[key] as string;
        text.setPlaceholder(String(DEFAULT_SETTINGS[key]))
          .setValue(original)
          .onChange((value) => {
            // 取 trim 后的首个字符作为绑定；空串 = 不绑定（合法值，直接保存）
            const binding = value.trim().slice(0, 1);
            text.inputEl.value = binding;
            (this.plugin.settings as unknown as Record<string, string>)[key] =
              binding;
            void this.plugin.saveSettings();
          });
      });
  }

  private addFilterDefaultSetting(
    containerEl: HTMLElement,
    label: string,
    key: keyof PluginSettings
  ): void {
    new Setting(containerEl)
      .setName(`默认筛选: ${label}`)
      .setDesc(`打开刷题面板时「${label}」筛选的默认状态`)
      .addDropdown((dd) =>
        dd
          .addOption("", "不限")
          .addOption("1", `仅${label}`)
          .addOption("0", `不${label}`)
          .setValue(this.plugin.settings[key] as string)
          .onChange((value) => {
            (this.plugin.settings as unknown as Record<string, string>)[key] = value;
            void this.plugin.saveSettings();
          })
      );
  }
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private readonly input: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.input = inputEl;
    this.limit = 100;
  }

  protected getSuggestions(query: string): TFolder[] {
    const q = query.trim().toLowerCase();
    return this.app.vault
      .getAllFolders(true)
      .filter(
        (folder) =>
          !folder.path.split("/").some((segment) => segment.startsWith("."))
      )
      .filter(
        (folder) =>
          q === "" ||
          folder.path.toLowerCase().includes(q) ||
          (folder.path === "/" && "根目录".includes(q))
      )
      .slice(0, 100);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path === "" ? "/" : folder.path);
  }

  selectSuggestion(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
    // 根目录哨兵为 "/"，不能归一成空串（空串表示未设置题库）
    this.setValue(folder.path === "" ? "/" : folder.path);
    this.input.trigger("input");
    this.close();
    super.selectSuggestion(folder, evt);
  }
}
