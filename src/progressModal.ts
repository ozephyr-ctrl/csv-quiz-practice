import { App, Modal } from "obsidian";
import { Question, MemoryCard } from "./types";
import { normalizeAnswerValue } from "./utils";

export interface ProgressModalOptions {
  questions: Question[]; // 视图当前列表(filteredQuestions,顺序/筛选与视图一致)
  answeredQuestions: Record<string, string>;
  memoryCards: Record<string, MemoryCard>;
  currentId: string | null; // 当前题 id(高亮用)
  onJump: (id: string) => void; // 点击跳转回调
}

/** 列表渲染上限：超限时提示使用筛选缩小范围，避免大量题目卡顿弹窗。 */
const RENDER_LIMIT = 500;

/** 刷题进度弹窗：展示当前列表每道题的答题/记忆状态，点击行跳转。 */
export class ProgressModal extends Modal {
  private opts: ProgressModalOptions;

  constructor(app: App, opts: ProgressModalOptions) {
    super(app);
    this.opts = opts;
    this.titleEl.setText("刷题进度");
  }

  onOpen(): void {
    this.contentEl.empty();
    const { questions, answeredQuestions, memoryCards, currentId } = this.opts;
    const now = new Date().getTime();

    // 汇总统计容器先创建（文本在构建循环累计完成后设置）；列表在 summary 之后
    const summary = this.contentEl.createDiv("csv-quiz-progress-summary");
    const list = this.contentEl.createDiv("csv-quiz-progress-list");
    const stateNames: Record<number, string> = {
      0: "新题",
      1: "学习中",
      2: "复习",
      3: "再学习",
    };

    // 用 DocumentFragment 批量构建行（避免逐行插入触发布局），统计在循环内累计
    const frag = document.createDocumentFragment();
    let answered = 0;
    let correct = 0;
    const renderCount = Math.min(questions.length, RENDER_LIMIT);
    for (let i = 0; i < renderCount; i++) {
      const q = questions[i];
      const a = answeredQuestions[q.id];
      if (a !== undefined) {
        answered++;
        if (normalizeAnswerValue(a) === normalizeAnswerValue(q.answer)) {
          correct++;
        }
      }

      const row = frag.createEl("div", { cls: "csv-quiz-progress-row" });
      if (q.id === currentId) row.addClass("csv-quiz-progress-row-current");
      row.createEl("span", { text: q.id, cls: "csv-quiz-progress-id" });
      // 题干(去 Markdown 符号截断 30 字)
      const stem = q.stem.replace(/[#*`_~[\]()>!-]/g, "").trim();
      row.createEl("span", {
        text: stem.length > 30 ? stem.slice(0, 30) + "…" : stem,
        cls: "csv-quiz-progress-stem",
      });
      // 答题状态
      if (a === undefined) {
        row.createEl("span", {
          text: "未答",
          cls: "csv-quiz-progress-status csv-quiz-progress-unanswered",
        });
      } else if (normalizeAnswerValue(a) === normalizeAnswerValue(q.answer)) {
        row.createEl("span", {
          text: `✓ 已答${a}`,
          cls: "csv-quiz-progress-status csv-quiz-progress-correct",
        });
      } else {
        row.createEl("span", {
          text: `✗ 答错${a}`,
          cls: "csv-quiz-progress-status csv-quiz-progress-wrong",
        });
      }
      // 记忆状态
      const card = memoryCards[q.id];
      if (card) {
        const dueT = new Date(card.due).getTime();
        const dueText = Number.isNaN(dueT)
          ? "—"
          : dueT <= now
            ? "已到期"
            : `${Math.max(1, Math.ceil((dueT - now) / 86400000))} 天后`;
        const memCls =
          "csv-quiz-progress-memory" +
          (dueT <= now ? " csv-quiz-progress-memory-due" : "");
        row.createEl("span", {
          text: `${stateNames[card.state] ?? card.state} ${dueText}`,
          cls: memCls,
        });
      } else {
        row.createEl("span", { text: "—", cls: "csv-quiz-progress-memory" });
      }
      // 标记
      const flags: string[] = [];
      if (q.favorite === "1") flags.push("★");
      if (q.mastered === "1") flags.push("✓");
      if (q.wrong === "1") flags.push("✗");
      if (flags.length > 0) {
        row.createEl("span", {
          text: flags.join(" "),
          cls: "csv-quiz-progress-flags",
        });
      }
      row.addEventListener("click", () => {
        this.close();
        this.opts.onJump(q.id);
      });
    }

    // 超限/空列表提示在 frag 之前追加到 list（显示在列表上方）
    if (questions.length > RENDER_LIMIT) {
      list.createEl("p", {
        text: `仅显示前 ${RENDER_LIMIT} 题，请使用筛选缩小范围`,
        cls: "csv-quiz-empty",
      });
    }
    if (questions.length === 0) {
      list.createEl("p", { text: "当前列表没有题目", cls: "csv-quiz-empty" });
    }
    list.appendChild(frag);

    // 最后设置汇总统计文本（基于当前列表全部题目）
    summary.setText(
      `共 ${questions.length} 题 · 已答 ${answered} · 未答 ${questions.length - answered} · 答对 ${correct} · 答错 ${answered - correct}` +
        (answered > 0
          ? ` · 正确率 ${((correct / answered) * 100).toFixed(1)}%`
          : "")
    );
  }
}
