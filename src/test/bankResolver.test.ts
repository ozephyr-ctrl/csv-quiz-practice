import { describe, it, expect } from "vitest";
import type { Vault } from "obsidian";
import {
  MANIFEST_FILENAME,
  MANIFEST_SIDECAR_BASENAME,
  MANIFEST_TYPE,
  ROOT_IMAGE_ANCHOR,
  chooseCsvCandidate,
  createLegacyManifest,
  dirnameVaultPath,
  joinVaultPath,
  manifestAnchorForBank,
  manifestPathForBank,
  migrateLegacySettings,
  normalizeBankFolder,
  parseBankManifest,
  resolveBankSource,
  resolveConfiguredSource,
  vaultFolderPath,
} from "../bankResolver";
import { sidecarPathFor } from "../sidecar";

/* ===================== 测试辅助 ===================== */

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "/" : path.slice(0, idx) || "/";
}

/** 构造最小 fake Vault：getFiles 返回 TFile 形状，adapter.exists/read 按路径应答。 */
function makeVault(
  files: string[],
  contents: Record<string, string> = {}
): Vault {
  const paths = new Set(files);
  return {
    getFiles: () =>
      files.map((path) => ({ path, parent: { path: parentOf(path) } })),
    adapter: {
      exists: async (path: string) => paths.has(path),
      read: async (path: string) => {
        if (Object.prototype.hasOwnProperty.call(contents, path)) {
          return contents[path];
        }
        throw new Error(`ENOENT: ${path}`);
      },
    },
  } as unknown as Vault;
}

/** 可写 fake Vault：在 makeVault 基础上支持 adapter.write，并记录写入内容。 */
function makeWritableVault(
  files: string[],
  contents: Record<string, string> = {}
): { vault: Vault; writes: Record<string, string> } {
  const paths = new Set(files);
  const writes: Record<string, string> = {};
  const vault = {
    getFiles: () =>
      files.map((path) => ({ path, parent: { path: parentOf(path) } })),
    adapter: {
      exists: async (path: string) =>
        paths.has(path) || Object.prototype.hasOwnProperty.call(writes, path),
      read: async (path: string) => {
        if (Object.prototype.hasOwnProperty.call(contents, path)) {
          return contents[path];
        }
        if (Object.prototype.hasOwnProperty.call(writes, path)) {
          return writes[path];
        }
        throw new Error(`ENOENT: ${path}`);
      },
      write: async (path: string, data: string) => {
        writes[path] = data;
        paths.add(path);
      },
    },
  } as unknown as Vault;
  return { vault, writes };
}

function manifestText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: MANIFEST_TYPE,
    version: 1,
    content: "题库.csv",
    imageFolder: "imgs",
    ...overrides,
  });
}

/* ===================== 纯函数 ===================== */

describe("normalizeBankFolder", () => {
  it("空串/空白 → 空串（未设置）", () => {
    expect(normalizeBankFolder("")).toBe("");
    expect(normalizeBankFolder("   ")).toBe("");
  });

  it("根哨兵保留为 /", () => {
    expect(normalizeBankFolder("/")).toBe("/");
    expect(normalizeBankFolder(".")).toBe("/");
    expect(normalizeBankFolder("./")).toBe("/");
    expect(normalizeBankFolder("///")).toBe("/");
  });

  it("去首尾斜杠、反斜杠转 /、折叠空段", () => {
    expect(normalizeBankFolder("  banks/x  ")).toBe("banks/x");
    expect(normalizeBankFolder("/banks//x/")).toBe("banks/x");
    expect(normalizeBankFolder("banks\\x\\")).toBe("banks/x");
  });

  it("处理 . 与 .. 段（.. 退到根时得到根哨兵）", () => {
    expect(normalizeBankFolder("./banks/./x")).toBe("banks/x");
    expect(normalizeBankFolder("banks/x/../y")).toBe("banks/y");
    expect(normalizeBankFolder("banks/..")).toBe("/");
    expect(normalizeBankFolder("banks/../..")).toBe("/");
  });

  it("与 normalizeVaultFolder 的差异：根不归为空串", () => {
    expect(normalizeBankFolder("/")).not.toBe("");
  });
});

