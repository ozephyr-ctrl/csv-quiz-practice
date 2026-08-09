import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  SuggestModal,
  TFile,
  SettingDefinitionItem,
  ToggleComponent,
} from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS } from "./types";
import { ChoiceModal, askResetChoice } from "./modals";

interface PluginHandle {
  settings: PluginSettings;
  refreshQuiz(): void;
  saveSettings(): Promise<void>;
  flushSettingsSave(): Promise<void>;
  resetQuizProgress(choice?: "records" | "cards" | "all"): Promise<void>;
}

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
        name: "CSV 文件路径",
        desc: "题库 CSV 文件相对于库根目录的路径",
        control: {
          type: "file",
          key: "csvPath",
          defaultValue: DEFAULT_SETTINGS.csvPath,
          filter: (file: TFile) => file.extension === "csv",
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
            desc: "记忆练习每天引入的新题数量上限",
            control: {
              type: "number",
              key: "memoryDailyNew",
              min: 1,
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
    if (key === "randomOrder") {
      await this.handleRandomOrderToggle(value === true);
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
   * 「随机题目顺序」开关处理：开启/关闭都会重排已有会话的显示顺序，
   * 因此开关切换都需要重置刷题进度（清除答题记录/统计）。
   * 用户取消则回滚开关。toggle 参数用于 <1.13 的命令式设置路径回滚开关 UI。
   */
  private async handleRandomOrderToggle(
    newValue: boolean,
    toggle?: ToggleComponent
  ): Promise<void> {
    if (newValue === this.plugin.settings.randomOrder) return;

    const modal = new ChoiceModal(this.app, {
      title: newValue
        ? "开启随机题目顺序需要重置进度"
        : "关闭随机题目顺序需要重置进度",
      message: newValue
        ? "打乱题目顺序需要重置当前刷题进度：将清除所有答题记录与正确/错误统计，并重新随机排列题目顺序。是否继续？"
        : "恢复默认 CSV 顺序需要重置当前刷题进度：将清除所有答题记录与正确/错误统计，并恢复为 CSV 默认顺序。是否继续？",
      options: [
        {
          label: newValue ? "重置并打乱" : "重置并恢复",
          value: "confirm",
          cta: true,
        },
        { label: "取消", value: "cancel" },
      ],
    });
    modal.open();
    const res = await modal.promise;
    if (res !== "confirm") {
      // 回滚开关（1.13+ 声明式设置路径下 UI 可能残留新状态显示，重新打开设置页即恢复）
      this.plugin.settings.randomOrder = !newValue;
      toggle?.setValue(!newValue);
      new Notice("已取消");
      return;
    }

    this.plugin.settings.randomOrder = newValue;
    await this.plugin.saveSettings();
    await this.plugin.resetQuizProgress();
    new Notice(
      newValue
        ? "已重置进度并随机打乱题目顺序"
        : "已重置进度并恢复 CSV 默认顺序"
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

    this.addCSVPathSetting(containerEl);
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
      "记忆练习每天引入的新题数量上限",
      "memoryDailyNew",
      1,
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
  }

  private addCSVPathSetting(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("CSV 文件路径")
      .setDesc("题库 CSV 文件相对于库根目录的路径")
      .addText((text) =>
        text
          .setPlaceholder("题库.csv")
          .setValue(this.plugin.settings.csvPath)
          .onChange((value) => {
            this.plugin.settings.csvPath = value;
            void this.plugin.saveSettings();
          })
      )
      .addButton((btn) => {
        btn.setButtonText("从库中选择").onClick(() => this.pickCSVFile());
      });
  }

  private pickCSVFile(): void {
    const csvFiles = this.app.vault
      .getFiles()
      .filter((f) => f.extension === "csv")
      .map((f) => f.path);

    if (csvFiles.length === 0) {
      new Notice("库中没有找到 CSV 文件");
      return;
    }

    const modal = new FilePickerModal(
      this.app,
      csvFiles,
      (selectedPath: string) => {
        this.plugin.settings.csvPath = selectedPath;
        void this.plugin.saveSettings();
      }
    );
    modal.open();
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
          return toggle
            .setValue(this.plugin.settings[key] as boolean)
            .onChange((value) => {
              void this.handleRandomOrderToggle(value, toggle);
            });
        }
        return toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange((value) => {
            (this.plugin.settings as unknown as Record<string, boolean | string>)[key] = value;
            void this.plugin.saveSettings();
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
            }
          })
      );
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

class FilePickerModal extends SuggestModal<string> {
  private files: string[];
  private onSelect: (path: string) => void;

  constructor(app: App, files: string[], onSelect: (path: string) => void) {
    super(app);
    this.files = files;
    this.onSelect = onSelect;
  }

  getSuggestions(query: string): string[] {
    return this.files.filter((f) =>
      f.toLowerCase().includes(query.toLowerCase())
    );
  }

  renderSuggestion(file: string, el: HTMLElement): void {
    el.createEl("div", { text: file });
  }

  onChooseSuggestion(file: string, evt: MouseEvent | KeyboardEvent): void {
    this.onSelect(file);
  }
}
