# AGENTS.md — csv-quiz-practice 项目约定

## 版本发布流程

- 远程名是 `csv-quiz-practice`（**不是** `origin`），地址 `git@github.com:ozephyr-ctrl/csv-quiz-practice.git`。
- 每次修复/功能提交遵循消息惯例：`fix:/feat:<中文要点摘要>,vX.Y.Z`，同时 bump `manifest.json` 与 `package.json` 的 `version` 并重新 `npm run build`（main.js 入库）。
- **GitHub Release 由 CI 自动发布，无需手动创建**：`.github/workflows/release.yml` 在推送任意 tag 时触发，自动构建并把 `main.js` / `manifest.json` / `styles.css` 作为附件发布 Release（含构建产物来源证明）。
- 发版完整步骤：

  ```bash
  git tag X.Y.Z
  git push csv-quiz-practice main X.Y.Z
  ```

- 本机没有 `gh` CLI、也没有 GitHub API token（仅 SSH 密钥可推代码），**无法**手动调 API 创建/编辑 Release；一切 Release 操作走推 tag 触发 CI。
- 注意：`3.1.8` 只有提交没有打 tag（tag 从 3.1.5/3.1.6/3.1.7 连续到 3.1.9，缺 3.1.8）；以后每个版本都应打 tag，否则该版本不会有 Release。

## 其它项目要点

- 测试：`npm test`（vitest，63+ 用例），构建：`npm run build`（tsc 类型检查 + esbuild）。改 `src/` 后两者都跑。
- sidecar 状态文件（`<题库>.csv/.cqv.sidecar.json`）是核心持久层，读写在 `src/sidecar.ts`，编排层在 `src/stateManager.ts`，视图集成在 `src/quizView.ts`；冲突副本检测/合并逻辑（v3.1.8+）也在 `src/sidecar.ts`，配套测试 `src/test/sidecarConflict.test.ts`。
- 统计口径：✅/❌ 计数是**累计作答事件数**（同题重刷每次 +1），不可按唯一题整体重算（v3.1.9 修复过的回归）。
- `example/` 目录是用户的真实冲突副本样例数据，保持未跟踪，不入库。
