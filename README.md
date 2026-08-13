# csv quiz practice

**Obsidian 刷题插件 / CSV-based Quiz Plugin for Obsidian**

基于 CSV 文件的 Obsidian 刷题插件。将你的题库写入 CSV，然后在 Obsidian 中刷题、标记、筛选、统计正确率；支持将题库编译为 `.cqv` 产物分发给使用者。

A CSV-based quiz practice plugin for Obsidian. Write your question bank in a CSV file, then practice with filtering, tagging, and progress tracking; compile your bank into a `.cqv` artifact for distribution.

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
| 序号 / ID | 题目的唯一标识，必须非空且不重复（空或重复题号将拒绝加载）/ Unique non-empty ID (empty/duplicate IDs are rejected) |
| 题干 / Stem | 支持 Markdown 渲染 / Supports Markdown rendering |
| 选项A~D / Options A-D | 四个选项 / Four answer options |
| 正确答案 / Correct Answer | `A`, `B`, `C` 或 `D` |
| 标签 / Tags | 空格分隔，如 `#数学 #代数` / Space-separated, e.g. `#Math #Algebra` |
| 一级~三级分类 / Categories | 三级分类体系，用于筛选 / 3-level category hierarchy for filtering |
| 收藏/掌握/错题 / Favorite/Mastered/Wrong | 初始标记：`1` = 是 / yes, `0` = 否 / no。**运行中的变更保存在状态文件，不再写回 CSV** / Initial flags; runtime changes go to the sidecar state file, not the CSV |
| 重复 / Repeat | 作者标记的重复题（有发布价值）/ Author-marked duplicate questions (published with the bank) |

### 示例行 / Example Row

```
1,1+1=?,1,2,3,4,B,#数学 #加法,#数学,,,1,,,
```

---

## 状态文件（sidecar）/ State File

每个题库在同目录下有一个同名的状态文件（`题库.csv.sidecar.json`），保存该题库的全部使用状态：答题记录、统计、记忆卡片（FSRS）、筛选、收藏/掌握/错题、标签与分类的修改等。**切换题库时各题库状态相互独立、自动恢复，不会互相覆盖。**

Each question bank has a same-name state file next to it (`题库.csv.sidecar.json`), holding all per-bank state: answer records, statistics, FSRS cards, filters, favorite/mastered/wrong flags, and edits to tags/categories. **Switching banks restores each bank's own progress automatically — no overwriting.**

- 状态写入为原子操作（临时文件 + 重命名），并每 30 分钟保留一份备份（`.bak`）；状态文件损坏或缺失时自动从备份恢复
  State writes are atomic (temp file + rename) with a 30-minute backup (`.bak`); corrupted or missing state files are auto-recovered from backup
- **重置进度请使用设置页「重置刷题进度」按钮**；手动删除状态文件会被备份自动恢复
  **Reset progress via the settings page "Reset Progress" button**; manually deleting the state file is auto-restored from backup
- 升级自旧版本时，旧进度自动迁移至状态文件，原 `data.json` 备份为 `data.json.bak`（如需回滚可手工恢复）
  When upgrading from older versions, legacy progress is migrated automatically and `data.json` is backed up as `data.json.bak` for manual rollback

---

## 功能 / Features

### 刷题 / Practice

- 选择答案后实时反馈对错，显示正确答案
  Instant feedback on answer selection with the correct answer shown
- **答对自动跳转**：可设置延迟秒数后自动进入下一题
  **Auto-advance**: auto-next with configurable delay on correct answer
- **随机题目顺序**：每次加载时重新排列题目；开关切换保留答题进度，仅重排显示顺序（关闭时恢复 CSV 默认顺序）
  **Random order**: shuffle questions on each load; toggling preserves progress and only reorders (off = back to CSV order)
- **随机选项顺序**：每题选项随机排列
  **Random options**: shuffle answer options per question
- **键盘切题**：面板聚焦时左右方向键切换上/下一题（输入框中不受影响）
  **Keyboard navigation**: arrow keys move between questions when the panel is focused (inputs unaffected)
- **滑动切题**（移动端）：面板内左右滑动切换题目，可设置关闭
  **Swipe navigation** (mobile): swipe left/right to switch questions, configurable

### 练习模式 / Practice Modes

- **随机练习**：按当前筛选条件随机选 **100 道未答题**作为练习集（不足自适应）
  **Random practice**: pick up to 100 unanswered questions (respecting current filters) as a practice set
- **记忆练习（FSRS 间隔重复）**：基于记忆曲线的智能复习
  **Memory practice (FSRS spaced repetition)**: smart review based on memory curve
  - 选题 = 到期复习题（按紧迫度排序）+ 每日新题（数量可配置，按自然日累计，每题库独立配额）
    Practice set = due reviews (sorted by urgency) + daily new questions (configurable quota, per-day, per-bank)
  - 答对按 FSRS 拉长复习间隔，答错进入再学习并在当天重现
    Correct answers extend intervals via FSRS; mistakes trigger relearning and reappear the same day
  - 练习集中显著标明题目来源：🆕 新题 / 🔁 复习
    Question source is clearly labeled: 🆕 new / 🔁 review
  - **掌握参与评分**（可关闭）：掌握题答对按 Easy（少复习）、其余一律 Good；收藏不参与评分（避免难度虚高与间隔压缩）；答错一律 Again
    **Mastery-aware rating** (optional): mastered questions answered correctly count as Easy, others as Good; favorites do not affect rating (prevents artificial difficulty inflation and interval compression); wrong answers always count as Again
  - 练习模式下统计显示**本次会话**答题结果，不污染全局正确率
    Practice mode shows per-session stats, leaving global accuracy untouched
  - 题目页眉底部可折叠「记忆卡片」信息栏，查看每题 FSRS 状态（难度/稳定性/到期时间等）
    Collapsible "memory card" panel shows each question's FSRS state (difficulty/stability/due, etc.)
  - 首次启用时若已有答题记录但无记忆数据，会提示重置进度后再开始
    First enable with existing progress but no memory data prompts a reset before starting

