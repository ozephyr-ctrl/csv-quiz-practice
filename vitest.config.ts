import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // obsidian 为运行时外部依赖（插件由 Obsidian 宿主提供），测试指向最小桩
      obsidian: path.resolve(__dirname, "src/test/mocks/obsidian.ts"),
    },
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    environment: "node",
  },
});
