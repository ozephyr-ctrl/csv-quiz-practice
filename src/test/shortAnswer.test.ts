import { describe, it, expect } from "vitest";
import {
  SHORT_ANSWER_TAG,
  REVERSE_SUFFIX,
  hasExactTagToken,
  parseShortDirection,
  isShortAnswer,
  isSelfAssessed,
  metaKeyFor,
  ensureShortAnswerTag,
  stripShortAnswerTag,
  validateQuestionRows,
  expandShortAnswerRows,
} from "../shortAnswer";
import type { Question } from "../types";

function q(overrides: Partial<Question> = {}): Question {
  return {
    id: "1",
    stem: "题干",
    optionA: "",
    optionB: "",
    optionC: "",
    optionD: "",
    answer: "答案原文",
    tags: "#简答题",
    category1: "c1",
    category2: "c2",
    category3: "",
    favorite: "0",
    mastered: "",
    repeat: "0",
    wrong: "",
    kind: "short",
    rawDirection: "",
    ...overrides,
  };
}

describe("hasExactTagToken", () => {
  it("命中行首/行尾/中间及带多余空白", () => {
    expect(hasExactTagToken("#简答题", "#简答题")).toBe(true);
    expect(hasExactTagToken("  #简答题  ", "#简答题")).toBe(true);
    expect(hasExactTagToken("#a #简答题", "#简答题")).toBe(true);
    expect(hasExactTagToken("#a  #简答题   #b", "#简答题")).toBe(true);
    expect(hasExactTagToken("#简答题\t#题库", "#简答题")).toBe(true);
  });

  it("子串不命中（#简答题啊 / #简答 / #简答题-x）", () => {
    expect(hasExactTagToken("#简答题啊", "#简答题")).toBe(false);
    expect(hasExactTagToken("#简答", "#简答题")).toBe(false);
    expect(hasExactTagToken("#a#简答题", "#简答题")).toBe(false);
    expect(hasExactTagToken("#简答题-x", "#简答题")).toBe(false);
  });

  it("空串与默认参数", () => {
    expect(hasExactTagToken("")).toBe(false);
    expect(hasExactTagToken("   ")).toBe(false);
    expect(hasExactTagToken("#简答题")).toBe(true);
  });
});

describe("parseShortDirection", () => {
  it("空值与合法方向", () => {
    expect(parseShortDirection("")).toBe(">");
    expect(parseShortDirection("   ")).toBe(">");
    expect(parseShortDirection(">")).toBe(">");
    expect(parseShortDirection("<")).toBe("<");
    expect(parseShortDirection("<>")).toBe("<>");
    expect(parseShortDirection(" <> ")).toBe("<>");
    expect(parseShortDirection("\t<\n")).toBe("<");
  });

  it("非法方向返回 null", () => {
    expect(parseShortDirection(">>")).toBeNull();
    expect(parseShortDirection("><")).toBeNull();
    expect(parseShortDirection("＜＞")).toBeNull(); // 全角
    expect(parseShortDirection("→")).toBeNull();
    expect(parseShortDirection("< >")).toBeNull();
    expect(parseShortDirection("x")).toBeNull();
  });
});

describe("isShortAnswer / isSelfAssessed", () => {
  it("kind=short 且非图片题才算简答题", () => {
    expect(isShortAnswer(q())).toBe(true);
    expect(isShortAnswer(q({ kind: "choice" }))).toBe(false);
    expect(isShortAnswer(q({ kind: undefined }))).toBe(false);
    expect(isShortAnswer(q({ imagePath: "a.png" }))).toBe(false);
  });

  it("图片题与简答题都是自评题型", () => {
    expect(isSelfAssessed(q())).toBe(true);
    expect(isSelfAssessed(q({ kind: undefined }))).toBe(false);
    expect(isSelfAssessed(q({ kind: "choice", imagePath: "x/y.png" }))).toBe(true);
    expect(isSelfAssessed(q({ kind: "choice" }))).toBe(false);
  });
});

describe("metaKeyFor", () => {
  it("选择题/图片题用 id，简答题用 baseId", () => {
    expect(metaKeyFor(q({ kind: "choice", id: "c1" }))).toBe("c1");
    expect(
      metaKeyFor(q({ kind: "choice", id: "img:a.png", imagePath: "a.png" }))
    ).toBe("img:a.png");
    expect(metaKeyFor(q({ id: "s1", baseId: "s1", side: "rev" }))).toBe("s1");
    expect(metaKeyFor(q({ id: "s1::rev", baseId: "s1", side: "rev" }))).toBe("s1");
    // 简答题缺 baseId 时退回 id
    expect(metaKeyFor(q({ id: "s2", baseId: undefined }))).toBe("s2");
  });
});

