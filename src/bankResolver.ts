/**
 * 题库文件夹 → 来源解析（纯逻辑 + 少量 vault IO）。
 *
 * 一个「题库」是 vault 里的一个文件夹，内容源有三种来源：
 * - `manifest.json`（复合题库：CSV/CQV + 图片并用，sidecar 锚点为 `<folder>/manifest`）
 * - 文件夹内唯一的 CSV/CQV 文件（sidecar 锚点为该文件路径）
 * - 文件夹内的图片（sidecar 锚点为该文件夹路径）
 *
 * 本模块只做「解析 + 校验 + 提示原因」，不读写 sidecar、不弹窗、不改设置；
 * 后续由 main / QuizView / settings 消费 `BankResolution` 决定流程。
 */

import type { Vault } from "obsidian";
import { IMAGE_EXTENSIONS } from "./imageBank";

/** 复合题库的清单文件名（放在题库文件夹内）。 */
export const MANIFEST_FILENAME = "manifest.json";
/** 清单的 type 标记（用于把无关的 manifest.json 当作不存在）。 */
export const MANIFEST_TYPE = "csvquiz-bank";
/** 复合题库 sidecar 锚点的文件名部分：`<folder>/manifest` → `manifest.sidecar.json`。 */
export const MANIFEST_SIDECAR_BASENAME = "manifest";

/** vault 根目录的题库文件夹哨兵（与「未设置」的空串区分）。 */
const ROOT_BANK_FOLDER = "/";

/** 显式来源类型：CSV/CQV 文件、图片文件夹、manifest 复合题库。 */
export type SourceType = "csv" | "image" | "manifest";

/** 设置中的显式来源配置。`sourceType` 为空串表示尚未配置。 */
export interface ConfiguredSourceSettings {
  sourceType: SourceType | "";
  sourcePath: string;
}

/**
 * 仅图片且图片文件夹为 vault 根时的 sidecar 锚点。
 * 根目录无法承载「文件夹路径即锚点」的约定（否则会落到 `/.sidecar.json`），
 * 因此用这个固定前缀在根目录下生成独立 sidecar。
 */
export const ROOT_IMAGE_ANCHOR = ".csv-quiz-root-images";

/** 识别的题库内容文件扩展名（小写，不含点）。 */
const CSV_EXTENSIONS = new Set(["csv", "cqv"]);

/** 复合题库清单结构（v1）。 */
export interface BankManifest {
  type: "csvquiz-bank";
  version: 1;
  /** .csv/.cqv，相对 manifest 所在目录（主内容文件，必填）。 */
  content: string;
  /** 额外内容文件（可选，顺序排在 content 之后），.csv/.cqv，相对 manifest 所在目录。 */
  contents?: string[];
  /** 图片文件夹，相对 manifest 所在目录；省略表示无图片。 */
  imageFolder?: string;
}

/** 解析成功后的来源描述。 */
export interface ResolvedBankSource {
  mode: "manifest" | "csv" | "image";
  /** 规范化；"/" 表示 vault 根，"" 表示未设置。 */
  bankFolder: string;
  /** manifest/csv 模式：首个 CSV/CQV 路径（= contentPaths[0]）；image 模式 ""。 */
  contentPath: string;
  /** 全部内容文件（顺序：content 后接 contents）；image 模式为空数组。 */
  contentPaths: string[];
  /** manifest/image 模式：图片文件夹（"" 表示无图片）；csv 模式 ""。 */
  imageFolder: string;
  /** sidecar 锚点：manifest 模式 `<folder>/manifest`；csv=contentPath；image=folder。 */
  anchor: string;
  manifest: BankManifest | null;
}

/** 解析结果：ok / 需要用户选择或配置（prompt）/ 配置错误（error）。 */
export type BankResolution =
  | { status: "ok"; source: ResolvedBankSource }
  | {
      status: "prompt";
      reason:
        | "unconfigured"
        | "empty"
        | "multiple-csv"
        | "both"
        | "type-mismatch";
      message: string;
      csvCandidate?: string;
    }
  | { status: "error"; reason: string; message: string };

/* ===================== 路径纯函数 ===================== */

/**
 * 归一化题库文件夹：
 * - 去首尾空白；空串 → ""（未设置）；
 * - `"/"` / `"."`（以及归一化后无段落的路径）→ `"/"`（vault 根哨兵）；
 * - 反斜杠转 `/`；按段归一（`.` 忽略、`..` 弹出）；
 * - 返回无首尾 `/` 的路径。
 *
 * 与 `contentSource.normalizeVaultFolder` 的区别：保留根哨兵 `"/"`，
 * 因为「vault 根」是合法题库，而「未设置」才是空串。
 */
export function normalizeBankFolder(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const segments = trimmed.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? ROOT_BANK_FOLDER : out.join("/");
}

