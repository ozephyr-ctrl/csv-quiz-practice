/**
 * obsidian API 的最小运行时桩（仅测试用，经 vitest.config.ts 的 resolve.alias 生效）。
 * 被测模块（csvHandler/sidecar）在解析告警与恢复路径会 new Notice；
 * 其余导入（App/Editor/MarkdownView/Vault 等）在纯函数路径仅作类型使用。
 */
export class Notice {
  constructor(public message: string) {}
}

export class Vault {}
export class App {}
export class Editor {}
export class MarkdownView {}

/** 测试跑在 node（桌面语义）：sidecar 的 fs 快路径（动态 import fs）保持可测。 */
export class Platform {
  static isDesktop = true;
}