describe("路径辅助", () => {
  it("vaultFolderPath：根哨兵 → 空串", () => {
    expect(vaultFolderPath("/")).toBe("");
    expect(vaultFolderPath("banks/x")).toBe("banks/x");
    expect(vaultFolderPath("")).toBe("");
  });

  it("joinVaultPath：根/空文件夹不加前缀", () => {
    expect(joinVaultPath("/", "a.csv")).toBe("a.csv");
    expect(joinVaultPath("", "a.csv")).toBe("a.csv");
    expect(joinVaultPath("banks/x", "a.csv")).toBe("banks/x/a.csv");
  });

  it("dirnameVaultPath：根目录返回 /", () => {
    expect(dirnameVaultPath("banks/x/a.csv")).toBe("banks/x");
    expect(dirnameVaultPath("a.csv")).toBe("/");
    expect(dirnameVaultPath("/a.csv")).toBe("/");
    expect(dirnameVaultPath("/banks/x/a.csv")).toBe("banks/x");
    expect(dirnameVaultPath("banks\\x\\a.csv")).toBe("banks/x");
    expect(dirnameVaultPath("/")).toBe("/");
  });

  it("manifestPathForBank / manifestAnchorForBank（根无前缀）", () => {
    expect(manifestPathForBank("/")).toBe(MANIFEST_FILENAME);
    expect(manifestPathForBank("banks/x")).toBe("banks/x/manifest.json");
    expect(manifestAnchorForBank("/")).toBe(MANIFEST_SIDECAR_BASENAME);
    expect(manifestAnchorForBank("banks/x")).toBe("banks/x/manifest");
    // 锚点必须保证 sidecar 落成 manifest.sidecar.json
    expect(sidecarPathFor(manifestAnchorForBank("/"))).toBe(
      "manifest.sidecar.json"
    );
    expect(sidecarPathFor(manifestAnchorForBank("banks/x"))).toBe(
      "banks/x/manifest.sidecar.json"
    );
  });
});

describe("parseBankManifest", () => {
  it("合法清单：按题库文件夹解析出内容与图片路径", () => {
    const result = parseBankManifest(
      manifestText({ content: "题库.csv", imageFolder: "imgs" }),
      "banks/x"
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.contentPath).toBe("banks/x/题库.csv");
    expect(result.imageFolder).toBe("banks/x/imgs");
    expect(result.manifest).toEqual({
      type: MANIFEST_TYPE,
      version: 1,
      content: "题库.csv",
      imageFolder: "imgs",
    });
  });

  it("根题库：路径不带前缀；imageFolder '.' 解析为 vault 根", () => {
    const result = parseBankManifest(
      manifestText({ content: "sub/题库.cqv", imageFolder: "." }),
      "/"
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.contentPath).toBe("sub/题库.cqv");
    expect(result.imageFolder).toBe("/");
  });

  it("imageFolder '.' 在非根题库解析为题库文件夹", () => {
    const result = parseBankManifest(
      manifestText({ imageFolder: "." }),
      "banks/x"
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.imageFolder).toBe("banks/x");
  });

  it("JSON 损坏 → error", () => {
    const result = parseBankManifest("{oops", "banks/x");
    expect(result.status).toBe("error");
  });

  it("顶层非对象 → error", () => {
    for (const text of ["[]", "null", '"str"', "42"]) {
      expect(parseBankManifest(text, "banks/x").status).toBe("error");
    }
  });

  it("type 不匹配 → ignored（当作无关 manifest）", () => {
    expect(
      parseBankManifest(manifestText({ type: "something-else" }), "banks/x")
        .status
    ).toBe("ignored");
    expect(parseBankManifest("{}", "banks/x").status).toBe("ignored");
  });

  it("version 不为 1 → error", () => {
    expect(
      parseBankManifest(manifestText({ version: 2 }), "banks/x").status
    ).toBe("error");
  });

  it("content/imageFolder 缺失或类型错误 → error", () => {
    expect(
      parseBankManifest(manifestText({ content: "" }), "banks/x").status
    ).toBe("error");
    expect(
      parseBankManifest(manifestText({ content: 123 }), "banks/x").status
    ).toBe("error");
    expect(
      parseBankManifest(manifestText({ imageFolder: undefined }), "banks/x")
        .status
    ).toBe("error");
    expect(
      parseBankManifest(manifestText({ imageFolder: "  " }), "banks/x").status
    ).toBe("error");
  });

  it("content 含 .. 或绝对路径 → error", () => {
    for (const content of [
      "../题库.csv",
      "sub/../题库.csv",
      "/题库.csv",
      "C:/题库.csv",
      "C:\\题库.csv",
      "sub\\题库.csv",
    ]) {
      expect(
        parseBankManifest(manifestText({ content }), "banks/x").status
      ).toBe("error");
    }
  });

  it("imageFolder 含 .. 或绝对路径 → error；反斜杠允许", () => {
    expect(
      parseBankManifest(manifestText({ imageFolder: "../imgs" }), "banks/x")
        .status
    ).toBe("error");
    expect(
      parseBankManifest(manifestText({ imageFolder: "/imgs" }), "banks/x")
        .status
    ).toBe("error");
    const ok = parseBankManifest(
      manifestText({ imageFolder: "imgs\\pics" }),
      "banks/x"
    );
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") return;
    expect(ok.imageFolder).toBe("banks/x/imgs/pics");
  });

  it("content 扩展名必须 .csv/.cqv", () => {
    for (const content of ["题库.md", "题库.json", "题库"]) {
      expect(
        parseBankManifest(manifestText({ content }), "banks/x").status
      ).toBe("error");
    }
    expect(
      parseBankManifest(manifestText({ content: "题库.CSV" }), "banks/x").status
    ).toBe("ok");
  });
});

