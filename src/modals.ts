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
