import type { ImageRatingKey } from "./imageBank";
import { IMAGE_RATING_LABELS } from "./imageBank";

export interface ShortAnswerQuestionUiOptions {
  container: HTMLElement;
  stem: string;
  answer: string;
  answerShown: boolean;
  rating: ImageRatingKey | null;
  memoryEnabled: boolean;
  reverse: boolean;
  onReveal: () => void;
  onRate: (rating: ImageRatingKey) => void;
  /** 由调用方提供 MarkdownRenderer 渲染；模块本身不依赖 Obsidian API */
  renderMarkdown: (el: HTMLElement, markdown: string) => void;
}

/** 评分按钮顺序（与图片题一致）。 */
const RATING_ORDER: ImageRatingKey[] = ["again", "hard", "good", "easy"];

/** 每个评分对应的颜色类，见 styles.css 里的 --csv-image-rate-color。 */
const RATING_COLOR_CLASS: Record<ImageRatingKey, string> = {
  again: "csv-quiz-short-rate-again",
  hard: "csv-quiz-short-rate-hard",
  good: "csv-quiz-short-rate-good",
  easy: "csv-quiz-short-rate-easy",
};

/** 答案为空（理论上不该发生）时的占位文案。 */
const EMPTY_ANSWER_TEXT = "（无答案）";

/**
 * 渲染简答题：题干与答案都由调用方的 MarkdownRenderer 渲染。
 * 未展示答案时不把答案写进 DOM（含文本、属性、aria/title/data-*），避免泄露。
 * 每题重建整棵子树，调用方在状态变化后重渲染即可。
 */
export function renderShortAnswerQuestionUi(
  opts: ShortAnswerQuestionUiOptions
): void {
  const container = opts.container;
  container.empty();

  const answerShown = opts.answerShown === true;
  const reverse = opts.reverse === true;
  const badgeText = reverse ? "简答题（反向）" : "简答题";

  const root = container.createDiv("csv-quiz-short-question");

  root.createDiv({ text: badgeText, cls: "csv-quiz-short-badge" });

  // 题干：完整 Markdown（高亮、表格、数学、代码等均由调用方渲染器处理）
  const stemEl = root.createDiv(
    "csv-quiz-short-stem markdown-rendered"
  );
  opts.renderMarkdown(stemEl, opts.stem);

  // 未展示答案：只给题干与主按钮，答案字符串不进入 DOM
  if (!answerShown) {
    const revealBtn = root.createEl("button", {
      text: "展示答案",
      cls: "csv-quiz-btn csv-quiz-btn-primary csv-quiz-short-reveal-btn",
      attr: { type: "button" },
    });
    revealBtn.addEventListener("click", () => opts.onReveal());
    return;
  }

  const answerBox = root.createDiv("csv-quiz-short-answer-box");
  answerBox.createDiv({ text: "答案", cls: "csv-quiz-short-answer-label" });

  const answerEl = answerBox.createDiv(
    "csv-quiz-short-answer markdown-rendered"
  );
  if (typeof opts.answer === "string" && opts.answer.trim() !== "") {
    opts.renderMarkdown(answerEl, opts.answer);
  } else {
    answerEl.setText(EMPTY_ANSWER_TEXT);
  }

  // 记忆曲线关闭：只给答案，不出现评分按钮
  if (opts.memoryEnabled !== true) {
    root.createDiv({
      text: "记忆曲线关闭，不记录 FSRS",
      cls: "csv-quiz-short-memory-off",
    });
    return;
  }

  // 已评分：展示结果标签，不再给按钮（下一题由调用方负责）
  const ratedLabel = opts.rating ? IMAGE_RATING_LABELS[opts.rating] : undefined;
  if (ratedLabel) {
    root.createDiv({
      text: `已评分：${ratedLabel}`,
      cls: "csv-quiz-short-rated",
    });
    return;
  }

  const rateRow = root.createDiv("csv-quiz-short-rate");
  for (const key of RATING_ORDER) {
    const btn = rateRow.createEl("button", {
      text: IMAGE_RATING_LABELS[key],
      cls: `csv-quiz-btn csv-quiz-short-rate-btn ${RATING_COLOR_CLASS[key]}`,
      attr: { type: "button" },
    });
    btn.dataset.rating = key;
    btn.addEventListener("click", () => opts.onRate(key));
  }
}