describe("chooseCsvCandidate", () => {
  it("唯一 CSV → one", () => {
    expect(chooseCsvCandidate(["banks/x/题库.csv"], "banks/x")).toEqual({
      status: "one",
      path: "banks/x/题库.csv",
    });
  });

  it("同 stem 的 .csv + .cqv 视为一个题库，优先 .csv", () => {
    expect(
      chooseCsvCandidate(["banks/x/题库.cqv", "banks/x/题库.csv"], "banks/x")
    ).toEqual({ status: "one", path: "banks/x/题库.csv" });
  });

  it("只有 CQV → one", () => {
    expect(chooseCsvCandidate(["banks/x/题库.cqv"], "banks/x")).toEqual({
      status: "one",
      path: "banks/x/题库.cqv",
    });
  });

  it("不同 stem → multiple（排序稳定）", () => {
    expect(
      chooseCsvCandidate(["banks/x/b.csv", "banks/x/a.csv"], "banks/x")
    ).toEqual({
      status: "multiple",
      paths: ["banks/x/a.csv", "banks/x/b.csv"],
    });
  });

  it("忽略 dot 文件、非 CSV/CQV、其它目录的文件", () => {
    expect(
      chooseCsvCandidate(
        [
          "banks/x/.hidden.csv",
          "banks/x/笔记.md",
          "banks/y/other.csv",
          "banks/x/题库.csv",
        ],
        "banks/x"
      )
    ).toEqual({ status: "one", path: "banks/x/题库.csv" });
    expect(chooseCsvCandidate([], "banks/x")).toEqual({ status: "none" });
  });

  it("根题库：接受纯文件名与根路径", () => {
    expect(chooseCsvCandidate(["题库.csv"], "/")).toEqual({
      status: "one",
      path: "题库.csv",
    });
    expect(chooseCsvCandidate(["/题库.cqv"], "/")).toEqual({
      status: "one",
      path: "/题库.cqv",
    });
  });
});

