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
  /** 图片题的 vault 内相对路径；存在即图片题（无选项，answer=文件名去扩展名）。 */
  imagePath?: string;
  /** 图片题在全部图片题中的稳定序号（按文件名排序后分配），未评分时用于脱敏显示。 */
  imageNumber?: number;
  /**
   * 题型。缺省（undefined）视为 "choice"，与旧题库兼容。
   * - "choice"：选择题，`answer` 为 A-D 之一。
   * - "short"：简答题，`answer` 为答案原文（不 trim、不改大小写）；选项 A-D 必须为空。
   */
  kind?: "choice" | "short";
  /**
   * 简答题方向：">" 仅正向、"<" 仅反向、"<>" 双向。
   * 仅简答题使用；选择题不设置（第 16 列非空即为校验错误）。
   */
  direction?: ">" | "<" | "<>";
  /** 简答题的共享元数据键（正向/反向卡共用同一 base id，用于统计与进度合并）。 */
  baseId?: string;
  /** 简答题展开后的卡面方向："fwd" 正向（stem → answer）、"rev" 反向（answer → stem）。 */
  side?: "fwd" | "rev";
  /** 题目来源文件路径（vault 相对或绝对，视调用方传入）。 */
  sourcePath?: string;
  /** 题目在来源文件中的行号（1 基，表头计为第 1 行）。 */
  rowNumber?: number;
  /** 解析期临时字段：原始列数、原始方向文本（供严格校验；运行期/编码可忽略）。 */
  rawColumnCount?: number;
  rawDirection?: string;
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
  /** 该卡片最近一次写入时间（epoch ms）。供同步冲突合并时判定卡片新旧；旧文件缺失。 */
  ts?: number;
}

export interface QuizSessionState {
  csvPath: string;
  currentIndex: number;
  correctCount: number;
  wrongCount: number;
  displayOrder: string[];
  filterText: string;
  filterTags: string;
  /** 排除标签筛选（空格分隔；题含任一排除标签即被滤除，与布尔筛选"否"同向）。旧进度无此字段。 */
  filterTagsExcluded: string;
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
  /** 每日答题事件数（本地自然日 "YYYY-MM-DD" → 次数，含常规/随机考试/记忆练习）。供练习面板统计与折线图；旧进度无此字段。 */
  dailyAnswers?: Record<string, number>;
}

export interface PluginSettings {
  csvPath: string;
  /** @deprecated 旧版单一图片文件夹设置；3.6.x 迁移后不再作为主入口。 */
  imageFolder: string;
  /** 题库文件夹（vault 相对路径；"/"=vault 根；""=未设置）。 */
  bankFolder: string;
  /** 无 manifest 且同目录 CSV+图片时，用户为某题库选择「仅用 CSV」的文件夹集合。 */
  bankSingleSources: Record<string, "csv">;
  /** 显式来源类型：csv 文件 / image 文件夹 / manifest 复合题库；""=未设置。 */
  sourceType: "" | "csv" | "image" | "manifest";
  /** 显式来源路径：csv 为文件路径，image/manifest 为文件夹路径。 */
  sourcePath: string;
  randomOrder: boolean;
  randomOptions: boolean;
  autoNextDelay: number;
  filterPanelOpen: boolean;
  editPanelOpen: boolean;
  /** 打开刷题面板时练习栏（入口/统计/折线图）默认是否展开 */
  practicePanelOpen: boolean;
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
  /** 非记忆模式下答题是否更新 FSRS 卡片（常规模式/随机考试；记忆练习始终更新） */
  memoryUpdateInNormalMode: boolean;
  /** 随机考试每次抽取的题目数量（从当前筛选范围内全部题目抽取，不限未答） */
  randomExamCount: number;
  /** 键盘绑定总开关（含方向键切题与下面的选项/标记快捷键） */
  keyboardBindingsEnabled: boolean;
  /** 选项快捷键：第 1 个显示的选项（单字符，空 = 不绑定；大小写不敏感） */
  keyOptionA: string;
  /** 选项快捷键：第 2 个显示的选项 */
  keyOptionB: string;
  /** 选项快捷键：第 3 个显示的选项 */
  keyOptionC: string;
  /** 选项快捷键：第 4 个显示的选项 */
  keyOptionD: string;
  /** 标记快捷键：收藏 */
  keyFavorite: string;
  /** 标记快捷键：掌握 */
  keyMastered: string;
  /** 标记快捷键：重复 */
  keyRepeat: string;
  /** 已执行过「manifest 组成 sidecar 合并」的 manifest 锚点集合（一次性迁移标记）。 */
  manifestMerged: Record<string, boolean>;
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
  practicePanelOpen: true,
  defaultFilterFavorite: "",
  defaultFilterMastered: "",
  defaultFilterRepeat: "",
  defaultFilterWrong: "",
  memoryEnabled: true,
  memoryDailyNew: 20,
  memoryReminder: true,
  memoryMarkRating: true,
  swipeNavigation: true,
  memoryUpdateInNormalMode: true,
  randomExamCount: 100,
  keyboardBindingsEnabled: true,
  keyOptionA: "1",
  keyOptionB: "2",
  keyOptionC: "3",
  keyOptionD: "4",
  keyFavorite: "m",
  keyMastered: "e",
  keyRepeat: "x",
  imageFolder: "",
  bankFolder: "",
  bankSingleSources: {},
  sourceType: "",
  sourcePath: "",
  manifestMerged: {},
};
