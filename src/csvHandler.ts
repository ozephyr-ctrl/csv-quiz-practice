import Papa from "papaparse";
import { Question } from "./types";

import { App, Editor, MarkdownView, Notice, Vault } from "obsidian";

export function parseCSV(content: string): Question[] {
  const result = Papa.parse(content, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];

  // 修复1: 解析错误可见化——未闭合引号等会导致列错位，提示用户数据可能错位
  if (result.errors.length > 0) {
    console.warn("CSV 解析警告: 检测到解析错误", result.errors.slice(0, 3));
    new Notice(
      `CSV 解析警告: ${result.errors.length} 处问题（如未闭合引号），数据可能错位`
    );
  }

  // Remove BOM from first cell if present
  if (rows.length > 0 && rows[0].length > 0) {
    rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  }

  // Skip header row
  const dataRows = rows.slice(1);

  // 修复2: 为空题号自动生成唯一 id（__auto_<n>），避免空 id 导致答题记录互相覆盖。
  // n 从 1 开始递增，若生成值与现有非空 id 冲突则继续递增。
  const usedIds = new Set<string>();
  for (const row of dataRows) {
    const id = String(row[0] || "").trim();
    if (id) usedIds.add(id);
  }
  let autoSeq = 1;
  for (const row of dataRows) {
    const id = String(row[0] || "").trim();
    if (!id) {
      let candidate = `__auto_${autoSeq}`;
      autoSeq++;
      while (usedIds.has(candidate)) {
        candidate = `__auto_${autoSeq}`;
        autoSeq++;
      }
      usedIds.add(candidate);
      row[0] = candidate;
    }
  }

  return dataRows.map((row: string[]) => ({
    id: String(row[0] || "").trim(),
    stem: row[1] || "",
    optionA: row[2] || "",
    optionB: row[3] || "",
    optionC: row[4] || "",
    optionD: row[5] || "",
    answer: (row[6] || "").toUpperCase().trim(),
    tags: row[7] || "",
    category1: row[8] || "",
    category2: row[9] || "",
    category3: row[10] || "",
    favorite: row[11] || "",
    mastered: row[12] || "",
    repeat: row[13] || "",
    wrong: row[14] || "",
  }));
}

export function generateCSVRow(question: Question): string[] {
  return [
    question.id,
    question.stem,
    question.optionA,
    question.optionB,
    question.optionC,
    question.optionD,
    question.answer,
    question.tags,
    question.category1,
    question.category2,
    question.category3,
    question.favorite,
    question.mastered,
    question.repeat,
    question.wrong,
  ];
}

export function findAndUpdateRow(
  csvContent: string,
  questionId: string,
  newData: string[]
): string | null {
  const result = Papa.parse(csvContent, { header: false, skipEmptyLines: true });
  const rows = result.data as string[][];

  // 修复1: 解析错误可见化，避免错位数据被写回文件
  if (result.errors.length > 0) {
    console.warn("CSV 解析警告: 检测到解析错误", result.errors.slice(0, 3));
  }

  if (rows.length < 2) return null;

  const header = rows[0];
  const dataRows = rows.slice(1);

  // Remove BOM from header if present
  if (header.length > 0) {
    header[0] = header[0].replace(/^\uFEFF/, "");
  }

  // 修复2: 空题号拒绝写入；匹配到多行（题号重复）也拒绝写入，避免改错行
  if (questionId.trim() === "") {
    throw new Error("CSV 中题号重复或为空，已拒绝写入，请检查题库");
  }

  const matchedIndices: number[] = [];
  dataRows.forEach((row: string[], i: number) => {
    if (String(row[0] || "").trim() === questionId) matchedIndices.push(i);
  });

  // 0 行匹配保持原有语义：返回 null，由调用方提示"未找到对应题号"
  if (matchedIndices.length === 0) return null;
  if (matchedIndices.length > 1) {
    throw new Error("CSV 中题号重复或为空，已拒绝写入，请检查题库");
  }

  const idx = matchedIndices[0];

  // H3: 保留超过 15 列的多余列，避免编辑保存后数据丢失
  const targetRow = dataRows[idx];
  dataRows[idx] =
    newData.length >= targetRow.length
      ? newData
      : [...newData, ...targetRow.slice(newData.length)];

  return Papa.unparse([header, ...dataRows], { delimiter: "," });
}

