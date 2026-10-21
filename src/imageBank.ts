import type { Question } from "./types";

/** 支持的图片扩展名（小写，不含点）。 */
export const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
]);

export type ImageRatingKey = "again" | "hard" | "good" | "easy";

export const IMAGE_RATING_LABELS: Record<ImageRatingKey, string> = {
  again: "重来",
  hard: "困难",
  good: "良好",
  easy: "简单",
};

/** 图片题的根分类（category1）与根目录图片的兜底分类。 */
const IMAGE_CATEGORY = "识图";
const FALLBACK_CATEGORY = "其它";

/** 图片题的固定标签。 */
export const IMAGE_TAG = "#图片题";

/** 是否为图片题（imagePath 为非空字符串）。 */
export function isImageQuestion(q: Question): boolean {
  return typeof q.imagePath === "string" && q.imagePath.trim() !== "";
}

export function isImageRatingKey(value: string): value is ImageRatingKey {
  return (
    value === "again" ||
    value === "hard" ||
    value === "good" ||
    value === "easy"
  );
}

/** rating key 返回中文标签，其它输入返回 null。 */
export function imageRatingLabel(value: string): string | null {
  return isImageRatingKey(value) ? IMAGE_RATING_LABELS[value] : null;
}

/** 取 basename（兼容 / 与 \），去掉最后一个扩展名，保留其余点/空格/中文。 */
export function imageAnswerFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // dot === 0 表示隐藏文件（如 ".png"），不去扩展名，避免得到空字符串。
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 规范化文件夹：trim、反斜杠转 /、去首尾 /、合并连续 /。 */
function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 相对路径中任一段以 . 开头即视为隐藏路径。 */
function hasHiddenSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith("."));
}

function pathCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

interface ImageEntry {
  relativePath: string;
  basename: string;
}

/**
 * 依据文件夹内的全部文件路径构建图片题。
 * 纯函数，不依赖 Obsidian，便于单元测试。
 */
export function buildImageQuestions(
  folder: string,
  filePaths: string[],
): Question[] {
  const root = normalizeFolder(folder);
  if (root === "") return [];

  const prefix = `${root}/`;
  const seen = new Set<string>();
  const entries: ImageEntry[] = [];

  for (const rawPath of filePaths) {
    if (typeof rawPath !== "string" || rawPath === "") continue;
    const path = rawPath.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (!path.startsWith(prefix)) continue;

    const relativePath = path.slice(prefix.length);
    if (relativePath === "") continue;
    if (hasHiddenSegment(relativePath)) continue;
    if (relativePath.endsWith("/")) continue;
    if (!IMAGE_EXTENSIONS.has(extensionOf(relativePath))) continue;
    if (seen.has(relativePath)) continue;

    seen.add(relativePath);
    entries.push({ relativePath, basename: basename(relativePath) });
  }

  entries.sort((a, b) => {
    const byBasename = pathCompare(a.basename, b.basename);
    return byBasename !== 0 ? byBasename : pathCompare(a.relativePath, b.relativePath);
  });

  return entries.map((entry, index) => {
    const answer = imageAnswerFromPath(entry.basename);
    const segments = entry.relativePath.split("/");
    return {
      id: `img:${entry.relativePath}`,
      stem: answer,
      optionA: "",
      optionB: "",
      optionC: "",
      optionD: "",
      answer,
      tags: IMAGE_TAG,
      category1: IMAGE_CATEGORY,
      category2: segments.length >= 2 ? segments[0] : FALLBACK_CATEGORY,
      category3: segments.length >= 3 ? segments[1] : FALLBACK_CATEGORY,
      favorite: "",
      mastered: "",
      repeat: "",
      wrong: "",
      imagePath: `${root}/${entry.relativePath}`,
      imageNumber: index + 1,
    };
  });
}
