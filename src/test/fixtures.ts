import { MemoryCard } from "../types";
import { SidecarData } from "../sidecar";

/** 合法记忆卡片样例（字段值在类型定义域内）。 */
export function cardFor(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return {
    state: 2,
    stability: 3.5,
    difficulty: 5.2,
    due: "2026-01-01T00:00:00.000Z",
    reps: 4,
    lapses: 1,
    learningSteps: 0,
    lastReview: "2025-12-30T00:00:00.000Z",
    ...overrides,
  };
}

/** 合法 sidecar 数据样例（v1）。 */
export function validSidecar(): SidecarData {
  return {
    version: 1,
    meta: { q1: { tags: "#t" } },
    state: {
      currentIndex: 7,
      correctCount: 3,
      wrongCount: 1,
      displayOrder: ["q1", "q2"],
      filterText: "",
      filterTags: "",
      filterCat1: "",
      filterCat2: "",
      filterCat3: "",
      filterFavorite: "",
      filterMastered: "",
      filterRepeat: "",
      filterWrong: "",
      filterUnanswered: "",
      answeredQuestions: { q1: "A" },
      memoryCards: { q1: cardFor() },
      memoryNewDate: "2026-09-03",
      memoryNewCountToday: 2,
      memoryPendingNew: ["q2"],
      memoryInitialized: true,
    },
  };
}
