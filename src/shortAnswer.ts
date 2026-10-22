import type { Question } from "./types";
import { isImageQuestion } from "./imageBank";

/**
 * 简答题数据层的纯函数集合（不依赖 Obsidian，便于单元测试）。
 *
 * 约定：
 * - 标签含**精确** token `#简答题` 的行是简答题；
 * - 15 列旧 CSV 完全兼容；第 16 列（可选）为「简答题方向」；
 * - 简答题答案写在「正确选项」列（第 7 列，index 6），必须保留原文；
 * - `>` / `<` / `<>` 分别展开成 1 / 1 / 2 张卡，反向卡 id 追加 `::rev`；
 * - 正反向卡共享元数据（标签/分类/标记/进度）时以 base id 为键。
 */

export const SHORT_ANSWER_TAG = "#简答题";
export const REVERSE_SUFFIX = "::rev";

export type ShortDirection = ">" | "<" | "<>";

/** 行级校验错误（file/rowNumber/id 用于定位；message 面向用户）。 */
export interface BankRowError {
  file?: string;
  rowNumber?: number;
  id?: string;
  message: string;
}

/** 按空白切分后精确匹配标签 token；子串不算命中。 */
export function hasExactTagToken(tags: string, tag: string = SHORT_ANSWER_TAG): boolean {
  if (typeof tags !== "string" || tags.trim() === "") return false;
  return tags.split(/\s+/).some((token) => token === tag);
}

/**
 * 解析第 16 列方向文本：trim 后 "" => ">"（默认仅正向）；
 * `>`、`<`、`<>` 原样返回；其它（含 `>>`、全角符号）返回 null。
 */
export function parseShortDirection(raw: string): ShortDirection | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "" || value === ">") return ">";
  if (value === "<") return "<";
  if (value === "<>") return "<>";
  return null;
}

/** 是否为简答题（kind 标记为 short 且不是图片题）。 */
export function isShortAnswer(q: Question): boolean {
  return q.kind === "short" && !isImageQuestion(q);
}

/** 是否自评题型（图片题或简答题）：无客观选项可判分。 */
export function isSelfAssessed(q: Question): boolean {
  return isImageQuestion(q) || isShortAnswer(q);
}

/** 共享元数据的键：简答题用 baseId（正反向卡一致），其它题型用 id。 */
export function metaKeyFor(q: Question): string {
  if (q.kind === "short" && typeof q.baseId === "string" && q.baseId !== "") {
    return q.baseId;
  }
  return q.id;
}

function tokenizeTags(tags: string): string[] {
  if (typeof tags !== "string") return [];
  return tags.split(/\s+/).filter((token) => token !== "");
}

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** 补上精确的 #简答题 token（已存在则不重复），保留其它标签及顺序。 */
export function ensureShortAnswerTag(tags: string): string {
  const tokens = dedupeTokens(tokenizeTags(tags));
  if (!tokens.includes(SHORT_ANSWER_TAG)) tokens.push(SHORT_ANSWER_TAG);
  return tokens.join(" ");
}

/** 去掉精确的 #简答题 token，保留其它标签（顺带去重与多余空白）。 */
export function stripShortAnswerTag(tags: string): string {
  return dedupeTokens(tokenizeTags(tags))
    .filter((token) => token !== SHORT_ANSWER_TAG)
    .join(" ");
}

function rowLabel(q: Question): string {
  const parts: string[] = [];
  if (q.sourcePath) parts.push(q.sourcePath);
  if (typeof q.rowNumber === "number") parts.push(`第 ${q.rowNumber} 行`);
  return parts.join(" ");
}

function pushError(errors: BankRowError[], q: Question, message: string): void {
  const label = rowLabel(q);
  errors.push({
    file: q.sourcePath,
    rowNumber: q.rowNumber,
    id: q.id,
    message: label === "" ? message : `${label}: ${message}`,
  });
}

/** 简答题行声明的方向：优先原始文本，其次已解析值，缺省为 ""（即 ">"）。 */
function rawDirectionOf(q: Question): string {
  if (typeof q.rawDirection === "string") return q.rawDirection;
  return q.direction ?? "";
}