/** 题库文件夹 → vault 相对文件夹路径（根哨兵 `"/"` → `""`，其它原样）。 */
export function vaultFolderPath(bankFolder: string): string {
  return bankFolder === ROOT_BANK_FOLDER ? "" : bankFolder;
}

/** 拼接 vault 路径：folder 为 `"/"`/`""` 时返回 name，否则 `${folder}/${name}`。 */
export function joinVaultPath(folder: string, name: string): string {
  if (folder === "" || folder === ROOT_BANK_FOLDER) return name;
  return `${folder}/${name}`;
}

/** 取 vault 路径的目录部分；根目录返回 `"/"`。 */
export function dirnameVaultPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const withoutTrailing = normalized.replace(/\/+$/, "");
  if (withoutTrailing === "") return ROOT_BANK_FOLDER;
  const idx = withoutTrailing.lastIndexOf("/");
  if (idx < 0) return ROOT_BANK_FOLDER;
  const dir = withoutTrailing.slice(0, idx);
  const normalizedDir = normalizeBankFolder(dir);
  return normalizedDir === "" ? ROOT_BANK_FOLDER : normalizedDir;
}

/** 题库文件夹 → 清单路径：`<folder>/manifest.json`（根为 `manifest.json`）。 */
export function manifestPathForBank(folder: string): string {
  return joinVaultPath(folder, MANIFEST_FILENAME);
}

/**
 * 题库文件夹 → 清单 sidecar 锚点：`<folder>/manifest`（根为 `manifest`）。
 * 保证 `sidecarPathFor(anchor)` = `manifest.sidecar.json`（根）或 `<folder>/manifest.sidecar.json`。
 */
export function manifestAnchorForBank(folder: string): string {
  return joinVaultPath(folder, MANIFEST_SIDECAR_BASENAME);
}

/* ===================== manifest 解析 ===================== */

export type ParseBankManifestResult =
  | {
      status: "ok";
      manifest: BankManifest;
      /** 主内容文件（= contentPaths[0]）。 */
      contentPath: string;
      /** 完整内容文件顺序：[content, ...contents]。 */
      contentPaths: string[];
      /** 图片文件夹；"" 表示无图片。 */
      imageFolder: string;
    }
  | { status: "ignored" }
  | { status: "error"; message: string };

/** 路径是否以绝对路径形态开头（`/`、`\`、盘符）。 */
function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}

/**
 * 校验并归一化 manifest 内的相对路径：
 * - 禁止绝对路径（`/` 开头、`C:` 等盘符）；
 * - 禁止任何 `..` 段；
 * - content 额外禁止反斜杠（imageFolder 允许，先统一为 `/` 再校验）；
 * - 空串（trim 后）视为非法。
 * 归一化后 `"."`/`"./"` 得到 `""`（由调用方决定是否允许 = 当前目录）。
 */
function normalizeManifestRelative(
  raw: string,
  allowBackslash: boolean
): { ok: true; path: string } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false };
  if (!allowBackslash && trimmed.indexOf("\\") >= 0) return { ok: false };
  const unified = trimmed.replace(/\\/g, "/");
  if (isAbsoluteLike(unified)) return { ok: false };
  const out: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false };
    out.push(segment);
  }
  return { ok: true, path: out.join("/") };
}

/** 取路径扩展名（小写，不含点）；无扩展名返回 ""。 */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * 解析 manifest.json 文本。
 * - JSON 解析失败 / 顶层非对象 → error；
 * - `type !== "csvquiz-bank"` → ignored（视为无关 manifest，按无 manifest 处理）；
 * - `version !== 1` → error；
 * - `content` 必须是非空字符串，且为安全的相对 .csv/.cqv 路径；
 * - `contents` 可选：字符串数组，逐项为安全的相对 .csv/.cqv 路径，归一化后不得与
 *   content 或彼此重复；
 * - `imageFolder` 可选：省略 = 无图片；存在时必须是非空安全的相对文件夹路径，
 *   `"."` 表示 manifest 所在文件夹自身（根目录解析为根哨兵 `"/"`）。
 * 返回解析后的 vault 路径（已按 bankFolder 拼接）。
 */
