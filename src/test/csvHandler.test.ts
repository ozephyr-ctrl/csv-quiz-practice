import { describe, it, expect } from "vitest";
import {
  parseCSV,
  checkIdQuality,
  filterQuestions,
  buildDisplayOrder,
} from "../csvHandler";
import { Question } from "../types";

const header =
  "序号,题干,选项A,选项B,选项C,选项D,正确答案,标签,一级分类,二级分类,三级分类,收藏,掌握,重复,错题";

function row(id: string, overrides: Partial<Record<keyof Question, string>> = {}): string {
  const cells: string[] = [
    id,
    `${id} 题干`,
    "甲", "乙", "丙", "丁",
    "B",
    "#tag1 #tag2",
    "cat1", "cat2", "",
    "0", "", "0", "",
  ];
  const q: Record<string, string> = {
    id: cells[0], stem: cells[1], optionA: cells[2], optionB: cells[3],
    optionC: cells[4], optionD: cells[5], answer: cells[6], tags: cells[7],
    category1: cells[8], category2: cells[9], category3: cells[10],
    favorite: cells[11], mastered: cells[12], repeat: cells[13], wrong: cells[14],
  };
  for (const [k, v] of Object.entries(overrides)) q[k] = v;
  return Object.values(q).map((v) => v ?? "").join(",");
}

describe("parseCSV", () => {
  it("跳过表头、剥离 BOM、按 15 列映射并大写答案", () => {
    const content = "\uFEFF" + header + "\n" + row("1") + "\n" + row("2");
    const questions = parseCSV(content);
    expect(questions).toHaveLength(2);
    expect(questions[0].id).toBe("1");
    expect(questions[0].answer).toBe("B");
    expect(questions[0].tags).toBe("#tag1 #tag2");
    expect(questions[0].category1).toBe("cat1");
    expect(questions[0].wrong).toBe("");
  });

  it("答案列小写被规范化为大写", () => {
    const questions = parseCSV(header + "\n" + row("1", { answer: "c" }));
    expect(questions[0].answer).toBe("C");
  });

  it("含引号包裹的逗号字段不错位", () => {
    const content =
      header + '\n3,"题干,带逗号",甲,乙,丙,丁,A,#t,,,,,,,,';
    const questions = parseCSV(content);
    expect(questions[0].stem).toBe("题干,带逗号");
  });
});

describe("checkIdQuality", () => {
  it("空题号与重复题号均被检出", () => {
    const questions = parseCSV(
      header + "\n" + row("1") + "\n" + row("1") + "\n" + row("")
    );
    const { emptyIds, duplicateIds } = checkIdQuality(questions);
    expect(emptyIds).toHaveLength(1);
    expect(duplicateIds).toEqual(["1"]);
  });

  it("干净题库通过校验", () => {
    const questions = parseCSV(header + "\n" + row("1") + "\n" + row("2"));
    const { emptyIds, duplicateIds } = checkIdQuality(questions);
    expect(emptyIds).toHaveLength(0);
    expect(duplicateIds).toHaveLength(0);
  });
});

