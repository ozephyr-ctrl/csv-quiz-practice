import { QuizSessionState, MemoryCard, PluginSettings } from "./types";

export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function sortByDisplayOrder<T extends { id: string }>(
  items: T[],
  displayOrder: string[]
): T[] {
  const orderMap = new Map<string, number>();
  displayOrder.forEach((id, index) => orderMap.set(id, index));

  return [...items].sort((a, b) => {
    const aIdx = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIdx = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIdx - bIdx;
  });
}

/**
 * Deep equality check for two quiz session states. Used to detect whether the
 * persisted progress (data.json) has been modified externally relative to the
 * in-memory current progress. `null` is treated as a distinct value: two nulls
 * are equal, one null and one state are not.
 */
export function quizStateEquals(
  a: QuizSessionState | null,
  b: QuizSessionState | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  if (a.csvPath !== b.csvPath) return false;
  if (a.currentIndex !== b.currentIndex) return false;
  if (a.correctCount !== b.correctCount) return false;
  if (a.wrongCount !== b.wrongCount) return false;
  if (a.filterText !== b.filterText) return false;
  if (a.filterTags !== b.filterTags) return false;
  if (a.filterCat1 !== b.filterCat1) return false;
  if (a.filterCat2 !== b.filterCat2) return false;
  if (a.filterCat3 !== b.filterCat3) return false;
  if (a.filterFavorite !== b.filterFavorite) return false;
  if (a.filterMastered !== b.filterMastered) return false;
  if (a.filterRepeat !== b.filterRepeat) return false;
  if (a.filterWrong !== b.filterWrong) return false;
  if ((a.filterUnanswered || "") !== (b.filterUnanswered || "")) return false;

  // displayOrder / answeredQuestions 为旧版数据可能缺失的字段，缺失时按空值处理
  const aOrder = a.displayOrder || [];
  const bOrder = b.displayOrder || [];
  if (aOrder.length !== bOrder.length) return false;
  for (let i = 0; i < aOrder.length; i++) {
    if (aOrder[i] !== bOrder[i]) return false;
  }

  const aq = a.answeredQuestions || {};
  const bq = b.answeredQuestions || {};
  const ak = Object.keys(aq);
  const bk = Object.keys(bq);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (aq[k] !== bq[k]) return false;
  }

  // memoryCards 为可选字段（旧进度无记忆数据），缺失视为空对象
  const am = a.memoryCards || {};
  const bm = b.memoryCards || {};
  const amk = Object.keys(am);
  const bmk = Object.keys(bm);
  if (amk.length !== bmk.length) return false;
  for (const k of amk) {
    const ac = am[k];
    const bc = bm[k];
    if (!ac || !bc) return false;
    if (ac.state !== bc.state) return false;
    if (ac.stability !== bc.stability) return false;
    if (ac.difficulty !== bc.difficulty) return false;
    if (ac.due !== bc.due) return false;
    if (ac.reps !== bc.reps) return false;
    if (ac.lapses !== bc.lapses) return false;
    if (ac.learningSteps !== bc.learningSteps) return false;
    if ((ac.lastReview || "") !== (bc.lastReview || "")) return false;
  }

  // 每日新题配额为可选字段（旧进度无），缺失视为 0/空
  if ((a.memoryNewDate || "") !== (b.memoryNewDate || "")) return false;
  if ((a.memoryNewCountToday || 0) !== (b.memoryNewCountToday || 0)) return false;

  // 当日已选未答新题为可选字段（旧进度无），缺失视为空数组
  const ap = a.memoryPendingNew || [];
  const bp = b.memoryPendingNew || [];
  if (ap.length !== bp.length) return false;
  for (let i = 0; i < ap.length; i++) {
    if (ap[i] !== bp[i]) return false;
  }

  // 记忆练习初始化标记为可选字段（旧进度无），缺失视为 false
  if (!!a.memoryInitialized !== !!b.memoryInitialized) return false;

  return true;
}

/** 统计到期卡片数：due 非法（不可解析）的卡片不计入。 */
export function countDueCards(
  cards: Record<string, MemoryCard> | undefined,
  now: Date = new Date()
): number {
  if (!cards) return 0;
  let n = 0;
  for (const c of Object.values(cards)) {
    if (!c || typeof c !== "object") continue;
    const t = new Date(c.due).getTime();
    if (!Number.isNaN(t) && t <= now.getTime()) n++;
  }
  return n;
}