export function parseBankManifest(
  text: string,
  bankFolder: string
): ParseBankManifestResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return { status: "error", message: `manifest.json 不是合法 JSON：${reason}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "error", message: "manifest.json 顶层必须是对象。" };
  }
  const record = raw as Record<string, unknown>;
  if (record.type !== MANIFEST_TYPE) return { status: "ignored" };
  if (record.version !== 1) {
    return {
      status: "error",
      message: `manifest.json 的 version 必须为 1（当前：${String(
        record.version
      )}）。`,
    };
  }

  // ---- content（主内容文件，必填） ----
  const contentRaw = record.content;
  if (typeof contentRaw !== "string" || contentRaw.trim() === "") {
    return {
      status: "error",
      message: "manifest.json 的 content 必须是非空字符串。",
    };
  }
  const contentRel = normalizeManifestRelative(contentRaw, false);
  if (!contentRel.ok || contentRel.path === "") {
    return {
      status: "error",
      message:
        "manifest.json 的 content 必须是相对 manifest 所在目录的文件路径（禁止绝对路径、.. 与反斜杠）。",
    };
  }
  if (!CSV_EXTENSIONS.has(extensionOf(contentRel.path))) {
    return {
      status: "error",
      message: "manifest.json 的 content 必须是 .csv 或 .cqv 文件。",
    };
  }

  // ---- contents（额外内容文件，可选） ----
  const contentsRaw = record.contents;
  const contentsRels: string[] = [];
  let contentsValues: string[] | undefined;
  if (contentsRaw !== undefined) {
    if (!Array.isArray(contentsRaw)) {
      return {
        status: "error",
        message: "manifest.json 的 contents 必须是字符串数组（可省略）。",
      };
    }
    const seen = new Set<string>([contentRel.path]);
    const values: string[] = [];
    for (let i = 0; i < contentsRaw.length; i += 1) {
      const item: unknown = contentsRaw[i];
      if (typeof item !== "string" || item.trim() === "") {
        return {
          status: "error",
          message: `manifest.json 的 contents[${i}] 必须是非空字符串。`,
        };
      }
      const rel = normalizeManifestRelative(item, false);
      if (!rel.ok || rel.path === "") {
        return {
          status: "error",
          message: `manifest.json 的 contents[${i}] 必须是相对 manifest 所在目录的文件路径（禁止绝对路径、.. 与反斜杠）：${item}`,
        };
      }
      if (!CSV_EXTENSIONS.has(extensionOf(rel.path))) {
        return {
          status: "error",
          message: `manifest.json 的 contents[${i}] 必须是 .csv 或 .cqv 文件：${item}`,
        };
      }
      if (seen.has(rel.path)) {
        return {
          status: "error",
          message: `manifest.json 的内容文件重复（content 与 contents 之间或 contents 内部）：${rel.path}`,
        };
      }
      seen.add(rel.path);
      contentsRels.push(rel.path);
      values.push(item.trim());
    }
    contentsValues = values;
  }

  // ---- imageFolder（可选） ----
  // 省略 = 无图片；存在时允许反斜杠（先统一），但仍禁止绝对路径与 `..`；
  // `"."` 表示题库文件夹自身。
  const imageRaw = record.imageFolder;
  let imageRelPath: string | null = null;
  let imageValue: string | undefined;
  if (imageRaw !== undefined) {
    if (typeof imageRaw !== "string" || imageRaw.trim() === "") {
      return {
        status: "error",
        message:
          "manifest.json 的 imageFolder 若存在必须是非空字符串（省略表示无图片）。",
      };
    }
    const imageRel = normalizeManifestRelative(imageRaw, true);
    if (!imageRel.ok) {
      return {
        status: "error",
        message:
          "manifest.json 的 imageFolder 必须是相对 manifest 所在目录的文件夹路径（禁止绝对路径与 ..）。",
      };
    }
    imageRelPath = imageRel.path;
    imageValue = imageRaw.trim();
  }

  const folder = normalizeBankFolder(bankFolder);
  // `imageFolder: "."` 表示 manifest 所在文件夹自身；根目录解析为根哨兵 `"/"`，
  // 由调用方用 ROOT_IMAGE_ANCHOR 承载根级图片题库的 sidecar。
  const imageFolder =
    imageRelPath === null
      ? ""
      : imageRelPath === ""
        ? folder
        : joinVaultPath(folder, imageRelPath);

  const contentPath = joinVaultPath(folder, contentRel.path);
  const contentPaths = [
    contentPath,
    ...contentsRels.map((rel) => joinVaultPath(folder, rel)),
  ];
  const manifest: BankManifest = {
    type: MANIFEST_TYPE,
    version: 1,
    content: contentRaw.trim(),
  };
  if (contentsValues !== undefined) manifest.contents = contentsValues;
  if (imageValue !== undefined) manifest.imageFolder = imageValue;

  return {
    status: "ok",
    manifest,
    contentPath,
    contentPaths,
    imageFolder,
  };
}

/* ===================== CSV 候选选择 ===================== */

export type ChooseCsvCandidateResult =
  | { status: "none" }
  | { status: "one"; path: string }
  | { status: "multiple"; paths: string[] };

/** 文件夹身份归一键：空串与 `"/"` 都视为 vault 根。 */
function folderKey(raw: string): string {
  const normalized = normalizeBankFolder(raw);
  return normalized === "" ? ROOT_BANK_FOLDER : normalized;
}

function sameFolder(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

/**
 * 从题库文件夹的**直接子文件**中选出唯一 CSV/CQV 候选。
 * - 只认 `.csv`/`.cqv`；同一 stem 的 `.csv`+`.cqv` 视为一个题库，**优先 .csv**；
 * - 多个不同 stem → multiple；
 * - 忽略以 `.` 开头的文件；跨目录的文件（非直接子文件）忽略。
 * `files` 可传完整 vault 路径或纯文件名（纯文件名按直接子文件处理）。
 */
export function chooseCsvCandidate(
  files: string[],
  bankFolder: string
): ChooseCsvCandidateResult {
  const folder = normalizeBankFolder(bankFolder);
  interface Group {
    stem: string;
    csv: string | null;
    cqv: string | null;
  }
  const groups = new Map<string, Group>();

  for (const raw of files) {
    if (raw === "") continue;
    const path = raw.trim().replace(/\\/g, "/");
    if (path === "") continue;
    const slash = path.lastIndexOf("/");
    const base = slash < 0 ? path : path.slice(slash + 1);
    const parent = slash < 0 ? null : path.slice(0, slash);
    if (base === "" || base.startsWith(".")) continue;
    if (parent !== null && !sameFolder(parent, folder)) continue;
    const ext = extensionOf(base);
    if (!CSV_EXTENSIONS.has(ext)) continue;
    const stem = base.slice(0, base.lastIndexOf("."));
    if (stem === "") continue;
    const key = stem.toLowerCase();
    const group = groups.get(key) ?? { stem, csv: null, cqv: null };
    if (ext === "csv") {
      if (group.csv === null) group.csv = path;
    } else if (group.cqv === null) {
      group.cqv = path;
    }
    groups.set(key, group);
  }

  const chosen: string[] = [];
  groups.forEach((group) => {
    // 同 stem 优先 .csv（复合题库的固定约定）
    const path = group.csv !== null ? group.csv : group.cqv;
    if (path !== null) chosen.push(path);
  });
  if (chosen.length === 0) return { status: "none" };
  if (chosen.length === 1) return { status: "one", path: chosen[0] };
  chosen.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
  return { status: "multiple", paths: chosen };
}

/* ===================== 旧设置迁移 ===================== */

export interface LegacyBankSettings {
  bankFolder: string;
  csvPath: string;
  imageFolder: string;
  bankSingleSources: Record<string, "csv">;
}

export interface MigratedBankSettings {
  bankFolder: string;
  bankSingleSources: Record<string, "csv">;
  changed: boolean;
}

/**
 * 旧设置（csvPath/imageFolder）→ 题库文件夹：
 * - bankFolder 已非空 → 原样返回（changed=false）；
 * - csvPath 非空 → bankFolder 取其目录；旧配置同时有 imageFolder 时，把该文件夹
 *   记入 bankSingleSources 降级为「仅 CSV」，避免每次打开都提示 csv+图片；
 * - 否则 imageFolder 非空 → bankFolder = 归一化后的图片文件夹；
 * - 都为空 → 不变。不修改入参（返回新的 bankSingleSources 副本）。
 */
export function migrateLegacySettings(
  settings: LegacyBankSettings
): MigratedBankSettings {
  const bankSingleSources: Record<string, "csv"> = {
    ...(settings.bankSingleSources ?? {}),
  };
  const existingBank = settings.bankFolder ?? "";
  if (existingBank.trim() !== "") {
    return {
      bankFolder: existingBank,
      bankSingleSources,
      changed: false,
    };
  }
  const csvPath = (settings.csvPath ?? "").trim();
  const imageFolder = (settings.imageFolder ?? "").trim();
  if (csvPath !== "") {
    const folder = dirnameVaultPath(csvPath);
    if (imageFolder !== "") bankSingleSources[folder] = "csv";
    return { bankFolder: folder, bankSingleSources, changed: true };
  }
  if (imageFolder !== "") {
    return {
      bankFolder: normalizeBankFolder(imageFolder),
      bankSingleSources,
      changed: true,
    };
  }
  return { bankFolder: "", bankSingleSources, changed: false };
}

/* ===================== IO 层 ===================== */

export interface BankResolverSettings {
  bankFolder: string;
  bankSingleSources?: Record<string, "csv">;
}

/** 只用到 path/parent 的最小文件形状（TFile 兼容，便于测试注入 fake）。 */
interface VaultFileLike {
  path: string;
  parent?: { path: string } | null;
}

/** 列出 vault 全部文件：优先 `vault.getFiles()`，缺失时回退递归 `adapter.list`。 */
async function listVaultFiles(vault: Vault): Promise<VaultFileLike[]> {
  const maybeVault = vault as unknown as {
    getFiles?: () => VaultFileLike[];
  };
  if (typeof maybeVault.getFiles === "function") {
    try {
      const files = maybeVault.getFiles();
      return Array.isArray(files) ? files : [];
    } catch {
      return [];
    }
  }
  const adapter = vault.adapter as unknown as {
    list?: (
      path: string
    ) => Promise<{ files: string[]; folders: string[] }>;
  };
  if (typeof adapter.list !== "function") return [];
  const out: VaultFileLike[] = [];
  const walk = async (dir: string): Promise<void> => {
    let listing: { files?: string[]; folders?: string[] };
    try {
      listing = await adapter.list!(dir);
    } catch {
      return;
    }
    const parent = dir === "" || dir === ROOT_BANK_FOLDER ? ROOT_BANK_FOLDER : dir;
    for (const file of listing.files ?? []) {
      out.push({ path: file, parent: { path: parent } });
    }
    for (const folder of listing.folders ?? []) {
      await walk(folder);
    }
  };
  await walk("");
  return out;
}

/** 文件所属文件夹（parent 缺失时按路径推断；根为 `"/"`）。 */
function parentPathOf(file: VaultFileLike): string {
  if (file.parent && typeof file.parent.path === "string") return file.parent.path;
  return dirnameVaultPath(file.path);
}

/** 题库文件夹的直接子文件路径（根目录兼容 `"/"` 与 `""`）。 */
function directChildPaths(files: VaultFileLike[], folder: string): string[] {
  const result: string[] = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || file.path === "") continue;
    if (!sameFolder(parentPathOf(file), folder)) continue;
    result.push(file.path);
  }
  return result;
}

/** 相对路径中任一段以 `.` 开头即视为隐藏路径（与 imageBank 口径一致）。 */
function hasHiddenSegment(relativePath: string): boolean {
  for (const segment of relativePath.split("/")) {
    if (segment.startsWith(".")) return true;
  }
  return false;
}

/**
 * 找出某 vault 文件夹下（递归）的全部受支持图片路径。
 * `folderVaultPath` 为 `""`（或 `"/"`）表示 vault 根。
 */
function imagePathsUnder(
  files: VaultFileLike[],
  folderVaultPath: string
): string[] {
  const root = folderVaultPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const prefix = root === "" ? "" : `${root}/`;
  const result: string[] = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || file.path === "") continue;
    const path = file.path.replace(/\\/g, "/");
    if (prefix !== "" && !path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (relative === "") continue;
    if (hasHiddenSegment(relative)) continue;
    if (!IMAGE_EXTENSIONS.has(extensionOf(relative))) continue;
    result.push(path);
  }
  return result;
}

function errorMessageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 以 CSV/CQV 文件为内容源。 */
function csvSource(folder: string, contentPath: string): BankResolution {
  return {
    status: "ok",
    source: {
      mode: "csv",
      bankFolder: folder,
      contentPath,
      contentPaths: [contentPath],
      imageFolder: "",
      anchor: contentPath,
      manifest: null,
    },
  };
}

/** 逐个检查 vault 路径是否存在，返回缺失的路径列表。 */
async function missingVaultPaths(
  vault: Vault,
  paths: string[]
): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    let exists = false;
    try {
      exists = await vault.adapter.exists(path);
    } catch {
      exists = false;
    }
    if (!exists) missing.push(path);
  }
  return missing;
}

/** 内容文件缺失的统一错误文案（列出全部缺失路径）。 */
function contentMissingMessage(missing: string[]): string {
  return missing.length === 1
    ? `manifest.json 指定的内容文件不存在：${missing[0]}`
    : `manifest.json 指定的内容文件不存在：${missing.join("、")}`;
}

/** 把任意 vault 路径规范成无前导 `/`、无反斜杠的形态。 */
function normalizeVaultFilePath(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
}

function configuredError(reason: string, message: string): BankResolution {
  return { status: "error", reason, message };
}

/**
 * 按设置中的显式来源类型解析题库来源（4.1+）。
 *
 * - `sourceType: ""` → prompt unconfigured；
 * - csv → 校验路径存在且为 .csv/.cqv；
 * - image → 递归扫描文件夹（允许 vault 根 `/`），至少一张图片；
 * - manifest → 严格读取 `<folder>/manifest.json`，不回退自动识别。
 */
export async function resolveConfiguredSource(
  vault: Vault,
  settings: ConfiguredSourceSettings
): Promise<BankResolution> {
  const sourceType = settings?.sourceType ?? "";
  if (sourceType === "") {
    return {
      status: "prompt",
      reason: "unconfigured",
      message: "尚未设置题库来源类型：请选择 CSV 文件、图片文件夹或复合题库文件夹。",
    };
  }

  if (sourceType === "csv") {
    const path = normalizeVaultFilePath(settings.sourcePath ?? "");
    if (path === "") {
      return configuredError("csv-missing", "请选择 CSV/CQV 文件。");
    }
    if (!CSV_EXTENSIONS.has(extensionOf(path))) {
      return configuredError(
        "csv-extension",
        `内容文件必须是 .csv 或 .cqv：${path}`
      );
    }
    let exists = false;
    try {
      exists = await vault.adapter.exists(path);
    } catch {
      exists = false;
    }
    if (!exists) {
      return configuredError("csv-missing", `内容文件不存在：${path}`);
    }
    return csvSource(dirnameVaultPath(path), path);
  }

  if (sourceType === "image") {
    const raw = (settings.sourcePath ?? "").trim();
    if (raw === "") {
      return configuredError("image-folder-missing", "请选择图片文件夹。");
    }
    const folder = normalizeBankFolder(raw);
    if (folder === "") {
      return configuredError("image-folder-missing", "请选择图片文件夹。");
    }
    if (IMAGE_EXTENSIONS.has(extensionOf(folder))) {
      return configuredError(
        "image-folder-invalid",
        `图片来源必须是文件夹，而不是图片文件：${folder}`
      );
    }
    const files = await listVaultFiles(vault);
    if (imagePathsUnder(files, vaultFolderPath(folder)).length === 0) {
      return configuredError(
        "image-folder-empty",
        folder === ROOT_BANK_FOLDER
          ? "vault 根目录下没有受支持的图片。"
          : `图片文件夹不存在或没有受支持的图片：${folder}`
      );
    }
    return {
      status: "ok",
      source: {
        mode: "image",
        bankFolder: folder,
        contentPath: "",
        contentPaths: [],
        imageFolder: folder,
        anchor: folder === ROOT_BANK_FOLDER ? ROOT_IMAGE_ANCHOR : folder,
        manifest: null,
      },
    };
  }

  // ---- manifest ----
  const folder = normalizeBankFolder((settings.sourcePath ?? "").trim());
  if (folder === "") {
    return configuredError(
      "manifest-folder-missing",
      "请选择包含 manifest.json 的复合题库文件夹。"
    );
  }
  const manifestPath = manifestPathForBank(folder);
  let manifestText = "";
  try {
    if (!(await vault.adapter.exists(manifestPath))) {
      return configuredError(
        "manifest-missing",
        `复合题库缺少 manifest.json：${manifestPath}`
      );
    }
    manifestText = await vault.adapter.read(manifestPath);
  } catch (e: unknown) {
    return configuredError(
      "manifest-read",
      `读取 ${manifestPath} 失败：${errorMessageOf(e)}`
    );
  }

  const parsed = parseBankManifest(manifestText, folder);
  if (parsed.status === "ignored") {
    return configuredError(
      "manifest-invalid",
      `manifest.json 的 type 不是 ${MANIFEST_TYPE}：${manifestPath}`
    );
  }
  if (parsed.status === "error") {
    return configuredError("manifest-invalid", parsed.message);
  }

  const missingContent = await missingVaultPaths(vault, parsed.contentPaths);
  if (missingContent.length > 0) {
    return configuredError("content-missing", contentMissingMessage(missingContent));
  }

  // imageFolder 省略/为空 = 无图片，跳过图片扫描与「至少一张图」校验。
  if (parsed.imageFolder !== "") {
    const files = await listVaultFiles(vault);
    if (imagePathsUnder(files, parsed.imageFolder).length === 0) {
      return configuredError(
        "image-folder-empty",
        `manifest.json 指定的图片文件夹不存在或没有受支持的图片：${parsed.imageFolder}`
      );
    }
  }

  return {
    status: "ok",
    source: {
      mode: "manifest",
      bankFolder: folder,
      contentPath: parsed.contentPath,
      contentPaths: parsed.contentPaths,
      imageFolder: parsed.imageFolder,
      anchor: manifestAnchorForBank(folder),
      manifest: parsed.manifest,
    },
  };
}

/* ===================== 旧配置 → manifest ===================== */

export interface LegacyManifestResult {
  status: "created" | "reused" | "error";
  bankFolder?: string;
  contentPath?: string;
  imageFolder?: string;
  message?: string;
}

/** 文件夹 → 段数组（根为 `[]`）。 */
function bankFolderSegments(folder: string): string[] {
  const normalized = normalizeBankFolder(folder);
  return normalized === "" || normalized === ROOT_BANK_FOLDER
    ? []
    : normalized.split("/");
}

/**
 * 为旧版「CSV 文件 + 图片文件夹」配置生成复合题库 manifest.json。
 *
 * 以两者的最低公共祖先作为题库文件夹（根为 `/`），manifest 内的路径相对该文件夹；
 * 已有 manifest.json 时只在内容完全一致时复用，否则报错且**不覆盖**。
 */
export async function createLegacyManifest(
  vault: Vault,
  csvPath: string,
  imageFolder: string
): Promise<LegacyManifestResult> {
  const contentPath = normalizeVaultFilePath(csvPath ?? "");
  const imageRaw = (imageFolder ?? "").trim();
  if (contentPath === "") {
    return { status: "error", message: "CSV 路径不能为空。" };
  }
  if (imageRaw === "") {
    return {
      status: "error",
      message: "图片文件夹为空，无法创建复合题库 manifest.json。",
    };
  }

  const contentFolder = normalizeBankFolder(dirnameVaultPath(contentPath));
  const contentBase = contentPath.slice(contentPath.lastIndexOf("/") + 1);
  if (contentBase === "") {
    return { status: "error", message: `CSV 路径无效：${contentPath}` };
  }
  const normalizedContentPath = joinVaultPath(contentFolder, contentBase);

  const imageBankFolder = normalizeBankFolder(imageRaw);
  if (imageBankFolder === "") {
    return {
      status: "error",
      message: "图片文件夹为空，无法创建复合题库 manifest.json。",
    };
  }
  if (IMAGE_EXTENSIONS.has(extensionOf(imageBankFolder))) {
    return {
      status: "error",
      message: `图片路径必须是文件夹：${imageBankFolder}`,
    };
  }

  const contentSegments = bankFolderSegments(contentFolder);
  const imageSegments = bankFolderSegments(imageBankFolder);
  const lca: string[] = [];
  const limit = Math.min(contentSegments.length, imageSegments.length);
  for (let i = 0; i < limit; i += 1) {
    if (contentSegments[i] !== imageSegments[i]) break;
    lca.push(contentSegments[i]);
  }
  const bankFolder = lca.length === 0 ? ROOT_BANK_FOLDER : lca.join("/");

  const contentRel = [
    ...contentSegments.slice(lca.length),
    contentBase,
  ].join("/");
  const imageRel = imageSegments.slice(lca.length).join("/") || ".";
  const imageFolderValue = imageRel;

  const isSafeRelative = (value: string): boolean =>
    value === "." ||
    (value !== "" &&
      value.split("/").every((segment) => segment !== "" && segment !== ".."));

  if (!isSafeRelative(contentRel) || !isSafeRelative(imageFolderValue)) {
    return {
      status: "error",
      message: "无法生成安全的相对路径（不允许 .. 或空段）。",
    };
  }

  const manifestPath = manifestPathForBank(bankFolder);
  let manifestExists = false;
  try {
    manifestExists = await vault.adapter.exists(manifestPath);
  } catch {
    manifestExists = false;
  }

  if (manifestExists) {
    let text: string;
    try {
      text = await vault.adapter.read(manifestPath);
    } catch (e: unknown) {
      return {
        status: "error",
        message: `读取已有 ${manifestPath} 失败：${errorMessageOf(e)}`,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e: unknown) {
      return {
        status: "error",
        message: `已有 ${manifestPath} 不是合法 JSON：${errorMessageOf(e)}`,
      };
    }
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      (raw as Record<string, unknown>).type !== MANIFEST_TYPE
    ) {
      return {
        status: "error",
        message: `已有 ${manifestPath} 的 type 不是 ${MANIFEST_TYPE}，不会覆盖。`,
      };
    }
    const parsed = parseBankManifest(text, bankFolder);
    if (parsed.status !== "ok") {
      return {
        status: "error",
        message:
          parsed.status === "error"
            ? parsed.message
            : `已有 ${manifestPath} 的类型不是 ${MANIFEST_TYPE}，不会覆盖。`,
      };
    }
    if (
      parsed.contentPath !== normalizedContentPath ||
      parsed.imageFolder !== imageBankFolder
    ) {
      return {
        status: "error",
        message: `已有 ${manifestPath} 指向的 content/imageFolder（${parsed.contentPath} / ${parsed.imageFolder}）与当前配置不一致，不会覆盖。`,
      };
    }
    return {
      status: "reused",
      bankFolder,
      contentPath: parsed.contentPath,
      imageFolder: parsed.imageFolder,
    };
  }

  const manifest: BankManifest = {
    type: MANIFEST_TYPE,
    version: 1,
    content: contentRel,
    imageFolder: imageFolderValue,
  };
  try {
    await vault.adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (e: unknown) {
    return {
      status: "error",
      message: `写入 ${manifestPath} 失败：${errorMessageOf(e)}`,
    };
  }

  return {
    status: "created",
    bankFolder,
    contentPath: normalizedContentPath,
    imageFolder: imageBankFolder,
  };
}

/**
 * 解析题库文件夹的来源。
 *
 * 判定顺序：manifest（严格校验）→ 已记住「仅 CSV」→ 唯一 CSV → 仅图片 → 提示。
 * 只读取 manifest 与文件清单，不写任何文件、不弹窗；返回 prompt 供调用方决定
 * 是引导设置、让用户选择 CSV，还是创建 manifest。
 */
export async function resolveBankSource(
  vault: Vault,
  settings: BankResolverSettings
): Promise<BankResolution> {
  const folder = normalizeBankFolder(settings?.bankFolder ?? "");
  if (folder === "") {
    return {
      status: "prompt",
      reason: "unconfigured",
      message:
        "尚未设置题库文件夹：请在设置中选择题库文件夹（或在其中创建 manifest.json）。",
    };
  }

  const allFiles = await listVaultFiles(vault);

  // ---- 1. manifest ----
  const manifestPath = manifestPathForBank(folder);
  let manifestText: string | null = null;
  try {
    if (await vault.adapter.exists(manifestPath)) {
      manifestText = await vault.adapter.read(manifestPath);
    }
  } catch (e: unknown) {
    return {
      status: "error",
      reason: "manifest-read",
      message: `读取 ${manifestPath} 失败：${errorMessageOf(e)}`,
    };
  }

  let hadIgnoredManifest = false;
  if (manifestText !== null) {
    const parsed = parseBankManifest(manifestText, folder);
    if (parsed.status === "error") {
      return {
        status: "error",
        reason: "manifest-invalid",
        message: parsed.message,
      };
    }
    if (parsed.status === "ignored") {
      // 与插件无关的 manifest.json：按「无 manifest」继续，但记下来供提示使用
      hadIgnoredManifest = true;
    } else {
      const missingContent = await missingVaultPaths(vault, parsed.contentPaths);
      if (missingContent.length > 0) {
        return {
          status: "error",
          reason: "content-missing",
          message: contentMissingMessage(missingContent),
        };
      }
      // imageFolder 省略/为空 = 无图片：跳过扫描，也不报「无图片」。
      if (
        parsed.imageFolder !== "" &&
        imagePathsUnder(allFiles, parsed.imageFolder).length === 0
      ) {
        return {
          status: "error",
          reason: "image-folder-empty",
          message: `manifest.json 指定的图片文件夹不存在或没有受支持的图片：${parsed.imageFolder}`,
        };
      }
      return {
        status: "ok",
        source: {
          mode: "manifest",
          bankFolder: folder,
          contentPath: parsed.contentPath,
          contentPaths: parsed.contentPaths,
          imageFolder: parsed.imageFolder,
          anchor: manifestAnchorForBank(folder),
          manifest: parsed.manifest,
        },
      };
    }
  }

  // ---- 2. 无 manifest：按文件夹内容推断 ----
  const direct = directChildPaths(allFiles, folder);
  const csv = chooseCsvCandidate(direct, folder);
  const images = imagePathsUnder(allFiles, vaultFolderPath(folder));
  const hasImages = images.length > 0;
  const forceCsv = settings?.bankSingleSources?.[folder] === "csv";

  if (csv.status === "one") {
    // 用户已为该文件夹选择「仅用 CSV」，即使有图片也不再提示
    if (forceCsv || !hasImages) return csvSource(folder, csv.path);
    return {
      status: "prompt",
      reason: "both",
      message: `题库「${csv.path}」同时包含 CSV/CQV 与图片：如需两者并用请在该文件夹创建 manifest.json；只练 CSV 请选择「仅用 CSV」。`,
      csvCandidate: csv.path,
    };
  }

  if (csv.status === "multiple") {
    return {
      status: "prompt",
      reason: "multiple-csv",
      message: `题库文件夹「${
        vaultFolderPath(folder) || ROOT_BANK_FOLDER
      }」中有多个题库（${csv.paths.join("、")}）：请创建 manifest.json 指定内容，或只保留一个 CSV/CQV。`,
    };
  }

  if (hasImages) {
    if (folder === ROOT_BANK_FOLDER) {
      // vault 根无法承载「文件夹级」sidecar 锚点（`/.sidecar.json`），必须让用户下钻
      return {
        status: "prompt",
        reason: hadIgnoredManifest ? "type-mismatch" : "unconfigured",
        message: hadIgnoredManifest
          ? `vault 根目录只有图片，且根目录的 manifest.json 不是 ${MANIFEST_TYPE} 类型：请修正 manifest.json，或选择题库子文件夹。`
          : "vault 根目录只有图片，无法在根目录生成状态文件：请选择题库子文件夹，或在其中创建 manifest.json。",
      };
    }
    return {
      status: "ok",
      source: {
        mode: "image",
        bankFolder: folder,
        contentPath: "",
        contentPaths: [],
        imageFolder: vaultFolderPath(folder),
        anchor: vaultFolderPath(folder),
        manifest: null,
      },
    };
  }

  if (hadIgnoredManifest) {
    return {
      status: "prompt",
      reason: "type-mismatch",
      message: `题库文件夹「${
        vaultFolderPath(folder) || ROOT_BANK_FOLDER
      }」中的 manifest.json 类型不是 ${MANIFEST_TYPE}，已忽略；也没有可用的 CSV/CQV 或图片。请修正 manifest.json 的 type。`,
    };
  }

  return {
    status: "prompt",
    reason: "empty",
    message: `题库文件夹「${
      vaultFolderPath(folder) || ROOT_BANK_FOLDER
    }」中既没有 CSV/CQV 文件，也没有受支持的图片。`,
  };
}
