import { QuizSessionState } from "./types";

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
  if (a.filterTags !== b.filterTags) return false;
  if (a.filterCat1 !== b.filterCat1) return false;
  if (a.filterCat2 !== b.filterCat2) return false;
  if (a.filterCat3 !== b.filterCat3) return false;
  if (a.filterFavorite !== b.filterFavorite) return false;
  if (a.filterMastered !== b.filterMastered) return false;
  if (a.filterRepeat !== b.filterRepeat) return false;
  if (a.filterWrong !== b.filterWrong) return false;

  if (a.displayOrder.length !== b.displayOrder.length) return false;
  for (let i = 0; i < a.displayOrder.length; i++) {
    if (a.displayOrder[i] !== b.displayOrder[i]) return false;
  }

  const ak = Object.keys(a.answeredQuestions);
  const bk = Object.keys(b.answeredQuestions);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a.answeredQuestions[k] !== b.answeredQuestions[k]) return false;
  }

  return true;
}
