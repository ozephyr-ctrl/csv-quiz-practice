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

export interface QuizSessionState {
  csvPath: string;
  currentIndex: number;
  correctCount: number;
  wrongCount: number;
  displayOrder: string[];
  filterTags: string;
  filterCat1: string;
  filterCat2: string;
  filterCat3: string;
  filterFavorite: string;
  filterMastered: string;
  filterRepeat: string;
  filterWrong: string;
  answeredQuestions: Record<string, string>;
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
};