/** 归一化答案：大写、去除非 A-D、去重、排序（用于对错比较，忽略字母顺序与重复）。 */
export function normalizeAnswerValue(value: string): string {
  return [...new Set(value.toUpperCase().replace(/[^A-D]/g, ""))].sort().join("");
}

/**
 * 单张记忆卡片的字段级归一化：state 必须为 0-3 的整数，数值字段必须为
 * 有限数字（difficulty 按定义域限制在 1-10），due/lastReview 必须为字符串。
 * 任一字段类型错误返回 null（整卡作废，题目回到新题状态，由调用方剔除），
 * 避免 renderCardPanel 的 toFixed 等调用在损坏数据上抛 TypeError 中断渲染。
 * due/lastReview 的"可解析为时间"不在此时强制——下游 parseDueTime 与
 * applyMemoryReview 的 F2 防御另行兜底。
 */
export function normalizeMemoryCard(raw: unknown): MemoryCard | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const toNum = (v: unknown, min: number, max: number): number | null => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      return null;
    }
    return v;
  };
  if (
    typeof r.state !== "number" ||
    !Number.isInteger(r.state) ||
    r.state < 0 ||
    r.state > 3
  ) {
    return null;
  }
  const stability = toNum(r.stability, 0, Infinity);
  if (stability === null) return null;
  const difficulty = toNum(r.difficulty, 1, 10);
  if (difficulty === null) return null;
  const reps = toNum(r.reps, 0, Infinity);
  if (reps === null) return null;
  const lapses = toNum(r.lapses, 0, Infinity);
  if (lapses === null) return null;
  const learningSteps = toNum(r.learningSteps, 0, Infinity);
  if (learningSteps === null) return null;
  if (typeof r.due !== "string" || typeof r.lastReview !== "string") {
    return null;
  }
  return {
    state: r.state,
    stability,
    difficulty,
    due: r.due,
    reps,
    lapses,
    learningSteps,
    lastReview: r.lastReview,
    // 冲突合并时间戳：有限非负数值才保留
    ...(typeof r.ts === "number" && Number.isFinite(r.ts) && r.ts >= 0
      ? { ts: r.ts }
      : {}),
  };
}

/** memoryCards 记录的字段级归一化：逐卡片校验，类型错误的整卡剔除。输入非对象时返回空记录。 */
export function normalizeMemoryCards(
  raw: unknown
): Record<string, MemoryCard> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, MemoryCard> = {};
  for (const [id, card] of Object.entries(raw)) {
    const c = normalizeMemoryCard(card);
    if (c !== null) result[id] = c;
  }
  return result;
}

/* ===================== 键盘绑定解析 ===================== */

/** 键盘绑定命中结果：选项按显示位置（0 起），标记为固定三字段之一。 */
export type KeyBindingTarget =
  | { kind: "option"; index: number }
  | { kind: "mark"; field: "favorite" | "mastered" | "repeat" };

/**
 * 解析按键命中的自定义绑定（选项快捷键/标记快捷键）。
 * 匹配规则：绑定值 trim 后与按键（KeyboardEvent.key）忽略大小写比较；
 * 绑定为空串/纯空白 = 未绑定（忽略）。选项优先于标记（重复绑定时先命中选项）。
 * 未命中返回 null。
 */
export function resolveKeyBinding(
  settings: PluginSettings,
  key: string
): KeyBindingTarget | null {
  const k = key.trim().toLowerCase();
  if (!k) return null;
  const optionBindings = [
    settings.keyOptionA,
    settings.keyOptionB,
    settings.keyOptionC,
    settings.keyOptionD,
  ];
  for (let i = 0; i < optionBindings.length; i++) {
    const b = (optionBindings[i] ?? "").trim().toLowerCase();
    if (b && b === k) return { kind: "option", index: i };
  }
  const markBindings: Array<["favorite" | "mastered" | "repeat", string]> = [
    ["favorite", settings.keyFavorite],
    ["mastered", settings.keyMastered],
    ["repeat", settings.keyRepeat],
  ];
  for (const [field, binding] of markBindings) {
    const b = (binding ?? "").trim().toLowerCase();
    if (b && b === k) return { kind: "mark", field };
  }
  return null;
}
