import type { ChartDayPoint } from "./practiceStats";

/**
 * 练习面板折线图：共 y 轴双系列（每日已答题量 / 预计到期题目量），横轴按日，
 * 支持左右拖动（触摸/鼠标/滚轮）平移查看历史与预测。
 * 性能要点：devicePixelRatio 缩放绘制；所有重绘经 requestAnimationFrame 合并
 * （拖动/惯性/尺寸变化每帧至多一次）；ResizeObserver 只在尺寸真实变化时重绘；
 * 面板折叠（画布无尺寸）时跳过绘制，展开后由调用方强制刷新。
 */
export class PracticeChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private height: number;
  private points: ChartDayPoint[] = [];
  private todayIndex = 0;
  /** 视窗起始的浮点天数（null = 尚未初始化，首次绘制时定位到今日附近）。 */
  private offset: number | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private rafId: number | null = null;
  private momentumRafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private seriesVisible: { answered: boolean; due: boolean } = {
    answered: true,
    due: true,
  };
  private colors = {
    answered: "#4caf50",
    due: "#ff9800",
    text: "#999999",
    grid: "#dddddd",
    accent: "#7c3aed",
  };
  /** 拖动状态（pointerdown 起始；velocity 单位 px/ms，供惯性用）。 */
  private pan = {
    active: false,
    pointerId: -1,
    lastX: 0,
    lastT: 0,
    velocity: 0,
  };

  private static readonly PAD_L = 34;
  private static readonly PAD_R = 10;
  private static readonly PAD_T = 20;
  private static readonly PAD_B = 20;

  constructor(canvas: HTMLCanvasElement, options: { height?: number } = {}) {
    this.canvas = canvas;
    this.height = options.height ?? 190;
    canvas.style.height = `${this.height}px`;
    this.ctx = canvas.getContext("2d");
    this.bindInteraction();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(canvas);
    }
    this.handleResize();
  }

  /** 更新数据。resetView=true 时把视窗重置到今日附近（面板展开/首次显示用）。 */
  setData(points: ChartDayPoint[], todayIndex: number, resetView = false): void {
    this.points = points;
    this.todayIndex = todayIndex;
    if (resetView) this.offset = null;
    this.clampOffset();
    this.scheduleDraw();
  }

  /** 切换系列可见性，返回切换后的状态。 */
  toggleSeries(series: "answered" | "due"): boolean {
    this.seriesVisible[series] = !this.seriesVisible[series];
    this.scheduleDraw();
    return this.seriesVisible[series];
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.stopMomentum();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /* ===================== 尺寸与绘制调度 ===================== */

  private handleResize(): void {
    if (this.destroyed) return;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight || this.height;
    if (cssW === 0) {
      // 折叠/隐藏：清零尺寸，展开后 ResizeObserver 会再次触发
      this.cssW = 0;
      return;
    }
    if (cssW === this.cssW && cssH === this.cssH) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.readColors();
    this.clampOffset();
    this.scheduleDraw();
  }

  /** 从画布继承的主题 CSS 变量读色（失败回退内置色）。 */
  private readColors(): void {
    try {
      const cs = getComputedStyle(this.canvas);
      const pick = (name: string, fallback: string): string => {
        const v = cs.getPropertyValue(name).trim();
        return v || fallback;
      };
      this.colors = {
        answered: pick("--color-green", this.colors.answered),
        due: pick("--color-orange", this.colors.due),
        text: pick("--text-muted", this.colors.text),
        grid: pick("--background-modifier-border", this.colors.grid),
        accent: pick("--interactive-accent", this.colors.accent),
      };
    } catch {
      // 保持现有回退色
    }
  }

  private scheduleDraw(): void {
    if (this.destroyed || this.rafId !== null) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  /* ===================== 布局计算 ===================== */

  private plotWidth(): number {
    return Math.max(
      50,
      this.cssW - PracticeChart.PAD_L - PracticeChart.PAD_R
    );
  }

  /** 单日像素宽：目标可见天数随宽度自适应（窄屏≈12 天，宽屏≤30 天）；数据少时拉伸填满。 */
  private computeDayWidth(): number {
    const targetVisible = Math.min(
      30,
      Math.max(12, Math.round(this.plotWidth() / 32))
    );
    const byTarget = this.plotWidth() / targetVisible;
    if (this.points.length === 0) return byTarget;
    return Math.max(byTarget, this.plotWidth() / this.points.length);
  }

  private visibleDays(dayWidth: number): number {
    return this.plotWidth() / dayWidth;
  }

  private maxOffset(dayWidth: number): number {
    return Math.max(0, this.points.length - this.visibleDays(dayWidth));
  }

  private clampOffset(): void {
    if (this.offset === null || this.cssW === 0 || this.points.length === 0) {
      return;
    }
    const dayWidth = this.computeDayWidth();
    this.offset = Math.min(
      Math.max(this.offset, 0),
      this.maxOffset(dayWidth)
    );
  }

  /* ===================== 绘制 ===================== */

  private draw(): void {
    if (this.destroyed || this.ctx === null || this.cssW === 0) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const W = this.cssW;
    const H = this.cssH;
    const padL = PracticeChart.PAD_L;
    const padR = PracticeChart.PAD_R;
    const padT = PracticeChart.PAD_T;
    const padB = PracticeChart.PAD_B;
    const plotW = this.plotWidth();
    const plotH = H - padT - padB;

    if (this.points.length === 0) {
      ctx.fillStyle = this.colors.text;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("暂无数据", W / 2, H / 2);
      return;
    }

    const dayWidth = this.computeDayWidth();
    // 首次绘制：把今日定位在视窗约 72% 处（左侧看历史、右侧看预测）
    if (this.offset === null) {
      this.offset = Math.min(
        Math.max(this.todayIndex + 0.5 - this.visibleDays(dayWidth) * 0.72, 0),
        this.maxOffset(dayWidth)
      );
    }
    const offset = this.offset;
    const xOf = (i: number): number => padL + (i - offset) * dayWidth;

    // y 轴刻度：可见窗口内两系列的最大值取“好看的步长”向上取整
    const i0 = Math.max(0, Math.floor(offset));
    const i1 = Math.min(this.points.length - 1, Math.ceil(offset + this.visibleDays(dayWidth)));
    let peak = 0;
    for (let i = i0; i <= i1; i++) {
      const p = this.points[i];
      if (this.seriesVisible.answered && p.answered > peak) peak = p.answered;
      if (this.seriesVisible.due && p.due > peak) peak = p.due;
    }
    // 计数为整数：步长夹到 ≥1，保证刻度标签恒为整数
    const step = Math.max(1, niceStep(Math.max(1, peak) / 4));
    const yMax = Math.max(step, Math.ceil(peak / step) * step);
    const yOf = (v: number): number => padT + plotH - (v / yMax) * plotH;

    // 水平网格线 + y 轴标签（整数计数值，右对齐留 6px）
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      const y = yOf(v);
      ctx.strokeStyle = this.colors.grid;
      ctx.globalAlpha = v === 0 ? 0.9 : 0.45;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.colors.text;
      ctx.fillText(String(v), padL - 6, y);
    }

    // 未来预测区（今日右侧）淡色底 + 今日竖虚线
    const todayX = xOf(this.todayIndex + 0.5);
    if (todayX < W - padR) {
      ctx.fillStyle = this.colors.accent;
      ctx.globalAlpha = 0.05;
      ctx.fillRect(todayX, padT, W - padR - todayX, plotH);
      ctx.globalAlpha = 1;
    }
    if (todayX >= padL - 1 && todayX <= W - padR + 1) {
      ctx.save();
      ctx.strokeStyle = this.colors.accent;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(todayX, padT - 4);
      ctx.lineTo(todayX, H - padB);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = this.colors.accent;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText("今天", todayX, padT - 5);
    }

    // x 轴日期标签（M/D）：步长保证相邻标签至少约 52px
    ctx.fillStyle = this.colors.text;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(52 / dayWidth));
    for (let i = i0; i <= i1; i++) {
      if (i % labelStep !== 0) continue;
      const x = xOf(i);
      if (x < padL + 8 || x > W - padR - 8) continue;
      const d = new Date(this.points[i].ms);
      ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, x, H - padB + 5);
    }

    // 双系列折线（先画到期再画答题，答题线在上）+ 半透明面积填充
    const drawSeries = (
      getValue: (p: ChartDayPoint) => number,
      color: string
    ): void => {
      const start = Math.max(0, i0 - 1);
      const end = Math.min(this.points.length - 1, i1 + 1);
      // 面积填充
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, withAlpha(color, 0.18));
      grad.addColorStop(1, withAlpha(color, 0.02));
      ctx.beginPath();
      ctx.moveTo(xOf(start), yOf(getValue(this.points[start])));
      for (let i = start + 1; i <= end; i++) {
        ctx.lineTo(xOf(i), yOf(getValue(this.points[i])));
      }
      ctx.lineTo(xOf(end), padT + plotH);
      ctx.lineTo(xOf(start), padT + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      // 折线
      ctx.beginPath();
      ctx.moveTo(xOf(start), yOf(getValue(this.points[start])));
      for (let i = start + 1; i <= end; i++) {
        ctx.lineTo(xOf(i), yOf(getValue(this.points[i])));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    };
    if (this.seriesVisible.due) {
      drawSeries((p) => p.due, this.colors.due);
    }
    if (this.seriesVisible.answered) {
      drawSeries((p) => p.answered, this.colors.answered);
    }

    // 全区间无任何数据时的占位提示（避免空图误判为故障）
    let hasAny = false;
    for (const p of this.points) {
      if (p.answered > 0 || p.due > 0) {
        hasAny = true;
        break;
      }
    }
    if (!hasAny) {
      ctx.fillStyle = this.colors.text;
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("暂无练习数据，答题后开始记录", W / 2, padT + plotH / 2);
    }
  }

  /* ===================== 交互：拖动 / 惯性 / 滚轮 ===================== */

  private bindInteraction(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e: PointerEvent) => {
      if (this.destroyed || !e.isPrimary || this.pan.active) return;
      this.stopMomentum();
      this.pan.active = true;
      this.pan.pointerId = e.pointerId;
      this.pan.lastX = e.clientX;
      this.pan.lastT = e.timeStamp;
      this.pan.velocity = 0;
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // 指针已失效等极端情况：忽略，拖动仍可继续（丢失 capture 则移出画布时结束）
      }
    });
    c.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.pan.active || e.pointerId !== this.pan.pointerId) return;
      const dx = e.clientX - this.pan.lastX;
      const dt = Math.max(1, e.timeStamp - this.pan.lastT);
      // 指数平滑速度（px/ms），供松手后的惯性滚动
      this.pan.velocity = 0.75 * this.pan.velocity + 0.25 * (dx / dt);
      this.pan.lastX = e.clientX;
      this.pan.lastT = e.timeStamp;
      this.applyPanDelta(dx);
    });
    const endPan = (e: PointerEvent): void => {
      if (!this.pan.active || e.pointerId !== this.pan.pointerId) return;
      this.pan.active = false;
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        // 已自动释放时忽略
      }
      if (Math.abs(this.pan.velocity) > 0.05) this.startMomentum();
    };
    c.addEventListener("pointerup", endPan);
    c.addEventListener("pointercancel", endPan);
    // 触摸板横向滚动 / Shift+滚轮 转横向；纵向滚动交给页面（不 preventDefault）
    c.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (this.destroyed || this.points.length === 0) return;
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        const shiftVertical = e.shiftKey && e.deltaY !== 0 && e.deltaX === 0;
        if (!horizontal && !shiftVertical) return;
        e.preventDefault();
        const delta = horizontal ? e.deltaX : e.deltaY;
        this.applyPanDelta(delta);
        this.stopMomentum();
      },
      { passive: false }
    );
  }

  /** 按像素位移平移视窗（右拖看历史、左拖看未来），并夹紧到数据区间。 */
  private applyPanDelta(dxPx: number): void {
    if (this.cssW === 0 || this.points.length === 0) return;
    const dayWidth = this.computeDayWidth();
    const base = this.offset ?? 0;
    this.offset = Math.min(
      Math.max(base - dxPx / dayWidth, 0),
      this.maxOffset(dayWidth)
    );
    this.scheduleDraw();
  }

  /** 松手后的惯性滚动：速度按帧衰减（≈0.94/16ms），触边即停。 */
  private startMomentum(): void {
    if (this.momentumRafId !== null || this.destroyed) return;
    let lastT = performance.now();
    let velocity = this.pan.velocity;
    const tick = (): void => {
      if (this.destroyed) {
        this.momentumRafId = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min(40, Math.max(1, now - lastT));
      lastT = now;
      velocity *= Math.pow(0.94, dt / 16);
      const before = this.offset;
      this.applyPanDelta(velocity * dt);
      const stopped =
        Math.abs(velocity) < 0.02 ||
        this.offset === before; // 触边后被夹紧 → 停止
      if (stopped) {
        this.momentumRafId = null;
        return;
      }
      this.momentumRafId = window.requestAnimationFrame(tick);
    };
    this.momentumRafId = window.requestAnimationFrame(tick);
  }

  private stopMomentum(): void {
    if (this.momentumRafId !== null) {
      window.cancelAnimationFrame(this.momentumRafId);
      this.momentumRafId = null;
    }
  }
}

/** 计数轴的“好看步长”：1/2/5 × 10^k 中取不小于 raw 的最小者。 */
function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 5, 10]) {
    const s = m * pow;
    if (s >= raw - 1e-9) return s;
  }
  return 10 * pow;
}

/** hex 颜色加透明度；非 hex 输入原样返回（CSS 变量可能是 rgb() 形式，直接用）。 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return color;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
