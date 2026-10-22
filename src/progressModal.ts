import { App, Modal } from "obsidian";
import { Question, MemoryCard } from "./types";
import { normalizeAnswerValue } from "./utils";
import {
  imageRatingLabel,
  isImageQuestion,
  isImageRatingKey,
} from "./imageBank";
import { isShortAnswer } from "./shortAnswer";

export interface ProgressModalOptions {
  questions: Question[]; // 视图当前列表(filteredQuestions,顺序/筛选与视图一致)
  answeredQuestions: Record<string, string>;
  memoryCards: Record<string, MemoryCard>;
  currentId: string | null; // 当前题 id(高亮用)
  onJump: (id: string) => void; // 点击跳转回调
  /** 随机考试进行中（尚未交卷）：隐藏对错、正确率、错题标记与记忆状态，避免泄露答案。 */
  maskCorrectness?: boolean;
}

/** 进度汇总的计数结果（纯数据，便于单测）。 */
export interface ProgressStats {
  /** 全部已答（含图片题、简答题） */
  answered: number;
  /** 普通选择题已答数（对错/正确率的分母） */
  textAnswered: number;
  correct: number;
  imageTotal: number;
  imageRated: number;
  shortTotal: number;
  shortRated: number;
}

/** 统计与行渲染共用的归一化缓存（统计时填充、行渲染时读取）。 */
export interface ProgressStatsResult {
  stats: ProgressStats;
  normCache: Map<string, string>;
}

/**
 * 全量遍历题目累计进度计数。纯函数，不依赖 Obsidian，便于单元测试。
 * - `answered` 统计全部已答（图片题/简答题只要有记录即算）；
 * - `textAnswered`（对错/正确率分母）只含既非图片、也非简答的普通选择题；
 * - 简答题：`shortRated` 只认四级 rating key，revealed 视为已答未评；
 * - `maskCorrectness` 为真时不计算对错，避免通过汇总泄露成绩。
 */
export function computeProgressStats(
  questions: Question[],
  answeredQuestions: Record<string, string>,
  maskCorrectness: boolean
): ProgressStatsResult {
  const normCache = new Map<string, string>();
  const stats: ProgressStats = {
    answered: 0,
    textAnswered: 0,
    correct: 0,
    imageTotal: 0,
    imageRated: 0,
    shortTotal: 0,
    shortRated: 0,
  };

  for (const q of questions) {
    const a = answeredQuestions[q.id];
    if (isImageQuestion(q)) {
      stats.imageTotal++;
      if (a !== undefined) {
        stats.answered++;
        if (isImageRatingKey(a)) stats.imageRated++;
      }
      continue;
    }
    if (isShortAnswer(q)) {
      stats.shortTotal++;
      if (a !== undefined) {
        stats.answered++;
        if (isImageRatingKey(a)) stats.shortRated++;
      }
      continue;
    }
    if (a !== undefined) {
      stats.answered++;
      stats.textAnswered++;
      // 随机考试进行中不计算/展示对错，避免通过汇总泄露成绩
      if (maskCorrectness) continue;
      const normA = normalizeAnswerValue(a);
      const normAns = normalizeAnswerValue(q.answer);
      normCache.set(`u:${q.id}`, normA);
      normCache.set(`c:${q.id}`, normAns);
      if (normA === normAns) {
        stats.correct++;
      }
    }
  }

  return { stats, normCache };
}

/** 汇总行文本：图片题/简答题进展各自只在存在该类题时追加，两者可同时出现。 */
export function formatProgressSummary(
  total: number,
  stats: ProgressStats,
  maskCorrectness: boolean
): string {
  // 图片题进展只在存在图片题时追加（已评数是中性信息，不受 maskCorrectness 影响）
  const imagePart =
    stats.imageTotal > 0 ? ` · 图片题已评 ${stats.imageRated}/${stats.imageTotal}` : "";
  // 简答题与图片题口径一致，但单独展示
  const shortPart =
    stats.shortTotal > 0 ? ` · 简答题已评 ${stats.shortRated}/${stats.shortTotal}` : "";

  if (maskCorrectness) {
    return (
      `共 ${total} 题 · 已答 ${stats.answered} · 未答 ${total - stats.answered}` +
      imagePart +
      shortPart
    );
  }
  return (
    `共 ${total} 题 · 已答 ${stats.answered} · 未答 ${total - stats.answered} · 答对 ${stats.correct} · 答错 ${stats.textAnswered - stats.correct}` +
    (stats.textAnswered > 0
      ? ` · 正确率 ${((stats.correct / stats.textAnswered) * 100).toFixed(1)}%`
      : "") +
    imagePart +
    shortPart
  );
}

