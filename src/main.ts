import { Plugin } from "obsidian";
import { PluginSettings, PluginData, VIEW_TYPE_QUIZ } from "./types";
import { CSVQuizSettingTab } from "./settings";
import { QuizView } from "./quizView";
import { StateManager } from "./stateManager";
import { CSVWriteQueue } from "./csvHandler";

export default class CSVQuizPlugin extends Plugin {
  settings: PluginSettings;
  stateManager: StateManager;
  csvWriteQueue: CSVWriteQueue;

  async onload(): Promise<void> {
    this.stateManager = new StateManager(this);
    this.csvWriteQueue = new CSVWriteQueue(this.app.vault);

    await this.loadSettings();
    await this.stateManager.loadPluginData(this.settings);

    this.registerView(VIEW_TYPE_QUIZ, (leaf) => {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ);
      if (existing.length > 0 && existing[0] !== leaf) {
        leaf.detach();
        this.app.workspace.setActiveLeaf(existing[0], false, true);
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
  }

  onunload(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ);
    for (const leaf of leaves) {
      const view = leaf.view as QuizView;
      if (view && view.onClose) {
        void view.onClose();
      }
    }
  }

  activateView(): void {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();

    if (!leaf) {
      leaf = workspace.getLeaf(true);
      void leaf.setViewState({ type: VIEW_TYPE_QUIZ, active: true });
    }

    workspace.setActiveLeaf(leaf, false, true);
  }

  refreshQuiz(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_QUIZ).first();
    if (leaf) {
      const view = leaf.view as QuizView;
      void view.refresh();
    }
  }

  async loadSettings(): Promise<void> {
    const data: PluginData = (await this.loadData()) || {
      settings: {
        csvPath: "题库.csv",
        randomOrder: false,
        randomOptions: false,
        autoNextDelay: 1,
        filterPanelOpen: true,
        editPanelOpen: true,
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
    };
  }

  async saveSettings(): Promise<void> {
    await this.stateManager.saveSettings(this.settings);
  }
}