describe("filterQuestions", () => {
  const questions = parseCSV(
    header +
      "\n" + row("1") +
      "\n" + row("2", { tags: "#only2", favorite: "1" }) +
      "\n" + row("3", { category1: "math" }) +
      "\n" + row("4", { wrong: "1" })
  );

  it("多标签交集匹配（词边界，前缀不误命中）", () => {
    const out = filterQuestions(questions, "#tag1 #tag2", "", "", "", "");
    expect(out.map((q) => q.id)).toEqual(["1", "3", "4"]);
    // #tag 不应命中 #tag1（词边界）
    const out2 = filterQuestions(questions, "#tag", "", "", "", "");
    expect(out2).toHaveLength(0);
  });

  it("标签排除筛选：题含任一排除标签即滤除（词边界）", () => {
    // 排除 #only2 → 只剩不含它的题
    expect(filterQuestions(questions, "", "#only2", "", "", "").map((q) => q.id))
      .toEqual(["1", "3", "4"]);
    // 词边界：排除 #tag 不应滤除只含 #tag1 的题
    expect(filterQuestions(questions, "", "#tag", "", "", "").map((q) => q.id))
      .toEqual(["1", "2", "3", "4"]);
  });

  it("标签三态组合：包含 AND 排除（含全部包含标签且不含任一排除标签）", () => {
    // 包含 #tag1 且排除 #only2
    expect(filterQuestions(questions, "#tag1", "#only2", "", "", "").map((q) => q.id))
      .toEqual(["1", "3", "4"]);
    // 包含与排除矛盾（同标签）→ 空
    expect(filterQuestions(questions, "#tag1", "#tag1", "", "", "")).toHaveLength(0);
    // 多排除标签任一命中即滤除
    expect(filterQuestions(questions, "", "#only2 #nope", "", "", "").map((q) => q.id))
      .toEqual(["1", "3", "4"]);
  });

  it("分类筛选", () => {
    const out = filterQuestions(questions, "", "", "math", "", "");
    expect(out.map((q) => q.id)).toEqual(["3"]);
  });

  it("标记三态筛选（不限/是/否）", () => {
    expect(filterQuestions(questions, "", "", "", "", "", "1").map((q) => q.id)).toEqual(["2"]);
    expect(filterQuestions(questions, "", "", "", "", "", "0").map((q) => q.id)).toEqual(["1", "3", "4"]);
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "1").map((q) => q.id)).toEqual(["4"]);
  });

  it("未答筛选：空串答案视为已答（=== undefined 语义）", () => {
    const answered = { "1": "", "2": "B" }; // "1" 为空选判错，仍是已答
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "", "", "1", answered).map((q) => q.id))
      .toEqual(["3", "4"]);
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "", "", "0", answered).map((q) => q.id))
      .toEqual(["1", "2"]);
  });

  it("忽略未答筛选时已答题仍在候选中（记忆到期/面板统计口径）", () => {
    const answered = { "1": "", "2": "B" };
    // 与 applyFiltersTo(..., true) 等价：filterUnanswered 传空串，其余筛选不变
    expect(
      filterQuestions(
        questions,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        answered
      ).map((q) => q.id)
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("自由文本筛选匹配题干与选项（不区分大小写）", () => {
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "", "3 题干").map((q) => q.id))
      .toEqual(["3"]);
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "", "甲").map((q) => q.id))
      .toEqual(["1", "2", "3", "4"]);
  });
});

describe("parseCSV 简答题（16 列兼容）", () => {
  const header16 = header + ",简答题方向";

  /** CSV 单元格编码（含逗号/引号/换行时加引号）。 */
  function cell(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }

  function buildRow(cells: string[]): string {
    return cells.map(cell).join(",");
  }

  /** 15 列简答题行（无方向列）。 */
  function shortCells(overrides: Record<number, string> = {}): string[] {
    const cells = [
      "s1",
      "什么是 X？",
      "",
      "",
      "",
      "",
      "答案原文",
      "#简答题 #概念",
      "cat1",
      "cat2",
      "",
      "0",
      "",
      "0",
      "",
    ];
    for (const [index, value] of Object.entries(overrides)) {
      cells[Number(index)] = value;
    }
    return cells;
  }

  it("15 列简答题：答案原文完全保留（大小写/空白/换行/高亮/HTML）", () => {
    const rawAnswer =
      "AbC ==高亮== <table><tr><td>单元格</td></tr></table>\n第二行 ";
    const content = header + "\n" + buildRow(shortCells({ 6: rawAnswer }));
    const [q] = parseCSV(content);
    expect(q.answer).toBe(rawAnswer);
    expect(q.answer).not.toBe(rawAnswer.toUpperCase());
    expect(q.kind).toBe("short");
    expect(q.rawColumnCount).toBe(15);
    expect(q.rawDirection).toBe("");
    // 15 列无方向时默认正向
    expect(q.direction).toBe(">");
  });

  it("16 列简答题：解析方向 <> 与 <", () => {
    const content =
      header16 +
      "\n" + buildRow([...shortCells({ 0: "s1" }), "<>"]) +
      "\n" + buildRow([...shortCells({ 0: "s2", 6: "另一答案" }), "<"]) +
      "\n" + buildRow([...shortCells({ 0: "s3" }), "  "]);
    const questions = parseCSV(content);
    expect(questions.map((q) => q.direction)).toEqual(["<>", "<", ">"]);
    expect(questions.map((q) => q.rawDirection)).toEqual(["<>", "<", "  "]);
    expect(questions.map((q) => q.rawColumnCount)).toEqual([16, 16, 16]);
  });

  it("标签不是精确 #简答题 时保持选择题语义（答案大写）", () => {
    const cells = shortCells({ 6: "b", 7: "#简答题啊 #概念", 2: "甲" });
    const [q] = parseCSV(header + "\n" + buildRow(cells));
    expect(q.kind).toBe("choice");
    expect(q.answer).toBe("B");
    expect(q.direction).toBeUndefined();
  });

  it("选择题答案仍大写并 trim；15 列旧格式不回归", () => {
    const [q] = parseCSV(header + "\n" + row("1", { answer: "  c  " }));
    expect(q.answer).toBe("C");
    expect(q.kind).toBe("choice");
    expect(q.rawColumnCount).toBe(15);
    expect(q.rawDirection).toBe("");
    expect(q.direction).toBeUndefined();
  });
});