/** 题干预览：去掉常见 Markdown 符号后按 30 字截断（加省略号）。 */
export function progressStemPreview(stem: string): string {
  const text = stem.replace(/[#*`_~[\]()>!-]/g, "").trim();
  return text.length > 30 ? text.slice(0, 30) + "…" : text;
}

/** 简答题左侧徽标文案；反向卡标注方向。 */
export function shortAnswerBadge(q: Question): string {
  return q.side === "rev" ? "简答题（反向）" : "简答题";
}

/** 简答题状态文案与样式类；简答与图片一样不区分对错（无红绿）。 */
export function shortAnswerStatus(
  answer: string | undefined,
  maskCorrectness: boolean
): { text: string; cls: string } {
  const neutral = "csv-quiz-progress-status";
  if (answer === undefined) {
    return { text: "未答", cls: `${neutral} csv-quiz-progress-unanswered` };
  }
  if (maskCorrectness) {
    return { text: "已答", cls: `${neutral} csv-quiz-progress-masked` };
  }
  const ratingLabel = imageRatingLabel(answer);
  if (ratingLabel !== null) {
    return { text: `已评 · ${ratingLabel}`, cls: neutral };
  }
  // revealed：已看答案但未评分
  return { text: "已看答案", cls: `${neutral} csv-quiz-progress-unanswered` };
}

/** 刷题进度弹窗：展示当前列表每道题的答题/记忆状态，点击行跳转。
 *  大题库下全量渲染行（数千行 × 多个子元素）会导致打开迟滞与滚动卡顿，
 *  列表采用虚拟滚动：只构建视口附近的行，上下 spacer 占位维持总高度，
 *  滚动条几何由 行数 × 实测行高 计算（行均为单行文本，高度一致）。 */
export class ProgressModal extends Modal {
  private opts: ProgressModalOptions;

  /** 视口上下各多渲染的缓冲行数（滚动时窗口漂出缓冲区才重建，降低重建频率） */
  private static readonly BUFFER_ROWS = 10;
  /** 行高实测失败（onOpen 时 modal 尚未布局）的回退值 px */
  private static readonly FALLBACK_ROW_HEIGHT = 32;

  constructor(app: App, opts: ProgressModalOptions) {
    super(app);
    this.opts = opts;
    this.titleEl.setText("刷题进度");
  }

  onOpen(): void {
    this.contentEl.empty();
    const { questions, answeredQuestions, memoryCards, currentId } = this.opts;
    const maskCorrectness = this.opts.maskCorrectness === true;
    const now = new Date().getTime();

    // 汇总统计容器先创建（文本在统计循环累计完成后设置）；列表在 summary 之后
    const summary = this.contentEl.createDiv("csv-quiz-progress-summary");
    const list = this.contentEl.createDiv("csv-quiz-progress-list");
    const stateNames: Record<number, string> = {
      0: "新题",
      1: "学习中",
      2: "复习",
      3: "再学习",
    };

    // 统计与渲染解耦——单独全量遍历所有题目累计 answered/correct（基数与列表长度一致），
    // 同时把每题的用户答案与标准答案的归一化结果存入 Map（统计时填充、行渲染时读取，避免重复 normalizeAnswerValue）
    const { stats, normCache } = computeProgressStats(
      questions,
      answeredQuestions,
      maskCorrectness
    );

    // 最后设置汇总统计文本（基于当前列表全部题目；空列表分支同样适用）
    summary.setText(formatProgressSummary(questions.length, stats, maskCorrectness));

    if (questions.length === 0) {
      list.createEl("p", { text: "当前列表没有题目", cls: "csv-quiz-empty" });
      return;
    }

    // 单行渲染（结构与旧版一致；点击改为 viewport 级委托，行上只挂 data-id）
    const renderRow = (q: Question): HTMLElement => {
      const a = answeredQuestions[q.id];
      const isImage = isImageQuestion(q);
      const ratingLabel = a !== undefined ? imageRatingLabel(a) : null;

      const row = createEl("div", { cls: "csv-quiz-progress-row" });
      row.dataset.id = q.id;
      if (q.id === currentId) row.addClass("csv-quiz-progress-row-current");
      if (isImage) {
        // 图片题：stem 就是答案（文件名），不能走下面的“去 Markdown 题干”路径；
        // 左侧用中性徽标（未评分）或文件名（已评分），保持单行等高
        const num =
          typeof q.imageNumber === "number" && Number.isFinite(q.imageNumber)
            ? Math.max(1, Math.trunc(q.imageNumber))
            : 1;
        row.createEl("span", {
          text: `图片题 #${num}`,
          cls: "csv-quiz-progress-image-label",
        });
        // 随机考试进行中：文件名即答案，不能展示
        const showName = ratingLabel !== null && !maskCorrectness;
        row.createEl("span", {
          text: showName ? q.answer : "（图片题）",
          cls: showName
            ? "csv-quiz-progress-image-answer"
            : "csv-quiz-progress-stem",
        });
        // 状态：图片题无对错，统一用中性样式（避免红绿）
        if (a === undefined) {
          row.createEl("span", {
            text: "未答",
            cls: "csv-quiz-progress-status csv-quiz-progress-unanswered",
          });
        } else if (maskCorrectness) {
          row.createEl("span", {
            text: "已答",
            cls: "csv-quiz-progress-status csv-quiz-progress-masked",
          });
        } else if (ratingLabel !== null) {
          row.createEl("span", {
            text: `已评 · ${ratingLabel}`,
            cls: "csv-quiz-progress-status",
          });
        } else {
          // revealed：已看答案但未评分
          row.createEl("span", {
            text: "已看答案",
            cls: "csv-quiz-progress-status csv-quiz-progress-unanswered",
          });
        }
      } else if (isShortAnswer(q)) {
        // 简答题：自评题型，与图片题同样不显示对错红绿；stem 是卡面题干
        // （反向卡的 stem 是原答案文本，同属可预览内容），绝不展示 q.answer
        row.createEl("span", {
          text: shortAnswerBadge(q),
          cls: "csv-quiz-progress-image-label csv-quiz-progress-short-label",
        });
        row.createEl("span", {
          text: progressStemPreview(q.stem),
          cls: "csv-quiz-progress-stem",
        });
        const status = shortAnswerStatus(a, maskCorrectness);
        row.createEl("span", { text: status.text, cls: status.cls });
      } else {
        row.createEl("span", { text: q.id, cls: "csv-quiz-progress-id" });
        // 题干(去 Markdown 符号截断 30 字)
        row.createEl("span", {
          text: progressStemPreview(q.stem),
          cls: "csv-quiz-progress-stem",
        });
        // 答题状态
        if (a === undefined) {
          row.createEl("span", {
            text: "未答",
            cls: "csv-quiz-progress-status csv-quiz-progress-unanswered",
          });
        } else if (maskCorrectness) {
          // 随机考试进行中：只显示已答，不泄露对错
          row.createEl("span", {
            text: "已答",
            cls: "csv-quiz-progress-status csv-quiz-progress-masked",
          });
        } else if (
          normCache.get(`u:${q.id}`) === normCache.get(`c:${q.id}`)
        ) {
          row.createEl("span", {
            text: a ? `✓ 已答${a}` : "✓ 已答",
            cls: "csv-quiz-progress-status csv-quiz-progress-correct",
          });
        } else {
          row.createEl("span", {
            text: a ? `✗ 答错${a}` : "✗ 答错",
            cls: "csv-quiz-progress-status csv-quiz-progress-wrong",
          });
        }
      }
      // 记忆状态
      const card = memoryCards[q.id];
      if (maskCorrectness) {
        // 随机考试进行中：卡片会因本次作答进入再学习/到期，展示状态会间接泄露对错
        row.createEl("span", { text: "—", cls: "csv-quiz-progress-memory" });
      } else if (card) {
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
          text: `${stateNames[card.state] ?? "未知"} ${dueText}`,
          cls: memCls,
        });
      } else {
        row.createEl("span", { text: "—", cls: "csv-quiz-progress-memory" });
      }
      // 标记（考试进行中隐藏错题标记，答错会自动置位会泄露对错）
      const flags: string[] = [];
      if (q.favorite === "1") flags.push("★");
      if (q.mastered === "1") flags.push("✓");
      if (!maskCorrectness && q.wrong === "1") flags.push("✗");
      if (flags.length > 0) {
        row.createEl("span", {
          text: flags.join(" "),
          cls: "csv-quiz-progress-flags",
        });
      }
      return row;
    };

    // 虚拟滚动骨架：topSpacer + 视口行容器 + bottomSpacer（均在滚动的 list 内）
    const topSpacer = list.createDiv();
    const viewport = list.createDiv();
    const bottomSpacer = list.createDiv();

    // 行高实测：先插入首行读实际渲染高度（行均为单行文本，结构一致高度相同）。
    // 必须用 getBoundingClientRect().height（含小数）：offsetHeight 取整后与实际
    // 分数行高（主题 line-height/缩放下是常态）不符，spacer 按整数算会让每次
    // 窗口重建扰动视口几何，Chromium 滚动锚定随之同向补偿 scrollTop，
    // 滚动距离被间歇放大约 3 倍（滑动速度不可控）。
    // onOpen 时 modal 若尚未完成布局，实测可能为 0，由下方 rAF 复测兜底
    const probe = renderRow(questions[0]);
    viewport.appendChild(probe);
    let rowHeight = probe.getBoundingClientRect().height || ProgressModal.FALLBACK_ROW_HEIGHT;

    const total = questions.length;
    let renderedStart = 0;
    let renderedEnd = 0;

    const renderWindow = (force: boolean): void => {
      const firstVisible = Math.max(
        0,
        Math.floor(list.scrollTop / rowHeight) - ProgressModal.BUFFER_ROWS
      );
      const visibleCount =
        Math.ceil(list.clientHeight / rowHeight) +
        ProgressModal.BUFFER_ROWS * 2;
      const start = Math.min(firstVisible, Math.max(0, total - 1));
      const end = Math.min(total, start + Math.max(1, visibleCount));
      // 当前所需窗口完全落在已渲染范围内 → 跳过重建（滚动常见路径零开销）
      if (!force && start >= renderedStart && end <= renderedEnd) return;
      renderedStart = start;
      renderedEnd = end;
      viewport.empty();
      const frag = createFragment();
      for (let i = start; i < end; i++) {
        frag.appendChild(renderRow(questions[i]));
      }
      viewport.appendChild(frag);
      topSpacer.style.height = `${start * rowHeight}px`;
      bottomSpacer.style.height = `${(total - end) * rowHeight}px`;
    };

    // 点击委托：viewport 单监听器（替代每行一个 listener，大题库下显著省内存与建行耗时）
    viewport.addEventListener("click", (e: MouseEvent) => {
      const row = (e.target as HTMLElement | null)?.closest(
        ".csv-quiz-progress-row"
      ) as HTMLElement | null;
      const id = row?.dataset.id;
      if (!id) return;
      this.close();
      this.opts.onJump(id);
    });

    // 先建立几何（spacer 高度就位）再定位当前题，否则 scrollTop 会被内容高度钳制为 0
    const scrollToCurrent = (): void => {
      if (!currentId) return;
      const idx = questions.findIndex((q) => q.id === currentId);
      if (idx >= 0) {
        list.scrollTop = Math.max(
          0,
          idx * rowHeight - Math.floor(list.clientHeight / 2)
        );
      }
    };
    renderWindow(true);
    scrollToCurrent();
    renderWindow(true);

    // 被动 scroll 监听：窗口漂出缓冲区才重建行
    list.addEventListener("scroll", () => renderWindow(false), {
      passive: true,
    });

    // 布局稳定后复测行高（打开动画期间 onOpen 的同步实测可能为 0/偏差）：
    // 行高有变时按实际行高重定位当前题；实测仍为 0 则再等一帧（最多 4 帧）
    const settle = (retries: number): void => {
      window.requestAnimationFrame(() => {
        const first = viewport.querySelector<HTMLElement>(
          ".csv-quiz-progress-row"
        );
        // 与初始实测同口径：getBoundingClientRect().height 保留小数，
        // offsetHeight 取整会重新引入行高失配
        const measured = first?.getBoundingClientRect().height ?? 0;
        if (measured > 0 && measured !== rowHeight) {
          rowHeight = measured;
          scrollToCurrent();
        }
        renderWindow(true);
        if (measured === 0 && retries > 0) settle(retries - 1);
      });
    };
    settle(3);

    // 视口尺寸变化（旋转屏幕/窗口缩放）时整窗重渲染。自清理：弹窗关闭（DOM 脱离）
    // 后首个 resize 自动移除监听——调用方可能以实例属性覆盖 onClose，不能依赖它清理
    const onResize = (): void => {
      if (!list.isConnected) {
        window.removeEventListener("resize", onResize);
        return;
      }
      renderWindow(true);
    };
    window.addEventListener("resize", onResize);
  }
}
