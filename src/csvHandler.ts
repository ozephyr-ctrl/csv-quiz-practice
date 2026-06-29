import Papa from "papaparse";
import { Question, QuizSessionState } from "./types";

import { Vault } from "obsidian";

export function parseCSV(content: string): Question[] {
  const result = Papa.parse(content, { header: false, skipEmptyLines: true }) as Papa.ParseResult<string[]>;
  const rows = result.data;

  // Remove BOM from first cell if present
  if (rows.length > 0 && rows[0].length > 0) {
    rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  }

  // Skip header row
  const dataRows = rows.slice(1);

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
  const result = Papa.parse(csvContent, { header: false, skipEmptyLines: true }) as Papa.ParseResult<string[]>;
  const rows = result.data;
  if (rows.length < 2) return null;

  const header = rows[0];
  const dataRows = rows.slice(1);

  // Remove BOM from header if present
  if (header.length > 0) {
    header[0] = header[0].replace(/^\uFEFF/, "");
  }

  const idx = dataRows.findIndex(
    (row: string[]) => String(row[0] || "").trim() === questionId
  );

  if (idx < 0) return null;

  dataRows[idx] = newData;

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
  filterWrong: string = ""
): Question[] {
  return questions.filter((q) => {
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
    transform: CSVTransform;
    resolve: (value: void) => void;
    reject: (reason: any) => void;
  }> = [];
  private processing = false;
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  enqueue(csvPath: string, transform: CSVTransform): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ csvPath, transform, resolve, reject });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift()!;
    try {
      const currentContent = await readCSVFile(this.vault, item.csvPath);
      const newContent = await Promise.resolve(item.transform(currentContent));
      await writeCSVFile(this.vault, item.csvPath, newContent);
      item.resolve();
    } catch (e) {
      item.reject(e);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  async drain(): Promise<void> {
    while (this.processing || this.queue.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}