describe("parseCSV 定位信息", () => {
  const header16 = header + ",简答题方向";

  function buildRow(cells: string[]): string {
    return cells
      .map((v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
      .join(",");
  }

  it("sourcePath 与 rowNumber（表头计为第 1 行）", () => {
    const content =
      header16 +
      "\n" + buildRow(["1", "题干一", "甲", "乙", "丙", "丁", "A", "#t", "", "", "", "", "", "", "", ""]) +
      "\n" + buildRow(["2", "题干二", "", "", "", "", "答案", "#简答题", "", "", "", "", "", "", "", "<>"]);
    const questions = parseCSV(content, { sourcePath: "题库/示例.csv" });
    expect(questions.map((q) => q.rowNumber)).toEqual([2, 3]);
    expect(questions.map((q) => q.sourcePath)).toEqual([
      "题库/示例.csv",
      "题库/示例.csv",
    ]);
    expect(questions[1].kind).toBe("short");
  });

  it("缺省 opts 时 sourcePath 为 undefined，rowNumber 仍计算", () => {
    const questions = parseCSV(header + "\n" + row("1") + "\n" + row("2"));
    expect(questions[0].sourcePath).toBeUndefined();
    expect(questions.map((q) => q.rowNumber)).toEqual([2, 3]);
  });

  it("数据之间有空行时 rowNumber 仍指向真实文件行", () => {
    const content = header + "\n\n" + row("1") + "\n\n\n" + row("2");
    const questions = parseCSV(content);
    expect(questions.map((q) => q.id)).toEqual(["1", "2"]);
    // 表头第 1 行；row("1") 第 3 行；row("2") 第 6 行
    expect(questions.map((q) => q.rowNumber)).toEqual([3, 6]);
  });

  it("全空白行与纯逗号行被过滤，但仍占行号", () => {
    const content = header + "\n" + row("1") + "\n   \n,,,,\n" + row("2");
    const questions = parseCSV(content);
    expect(questions.map((q) => q.id)).toEqual(["1", "2"]);
    expect(questions.map((q) => q.rowNumber)).toEqual([2, 5]);
  });

  it("表头前有空行时，表头为首个非空记录且行号含空行偏移", () => {
    const content = "\n" + header + "\n" + row("1");
    const questions = parseCSV(content);
    expect(questions).toHaveLength(1);
    expect(questions[0].id).toBe("1");
    expect(questions[0].rowNumber).toBe(3);
  });
});

describe("buildDisplayOrder", () => {

  const questions = parseCSV(header + "\n" + row("1") + "\n" + row("2") + "\n" + row("3"));

  it("合法保存顺序被复用", () => {
    expect(buildDisplayOrder(questions, false, ["3", "1", "2"])).toEqual(["3", "1", "2"]);
  });

  it("长度不一致或含未知 id 时重建", () => {
    expect(buildDisplayOrder(questions, false, ["1", "2"])).toEqual(["1", "2", "3"]);
    expect(buildDisplayOrder(questions, false, ["1", "2", "ghost"])).toEqual(["1", "2", "3"]);
  });

  it("随机模式返回同一 id 集合的排列", () => {
    const order = buildDisplayOrder(questions, true);
    expect(order.sort()).toEqual(["1", "2", "3"]);
  });
});
