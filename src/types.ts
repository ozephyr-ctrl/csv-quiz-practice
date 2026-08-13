export interface Question {
  id: string;
  stem: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  answer: string;
  tags: string;
  category1: string;
  category2: string;
  category3: string;
  favorite: string;
  mastered: string;
  repeat: string;
  wrong: string;
}

/**
 * 单题的间隔重复记忆卡片（FSRS 状态快照，对应 ts-fsrs Card 的子集）。
 * 持久化到题库 sidecar 文件的 state.memoryCards。
 */
export interface MemoryCard {
  state: number; // 0=新题 1=学习中 2=复习 3=再学习
  stability: number; // 稳定性（天）
  difficulty: number; // 难度 1-10
  due: string; // 下次到期 ISO 时间
  reps: number; // 复习总次数
  lapses: number; // 遗忘次数
  learningSteps: number; // 学习/再学习步进位置
  lastReview: string; // 上次复习 ISO 时间（空串 "" 表示从未复习）
}

export interface QuizSessionState {
  csvPath: string;
  currentIndex: number;
  correctCount: number;
  wrongCount: number;
  displayOrder: string[];
  filterText: string;
  filterTags: string;
  filterCat1: string;
  filterCat2: string;
  filterCat3: string;
  filterFavorite: string;
  filterMastered: string;
  filterRepeat: string;
  filterWrong: string;
  /** 未答题筛选：""=不限、"1"=仅未答、"0"=仅已答 */
  filterUnanswered: string;
  answeredQuestions: Record<string, string>;
  /** 记忆练习的记忆卡片（题 id → 卡片）。旧进度无此字段。 */
  memoryCards?: Record<string, MemoryCard>;
  /** 每日新题配额：最近一次启用记忆练习的自然日（本地日期 "YYYY-MM-DD"）。旧进度无此字段。 */
  memoryNewDate?: string;
  /** 每日新题配额：当日已取的新题数量。旧进度无此字段。 */
  memoryNewCountToday?: number;
  /** 当日已选取但尚未作答的新题 id（退出再进仍保留，不重复扣配额）。旧进度无此字段。 */
  memoryPendingNew?: string[];
  /** 记忆练习是否已初始化过（至少判分一次）；仅删除记忆卡片时保留，避免重复触发首次启用重置提示。旧进度无此字段。 */
  memoryInitialized?: boolean;
}

export interface PluginSettings {
  csvPath: string;
  randomOrder: boolean;
  randomOptions: boolean;
  autoNextDelay: number;
  filterPanelOpen: boolean;
  editPanelOpen: boolean;
  defaultFilterFavorite: string;
  defaultFilterMastered: string;
  defaultFilterRepeat: string;
  defaultFilterWrong: string;
  memoryEnabled: boolean;
  /** 记忆练习每日新题数量上限 */
  memoryDailyNew: number;
  /** 状态栏显示今日待复习题数提醒 */
  memoryReminder: boolean;
  /** 掌握标记参与 FSRS 评分（掌握答对=Easy）；收藏不参与评分，避免 Hard 导致难度虚高与间隔压缩 */
  memoryMarkRating: boolean;
  /** 移动端左右滑动切题（左滑下一题/右滑上一题） */
  swipeNavigation: boolean;
}

export interface PluginData {
  settings: PluginSettings;
  quizState: QuizSessionState | null;
}

export const VIEW_TYPE_QUIZ = "csv-quiz-practice-view";

export const DEFAULT_SETTINGS: PluginSettings = {
  csvPath: "题库.csv",
  randomOrder: false,
  randomOptions: false,
  autoNextDelay: 1,
  filterPanelOpen: true,
  editPanelOpen: true,
  defaultFilterFavorite: "",
  defaultFilterMastered: "",
  defaultFilterRepeat: "",
  defaultFilterWrong: "",
  memoryEnabled: true,
  memoryDailyNew: 20,
  memoryReminder: true,
  memoryMarkRating: true,
  swipeNavigation: true,
};
