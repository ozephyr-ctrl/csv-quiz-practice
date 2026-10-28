import { MemoryCard, Question } from "./types";
import { shuffle } from "./utils";

/**
 * 「按当前筛选练习」的题目排序模式。
 * - "bank"：保持调用方给定的题库顺序（CSV 解析顺序）
 * - "random"：随机打乱
 * - "due"：记忆到期时间升序（已到期/逾期在前），无卡片的题按原序追加
 */
export type FilterPracticeOrder = "bank" | "random" | "due";

/** 卡片是否存在且 due 可解析。 */
export function hasValidDue(card: MemoryCard | undefined): boolean {
  if (!card) return false;
  return !Number.isNaN(new Date(card.due).getTime());
}

/**
 * 按指定模式排列「当前筛选」得到的题池（纯函数，不修改入参）。
 *
 * @param pool 筛选后的题池，顺序即调用方的题库顺序
 * @param mode 排序模式
 * @param memoryCards 题库的记忆卡片表（按题 id 索引）
 * @param now 预留参数（当前不参与过滤：逾期与未来到期都保留）
 * @param shuffleFn 可注入的洗牌函数（测试/确定性用），缺省用 utils.shuffle
 */
export function orderFilterPracticePool(
  pool: Question[],
  mode: FilterPracticeOrder,
  memoryCards: Record<string, MemoryCard>,
  now?: number,
  shuffleFn?: <T>(items: T[]) => T[]
): Question[] {
  const base = Array.isArray(pool) ? pool : [];
  // now 仅为 API 稳定性保留：到期模式不做「此刻」过滤，逾期与未来到期都计入。
  void now;

  if (mode === "random") {
    const doShuffle = shuffleFn ?? shuffle;
    return [...doShuffle(base)];
  }

  if (mode === "due") {
    const cards = memoryCards ?? {};
    const dueItems: Array<{ question: Question; dueMs: number; index: number }> =
      [];
    const rest: Question[] = [];

    base.forEach((question, index) => {
      const card = cards[question.id];
      if (!hasValidDue(card)) {
        rest.push(question);
        return;
      }
      dueItems.push({
        question,
        dueMs: new Date(card.due).getTime(),
        index,
      });
    });

    // 显式按 [dueMs, 原下标] 排序，保证同期稳定且不依赖引擎的排序稳定性。
    dueItems.sort((a, b) => {
      if (a.dueMs !== b.dueMs) return a.dueMs - b.dueMs;
      return a.index - b.index;
    });

    return [...dueItems.map((item) => item.question), ...rest];
  }

  // "bank"（及未知模式兜底）：原序返回，不排序、不洗牌。
  return [...base];
}
