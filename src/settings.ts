import {
  App,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  Notice,
  SuggestModal,
} from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS } from "./types";

export class CSVQuizSettingTab extends PluginSettingTab {
  private plugin: any;

  constructor(app: App, plugin: any) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "刷题啊 - 设置" });

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

    containerEl.createEl("h3", { text: "标记筛选默认值" });

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

    containerEl.createEl("h3", { text: "管理" });
    new Setting(containerEl)
      .setName("重置刷题进度")
      .setDesc("清除所有答题记录、统计和筛选状态，重新加载题库")
      .addButton((btn) =>
        btn.setButtonText("重置").onClick(async () => {
          await this.plugin.refreshQuiz();
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
          .onChange(async (value) => {
            this.plugin.settings.csvPath = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) => {
        btn.setButtonText("从库中选择").onClick(() => this.pickCSVFile());
      });
  }

  private pickCSVFile(): void {
    const csvFiles = this.app.vault
      .getFiles()
      .filter((f: TAbstractFile & { extension?: string }) => f.extension === "csv")
      .map((f: any) => f.path);

    if (csvFiles.length === 0) {
      new Notice("库中没有找到 CSV 文件");
      return;
    }

    const modal = new FilePickerModal(
      this.app,
      csvFiles,
      async (selectedPath: string) => {
        this.plugin.settings.csvPath = selectedPath;
        await this.plugin.saveSettings();
        this.display();
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
          .onChange(async (value) => {
            (this.plugin.settings as any)[key] = value;
            await this.plugin.saveSettings();
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
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= min && num <= max) {
              (this.plugin.settings as any)[key] = num;
              await this.plugin.saveSettings();
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
          .onChange(async (value) => {
            (this.plugin.settings as any)[key] = value;
            await this.plugin.saveSettings();
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
