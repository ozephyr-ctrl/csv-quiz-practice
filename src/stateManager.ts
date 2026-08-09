import { Notice, Plugin } from "obsidian";
import {
  MemoryCard,
  QuizSessionState,
  PluginData,
  PluginSettings,
} from "./types";

interface DataPatch {
  settings?: PluginSettings;
  quizState?: QuizSessionState | null;
}

class StateWriteQueue {
  private queue: Array<{
    patch: DataPatch;
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];
  private processing = false;
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  enqueue(patch: DataPatch): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ patch, resolve, reject });
      void this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    try {
      const data =
        ((await this.plugin.loadData()) as Record<string, unknown> | null) ||
        {};
      if (item.patch.settings !== undefined) {
        data.settings = item.patch.settings;
      }
      if (item.patch.quizState !== undefined) {
        data.quizState = item.patch.quizState;
      }
      await this.plugin.saveData(data);
      item.resolve();
    } catch (e: unknown) {
      item.reject(e);
    } finally {
      this.processing = false;
      void this.processNext();
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

export class StateManager {
  private plugin: Plugin;
  private currentState: QuizSessionState | null = null;
  private saveTimer: number | null = null;
  private writeQueue: StateWriteQueue;
  private settingsSaveTimer: number | null = null;
  private pendingSettings: PluginSettings | null = null;
  /** 等待本次设置落盘完成的 resolve 集合（共享 promise 语义：后一次保存覆盖前一次，所有等待者统一在最终写入完成后 resolve）。 */
  private settingsResolvers: Array<() => void> = [];

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.writeQueue = new StateWriteQueue(plugin);
  }

  async loadPluginData(currentSettings: PluginSettings): Promise<PluginData> {
    const data =
      ((await this.plugin.loadData()) as Record<string, unknown> | null) || {};
    const settings: PluginSettings = {
      ...currentSettings,
      ...(data.settings as Partial<PluginSettings> | undefined || {}),
    };
    const quizState = this.normalizeQuizState(data.quizState);
    this.currentState = quizState;
    return { settings, quizState };
  }

  /**
   * 对磁盘上读取的 quizState 做字段级归一化防御：类型错误的字段
   * （如 correctCount: "5"、memoryDailyNew: "abc"）在此兜底，避免
   * 类型错误进入运行时崩溃。
   */
  private normalizeQuizState(raw: unknown): QuizSessionState | null {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const toNumber = (v: unknown): number => {
      const n = Number(v);
      return Number.isNaN(n) ? 0 : n;
    };
    const toStr = (v: unknown): string => (typeof v === "string" ? v : "");
    const toStrArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const toRecord = (v: unknown): Record<string, string> =>
      v && typeof v === "object" ? (v as Record<string, string>) : {};
    const memoryCards =
      r.memoryCards === undefined
        ? undefined
        : r.memoryCards && typeof r.memoryCards === "object"
          ? (r.memoryCards as Record<string, MemoryCard>)
          : {};
    return {
      csvPath: toStr(r.csvPath),
      currentIndex: toNumber(r.currentIndex),
      correctCount: toNumber(r.correctCount),
      wrongCount: toNumber(r.wrongCount),
      displayOrder: toStrArray(r.displayOrder),
      filterText: toStr(r.filterText),
      filterTags: toStr(r.filterTags),
      filterCat1: toStr(r.filterCat1),
      filterCat2: toStr(r.filterCat2),
      filterCat3: toStr(r.filterCat3),
      filterFavorite: toStr(r.filterFavorite),
      filterMastered: toStr(r.filterMastered),
      filterRepeat: toStr(r.filterRepeat),
      filterWrong: toStr(r.filterWrong),
      filterUnanswered: toStr(r.filterUnanswered),
      answeredQuestions: toRecord(r.answeredQuestions),
      memoryCards,
      memoryNewDate: toStr(r.memoryNewDate),
      memoryNewCountToday: toNumber(r.memoryNewCountToday),
      memoryPendingNew: toStrArray(r.memoryPendingNew),
      memoryInitialized:
        typeof r.memoryInitialized === "boolean" ? r.memoryInitialized : undefined,
    };
  }

  getState(): QuizSessionState | null {
    return this.currentState;
  }

  setState(state: QuizSessionState | null): void {
    this.currentState = state;
  }

  async saveStateImmediately(state: QuizSessionState): Promise<void> {
    this.cancelScheduledSave();
    this.currentState = state;
    await this.writeQueue.enqueue({ quizState: state });
  }

  scheduleSave(state: QuizSessionState, delay: number = 300): void {
    this.currentState = state;
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.writeQueue.enqueue({ quizState: state }).catch((e: unknown) => {
        console.error("CSV Quiz: Failed to save state", e);
        const message = e instanceof Error ? e.message : String(e);
        new Notice("刷题进度保存失败: " + message);
      });
    }, delay);
  }

  async clearState(): Promise<void> {
    this.cancelScheduledSave();
    this.currentState = null;
    await this.writeQueue.enqueue({ quizState: null });
  }

  cancelScheduledSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * 设置保存防抖：设置面板每次击键都会触发，合并为最后一次变更后 400ms 写入一次。
   * 使用"共享 promise"语义：每次调用都会登记一个 resolve，由最终那次写入完成后统一
   * resolve，避免旧调用 clearTimeout 后其返回的 Promise 永不 resolve。
   */
  async saveSettings(settings: PluginSettings): Promise<void> {
    this.pendingSettings = settings;
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
    }
    return new Promise<void>((resolve) => {
      this.settingsResolvers.push(resolve);
      this.settingsSaveTimer = window.setTimeout(() => {
        this.settingsSaveTimer = null;
        void this.flushSettingsSave();
      }, 400);
    });
  }

  /** 立即落盘挂起的设置保存（设置页关闭 / 插件卸载时调用，避免防抖窗口内丢设置）。 */
  async flushSettingsSave(): Promise<void> {
    if (this.settingsSaveTimer !== null) {
      window.clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
    }
    const s = this.pendingSettings;
    this.pendingSettings = null;
    const resolvers = this.settingsResolvers;
    this.settingsResolvers = [];
    try {
      if (s) {
        await this.writeQueue.enqueue({ settings: s });
      }
    } finally {
      // 统一 resolve 所有登记过的等待者（即使写入失败也需解除挂起）
      resolvers.forEach((resolve) => resolve());
    }
  }
}
