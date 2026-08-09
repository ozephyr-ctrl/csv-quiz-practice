import { QuizSessionState, MemoryCard } from "./types";

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
