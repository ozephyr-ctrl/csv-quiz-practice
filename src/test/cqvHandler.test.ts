import { describe, it, expect } from "vitest";
import { encodeCqv, decodeCqv } from "../cqvHandler";
import { Question } from "../types";
import { validSidecar } from "./fixtures";

const questions: Question[] = [
  {
    id: "1",
    stem: "1+1=?（含中文与,逗号）",
    optionA: "1",
    optionB: "2",
    optionC: "3",
    optionD: "4",
    answer: "B",
    tags: "#数学 #加法",
    category1: "数学",
    category2: "",
    category3: "",
    favorite: "1",
    mastered: "",
    repeat: "0",
    wrong: "",
  },
  {
    id: "2",
    stem: "multi\nline",
    optionA: "x",
    optionB: "y",
    optionC: "z",
    optionD: "w",
    answer: "AC",
    tags: "",
    category1: "",
    category2: "sub",
    category3: "",
    favorite: "",
    mastered: "1",
    repeat: "",
    wrong: "1",
  },
];

describe("encodeCqv / decodeCqv", () => {
  it("round-trip 保真：题目字段与头部元信息", () => {
    const buffer = encodeCqv(questions, {
      sourceCsv: "题库.csv",
      note: "v2 修订,含逗号",
      generatedAt: 1767225600,
    });
    const result = decodeCqv(buffer);
    expect(result.header.formatVersion).toBe(1);
    expect(result.header.questionCount).toBe(2);
    expect(result.header.generatedAt).toBe(1767225600);
    expect(result.header.sourceCsv).toBe("题库.csv");
    expect(result.header.note).toBe("v2 修订,含逗号");
    // C 类字段（favorite/mastered/wrong）不入产物，round-trip 后为空串
    const expected = questions.map((q) => ({
      ...q,
      favorite: "",
      mastered: "",
      wrong: "",
    }));
    expect(result.questions).toEqual(expected);
  });

  it("C 类字段（favorite/mastered/wrong）不入产物，解码后为空串", () => {
    const buffer = encodeCqv(questions, { sourceCsv: "a.csv", note: "" });
    const result = decodeCqv(buffer);
    // 原 CSV 中 favorite=1/mastered=1/wrong=1，产物中应被清空
    expect(result.questions.every((q) => q.favorite === "" && q.mastered === "" && q.wrong === "")).toBe(true);
    // repeat 属 B 类，随产物分发
    expect(result.questions[0].repeat).toBe("0");
  });

  it("空题库 round-trip", () => {
    const result = decodeCqv(encodeCqv([], { sourceCsv: "", note: "" }));
    expect(result.questions).toEqual([]);
    expect(result.header.questionCount).toBe(0);
  });
});

describe("decodeCqv 防御", () => {
  const valid = encodeCqv(questions, { sourceCsv: "a.csv", note: "n" });

  it("过短文件被拒绝", () => {
    expect(() => decodeCqv(new ArrayBuffer(8))).toThrow();
  });

  it("魔数不匹配被拒绝", () => {
    const corrupted = new Uint8Array(valid.slice(0));
    corrupted[0] = "X".charCodeAt(0);
    expect(() => decodeCqv(corrupted.buffer)).toThrow("魔数");
  });

  it("不支持的版本被拒绝", () => {
    const corrupted = new Uint8Array(valid.slice(0));
    const view = new DataView(corrupted.buffer);
    view.setUint32(8, 99, true);
    expect(() => decodeCqv(corrupted.buffer)).toThrow("版本");
  });

  it("截断的题目数据被拒绝（questionCount 超出实际数据）", () => {
    const full = new Uint8Array(valid);
    const truncated = full.slice(0, full.length - 10);
    expect(() => decodeCqv(truncated.buffer)).toThrow();
  });
});

// 防 sidecar/cqv 样例漂移：validSidecar 必须通过 normalizeSidecar 且保持 v1
describe("fixtures 与生产代码契约", () => {
  it("validSidecar 通过归一化且内容保真", async () => {
    const { normalizeSidecar } = await import("../sidecar");
    const normalized = normalizeSidecar(validSidecar());
    expect(normalized).toEqual(validSidecar());
  });
});
