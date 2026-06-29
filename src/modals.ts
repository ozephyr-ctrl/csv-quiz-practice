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
  private resolveFn!: (value: string | null) => void;
  private resolved = false;
  private readonly opts: ChoiceModalOptions;

  constructor(app: App, opts: ChoiceModalOptions) {
    super(app);
    this.opts = opts;
  }

  open(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.resolveFn = resolve;
      void super.open();
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