describe("ensureShortAnswerTag / stripShortAnswerTag", () => {
  it("补标签并保留其它标签与顺序", () => {
    expect(ensureShortAnswerTag("#概念 #数学")).toBe("#概念 #数学 #简答题");
    expect(ensureShortAnswerTag("")).toBe("#简答题");
    expect(ensureShortAnswerTag("   ")).toBe("#简答题");
  });

  it("已有标签不重复添加、重复 token 去重", () => {
    expect(ensureShortAnswerTag("#简答题 #概念 #简答题")).toBe("#简答题 #概念");
    expect(ensureShortAnswerTag("#a  #a   #b")).toBe("#a #b #简答题");
    expect(ensureShortAnswerTag("#简答题啊")).toBe("#简答题啊 #简答题");
  });

  it("剥离标签保留其它 token", () => {
    expect(stripShortAnswerTag("#简答题 #概念")).toBe("#概念");
    expect(stripShortAnswerTag("#概念  #简答题   #数学")).toBe("#概念 #数学");
    expect(stripShortAnswerTag("#简答题")).toBe("");
    expect(stripShortAnswerTag("#简答题啊")).toBe("#简答题啊");
    expect(stripShortAnswerTag("#a #a #简答题")).toBe("#a");
  });
});

describe("validateQuestionRows", () => {
  it("合法 15 列简答题通过（空方向默认 >）", () => {
    const rows = [q({ rawColumnCount: 15, rawDirection: "" })];
    expect(validateQuestionRows(rows)).toEqual([]);
  });

  it("合法 16 列简答题通过（含 <>）", () => {
    const rows = [q({ rawColumnCount: 16, rawDirection: "<>" })];
    expect(validateQuestionRows(rows)).toEqual([]);
  });

  it("简答题选项非空 → 报错（逐项聚合）", () => {
    const rows = [q({ optionA: "甲", optionC: "丙" })];
    const errors = validateQuestionRows(rows);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("A/C");
    expect(errors[0].id).toBe("1");
  });

  it("简答题答案为空 → 报错（trim 后为空也算）", () => {
    expect(validateQuestionRows([q({ answer: "   " })])).toHaveLength(1);
    expect(validateQuestionRows([q({ answer: "" })])[0].message).toContain("不能为空");
  });

  it("简答题方向非法 → 报错", () => {
    const errors = validateQuestionRows([q({ rawColumnCount: 16, rawDirection: ">>" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("方向非法");
  });

  it("无 rawDirection 时回落到 direction 字段", () => {
    expect(
      validateQuestionRows([q({ rawDirection: undefined, direction: "<" })])
    ).toEqual([]);
    expect(
      validateQuestionRows([q({ rawDirection: undefined, direction: undefined })])
    ).toEqual([]);
  });

  it("选择题第 16 列非空 → 报错；留空通过", () => {
    const withDir = q({
      kind: "choice",
      rawColumnCount: 16,
      rawDirection: "<",
      answer: "B",
    });
    const errors = validateQuestionRows([withDir]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("第 16 列");

    const emptyDir = q({ kind: "choice", rawColumnCount: 16, rawDirection: "  " });
    expect(validateQuestionRows([emptyDir])).toEqual([]);
    // 15 列旧数据（无 rawDirection）不报错
    expect(validateQuestionRows([q({ kind: "choice", rawColumnCount: 15 })])).toEqual([]);
  });

  it("id 含 :: → 报错", () => {
    const errors = validateQuestionRows([q({ id: "s1::rev" })]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("::");
  });

  it("列数超过 16 → 报错并带定位信息", () => {
    const errors = validateQuestionRows([
      q({ id: "s1", sourcePath: "bank/a.csv", rowNumber: 7, rawColumnCount: 17 }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: "bank/a.csv",
      rowNumber: 7,
      id: "s1",
    });
    expect(errors[0].message).toContain("17");
  });

  it("多条错误分别返回，不合并为一条", () => {
    const errors = validateQuestionRows([
      q({ id: "a::b", optionA: "甲", answer: "" }),
      q({ id: "s2", rawColumnCount: 17 }),
    ]);
    // 第一行：id + 选项 + 答案 = 3 条；第二行：列数 = 1 条
    expect(errors).toHaveLength(4);
    expect(errors.filter((e) => e.id === "a::b")).toHaveLength(3);
    expect(errors.filter((e) => e.id === "s2")).toHaveLength(1);
  });
});

describe("validateQuestionRows 原始行 id 质量（展开前）", () => {
  it("< 简答行与普通题同 id → 题号重复", () => {
    const errors = validateQuestionRows([
      q({ id: "x", rawDirection: "<", rowNumber: 2 }),
      q({ id: "x", kind: "choice", answer: "B", rawDirection: "", rowNumber: 3, sourcePath: "bank/a.csv" }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      file: "bank/a.csv",
      rowNumber: 3,
      id: "x",
    });
    expect(errors[0].message).toContain("题号重复");
    expect(errors[0].message).toContain("x");
  });

  it("< 简答行 id 为空 → 题号为空（不会因展开出 ::rev 而漏检）", () => {
    const errors = validateQuestionRows([q({ id: "", rawDirection: "<", rowNumber: 4 })]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("题号为空");
    expect(errors[0].id).toBe("");
    expect(errors[0].rowNumber).toBe(4);
    // 佐证：展开后卡片 id 为 "::rev"（非空），只在展开后校验必然漏检
    expect(expandShortAnswerRows([q({ id: "", rawDirection: "<" })])[0].id).toBe(
      REVERSE_SUFFIX
    );
  });

  it("两条普通选择题同 id → 题号重复", () => {
    const errors = validateQuestionRows([
      q({ id: "c1", kind: "choice", answer: "A" }),
      q({ id: "c1", kind: "choice", answer: "B" }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe("c1");
    expect(errors[0].message).toContain("题号重复");
  });

  it("id 两侧空白按 trim 后比较（视为同 id）", () => {
    const errors = validateQuestionRows([q({ id: "x" }), q({ id: "  x  " })]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("题号重复");
  });

  it("合法 <> 简答 + 无关普通题 → 无错误", () => {
    expect(
      validateQuestionRows([
        q({ id: "s1", rawDirection: "<>", rawColumnCount: 16 }),
        q({ id: "c1", kind: "choice", answer: "A", rawColumnCount: 15 }),
      ])
    ).toEqual([]);
  });
});

describe("expandShortAnswerRows", () => {
  it("> 只生成一张正向卡", () => {
    const out = expandShortAnswerRows([q({ id: "s1", rawDirection: ">" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "s1",
      kind: "short",
      baseId: "s1",
      side: "fwd",
      direction: ">",
      stem: "题干",
      answer: "答案原文",
    });
  });

  it("< 只生成反向卡（id 带 ::rev，stem/answer 互换）", () => {
    const out = expandShortAnswerRows([q({ id: "s1", rawDirection: "<" })]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("s1" + REVERSE_SUFFIX);
    expect(out[0].side).toBe("rev");
    expect(out[0].baseId).toBe("s1");
    expect(out[0].direction).toBe("<");
    expect(out[0].stem).toBe("答案原文");
    expect(out[0].answer).toBe("题干");
  });

  it("<> 生成正向紧跟反向两张卡", () => {
    const out = expandShortAnswerRows([q({ id: "s1", rawDirection: "<>" })]);
    expect(out.map((x) => x.id)).toEqual(["s1", "s1::rev"]);
    expect(out.map((x) => x.side)).toEqual(["fwd", "rev"]);
    expect(out.map((x) => x.direction)).toEqual(["<>", "<>"]);
    expect(out.map((x) => x.baseId)).toEqual(["s1", "s1"]);
    expect(out[0].stem).toBe("题干");
    expect(out[0].answer).toBe("答案原文");
    expect(out[1].stem).toBe("答案原文");
    expect(out[1].answer).toBe("题干");
  });

  it("副本保留 tags/category/flags/sourcePath/rowNumber", () => {
    const row = q({
      id: "s1",
      rawDirection: "<>",
      tags: "#简答题 #概念",
      category1: "c1",
      category2: "c2",
      category3: "c3",
      favorite: "1",
      mastered: "1",
      repeat: "0",
      wrong: "1",
      sourcePath: "bank/a.csv",
      rowNumber: 5,
    });
    const out = expandShortAnswerRows([row]);
    for (const card of out) {
      expect(card.tags).toBe("#简答题 #概念");
      expect(card.category1).toBe("c1");
      expect(card.category2).toBe("c2");
      expect(card.category3).toBe("c3");
      expect(card.favorite).toBe("1");
      expect(card.mastered).toBe("1");
      expect(card.wrong).toBe("1");
      expect(card.sourcePath).toBe("bank/a.csv");
      expect(card.rowNumber).toBe(5);
    }
  });

  it("空方向默认 >（仅正向）", () => {
    const out = expandShortAnswerRows([q({ id: "s1", rawDirection: "" })]);
    expect(out.map((x) => x.id)).toEqual(["s1"]);
  });

  it("不修改入参数组与对象", () => {
    const rows = [q({ id: "s1", rawDirection: "<>" })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const out = expandShortAnswerRows(rows);
    expect(JSON.parse(JSON.stringify(rows))).toEqual(snapshot);
    expect(rows).toHaveLength(1);
    expect(out[0]).not.toBe(rows[0]);
    expect(out[1]).not.toBe(rows[0]);
  });

  it("非简答行原样保留且 kind 缺省填 choice", () => {
    const choice = q({ id: "c1", kind: undefined, answer: "B", optionA: "甲" });
    const out = expandShortAnswerRows([choice]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("choice");
    expect(out[0].id).toBe("c1");
    expect(out[0].answer).toBe("B");
    expect(out[0].optionA).toBe("甲");
    expect(out[0]).not.toBe(choice);
  });

  it("混合行顺序稳定", () => {
    const out = expandShortAnswerRows([
      q({ id: "c1", kind: "choice", rawDirection: "" }),
      q({ id: "s1", rawDirection: "<>" }),
      q({ id: "c2", kind: "choice", rawDirection: "" }),
    ]);
    expect(out.map((x) => x.id)).toEqual(["c1", "s1", "s1::rev", "c2"]);
  });
});
