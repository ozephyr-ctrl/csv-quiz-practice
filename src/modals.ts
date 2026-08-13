import { App, Modal } from "obsidian";

export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
  /** Render as primary call-to-action button. */
  cta?: boolean;
  /** Render as destructive (red) button. */
  danger?: boolean;
}

export interface ChoiceModalOptions {
  title: string;
  message: string;
  options: ChoiceOption[];
}

/**
 * Promise-based modal that presents a title, a message, and a vertical list of
 * choice buttons. Resolves with the chosen option's `value`, or `null` if the
 * user closes the modal (Esc / backdrop) without choosing.
 */
export class ChoiceModal extends Modal {
  readonly promise: Promise<string | null>;
  private resolveFn!: (value: string | null) => void;
  private resolved = false;
  private readonly opts: ChoiceModalOptions;

  constructor(app: App, opts: ChoiceModalOptions) {
    super(app);
    this.opts = opts;
    this.promise = new Promise<string | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.empty();

    if (this.opts.message) {
      this.contentEl.createEl("p", {
        text: this.opts.message,
        cls: "csv-quiz-modal-message",
      });
    }

    const list = this.contentEl.createDiv("csv-quiz-modal-options");

    for (const opt of this.opts.options) {
      const item = list.createDiv("csv-quiz-modal-option");

      const btn = item.createEl("button", {
        text: opt.label,
        cls:
          "csv-quiz-btn csv-quiz-modal-btn" +
          (opt.cta ? " csv-quiz-btn-primary" : "") +
          (opt.danger ? " csv-quiz-btn-danger" : ""),
      });
      btn.addEventListener("click", () => this.choose(opt.value));

      if (opt.description) {
        item.createEl("div", {
          text: opt.description,
          cls: "csv-quiz-modal-option-desc",
        });
      }
    }
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolveFn(null);
    }
  }

  private choose(value: string): void {
    if (this.resolved) return;
    this.resolved = true;
    this.close();
    this.resolveFn(value);
  }
}

/** 弹「重置刷题进度」分项选择框；返回 "records"/"cards"/"order"/"all"，取消或关闭返回 null。 */
export function askResetChoice(
  app: App
): Promise<"records" | "cards" | "order" | "all" | null> {
  const modal = new ChoiceModal(app, {
    title: "重置刷题进度",
    message:
      "选择要清理的内容。刷题记录：答题记录与正确/错误统计；记忆卡片：FSRS 间隔重复数据（到期安排、稳定性、难度等）。",
    options: [
      {
        label: "仅清理刷题记录",
        value: "records",
        description: "清除答题记录与统计，保留记忆卡片；题目顺序将按当前设置重建",
      },
      {
        label: "仅删除记忆卡片",
        value: "cards",
        description: "清除 FSRS 间隔重复数据，保留答题记录；题目顺序将按当前设置重建",
      },
      {
        label: "重置题目顺序",
        value: "order",
        description: "将题目顺序恢复为 CSV 文件原始顺序，不清理答题记录与记忆卡片",
      },
      {
        label: "全部重置",
        value: "all",
        description:
          "清除答题记录、记忆卡片与状态标记（收藏/掌握/错题/标签覆盖），并重新加载题库",
        cta: true,
      },
      { label: "取消", value: "cancel" },
    ],
  });
  modal.open();
  return modal.promise.then((res) =>
    res === null || res === "cancel"
      ? null
      : (res as "records" | "cards" | "order" | "all")
  );
}

/**
 * Promise-based modal for picking tags from a list of all existing tags.
 * Displays checkboxes for each tag, pre-checked based on currentTags.
 * Resolves with a space-separated tag string, or `null` if cancelled.
 */
export class TagPickerModal extends Modal {
  readonly promise: Promise<string | null>;
  private resolveFn!: (value: string | null) => void;
  private resolved = false;
  private readonly allTags: string[];
  private readonly currentTags: string;

