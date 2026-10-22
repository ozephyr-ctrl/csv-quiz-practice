import { describe, it, expect } from "vitest";
import { encodeCqv, decodeCqv } from "../cqvHandler";
import { Question } from "../types";
import { validSidecar } from "./fixtures";

const v1Questions: Question[] = [
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

/** 混合原始行：选择题 + 简答题（含大小写/换行/==高亮==）。 */
const v2Rows: Question[] = [
  {
    id: "c1",
    stem: "选择题干",
    optionA: "1",
    optionB: "2",
    optionC: "3",
    optionD: "4",
    answer: "B",
    tags: "#x",
    category1: "",
    category2: "",
    category3: "",
    favorite: "",
    mastered: "",
    repeat: "0",
    wrong: "",
    kind: "choice",
  },
  {
    id: "s1",
    stem: "TCP 三次握手？",
    optionA: "",
    optionB: "",
    optionC: "",
    optionD: "",
    answer: "First SYN\nSecond SYN-ACK  (Case Sensitive) ==highlight==",
    tags: "#网络 #简答题",
    category1: "网络",
    category2: "",
    category3: "",
    favorite: "",
    mastered: "",
    repeat: "",
    wrong: "",
    kind: "short",
    direction: "<>",
  },
];

function versionOf(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint32(8, true);
}

function headerLenOf(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint32(4, true);
}

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

describe("encodeCqv / decodeCqv（v1 回归）", () => {
  it("默认 formatVersion=1，字节头 version=1，round-trip 保真", () => {
    const buffer = encodeCqv(v1Questions, {
      sourceCsv: "题库.csv",
      note: "v2 修订,含逗号",
      generatedAt: 1767225600,
    });
    expect(versionOf(buffer)).toBe(1);

    const result = decodeCqv(buffer);
    expect(result.header.formatVersion).toBe(1);
    expect(result.header.questionCount).toBe(2);
    expect(result.header.generatedAt).toBe(1767225600);
    expect(result.header.sourceCsv).toBe("题库.csv");
    expect(result.header.sourceFiles).toEqual(["题库.csv"]);
    expect(result.header.note).toBe("v2 修订,含逗号");

    // C 类字段不入产物；v1 行统一补 kind=choice / direction=>
    const expected = v1Questions.map((q) => ({
      ...q,
      favorite: "",
      mastered: "",
      wrong: "",
      kind: "choice",
      direction: ">",
    }));
    expect(result.questions).toEqual(expected);
  });

  it("v1 字节布局：headerLen 精确 + 12 字段总长", () => {
    const sourceCsv = "a.csv";
    const note = "n";
    const buffer = encodeCqv(v1Questions, {
      sourceCsv,
      note,
      generatedAt: 1,
    });
    const expectedHeaderLen = 20 + 4 + byteLen(sourceCsv) + 4 + byteLen(note);
    expect(headerLenOf(buffer)).toBe(expectedHeaderLen);

    // 12 字段（不含 kind/direction）：总长度 = headerLen + Σ(4 + 字段字节数)
    const fieldNames = [
      "id",
      "stem",
      "optionA",
      "optionB",
      "optionC",
      "optionD",
      "answer",
      "tags",
      "category1",
      "category2",
      "category3",
      "repeat",
    ] as const;
    let dataBytes = 0;
    for (const q of v1Questions) {
      for (const f of fieldNames) dataBytes += 4 + byteLen(q[f]);
    }
    expect(buffer.byteLength).toBe(expectedHeaderLen + dataBytes);
  });

  it("C 类字段（favorite/mastered/wrong）不入产物，解码后为空串", () => {
    const buffer = encodeCqv(v1Questions, { sourceCsv: "a.csv", note: "" });
    const result = decodeCqv(buffer);
    expect(
      result.questions.every(
        (q) => q.favorite === "" && q.mastered === "" && q.wrong === ""
      )
    ).toBe(true);
    expect(result.questions[0].repeat).toBe("0");
  });

  it("空题库 round-trip", () => {
    const result = decodeCqv(encodeCqv([], { sourceCsv: "", note: "" }));
    expect(result.questions).toEqual([]);
    expect(result.header.questionCount).toBe(0);
  });

  it("v1 即使 tags 含 #简答题 也绝不按 short 判定", () => {
    const rows: Question[] = [
      { ...v1Questions[0], tags: "#简答题 #网络" },
    ];
    const result = decodeCqv(encodeCqv(rows, { sourceCsv: "a.csv", note: "" }));
    expect(result.questions[0].kind).toBe("choice");
    expect(result.questions[0].direction).toBe(">");
  });
});

describe("encodeCqv / decodeCqv（v2）", () => {
  it("混合 choice + short 行：kind/direction/answer 原文无损，sourceFiles 有序，不展开", () => {
    const buffer = encodeCqv(v2Rows, {
      sourceCsv: "main.csv",
      sourceFiles: ["a.csv", "b.csv"],
      note: "v2 说明",
      generatedAt: 1767225600,
      formatVersion: 2,
    });
    expect(versionOf(buffer)).toBe(2);

    const result = decodeCqv(buffer);
    expect(result.header.formatVersion).toBe(2);
    expect(result.header.sourceFiles).toEqual(["a.csv", "b.csv"]);
    expect(result.header.sourceCsv).toBe("a.csv");
    // questionCount 为原始行数（不是展开后的卡片数）
    expect(result.header.questionCount).toBe(2);
    expect(result.questions.length).toBe(2);

    expect(result.questions[0].kind).toBe("choice");
    expect(result.questions[0].direction).toBe(">");
    expect(result.questions[0].answer).toBe("B");

    expect(result.questions[1].kind).toBe("short");
    expect(result.questions[1].direction).toBe("<>");
    expect(result.questions[1].answer).toBe(
      "First SYN\nSecond SYN-ACK  (Case Sensitive) ==highlight=="
    );
    expect(result.questions[1].tags).toBe("#网络 #简答题");

    // C 类字段仍为空
    expect(result.questions.every((q) => q.favorite === "" && q.mastered === "" && q.wrong === "")).toBe(
      true
    );
  });

  it("v2 headerLen 精确覆盖到逐行数据开始前", () => {
    const sourceFiles = ["a.csv", "b.csv"];
    const note = "note";
    const buffer = encodeCqv(v2Rows, {
      sourceCsv: "a.csv",
      sourceFiles,
      note,
      formatVersion: 2,
    });
    let expectedHeaderLen = 20 + 4; // 固定头 + sourceFileCount
    for (const f of sourceFiles) expectedHeaderLen += 4 + byteLen(f);
    expectedHeaderLen += 4 + byteLen(note);
    expect(headerLenOf(buffer)).toBe(expectedHeaderLen);
  });

  it("v2 sourceFiles 缺省为 [sourceCsv]", () => {
    const buffer = encodeCqv(v2Rows, {
      sourceCsv: "only.csv",
      note: "",
      formatVersion: 2,
    });
    expect(decodeCqv(buffer).header.sourceFiles).toEqual(["only.csv"]);
  });

  it("v2 空 sourceFiles 兜底为 [sourceCsv]", () => {
    const buffer = encodeCqv(v2Rows, {
      sourceCsv: "only.csv",
      sourceFiles: [],
      note: "",
      formatVersion: 2,
    });
    expect(decodeCqv(buffer).header.sourceFiles).toEqual(["only.csv"]);
  });

  it("v2 空题库 round-trip", () => {
    const result = decodeCqv(
      encodeCqv([], {
        sourceCsv: "a.csv",
        sourceFiles: ["a.csv", "b.csv"],
        note: "",
        formatVersion: 2,
      })
    );
    expect(result.questions).toEqual([]);
    expect(result.header.questionCount).toBe(0);
    expect(result.header.sourceFiles).toEqual(["a.csv", "b.csv"]);
  });
});

describe("decodeCqv 防御", () => {
  const validV1 = encodeCqv(v1Questions, { sourceCsv: "a.csv", note: "n" });
  const validV2 = encodeCqv(v2Rows, {
    sourceCsv: "a.csv",
    sourceFiles: ["a.csv"],
    note: "n",
    formatVersion: 2,
  });

  it("过短文件被拒绝", () => {
    expect(() => decodeCqv(new ArrayBuffer(8))).toThrow();
  });

  it("坏魔数被拒绝（v1/v2 同魔数）", () => {
    for (const valid of [validV1, validV2]) {
      const corrupted = new Uint8Array(valid.slice(0));
      corrupted[0] = "X".charCodeAt(0);
      expect(() => decodeCqv(corrupted.buffer)).toThrow("魔数");
    }
  });

  it("不支持的版本被拒绝（v2 头改写为 3）", () => {
    const corrupted = new Uint8Array(validV2.slice(0));
    const view = new DataView(corrupted.buffer);
    view.setUint32(8, 3, true);
    expect(() => decodeCqv(corrupted.buffer)).toThrow("版本");
  });

  it("v1 非法版本被拒绝", () => {
    const corrupted = new Uint8Array(validV1.slice(0));
    const view = new DataView(corrupted.buffer);
    view.setUint32(8, 99, true);
    expect(() => decodeCqv(corrupted.buffer)).toThrow("版本");
  });

  it("截断的题目数据被拒绝（questionCount 超出实际数据）", () => {
    for (const valid of [validV1, validV2]) {
      const full = new Uint8Array(valid.slice(0));
      const truncated = full.slice(0, full.length - 10);
      expect(() => decodeCqv(truncated.buffer)).toThrow();
    }
  });

  it("v2 sourceFileCount 超大被拒绝", () => {
    const corrupted = new Uint8Array(validV2.slice(0));
    const view = new DataView(corrupted.buffer);
    view.setUint32(20, 0xfffffff0, true);
    expect(() => decodeCqv(corrupted.buffer)).toThrow("截断");
  });

  it("v2 字段截断被拒绝", () => {
    const full = new Uint8Array(validV2.slice(0));
    const truncated = full.slice(0, full.length - 3);
    expect(() => decodeCqv(truncated.buffer)).toThrow();
  });

  it("v2 非法 kind 抛中文错误", () => {
    // 单独编码一行，定位其 kind 字段内容（"choice"）并原位改写为 "imagex"
    const kindBuffer = encodeCqv([{ ...v2Rows[0], kind: "choice" }], {
      sourceCsv: "a.csv",
      note: "",
      formatVersion: 2,
    });
    const bytes = new Uint8Array(kindBuffer.slice(0));
    const marker = new TextEncoder().encode("choice");
    let idx = -1;
    for (let i = 0; i + marker.length <= bytes.length; i++) {
      let match = true;
      for (let j = 0; j < marker.length; j++) {
        if (bytes[i + j] !== marker[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThan(0);
    bytes.set(new TextEncoder().encode("imagex"), idx);
    expect(() => decodeCqv(bytes.buffer)).toThrow("题型");
  });

  it("v2 非法 direction 抛中文错误", () => {
    const buf = encodeCqv(
      [{ ...v2Rows[1], direction: "<" as const }],
      { sourceCsv: "a.csv", note: "", formatVersion: 2 }
    );
    const bytes = new Uint8Array(buf.slice(0));
    const marker = new TextEncoder().encode("<");
    // 最后一个 "<" 即为 direction 字段内容（答案里不含 "<"）
    let idx = -1;
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] === marker[0]) {
        idx = i;
        break;
      }
    }
    expect(idx).toBeGreaterThan(0);
    // 改写为 "x"（长度不变，避免破坏后续偏移）
    bytes[idx] = "x".charCodeAt(0);
    expect(() => decodeCqv(bytes.buffer)).toThrow("方向");
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
