import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  SuggestModal,
  TFile,
  SettingDefinitionItem,
} from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS } from "./types";

interface PluginHandle {
  settings: PluginSettings;
  refreshQuiz(): void;
  saveSettings(): Promise<void>;
}

export class CSVQuizSettingTab extends PluginSettingTab {
  private plugin: PluginHandle;

  constructor(app: App, plugin: PluginHandle) {
    super(app, plugin as any);
    this.plugin = plugin;
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
            desc: "清除所有答题记录、统计和筛选状态，重新加载题库",
            action: () => this.plugin.refreshQuiz(),
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
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
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
      .setDesc("清除所有答题记录、统计和筛选状态，重新加载题库")
      .addButton((btn) =>
        btn.setButtonText("重置").onClick(() => {
          this.plugin.refreshQuiz();
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
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings[key] as boolean)
          .onChange((value) => {
            (this.plugin.settings as unknown as Record<string, boolean | string>)[key] = value;
            void this.plugin.saveSettings();
          })
      );
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
          .setPlaceholder(String(DEFAULT_SETTINGS[key] as number))
          .setValue(String(this.plugin.settings[key] as number))
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