  constructor(app: App, allTags: string[], currentTags: string) {
    super(app);
    this.allTags = allTags;
    this.currentTags = currentTags;
    this.promise = new Promise<string | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  onOpen(): void {
    this.titleEl.setText("快速设置标签");
    this.contentEl.empty();

    if (this.allTags.length === 0) {
      this.contentEl.createEl("p", {
        text: "暂无标签",
        cls: "csv-quiz-tag-picker-empty",
      });
      return;
    }

    this.contentEl.createEl("p", {
      text: "选择你要应用到题目的标签",
      cls: "csv-quiz-modal-message",
    });

    const list = this.contentEl.createDiv("csv-quiz-tag-picker-list");

    const currentTagSet = new Set(
      this.currentTags
        .split(/\s+/)
        .filter((t) => t.length > 0),
    );

    const checkboxes: HTMLInputElement[] = [];

    for (const tag of this.allTags) {
      const item = list.createDiv("csv-quiz-tag-picker-item");

      const cb = item.createEl("input", {
        cls: "csv-quiz-tag-picker-checkbox",
        attr: { type: "checkbox" },
      });
      cb.checked = currentTagSet.has(tag);
      checkboxes.push(cb);

      item.createEl("span", {
        text: tag,
        cls: "csv-quiz-tag-picker-label",
      });

      item.addEventListener("click", (e) => {
        if (e.target !== cb) {
          cb.checked = !cb.checked;
        }
      });
    }

    const actions = this.contentEl.createDiv("csv-quiz-tag-picker-actions");

    const confirmBtn = actions.createEl("button", {
      text: "确认",
      cls: "csv-quiz-btn csv-quiz-modal-btn csv-quiz-btn-primary",
    });
    confirmBtn.addEventListener("click", () => {
      const selected = this.allTags.filter((_, i) => checkboxes[i].checked);
      this.choose(selected.join(" "));
    });

    const cancelBtn = actions.createEl("button", {
      text: "取消",
      cls: "csv-quiz-btn csv-quiz-modal-btn",
    });
    cancelBtn.addEventListener("click", () => this.cancel());
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolveFn(null);
    }
  }

  private choose(value: string): void {
    if (this.resolved) return;
    this.resolved = true;
    this.close();
    this.resolveFn(value);
  }

  private cancel(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.close();
    this.resolveFn(null);
  }
}

export interface PromptModalOptions {
  title: string;
  message?: string;
  placeholder?: string;
}

/**
 * Promise-based 文本输入弹窗：单行输入 + 确认/取消按钮。
 * resolve 输入值（trim 后；空串是合法值）或 null（取消/关闭/Esc）。
 */
export class PromptModal extends Modal {
  readonly promise: Promise<string | null>;
  private resolveFn!: (value: string | null) => void;
  private resolved = false;
  private readonly opts: PromptModalOptions;
  private inputEl!: HTMLInputElement;

  constructor(app: App, opts: PromptModalOptions) {
    super(app);
    this.opts = opts;
    this.promise = new Promise<string | null>((resolve) => {
      this.resolveFn = resolve;
    });
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.empty();

    if (this.opts.message) {
      this.contentEl.createEl("p", {
        text: this.opts.message,
        cls: "csv-quiz-modal-message",
      });
    }

    this.inputEl = this.contentEl.createEl("input", {
      type: "text",
      cls: "csv-quiz-modal-input",
      attr: { placeholder: this.opts.placeholder ?? "" },
    });
    // Enter 确认
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.choose();
    });

    const actions = this.contentEl.createDiv("csv-quiz-modal-options");
    const confirmBtn = actions.createEl("button", {
      text: "确认",
      cls: "csv-quiz-btn csv-quiz-modal-btn csv-quiz-btn-primary",
    });
    confirmBtn.addEventListener("click", () => this.choose());
    const cancelBtn = actions.createEl("button", {
      text: "取消",
      cls: "csv-quiz-btn csv-quiz-modal-btn",
    });
    cancelBtn.addEventListener("click", () => this.cancel());
  }

  onClose(): void {
    if (!this.resolved) {
      this.resolved = true;
      this.resolveFn(null);
    }
  }

  private choose(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.close();
    // 空串是合法值（允许空备注）；仅取消/关闭返回 null
    this.resolveFn(this.inputEl.value.trim());
  }

  private cancel(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.close();
    this.resolveFn(null);
  }
}

/** 弹文本输入框；返回输入值（trim 后，空串合法）或 null（取消）。 */
export function askPrompt(
  app: App,
  opts: PromptModalOptions
): Promise<string | null> {
  const modal = new PromptModal(app, opts);
  modal.open();
  return modal.promise;
}
