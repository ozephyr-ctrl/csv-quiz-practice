#csv quiz practice

**Obsidian 刷题插件 / CSV-based Quiz Plugin for Obsidian**

基于 CSV 文件的 Obsidian 刷题插件。将你的题库写入 CSV，然后在 Obsidian 中刷题、标记、筛选、统计正确率。

A CSV-based quiz practice plugin for Obsidian. Write your question bank in a CSV file, then practice with filtering, tagging, and progress tracking.

---

## 快速开始 / Quick Start

1. 在 vault 根目录创建 `题库.csv`（也可在设置中指定其他路径）
   Create `题库.csv` in your vault root (or set a custom path in settings)

2. 点击左侧 ribbon 的图书图标，或执行命令 `打开刷题面板`
   Click the book icon in the left ribbon, or run the command `打开刷题面板`

3. 开始刷题
   Start practicing

---

## CSV 格式 / CSV Format

CSV 文件必须为 **BOM 前缀的 UTF-8** 编码，15 列：

The CSV file must be **BOM-prefixed UTF-8** with 15 columns:

```
序号,题干,选项A,选项B,选项C,选项D,正确答案,标签,一级分类,二级分类,三级分类,收藏,掌握,重复,错题
```

| 列 / Column | 说明 / Description |
|---|---|
| 序号 / ID | 题目的唯一标识，必须是数字 / Unique numeric ID |
| 题干 / Stem | 支持 Markdown 渲染 / Supports Markdown rendering |
| 选项A~D / Options A-D | 四个选项 / Four answer options |
| 正确答案 / Correct Answer | `A`, `B`, `C` 或 `D` |
| 标签 / Tags | 空格分隔，如 `#数学 #代数` / Space-separated, e.g. `#Math #Algebra` |
| 一级~三级分类 / Categories | 三级分类体系，用于筛选 / 3-level category hierarchy for filtering |
| 收藏/掌握/重复/错题 / Flags | 布尔标记：`1` = 是 / yes, `0` = 否 / no |

### 示例行 / Example Row

```
1,1+1=?,1,2,3,4,B,#数学 #加法,#数学,,,1,,,
```

---

## 功能 / Features

### 刷题 / Practice

- 选择答案后实时反馈对错，显示正确答案
  Instant feedback on answer selection with the correct answer shown
- **答对自动跳转**：可设置延迟秒数后自动进入下一题
  **Auto-advance**: auto-next with configurable delay on correct answer
- **随机题目顺序**：每次加载时重新排列题目
  **Random order**: shuffle questions on each load
- **随机选项顺序**：每题选项随机排列
  **Random options**: shuffle answer options per question

### 筛选 / Filtering

- **标签筛选**：点击标签芯片切换，支持多标签交集
  **Tag filter**: clickable tag chips with multi-tag intersection matching
- **分类筛选**：三级分类联动下拉筛选
  **Category filter**: 3-level cascading dropdown filters
- **标记筛选**：收藏/掌握/重复/错题三态切换（不限 / 仅 / 否）
  **Boolean filters**: favorite/mastered/repeat/wrong — three states (any / yes / no)
- 筛选结果自动更新题目列表和进度
  Question list and progress update automatically on filter change

### 编辑 / Editing

- 答题过程中可编辑当前题目的标签、分类和标记
  Edit tags, categories, and flags of the current question during practice
- 修改自动保存到 CSV 文件
  Changes auto-save to the CSV file

### 进度持久化 / Persistence

- 答题记录、正确率、当前进度自动保存
  Answers, accuracy, and current position are automatically saved
- 关闭后重新打开，自动恢复到上次位置
  Resumes from where you left off after reopening Obsidian
- 切换 CSV 路径自动开始新会话
  Switching CSV path starts a fresh session

### 设置项 / Settings

| 设置 / Setting | 说明 / Description |
|---|---|
| CSV 文件路径 / CSV Path | 题库 CSV 路径（相对 vault 根目录） |
| 随机题目顺序 / Random Order | 每次加载时随机排列题目 |
| 随机选项顺序 / Random Options | 每题选项顺序随机 |
| 答对自动跳转延迟 / Auto-Advance Delay | 答对后等待秒数，0 = 不自动（秒 / seconds） |
| 默认展开筛选栏 / Filter Panel Open | 打开面板时筛选栏默认展开 |
| 默认展开编辑栏 / Edit Panel Open | 打开面板时编辑栏默认展开 |
| 标记筛选默认值 / Default Filter Values | 各标记筛选的默认状态 |
| 重置刷题进度 / Reset Progress | 清除所有状态，重新加载题库 |

---

## 安装 / Installation

1. Obsidian 设置 → 社区插件 → 浏览 → 搜索 "csv quiz practice"
   Obsidian Settings → Community plugins → Browse → Search "csv quiz practice"

2. 或手动安装：将 `main.js` + `manifest.json` + `styles.css` 复制到 vault 的 `.obsidian/plugins/csv-quiz-practice/`，然后重载 Obsidian
   Or install manually: copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/csv-quiz-practice/` and reload Obsidian

---

