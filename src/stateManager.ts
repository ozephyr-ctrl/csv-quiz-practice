import { Plugin } from "obsidian";
import { QuizSessionState, PluginData, PluginSettings } from "./types";

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
      const data = (await this.plugin.loadData()) || {};
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

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.writeQueue = new StateWriteQueue(plugin);
  }

  async loadPluginData(): Promise<PluginData> {
    const data: Record<string, unknown> = (await this.plugin.loadData()) || {};
    const settings: PluginSettings = {
      ...(this.plugin.settings as PluginSettings),
      ...(data.settings as Partial<PluginSettings> | undefined || {}),
    };
    const quizState: QuizSessionState | null = data.quizState
      ? { ...(data.quizState as QuizSessionState) }
      : null;
    this.currentState = quizState;
    return { settings, quizState };
  }

  getState(): QuizSessionState | null {
    return this.currentState;
  }

  setState(state: QuizSessionState | null): void {
    this.currentState = state;
  }

  async saveStateImmediately(state: QuizSessionState): Promise<void> {
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
      this.writeQueue.enqueue({ quizState: state }).catch((e) =>
        console.error("CSV Quiz: Failed to save state", e)
      );
    }, delay);
  }

  async clearState(): Promise<void> {
    this.currentState = null;
    await this.writeQueue.enqueue({ quizState: null });
  }

  cancelScheduledSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  async saveSettings(settings: PluginSettings): Promise<void> {
    await this.writeQueue.enqueue({ settings });
  }
}
