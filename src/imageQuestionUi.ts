import type { ImageRatingKey } from "./imageBank";
import { IMAGE_RATING_LABELS } from "./imageBank";

export interface ImageQuestionUiOptions {
  container: HTMLElement;
  /** 图片显示地址；null 表示正在加载或加载失败（配合 imageLoading 区分） */
  imageUrl: string | null;
  imageLoading?: boolean;
  imageNumber: number;
  answer: string;
  answerShown: boolean;
  rating: ImageRatingKey | null;
  memoryEnabled: boolean;
  onReveal: () => void;
  onRate: (rating: ImageRatingKey) => void;
}

/** 评分按钮顺序（与 FSRS 四级一致）。 */
const RATING_ORDER: ImageRatingKey[] = ["again", "hard", "good", "easy"];

/** 每个评分对应的颜色类，见 styles.css 里的 --csv-image-rate-color。 */
const RATING_COLOR_CLASS: Record<ImageRatingKey, string> = {
  again: "csv-quiz-image-rate-again",
  hard: "csv-quiz-image-rate-hard",
  good: "csv-quiz-image-rate-good",
  easy: "csv-quiz-image-rate-easy",
};

/** 图片加载失败时的中性占位文案（任何情况下都不得是答案）。 */
const IMAGE_ERROR_TEXT = "图片加载失败";
const IMAGE_LOADING_TEXT = "图片加载中…";

/** 答案为空（理论上不该发生）时的占位文案。 */
const EMPTY_ANSWER_TEXT = "（无答案）";

/**
 * 渲染图片题：图片即题干，文件名（去扩展名）即答案。
 * 未展示答案时不把答案写进 DOM（含 alt），避免任何形式泄露。
 * 每题重建整棵子树，调用方在状态变化后重渲染即可。
 */
export function renderImageQuestionUi(opts: ImageQuestionUiOptions): void {
  const container = opts.container;
  container.empty();

  const imageNumber = Number.isFinite(opts.imageNumber)
    ? Math.max(1, Math.trunc(opts.imageNumber))
    : 1;
  const badgeText = `图片题 #${imageNumber}`;
  const answerText =
    typeof opts.answer === "string" && opts.answer.trim() !== ""
      ? opts.answer
      : EMPTY_ANSWER_TEXT;
  const answerShown = opts.answerShown === true;

  const root = container.createDiv("csv-quiz-image-question");

  root.createDiv({ text: badgeText, cls: "csv-quiz-image-badge" });

  // 图片区：居中的浅边框画框，图片按 contain 缩放，长图/宽图都不撑破布局
  const frame = root.createDiv("csv-quiz-image-frame");
  const img = frame.createEl("img", { cls: "csv-quiz-image" });
  // 未展示答案时 alt 只给编号（读屏用户也不会提前拿到答案）
  img.alt = answerShown ? answerText : badgeText;
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;

  const fallback = frame.createDiv({
    text: IMAGE_ERROR_TEXT,
    cls: "csv-quiz-image-fallback csv-quiz-image-fallback-hidden",
  });

  if (opts.imageUrl) {
    img.src = opts.imageUrl;
  } else {
    // 未拿到（脱敏的）图片地址：不写入任何 src，避免资源路径泄露文件名答案
    img.addClass("csv-quiz-image-broken");
    fallback.removeClass("csv-quiz-image-fallback-hidden");
    fallback.setText(
      opts.imageLoading === true ? IMAGE_LOADING_TEXT : IMAGE_ERROR_TEXT
    );
  }

  img.addEventListener("error", () => {
    img.addClass("csv-quiz-image-broken");
    // 加载失败后图片不可见，alt 同步换成中性文本，不留答案痕迹
    img.alt = IMAGE_ERROR_TEXT;
    fallback.setText(IMAGE_ERROR_TEXT);
    fallback.removeClass("csv-quiz-image-fallback-hidden");
  });

  if (!answerShown) {
    const revealBtn = root.createEl("button", {
      text: "展示答案",
      cls: "csv-quiz-btn csv-quiz-btn-primary csv-quiz-image-reveal-btn",
      attr: { type: "button" },
    });
    revealBtn.addEventListener("click", () => opts.onReveal());
    return;
  }

  const answerBox = root.createDiv("csv-quiz-image-answer");
  answerBox.createDiv({ text: "答案", cls: "csv-quiz-image-answer-label" });
  answerBox.createDiv({
    text: answerText,
    cls: "csv-quiz-image-answer-text",
  });

  // 记忆曲线关闭：只给答案，不出现评分按钮
  if (opts.memoryEnabled !== true) {
    root.createDiv({
      text: "记忆曲线关闭，不记录 FSRS",
      cls: "csv-quiz-image-memory-off",
    });
    return;
  }

  // 已评分：展示结果标签，不再给按钮（下一题由调用方负责）
  const ratedLabel = opts.rating ? IMAGE_RATING_LABELS[opts.rating] : undefined;
  if (ratedLabel) {
    root.createDiv({
      text: `已评分：${ratedLabel}`,
      cls: "csv-quiz-image-rated",
    });
    return;
  }

  const rateRow = root.createDiv("csv-quiz-image-rate");
  for (const key of RATING_ORDER) {
    const btn = rateRow.createEl("button", {
      text: IMAGE_RATING_LABELS[key],
      cls: `csv-quiz-btn csv-quiz-image-rate-btn ${RATING_COLOR_CLASS[key]}`,
      attr: { type: "button" },
    });
    btn.dataset.rating = key;
    btn.addEventListener("click", () => opts.onRate(key));
  }
}
