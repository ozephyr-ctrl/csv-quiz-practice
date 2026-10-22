import { describe, expect, it, vi } from "vitest";

// progressModal 依赖 Obsidian 的 Modal/App；本测试只覆盖纯函数，
// 用最小桩替换模块，避免引入 DOM。
vi.mock("obsidian", () => ({
  App: class {},
  Modal: class {
    titleEl = { setText: () => {} };
  },
}));

import { Question } from "../types";
import {
  computeProgressStats,
  formatProgressSummary,
  progressStemPreview,
  shortAnswerBadge,
  shortAnswerStatus,
} from "../progressModal";

function q(overrides: Partial<Question>): Question {
  return {
    id: "q1",
    stem: "题干",
    optionA: "A",
    optionB: "B",
    optionC: "C",
    optionD: "D",
    answer: "A",
    tags: "",
    category1: "",
    category2: "",
    category3: "",
    favorite: "",
    mastered: "",
    repeat: "",
    wrong: "",
    ...overrides,
  };
}

const shortQ = (side: "fwd" | "rev" = "fwd"): Question =>
  q({
    id: side === "rev" ? "s1::rev" : "s1",
    kind: "short",
    side,
    baseId: "s1",
    stem: side === "rev" ? "答案原文" : "问题题干",
    answer: side === "rev" ? "问题题干" : "答案原文",
    optionA: "",
    optionB: "",
    optionC: "",
    optionD: "",
  });

const imageQ = (): Question =>
  q({ id: "img:a.png", stem: "a", answer: "a", imagePath: "a.png", imageNumber: 1 });

describe("computeProgressStats", () => {
  it("简答题计入 answered，但不计入 textAnswered；图片题同样不入分母", () => {
    const questions = [q({ id: "c1" }), shortQ(), shortQ("rev"), imageQ()];
    const { stats } = computeProgressStats(
      questions,
      { c1: "A", s1: "good", "s1::rev": "revealed", "img:a.png": "easy" },
      false
    );
    expect(stats.answered).toBe(4);
    expect(stats.textAnswered).toBe(1);
    expect(stats.correct).toBe(1);
    expect(stats.shortTotal).toBe(2);
    // revealed 算已答未评
    expect(stats.shortRated).toBe(1);
    expect(stats.imageTotal).toBe(1);
    expect(stats.imageRated).toBe(1);
  });

  it("简答题只有 rating key 才算已评；未答不计", () => {
    const questions = [shortQ(), shortQ("rev")];
    const { stats } = computeProgressStats(questions, { s1: "revealed" }, false);
    expect(stats.answered).toBe(1);
    expect(stats.textAnswered).toBe(0);
    expect(stats.shortTotal).toBe(2);
    expect(stats.shortRated).toBe(0);
    expect(stats.correct).toBe(0);
  });

  it("maskCorrectness 不计算对错，但计数不变", () => {
    const questions = [q({ id: "c1" }), shortQ()];
    const { stats, normCache } = computeProgressStats(
      questions,
      { c1: "A", s1: "again" },
      true
    );
    expect(stats.answered).toBe(2);
    expect(stats.textAnswered).toBe(1);
    expect(stats.correct).toBe(0);
    expect(stats.shortRated).toBe(1);
    expect(normCache.size).toBe(0);
  });
});

describe("formatProgressSummary", () => {
  it("存在简答题时追加简答题已评，且与图片题并存", () => {
    const questions = [q({ id: "c1" }), shortQ(), imageQ()];
    const { stats } = computeProgressStats(
      questions,
      { c1: "A", s1: "good", "img:a.png": "hard" },
      false
    );
    const text = formatProgressSummary(questions.length, stats, false);
    expect(text).toContain("简答题已评 1/1");
    expect(text).toContain("图片题已评 1/1");
    expect(text.indexOf("图片题已评")).toBeLessThan(text.indexOf("简答题已评"));
    expect(text).toContain("正确率 100.0%");
  });

  it("无简答题时不出现简答题段；无图片题时不出现图片题段", () => {
    const questions = [q({ id: "c1" })];
    const { stats } = computeProgressStats(questions, {}, false);
    const text = formatProgressSummary(questions.length, stats, false);
    expect(text).not.toContain("简答题");
    expect(text).not.toContain("图片题");
    expect(text).toBe("共 1 题 · 已答 0 · 未答 1 · 答对 0 · 答错 0");
  });

  it("maskCorrectness 汇总不出现对错，但保留题型进展", () => {
    const questions = [shortQ(), imageQ()];
    const { stats } = computeProgressStats(
      questions,
      { s1: "easy", "img:a.png": "revealed" },
      true
    );
    const text = formatProgressSummary(questions.length, stats, true);
    expect(text).toBe(
      "共 2 题 · 已答 2 · 未答 0 · 图片题已评 0/1 · 简答题已评 1/1"
    );
  });
});

describe("progressStemPreview", () => {
  it("去 Markdown 符号并截断 30 字", () => {
    expect(progressStemPreview("**粗体** `代码`")).toBe("粗体 代码");
    const long = "啊".repeat(40);
    expect(progressStemPreview(long)).toBe("啊".repeat(30) + "…");
    expect(progressStemPreview(long)).toHaveLength(31);
  });

  it("反向卡 stem（原答案文本）可正常预览", () => {
    expect(progressStemPreview(shortQ("rev").stem)).toBe("答案原文");
  });
});

describe("shortAnswerBadge / shortAnswerStatus", () => {
  it("反向卡徽标标注方向", () => {
    expect(shortAnswerBadge(shortQ())).toBe("简答题");
    expect(shortAnswerBadge(shortQ("rev"))).toBe("简答题（反向）");
  });

  it("状态：未答 / 已答(masked) / 已评 · 标签 / 已看答案，且不含对错样式", () => {
    expect(shortAnswerStatus(undefined, false)).toEqual({
      text: "未答",
      cls: "csv-quiz-progress-status csv-quiz-progress-unanswered",
    });
    expect(shortAnswerStatus("good", true).text).toBe("已答");
    expect(shortAnswerStatus("good", true).cls).toContain("csv-quiz-progress-masked");
    expect(shortAnswerStatus("good", false).text).toBe("已评 · 良好");
    expect(shortAnswerStatus("revealed", false).text).toBe("已看答案");
    for (const value of ["good", "revealed", undefined]) {
      const cls = shortAnswerStatus(value, false).cls;
      expect(cls).not.toContain("csv-quiz-progress-correct");
      expect(cls).not.toContain("csv-quiz-progress-wrong");
    }
  });
});