describe("migrateLegacySettings", () => {
  const base = {
    bankFolder: "",
    csvPath: "",
    imageFolder: "",
    bankSingleSources: {} as Record<string, "csv">,
  };

  it("bankFolder 已设置 → 原样返回且 changed=false", () => {
    const result = migrateLegacySettings({
      ...base,
      bankFolder: "banks/x",
      csvPath: "old/a.csv",
      imageFolder: "imgs",
    });
    expect(result.bankFolder).toBe("banks/x");
    expect(result.changed).toBe(false);
    expect(result.bankSingleSources).toEqual({});
  });

  it("仅 csvPath → bankFolder 取其目录", () => {
    const result = migrateLegacySettings({ ...base, csvPath: "banks/x/a.csv" });
    expect(result.bankFolder).toBe("banks/x");
    expect(result.changed).toBe(true);
    expect(result.bankSingleSources).toEqual({});
  });

  it("根目录 csvPath → bankFolder 为根哨兵", () => {
    const result = migrateLegacySettings({ ...base, csvPath: "题库.csv" });
    expect(result.bankFolder).toBe("/");
    expect(result.changed).toBe(true);
  });

  it("仅 imageFolder → bankFolder 为归一化图片文件夹", () => {
    const result = migrateLegacySettings({
      ...base,
      imageFolder: "/imgs\\quiz/",
    });
    expect(result.bankFolder).toBe("imgs/quiz");
    expect(result.changed).toBe(true);
  });

  it("csv + image 混合旧配置 → 降级为「仅 CSV」并记录", () => {
    const result = migrateLegacySettings({
      ...base,
      csvPath: "banks/x/a.csv",
      imageFolder: "banks/x/imgs",
    });
    expect(result.bankFolder).toBe("banks/x");
    expect(result.bankSingleSources).toEqual({ "banks/x": "csv" });
    expect(result.changed).toBe(true);
  });

  it("都为空 → 不变，且不修改入参", () => {
    const settings = { ...base, bankSingleSources: { "banks/x": "csv" as const } };
    const result = migrateLegacySettings(settings);
    expect(result.bankFolder).toBe("");
    expect(result.changed).toBe(false);
    expect(result.bankSingleSources).toEqual({ "banks/x": "csv" });
    expect(result.bankSingleSources).not.toBe(settings.bankSingleSources);
  });
});

/* ===================== IO 层 ===================== */