/**
 * 严格校验解析结果，按行聚合返回全部错误（一条错误一个对象，不做合并）。
 * 逐行检查：原始行 id 是否为空/重复、列数是否超过 16、id 是否含 `::`、
 * 简答题选项/答案/方向、选择题第 16 列是否为空。
 *
 * 注意：这里校验的是**展开前**的原始行 id。展开后卡片 id 会追加 `::rev`，
 * 若只在展开后校验，`<` 行 id=`x` 与普通题 id=`x`（或 `<` 行 id 为空）都会漏检，
 * 而两者 metaKey 相同会把共享元数据串在一起。
 */
export function validateQuestionRows(rows: Question[]): BankRowError[] {
  const errors: BankRowError[] = [];
  const seenIds = new Map<string, number>();

  for (const q of rows) {
    const rawId = typeof q.id === "string" ? q.id.trim() : "";
    if (rawId === "") {
      pushError(errors, q, `题号为空（「序号」列不能为空）`);
    } else if (seenIds.has(rawId)) {
      seenIds.set(rawId, (seenIds.get(rawId) ?? 0) + 1);
      pushError(errors, q, `题号重复：${rawId}（题库内题号必须唯一）`);
    } else {
      seenIds.set(rawId, 1);
    }

    if (typeof q.rawColumnCount === "number" && q.rawColumnCount > 16) {
      pushError(
        errors,
        q,
        `列数超过 16（实际 ${q.rawColumnCount} 列），请检查第 16 列之后是否有多余内容`
      );
    }

    if (q.id.includes("::")) {
      pushError(errors, q, `题号不能包含 "::"（该后缀保留给简答题反向卡）`);
    }

    if (q.kind === "short") {
      const nonEmptyOptions = (
        [
          ["A", q.optionA],
          ["B", q.optionB],
          ["C", q.optionC],
          ["D", q.optionD],
        ] as Array<[string, string]>
      ).filter(([, value]) => (value ?? "").trim() !== "");
      if (nonEmptyOptions.length > 0) {
        const names = nonEmptyOptions.map(([name]) => name).join("/");
        pushError(
          errors,
          q,
          `简答题的选项 ${names} 必须为空（简答题答案写在「正确选项」列）`
        );
      }

      if ((q.answer ?? "").trim() === "") {
        pushError(errors, q, `简答题的答案（「正确选项」列）不能为空`);
      }

      const rawDirection = rawDirectionOf(q);
      if (parseShortDirection(rawDirection) === null) {
        pushError(
          errors,
          q,
          `简答题方向非法：${JSON.stringify(rawDirection)}（只支持 >、<、<> 或留空）`
        );
      }
    } else if (typeof q.rawDirection === "string" && q.rawDirection.trim() !== "") {
      pushError(
        errors,
        q,
        `选择题第 16 列（简答题方向）必须为空，当前为 ${JSON.stringify(q.rawDirection)}`
      );
    }
  }

  return errors;
}

function shortAnswerCard(
  q: Question,
  base: string,
  baseId: string,
  direction: ShortDirection,
  side: "fwd" | "rev"
): Question {
  const common = {
    ...q,
    kind: "short" as const,
    baseId,
    side,
    direction,
  };
  if (side === "fwd") {
    return { ...common, id: base };
  }
  return {
    ...common,
    id: base + REVERSE_SUFFIX,
    stem: q.answer,
    answer: q.stem,
  };
}

/**
 * 按方向展开简答题：`>` 1 张（正向）、`<` 1 张（反向）、`<>` 2 张（正向紧跟反向）。
 * 非简答行原样保留（kind 缺省填 "choice"）。不修改入参对象/数组。
 */
export function expandShortAnswerRows(rows: Question[]): Question[] {
  const out: Question[] = [];

  for (const q of rows) {
    if (!isShortAnswer(q)) {
      out.push({ ...q, kind: q.kind ?? "choice" });
      continue;
    }

    const base = q.id;
    const baseId = typeof q.baseId === "string" && q.baseId !== "" ? q.baseId : base;
    const direction = parseShortDirection(rawDirectionOf(q)) ?? ">";

    if (direction === ">" || direction === "<>") {
      out.push(shortAnswerCard(q, base, baseId, direction, "fwd"));
    }
    if (direction === "<" || direction === "<>") {
      out.push(shortAnswerCard(q, base, baseId, direction, "rev"));
    }
  }

  return out;
}