export function getUniqueTags(questions: Question[]): string[] {
  const set = new Set<string>();
  for (const q of questions) {
    for (const tag of q.tags.split(/\s+/)) {
      const t = tag.trim();
      if (t.startsWith("#")) set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function getUniqueCategories(questions: Question[]): {
  cat1: string[];
  cat2: string[];
  cat3: string[];
} {
  const cat1Set = new Set<string>();
  const cat2Set = new Set<string>();
  const cat3Set = new Set<string>();

  for (const q of questions) {
    if (q.category1) cat1Set.add(q.category1);
    if (q.category2) cat2Set.add(q.category2);
    if (q.category3) cat3Set.add(q.category3);
  }

  const sortFn = (a: string, b: string) => a.localeCompare(b);

  return {
    cat1: [...cat1Set].sort(sortFn),
    cat2: [...cat2Set].sort(sortFn),
    cat3: [...cat3Set].sort(sortFn),
  };
}

export async function readCSVFile(
  vault: Vault,
  path: string
): Promise<string> {
  return await vault.adapter.read(path);
}

async function writeCSVFile(
  vault: Vault,
  path: string,
  content: string
): Promise<void> {
  await vault.adapter.write(path, "\uFEFF" + content);
}

export function filterQuestions(
  questions: Question[],
  filterTags: string,
  filterCat1: string,
  filterCat2: string,
  filterCat3: string,
  filterFavorite: string = "",
  filterMastered: string = "",
  filterRepeat: string = "",
  filterWrong: string = "",
  filterText: string = "",
  filterUnanswered: string = "",
  answeredQuestions: Record<string, string> = {}
): Question[] {
  return questions.filter((q) => {
    // 自由文本筛选：不区分大小写，匹配题干或任一选项（子串包含）
    const text = filterText.trim().toLowerCase();
    if (text) {
      const haystack =
        (q.stem + " " + q.optionA + " " + q.optionB + " " + q.optionC + " " + q.optionD).toLowerCase();
      if (!haystack.includes(text)) return false;
    }

    // 未答筛选：仅按 answeredQuestions 中是否"存在该题 id"判断（必须用 === undefined，
    // answeredQuestions[id] 可能为 "" 空字符串，用 falsy 判断会把空串误判为未答）
    if (filterUnanswered !== "") {
      const answered = (filterUnanswered === "1")
        ? (q: Question) => answeredQuestions[q.id] === undefined
        : (q: Question) => answeredQuestions[q.id] !== undefined;
      if (!answered(q)) return false;
    }

    if (filterTags && filterTags.trim() !== "") {
      const tagFilters = filterTags
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      for (const tag of tagFilters) {
        const tagStr = tag.startsWith("#") ? tag : "#" + tag;
        const escaped = tagStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`);
        if (!re.test(q.tags)) return false;
      }
    }

    if (filterCat1 && q.category1 !== filterCat1) return false;
    if (filterCat2 && q.category2 !== filterCat2) return false;
    if (filterCat3 && q.category3 !== filterCat3) return false;

    if (filterFavorite !== "" && (q.favorite === "1") !== (filterFavorite === "1")) return false;
    if (filterMastered !== "" && (q.mastered === "1") !== (filterMastered === "1")) return false;
    if (filterRepeat !== "" && (q.repeat === "1") !== (filterRepeat === "1")) return false;
    if (filterWrong !== "" && (q.wrong === "1") !== (filterWrong === "1")) return false;

    return true;
  });
}

export function buildDisplayOrder(
  questions: Question[],
  randomOrder: boolean,
  savedOrder?: string[]
): string[] {
  if (savedOrder && savedOrder.length === questions.length) {
    const savedSet = new Set(savedOrder);
    const allIds = new Set(questions.map((q) => q.id));
    if ([...savedSet].every((id) => allIds.has(id))) {
      return savedOrder;
    }
  }

  const ids = questions.map((q) => q.id);
  if (randomOrder) {
    return shuffleArray(ids);
  }
  return ids;
}

function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export type CSVTransform = (content: string) => string | Promise<string>;

export class CSVWriteQueue {
  private queue: Array<{
    csvPath: string;
    transforms: CSVTransform[];
    resolves: Array<(value: void) => void>;
    rejects: Array<(reason: unknown) => void>;
  }> = [];
  private processing = false;
  private app: App;
  private vault: Vault;

  constructor(app: App) {
    this.app = app;
    this.vault = app.vault;
  }

  enqueue(csvPath: string, transform: CSVTransform): Promise<void> {
    // 修复4: 若队列中已有同 csvPath 的项（尚未开始处理），合并写入：
    // 追加 transform，并把本次 promise 的 resolve/reject 登记到该项。
    const existing = this.queue.find((item) => item.csvPath === csvPath);
    if (existing) {
      existing.transforms.push(transform);
      return new Promise<void>((resolve, reject) => {
        existing.resolves.push(resolve);
        existing.rejects.push(reject);
      });
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        csvPath,
        transforms: [transform],
        resolves: [resolve],
        rejects: [reject],
      });
      void this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift()!;
    try {
      // H1: 若文件正打开在编辑器中，以编辑器内容为基准读写，避免插件写盘后
      // 编辑器 Ctrl+S 用陈旧 buffer 覆盖插件的修改。
      const editors = this.getOpenEditors(item.csvPath);

      const currentContent =
        editors.length > 0
          ? editors[0].getValue()
          : await readCSVFile(this.vault, item.csvPath);

      // 修复4: 读一次 → 依次应用所有待写变换（后者的输入为前者的输出）→ 写一次
      let newContent = currentContent;
      for (const transform of item.transforms) {
        newContent = await Promise.resolve(transform(newContent));
      }

      await writeCSVFile(this.vault, item.csvPath, newContent);

      // 修复3: 同步所有打开该文件的分栏编辑器，任一存在则提示一次
      if (editors.length > 0) {
        for (const editor of editors) {
          editor.setValue(newContent);
        }
        new Notice("题库文件正在编辑器中打开，已同步更新编辑器内容");
      }

      for (const resolve of item.resolves) resolve();
    } catch (e: unknown) {
      // 任一 transform 抛错时该项整体失败：reject 该单项所有 promise，后续 transforms 不再执行
      for (const reject of item.rejects) reject(e);
    } finally {
      this.processing = false;
      void this.processNext();
    }
  }

  /** 若 csvPath 对应的文件正打开在 Markdown 编辑器中，返回其全部编辑器实例，否则返回空数组。 */
  private getOpenEditors(csvPath: string): Editor[] {
    const file = this.app.vault.getFileByPath(csvPath);
    if (!file) return [];
    const editors: Editor[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
        editors.push(leaf.view.editor);
      }
    });
    return editors;
  }

  get pending(): number {
    return this.queue.length;
  }

  async drain(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 10));
    }
  }
}