### 筛选 / Filtering

- **标签筛选**：点击标签芯片切换，支持多标签交集
  **Tag filter**: clickable tag chips with multi-tag intersection matching
- **分类筛选**：三级分类联动下拉筛选
  **Category filter**: 3-level cascading dropdown filters
- **标记筛选**：收藏/掌握/重复/错题三态切换（不限 / 仅 / 否）
  **Boolean filters**: favorite/mastered/repeat/wrong — three states (any / yes / no)
- **未答题筛选**：仅显示未作答 / 仅显示已作答
  **Unanswered filter**: show only unanswered / only answered questions
- 筛选结果自动更新题目列表和进度；每个题库记住自己的筛选
  Question list and progress update automatically on filter change; filters are remembered per bank

### 编辑 / Editing

- 答题过程中可编辑当前题目的标签、分类和标记（收藏/掌握/重复/错题）
  Edit tags, categories, and flags of the current question during practice
- 修改自动保存到**状态文件**（不修改题库文件本身）
  Changes auto-save to the **state file** (the bank file itself is not modified)
- **导出修改到 CSV**（编辑者用）：把状态文件中的标签/分类/重复修改写回 CSV 并清除对应覆盖，随题库一起发布
  **Export changes to CSV** (for bank authors): write tag/category/repeat edits from the state file back into the CSV and clear the overrides, so they ship with the bank

### 编译产物（.cqv）/ Compiled Bank (.cqv)

- 设置页「**优化题库**」：把 CSV 编译为同目录 `.cqv` 二进制产物（校验题号质量，可附一句备注），随产物分发
  Settings page "**Optimize Bank**": compile the CSV into a `.cqv` binary artifact next to it (ID quality validated, optional note), for distribution
- 使用者把 `.cqv` 设为题库路径即可使用：产物只读、解析更快、不会被误改；产物更新后状态按题号自动对齐
  Consumers set the `.cqv` as the bank path: read-only, faster to load, safe from accidental edits; state stays aligned by question ID when the artifact is updated
- `.cqv` 与同名 CSV 的状态文件相互独立（同题库换格式 = 换状态）
  The `.cqv` and its CSV counterpart keep separate state files (switching format = separate state)

### 进度持久化 / Persistence

- 答题记录、正确率、当前进度自动保存到状态文件
  Answers, accuracy, and current position are automatically saved to the state file
- 关闭后重新打开，自动恢复到上次位置与上次题库
  Resumes from where you left off after reopening Obsidian
- **多题库切换**：切换题库路径时保留各自进度，切换前自动落盘；有进度的题库切换时弹轻量确认
  **Multi-bank switching**: each bank keeps its own progress, flushed before switching; a light confirmation appears when switching away from a bank with progress
- **分项重置进度**：重置时可选「仅清理刷题记录 / 仅删除记忆卡片 / 重置题目顺序 / 全部重置」，筛选条件保留；全部重置会清空状态标记并重读题库
  **Selective reset**: choose to clear answer records only, memory cards only, reset question order, or everything (filters preserved); a full reset also clears state flags and reloads the bank

---

## 设置项 / Settings

| 设置 / Setting | 说明 / Description |
|---|---|
| CSV 文件路径 / Bank Path | 题库路径（.csv 或编译产物 .cqv），下方展示对应状态文件路径 / Path to the bank (.csv or .cqv); the corresponding state file path is shown below |
| 随机题目顺序 / Random Order | 每次加载时随机排列题目 |
| 随机选项顺序 / Random Options | 每题选项顺序随机 |
| 答对自动跳转延迟 / Auto-Advance Delay | 答对后等待秒数，0 = 不自动（秒 / seconds） |
| 默认展开筛选栏 / Filter Panel Open | 打开面板时筛选栏默认展开 |
| 默认展开编辑栏 / Edit Panel Open | 打开面板时编辑栏默认展开 |
| 标记筛选默认值 / Default Filter Values | 各标记筛选的默认状态 |
| 左右滑动切题 / Swipe Navigation | 移动端面板内左右滑动切换题目（默认开启） |
| 记忆练习 / Memory Practice | 启用基于记忆曲线（FSRS）的练习 |
| 每日新题数 / Daily New Questions | 记忆练习每天引入的新题数量上限（默认 20，每题库独立配额） |
| 到期提醒 / Due Reminder | 状态栏显示今日待复习题数提醒 |
| 掌握参与评分 / Mastery-aware Rating | 掌握答对=Easy、其余=Good；收藏不参与评分（默认开启） |
| 优化题库 / Optimize Bank | 把 CSV 编译为 `.cqv` 产物（需面板已打开） |
| 导出修改到 CSV / Export Changes to CSV | 把状态文件中的标签/分类/重复修改写回 CSV（需面板已打开） |
| 重置刷题进度 / Reset Progress | 分项清理：仅刷题记录 / 仅记忆卡片 / 重置题目顺序 / 全部重置 |

---

## 安装 / Installation

1. Obsidian 设置 → 社区插件 → 浏览 → 搜索 "csv quiz practice"
   Obsidian Settings → Community plugins → Browse → Search "csv quiz practice"

2. 或手动安装：将 `main.js` + `manifest.json` + `styles.css` 复制到 vault 的 `.obsidian/plugins/csv-quiz-practice/`，然后重载 Obsidian
   Or install manually: copy `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/csv-quiz-practice/` and reload Obsidian

---
