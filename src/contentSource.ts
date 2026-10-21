/**
 * 内容源路径解析（纯函数，不依赖 Obsidian）。
 *
 * 题库内容源有两种形态：
 * - CSV/CQV 文件（传统模式）
 * - 图片文件夹（CSV/CQV 路径为空时，以图片文件夹作为内容源锚点）
 *
 * 两种形态都复用 sidecar 的文件命名约定（`<内容源路径>.sidecar.json`），
 * 因此这里只需产出规范的 vault 相对路径字符串。
 */

/**
 * 归一化 vault 相对文件夹路径：
 * - 去首尾空白；反斜杠转 `/`；
 * - 按 `/` 分段，忽略空段与 `.`；`..` 弹出一段（已在根时无操作）；
 * - 合并后返回无前导/尾随 `/` 的路径；空串或根路径返回 `""`。
 */
export function normalizeVaultFolder(raw: string): string {
  if (!raw) return "";
  const segments = raw.trim().replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * 解析实际用于 sidecar 关联的内容源路径：
 * - csvPath trim 后非空 → 返回它（CSV/CQV 优先，兼容现有 sidecar 命名）；
 * - 否则返回归一化后的图片文件夹路径（可能为 `""`，表示无内容源）。
 */
export function resolveContentPath(
  csvPath: string,
  imageFolder: string
): string {
  const trimmed = csvPath.trim();
  if (trimmed !== "") return trimmed;
  return normalizeVaultFolder(imageFolder);
}
