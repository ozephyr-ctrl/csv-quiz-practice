import { describe, it, expect } from "vitest";
import { normalizeVaultFolder, resolveContentPath } from "../contentSource";

describe("normalizeVaultFolder", () => {
  it("空值/空白/根路径归一为空串", () => {
    expect(normalizeVaultFolder("")).toBe("");
    expect(normalizeVaultFolder("   ")).toBe("");
    expect(normalizeVaultFolder("/")).toBe("");
    expect(normalizeVaultFolder("///")).toBe("");
    expect(normalizeVaultFolder(".")).toBe("");
    expect(normalizeVaultFolder("./")).toBe("");
  });

  it("去掉前后斜杠与多余空白", () => {
    expect(normalizeVaultFolder("  imgs/quiz  ")).toBe("imgs/quiz");
    expect(normalizeVaultFolder("/imgs/quiz/")).toBe("imgs/quiz");
  });

  it("反斜杠转正斜杠", () => {
    expect(normalizeVaultFolder("imgs\\quiz")).toBe("imgs/quiz");
    expect(normalizeVaultFolder("imgs\\quiz\\2026\\")).toBe("imgs/quiz/2026");
    expect(normalizeVaultFolder("\\imgs\\quiz")).toBe("imgs/quiz");
  });

  it("连续斜杠折叠，忽略空段", () => {
    expect(normalizeVaultFolder("imgs//quiz")).toBe("imgs/quiz");
    expect(normalizeVaultFolder("imgs///quiz//2026")).toBe("imgs/quiz/2026");
  });

  it("处理 . 与 .. 段", () => {
    expect(normalizeVaultFolder("./imgs/./quiz")).toBe("imgs/quiz");
    expect(normalizeVaultFolder("imgs/quiz/../2026")).toBe("imgs/2026");
    expect(normalizeVaultFolder("imgs/../..")).toBe("");
    expect(normalizeVaultFolder("../../etc")).toBe("etc");
  });
});

describe("resolveContentPath", () => {
  it("CSV 路径优先（trim 后非空）", () => {
    expect(resolveContentPath("  bank.csv  ", "imgs/quiz")).toBe("bank.csv");
    expect(resolveContentPath("bank.cqv", "")).toBe("bank.cqv");
    // 图片文件夹为空也不影响 CSV 优先
    expect(resolveContentPath("sub/bank.csv", "imgs")).toBe("sub/bank.csv");
  });

  it("CSV 路径为空时回退图片文件夹（归一化）", () => {
    expect(resolveContentPath("", "imgs\\quiz\\")).toBe("imgs/quiz");
    expect(resolveContentPath("   ", "/imgs//quiz/")).toBe("imgs/quiz");
    expect(resolveContentPath("", "")).toBe("");
    expect(resolveContentPath("  ", "  ")).toBe("");
  });
});
