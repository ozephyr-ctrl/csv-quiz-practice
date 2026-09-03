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
    const normCache = new Map<string, string>();
    let answered = 0;
    let correct = 0;
    for (const q of questions) {
      const a = answeredQuestions[q.id];
      if (a !== undefined) {
        answered++;
        const normA = normalizeAnswerValue(a);
        const normAns = normalizeAnswerValue(q.answer);
        normCache.set(`u:${q.id}`, normA);
        normCache.set(`c:${q.id}`, normAns);
        if (normA === normAns) {
          correct++;
        }
      }
    }

    // 最后设置汇总统计文本（基于当前列表全部题目；空列表分支同样适用）
    summary.setText(
      `共 ${questions.length} 题 · 已答 ${answered} · 未答 ${questions.length - answered} · 答对 ${correct} · 答错 ${answered - correct}` +
        (answered > 0
          ? ` · 正确率 ${((correct / answered) * 100).toFixed(1)}%`
          : "")
    );

    if (questions.length === 0) {
      list.createEl("p", { text: "当前列表没有题目", cls: "csv-quiz-empty" });
      return;
    }

    // 单行渲染（结构与旧版一致；点击改为 viewport 级委托，行上只挂 data-id）
    const renderRow = (q: Question): HTMLElement => {
      const a = answeredQuestions[q.id];

      const row = createEl("div", { cls: "csv-quiz-progress-row" });
      row.dataset.id = q.id;
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
          text: `${stateNames[card.state] ?? "未知"} ${dueText}`,
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
      return row;
    };

    // 虚拟滚动骨架：topSpacer + 视口行容器 + bottomSpacer（均在滚动的 list 内）
    const topSpacer = list.createDiv();
    const viewport = list.createDiv();
    const bottomSpacer = list.createDiv();

    // 行高实测：先插入首行读 offsetHeight（行均为单行文本，结构一致高度相同）。
    // onOpen 时 modal 若尚未完成布局，实测可能为 0/偏差，由下方 rAF 复测兜底
    const probe = renderRow(questions[0]);
    viewport.appendChild(probe);
    let rowHeight = probe.offsetHeight || ProgressModal.FALLBACK_ROW_HEIGHT;

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
        const measured = first?.offsetHeight ?? 0;
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