describe("resolveBankSource：manifest 模式", () => {
  it("清单合法且内容/图片都在 → manifest 模式", async () => {
    const vault = makeVault(
      [
        "banks/a/manifest.json",
        "banks/a/题库.csv",
        "banks/a/imgs/p1.png",
        "banks/a/imgs/sub/p2.jpg",
      ],
      { "banks/a/manifest.json": manifestText() }
    );
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("manifest");
    expect(result.source.bankFolder).toBe("banks/a");
    expect(result.source.contentPath).toBe("banks/a/题库.csv");
    expect(result.source.imageFolder).toBe("banks/a/imgs");
    expect(result.source.anchor).toBe("banks/a/manifest");
    expect(result.source.manifest).not.toBeNull();
  });

  it("根题库 manifest → 锚点为 manifest", async () => {
    const vault = makeVault(
      ["manifest.json", "题库.csv", "imgs/p.png"],
      { "manifest.json": manifestText() }
    );
    const result = await resolveBankSource(vault, { bankFolder: "/" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.bankFolder).toBe("/");
    expect(result.source.contentPath).toBe("题库.csv");
    expect(result.source.imageFolder).toBe("imgs");
    expect(result.source.anchor).toBe("manifest");
    expect(sidecarPathFor(result.source.anchor)).toBe("manifest.sidecar.json");
  });

  it("清单指定的内容文件不存在 → error", async () => {
    const vault = makeVault(
      ["banks/a/manifest.json", "banks/a/imgs/p.png"],
      { "banks/a/manifest.json": manifestText() }
    );
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("content-missing");
  });

  it("清单指定的图片文件夹为空（含仅隐藏目录）→ error", async () => {
    const vault = makeVault(
      [
        "banks/a/manifest.json",
        "banks/a/题库.csv",
        "banks/a/imgs/.trash/p.png",
      ],
      { "banks/a/manifest.json": manifestText() }
    );
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("image-folder-empty");
  });

  it("清单 JSON 损坏 → error", async () => {
    const vault = makeVault(["banks/a/manifest.json"], {
      "banks/a/manifest.json": "{broken",
    });
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("manifest-invalid");
  });

  it("type 不匹配 → 回落到无 manifest 逻辑（唯一 CSV 走 csv 模式）", async () => {
    const vault = makeVault(
      ["banks/a/manifest.json", "banks/a/题库.csv"],
      { "banks/a/manifest.json": manifestText({ type: "other-plugin" }) }
    );
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("csv");
    expect(result.source.contentPath).toBe("banks/a/题库.csv");
    expect(result.source.manifest).toBeNull();
  });

  it("type 不匹配且无可解析来源 → prompt type-mismatch", async () => {
    const vault = makeVault(["banks/a/manifest.json"], {
      "banks/a/manifest.json": manifestText({ type: "other-plugin" }),
    });
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("type-mismatch");
  });
});

describe("resolveBankSource：无 manifest", () => {
  it("唯一 CSV → csv 模式（anchor = 内容路径）", async () => {
    const vault = makeVault(["banks/a/题库.csv"]);
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("csv");
    expect(result.source.contentPath).toBe("banks/a/题库.csv");
    expect(result.source.imageFolder).toBe("");
    expect(result.source.anchor).toBe("banks/a/题库.csv");
  });

  it("根题库唯一 CSV → csv 模式", async () => {
    const vault = makeVault(["题库.csv"]);
    const result = await resolveBankSource(vault, { bankFolder: "/" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.bankFolder).toBe("/");
    expect(result.source.contentPath).toBe("题库.csv");
  });

  it("只有图片 → image 模式（anchor = 文件夹）", async () => {
    const vault = makeVault(["banks/a/x.png", "banks/a/sub/y.webp"]);
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("image");
    expect(result.source.contentPath).toBe("");
    expect(result.source.imageFolder).toBe("banks/a");
    expect(result.source.anchor).toBe("banks/a");
  });

  it("CSV + 图片 → prompt both，并给出 csvCandidate", async () => {
    const vault = makeVault(["banks/a/题库.csv", "banks/a/x.png"]);
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("both");
    expect(result.csvCandidate).toBe("banks/a/题库.csv");
  });

  it("多个 CSV → prompt multiple-csv", async () => {
    const vault = makeVault(["banks/a/a.csv", "banks/a/b.cqv"]);
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("multiple-csv");
  });

  it("bankSingleSources 标记「仅 CSV」→ 即使有图片也走 csv 模式", async () => {
    const vault = makeVault(["banks/a/题库.csv", "banks/a/x.png"]);
    const result = await resolveBankSource(vault, {
      bankFolder: "banks/a",
      bankSingleSources: { "banks/a": "csv" },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("csv");
    expect(result.source.contentPath).toBe("banks/a/题库.csv");
  });

  it("根题库只有图片 → prompt（根无法承载文件夹锚点）", async () => {
    const vault = makeVault(["imgs/x.png"]);
    const result = await resolveBankSource(vault, { bankFolder: "/" });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("unconfigured");
    expect(result.message).toContain("manifest.json");
  });

  it("文件夹为空 → prompt empty", async () => {
    const vault = makeVault(["banks/a/readme.md", "banks/a/.hidden/p.png"]);
    const result = await resolveBankSource(vault, { bankFolder: "banks/a" });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("empty");
  });

  it("未设置题库文件夹 → prompt unconfigured", async () => {
    const vault = makeVault([]);
    const result = await resolveBankSource(vault, { bankFolder: "   " });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("unconfigured");
  });
});

/* ===================== 显式来源类型 ===================== */

describe("resolveConfiguredSource：未配置", () => {
  it("sourceType 为空 → prompt unconfigured", async () => {
    const vault = makeVault([]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "",
      sourcePath: "banks/a/q.csv",
    });
    expect(result.status).toBe("prompt");
    if (result.status !== "prompt") return;
    expect(result.reason).toBe("unconfigured");
  });
});

describe("resolveConfiguredSource：csv", () => {
  it("合法 CSV → csv 模式（anchor = 内容路径）", async () => {
    const vault = makeVault(["banks/a/题库.csv"]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "csv",
      sourcePath: " banks/a/题库.csv ",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("csv");
    expect(result.source.bankFolder).toBe("banks/a");
    expect(result.source.contentPath).toBe("banks/a/题库.csv");
    expect(result.source.imageFolder).toBe("");
    expect(result.source.anchor).toBe("banks/a/题库.csv");
    expect(result.source.manifest).toBeNull();
  });

  it("文件不存在 → error", async () => {
    const vault = makeVault([]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "csv",
      sourcePath: "banks/a/题库.csv",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("csv-missing");
  });

  it("扩展名不是 .csv/.cqv → error", async () => {
    const vault = makeVault(["banks/a/笔记.md"]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "csv",
      sourcePath: "banks/a/笔记.md",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("csv-extension");
  });

  it("空路径 → error", async () => {
    const result = await resolveConfiguredSource(makeVault([]), {
      sourceType: "csv",
      sourcePath: "   ",
    });
    expect(result.status).toBe("error");
  });
});

describe("resolveConfiguredSource：image", () => {
  it("普通文件夹 → image 模式（anchor = 文件夹）", async () => {
    const vault = makeVault(["imgs/a.png", "imgs/sub/b.jpg", "imgs/c.txt"]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "image",
      sourcePath: " imgs ",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("image");
    expect(result.source.bankFolder).toBe("imgs");
    expect(result.source.contentPath).toBe("");
    expect(result.source.imageFolder).toBe("imgs");
    expect(result.source.anchor).toBe("imgs");
    expect(result.source.manifest).toBeNull();
  });

  it("vault 根 '/' → imageFolder '/'，anchor 为 ROOT_IMAGE_ANCHOR", async () => {
    const vault = makeVault(["a.png", "sub/b.webp"]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "image",
      sourcePath: "/",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("image");
    expect(result.source.bankFolder).toBe("/");
    expect(result.source.imageFolder).toBe("/");
    expect(result.source.anchor).toBe(ROOT_IMAGE_ANCHOR);
  });

  it("无受支持图片 → error", async () => {
    const vault = makeVault(["imgs/a.txt", "imgs/.hidden/b.png"]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "image",
      sourcePath: "imgs",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("image-folder-empty");
  });

  it("空路径 → error", async () => {
    const result = await resolveConfiguredSource(makeVault([]), {
      sourceType: "image",
      sourcePath: "  ",
    });
    expect(result.status).toBe("error");
  });
});

describe("resolveConfiguredSource：manifest", () => {
  it("合法 manifest → manifest 模式", async () => {
    const vault = makeVault(
      [
        "banks/a/manifest.json",
        "banks/a/题库.csv",
        "banks/a/imgs/p.png",
      ],
      { "banks/a/manifest.json": manifestText() }
    );
    const result = await resolveConfiguredSource(vault, {
      sourceType: "manifest",
      sourcePath: "banks/a",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.mode).toBe("manifest");
    expect(result.source.contentPath).toBe("banks/a/题库.csv");
    expect(result.source.imageFolder).toBe("banks/a/imgs");
    expect(result.source.anchor).toBe("banks/a/manifest");
    expect(result.source.manifest).not.toBeNull();
  });

  it("manifest 缺失 → error（不回退自动识别）", async () => {
    const vault = makeVault(["banks/a/题库.csv", "banks/a/x.png"]);
    const result = await resolveConfiguredSource(vault, {
      sourceType: "manifest",
      sourcePath: "banks/a",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("manifest-missing");
  });

  it("content 缺失 → error", async () => {
    const vault = makeVault(["banks/a/manifest.json", "banks/a/imgs/p.png"], {
      "banks/a/manifest.json": manifestText(),
    });
    const result = await resolveConfiguredSource(vault, {
      sourceType: "manifest",
      sourcePath: "banks/a",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("content-missing");
  });

  it("图片目录为空 → error", async () => {
    const vault = makeVault(["banks/a/manifest.json", "banks/a/题库.csv"], {
      "banks/a/manifest.json": manifestText(),
    });
    const result = await resolveConfiguredSource(vault, {
      sourceType: "manifest",
      sourcePath: "banks/a",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("image-folder-empty");
  });

  it("type 不匹配 → error（不回退）", async () => {
    const vault = makeVault(
      ["banks/a/manifest.json", "banks/a/题库.csv"],
      { "banks/a/manifest.json": manifestText({ type: "other-plugin" }) }
    );
    const result = await resolveConfiguredSource(vault, {
      sourceType: "manifest",
      sourcePath: "banks/a",
    });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("manifest-invalid");
  });

  it("根 manifest 的 imageFolder '.' → imageFolder '/'", async () => {
    const vault = makeVault(
      ["manifest.json", "题库.csv", "a.png", "sub/b.png"],
      { "manifest.json": manifestText({ imageFolder: "." }) }
    );
    const result = await resolveConfiguredSource(vault, {
      sourceType: "manifest",
      sourcePath: "/",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.source.bankFolder).toBe("/");
    expect(result.source.contentPath).toBe("题库.csv");
    expect(result.source.imageFolder).toBe("/");
    expect(result.source.anchor).toBe("manifest");
  });
});

describe("createLegacyManifest", () => {
  it("CSV 与图片同级 → imageFolder '.'", async () => {
    const { vault, writes } = makeWritableVault(["banks/a/题库.csv"]);
    const result = await createLegacyManifest(
      vault,
      "banks/a/题库.csv",
      "banks/a"
    );
    expect(result.status).toBe("created");
    expect(result.bankFolder).toBe("banks/a");
    expect(result.contentPath).toBe("banks/a/题库.csv");
    expect(result.imageFolder).toBe("banks/a");
    const written = JSON.parse(writes["banks/a/manifest.json"]);
    expect(written).toEqual({
      type: MANIFEST_TYPE,
      version: 1,
      content: "题库.csv",
      imageFolder: ".",
    });
  });

  it("图片文件夹在 CSV 同级下方 → 相对公共祖先", async () => {
    const { vault, writes } = makeWritableVault(["banks/a/题库.csv"]);
    const result = await createLegacyManifest(
      vault,
      "banks/a/题库.csv",
      "banks/a/imgs"
    );
    expect(result.status).toBe("created");
    expect(result.bankFolder).toBe("banks/a");
    const written = JSON.parse(writes["banks/a/manifest.json"]);
    expect(written.content).toBe("题库.csv");
    expect(written.imageFolder).toBe("imgs");
    expect(written.content).not.toContain("..");
    expect(written.imageFolder).not.toContain("..");
  });

  it("公共祖先为 vault 根 → manifest 在根，content 无前缀", async () => {
    const { vault, writes } = makeWritableVault(["题库.csv"]);
    const result = await createLegacyManifest(vault, "题库.csv", "imgs");
    expect(result.status).toBe("created");
    expect(result.bankFolder).toBe("/");
    expect(result.imageFolder).toBe("imgs");
    const written = JSON.parse(writes["manifest.json"]);
    expect(written.content).toBe("题库.csv");
    expect(written.imageFolder).toBe("imgs");
    expect(written.content.startsWith("/")).toBe(false);
    expect(written.imageFolder.startsWith("/")).toBe(false);
  });

  it("已有内容一致的 manifest → reused，且不重写", async () => {
    const existing = JSON.stringify({
      type: MANIFEST_TYPE,
      version: 1,
      content: "题库.csv",
      imageFolder: "imgs",
    });
    const { vault, writes } = makeWritableVault(
      ["banks/a/manifest.json", "banks/a/题库.csv"],
      { "banks/a/manifest.json": existing }
    );
    const result = await createLegacyManifest(
      vault,
      "banks/a/题库.csv",
      "banks/a/imgs"
    );
    expect(result.status).toBe("reused");
    expect(result.bankFolder).toBe("banks/a");
    expect(writes["banks/a/manifest.json"]).toBeUndefined();
  });

  it("已有无关 manifest → error，且不覆盖", async () => {
    const existing = JSON.stringify({ type: "other-plugin", version: 1 });
    const { vault, writes } = makeWritableVault(
      ["banks/a/manifest.json", "banks/a/题库.csv"],
      { "banks/a/manifest.json": existing }
    );
    const result = await createLegacyManifest(
      vault,
      "banks/a/题库.csv",
      "banks/a/imgs"
    );
    expect(result.status).toBe("error");
    expect(writes["banks/a/manifest.json"]).toBeUndefined();
  });

  it("已有 manifest 指向不同内容 → error，且不覆盖", async () => {
    const existing = JSON.stringify({
      type: MANIFEST_TYPE,
      version: 1,
      content: "other.csv",
      imageFolder: "other-imgs",
    });
    const { vault, writes } = makeWritableVault(
      ["banks/a/manifest.json"],
      { "banks/a/manifest.json": existing }
    );
    const result = await createLegacyManifest(
      vault,
      "banks/a/题库.csv",
      "banks/a/imgs"
    );
    expect(result.status).toBe("error");
    expect(writes["banks/a/manifest.json"]).toBeUndefined();
  });

  it("空图片文件夹 → error", async () => {
    const { vault } = makeWritableVault(["banks/a/题库.csv"]);
    const result = await createLegacyManifest(
      vault,
      "banks/a/题库.csv",
      "   "
    );
    expect(result.status).toBe("error");
  });

  it("生成路径不含 ..（跨层级也不越界）", async () => {
    const { vault, writes } = makeWritableVault(["banks/a/题库.csv"]);
    await createLegacyManifest(vault, "banks/a/题库.csv", "banks/a/imgs/deep");
    const written = JSON.parse(writes["banks/a/manifest.json"]);
    expect(written.imageFolder).toBe("imgs/deep");
    expect(written.imageFolder.split("/")).not.toContain("..");
  });
});
