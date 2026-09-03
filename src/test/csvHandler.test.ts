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
    const out = filterQuestions(questions, "#tag1 #tag2", "", "", "");
    expect(out.map((q) => q.id)).toEqual(["1", "3", "4"]);
    // #tag 不应命中 #tag1（词边界）
    const out2 = filterQuestions(questions, "#tag", "", "", "");
    expect(out2).toHaveLength(0);
  });

  it("分类筛选", () => {
    const out = filterQuestions(questions, "", "math", "", "");
    expect(out.map((q) => q.id)).toEqual(["3"]);
  });

  it("标记三态筛选（不限/是/否）", () => {
    expect(filterQuestions(questions, "", "", "", "", "1").map((q) => q.id)).toEqual(["2"]);
    expect(filterQuestions(questions, "", "", "", "", "0").map((q) => q.id)).toEqual(["1", "3", "4"]);
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "1").map((q) => q.id)).toEqual(["4"]);
  });

  it("未答筛选：空串答案视为已答（=== undefined 语义）", () => {
    const answered = { "1": "", "2": "B" }; // "1" 为空选判错，仍是已答
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "", "1", answered).map((q) => q.id))
      .toEqual(["3", "4"]);
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "", "0", answered).map((q) => q.id))
      .toEqual(["1", "2"]);
  });

  it("自由文本筛选匹配题干与选项（不区分大小写）", () => {
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "3 题干").map((q) => q.id))
      .toEqual(["3"]);
    expect(filterQuestions(questions, "", "", "", "", "", "", "", "", "甲").map((q) => q.id))
      .toEqual(["1", "2", "3", "4"]);
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
