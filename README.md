# csv quiz practice

**Obsidian 刷题插件 / CSV-based Quiz Plugin for Obsidian**

基于 CSV 文件 / 图片文件夹的 Obsidian 刷题插件。将题库写入 CSV，或把图片放进 vault 文件夹（文件名即答案），然后在 Obsidian 中刷题、标记、筛选、统计正确率；支持将 CSV 题库编译为 `.cqv` 产物分发给使用者。

A CSV/image-folder-based quiz practice plugin for Obsidian. Write your question bank in a CSV, or put images in a vault folder (filename = answer), then practice with filtering, tagging, and progress tracking; compile CSV banks into `.cqv` artifacts for distribution.

---

## 快速开始 / Quick Start

1. 准备题库来源：一个 `.csv` / `.cqv` 文件、一个图片文件夹，或含 `manifest.json` 的复合题库文件夹
   Prepare a source: a `.csv` / `.cqv` file, an image folder, or a composite bank folder containing `manifest.json`

2. 在设置页选择「来源类型」和对应路径
   Choose the source type and path in settings

3. 点击左侧 ribbon 的图书图标，或执行命令 `打开刷题面板`
   Click the book icon in the left ribbon, or run the command `打开刷题面板`

4. 开始刷题
   Start practicing

---

## CSV 格式 / CSV Format

CSV 文件必须为 **BOM 前缀的 UTF-8** 编码。普通选择题为 15 列；简答题在末尾增加可选第 16 列 `简答题方向`：

The CSV file must be **BOM-prefixed UTF-8**. Choice questions use 15 columns; short-answer questions may append an optional 16th column, `简答题方向`:

```
序号,题干,选项A,选项B,选项C,选项D,正确答案,标签,一级分类,二级分类,三级分类,收藏,掌握,重复,错题,简答题方向
```

| 列 / Column | 说明 / Description |
|---|---|
| 序号 / ID | 题目的唯一标识，必须非空且不重复（空或重复题号将拒绝加载）/ Unique non-empty ID (empty/duplicate IDs are rejected) |
| 题干 / Stem | 支持 Markdown 渲染 / Supports Markdown rendering |
| 选项A~D / Options A-D | 四个选项 / Four answer options |
| 正确答案 / Correct Answer | 选择题填 `A`、`B`、`C` 或 `D`；简答题填答案原文（支持完整 Obsidian Markdown/HTML，保留大小写与换行）/ Choice: `A`-`D`; short answer: the answer text (full Obsidian Markdown/HTML, case and line breaks preserved) |
| 标签 / Tags | 空格分隔，如 `#数学 #代数` / Space-separated, e.g. `#Math #Algebra` |
| 一级~三级分类 / Categories | 三级分类体系，用于筛选 / 3-level category hierarchy for filtering |
| 收藏/掌握/错题 / Favorite/Mastered/Wrong | 初始标记：`1` = 是 / yes, `0` = 否 / no。**运行中的变更保存在状态文件，不再写回 CSV** / Initial flags; runtime changes go to the sidecar state file, not the CSV |
| 重复 / Repeat | 作者标记的重复题（有发布价值）/ Author-marked duplicate questions (published with the bank) |

### 示例行 / Example Row

```
1,1+1=?,1,2,3,4,B,#数学 #加法,#数学,,,1,,,
```

### 简答题 / Short Answer

- 标签列必须含精确 token `#简答题`，且选项 A/B/C/D 全为空；第 7 列填答案原文。
  The tags column must contain the exact token `#简答题`, options A-D must be empty, and the 7th column holds the answer text.
- 15 列旧 CSV 也支持简答题：没有第 16 列时方向默认单向。普通选择题行的第 16 列必须为空；超过 16 列、或任何行 ID 含 `::`，会整库拒绝。
  15-column CSVs are supported too: without the 16th column, direction defaults to forward. The 16th column must be empty on choice rows; more than 16 columns, or any row ID containing `::`, rejects the whole bank.
- `简答题方向`：`>` 单向、`<` 仅反向、`<>` 双向、空值等同 `>`；其它值整库拒绝。
  Direction: `>` forward, `<` reverse-only, `<>` both, empty = `>`; other values reject the whole bank.
- `<` 只生成反向卡；`<>` 生成正向卡和反向卡（正向卡 id 为原题号，反向卡 id 为 `原题号::rev`，顺序正向紧跟反向）。反向卡的题干是原答案，答案是原题干。
  `<` produces only the reverse card; `<>` produces forward then reverse cards (reverse id = `id::rev`). The reverse card swaps stem and answer.
- 正向/反向卡共享标签、分类、收藏、掌握、重复、错题；已答状态与 FSRS 卡片各自独立，进度和每日新题配额各算一张。
  Forward/reverse cards share tags, categories and flags, but have independent answered state and FSRS cards; each counts separately in progress and daily new quota.
- 题干与答案按完整 Obsidian Markdown 渲染（`==高亮==`、HTML 表格、数学、代码、wikilink/嵌入等）；答案在点击「展示答案」前不会进入 DOM。
  Stem and answer use the full Obsidian Markdown renderer; the answer is not inserted into the DOM before “展示答案”.
- 展示答案即记为已答；记忆曲线开启时显示四级评分，关闭时只显示答案。简答题不计文字题对错统计，不进入随机考试，进度弹窗单独统计。
  Revealing marks it answered; four-level rating appears only when memory is enabled. Short answers are excluded from text correctness stats and random exams, and are counted separately in the progress modal.
- 编辑面板只编辑标签/分类；答案与方向请在源 CSV 中修改。`#简答题` 是保留标签：简答题不能删除，普通题不能添加。
  The edit panel only edits tags/categories; edit answers and direction in the source CSV. `#简答题` is reserved: short answers cannot remove it, choice questions cannot add it.

---

## 题库来源与 manifest / Source Types & Manifest

设置页显式选择来源类型：

- `csv`：CSV/CQV 文件；sidecar 为同名文件加 `.sidecar.json`，不扫描图片。
- `image`：图片文件夹；递归扫描 png/jpg/jpeg/webp/gif/bmp，根目录用 `/`。
- `manifest`：含 manifest.json 的复合题库文件夹，CSV/CQV 与图片由 manifest 绑定。

复合题库清单：

```json
{
  "type": "csvquiz-bank",
  "version": 1,
  "content": "题库.csv",
  "contents": ["补充题库.csv", "另一份.cqv"],
  "imageFolder": "图片题"
}
```

- `content` 是主内容文件，必填；`contents` 是额外内容文件数组，可选；加载顺序为 `content` 后接 `contents`。
  `content` is the required primary file; optional `contents` lists additional files, loaded after `content`.
- `content` / `contents` 支持 `.csv` / `.cqv`；`imageFolder` 可省略（省略表示无图片）。
  `content` / `contents` accept `.csv` / `.cqv`; `imageFolder` may be omitted for a text-only manifest.
- 路径均相对 manifest 所在目录；禁止 `..` 和绝对路径；content/contents 归一化后重复、文件缺失或扩展名非法 → 整库失败。
  Paths are relative to the manifest directory; `..`, absolute paths, duplicates, missing files or bad extensions fail the whole bank.
- `imageFolder` 存在时仍要求至少一张受支持图片；根目录用 `"."`。
  When present, `imageFolder` must contain at least one supported image; use `"."` for the vault root.
- `type` 不匹配 → 当作无关 manifest 忽略；JSON 损坏、版本不是 1、content 缺失 → 报错不加载。
  Type mismatch is ignored as an unrelated manifest; bad JSON, version other than 1, or missing content is a hard error.
- manifest 手工创建，程序不自动生成/覆盖；旧配置迁移生成的 manifest 仅含 `content` + `imageFolder`。
  Manifests are created manually; the legacy migration only writes `content` + `imageFolder`.

Choose an explicit source type in settings:

- `csv`: CSV/CQV file; sidecar is the file path + `.sidecar.json`; images are not scanned.
- `image`: image folder; recursive png/jpg/jpeg/webp/gif/bmp; `/` for vault root.
- `manifest`: a composite bank folder containing manifest.json; CSV/CQV and images are bound by the manifest.

---

## 状态文件（sidecar）/ State File

题库状态文件按来源类型命名：

- 复合题库（`manifest.json`）：`manifest.sidecar.json`（与 manifest 同目录）
- 单一文字题库：`<content>.sidecar.json`（例如 `题库.csv.sidecar.json`）
- 单一图片题库：`<图片文件夹>.sidecar.json`（与图片文件夹同级）

每个状态文件保存答题记录、统计、记忆卡片（FSRS）、筛选、收藏/掌握/错题、标签与分类的修改等。**切换题库时各题库状态相互独立、自动恢复，不会互相覆盖。**

- 首次使用复合题库时，会把 `content`、`contents`、`imageFolder` 各自旧 sidecar 的答题/FSRS/meta/累计统计合并到 `manifest.sidecar.json`；旧 sidecar 保留作回退。合并按 manifest 锚点只执行一次，重置进度后不会再次合并。
  On first use of a composite bank, progress from the sidecars of `content`, `contents`, and `imageFolder` is merged into `manifest.sidecar.json`; the old sidecars are kept for rollback. This runs once per manifest anchor and is not repeated after a reset.

State files are named by source type:

- Composite bank (`manifest.json`): `manifest.sidecar.json` next to the manifest
- Single text bank: `<content>.sidecar.json` (e.g. `题库.csv.sidecar.json`)
- Single image bank: `<image-folder>.sidecar.json` next to the image folder

Each state file holds answer records, statistics, FSRS cards, filters, favorite/mastered/wrong flags, and tag/category edits. **Switching banks restores each bank's own progress automatically — no overwriting.**

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

### 图片题 / Image Questions

- 来源类型选择 `image`（图片文件夹）或 `manifest`（复合题库）；复合题库通过 manifest.json 绑定图片文件夹。支持递归扫描子文件夹，格式为 png/jpg/jpeg/webp/gif/bmp；根图片库可用 `/`
  Choose source type `image` (image folder) or `manifest` (composite bank); a composite bank binds its image folder via manifest.json. Recursive subfolder scan; formats png/jpg/jpeg/webp/gif/bmp; `/` for a vault-root image bank
- **文件名（去扩展名）= 答案，图片本身 = 题干**；分类固定为 `识图/一级子文件夹/二级子文件夹`（不足或更深为 `其它`），标签固定为 `#图片题`
  **Filename without extension = answer; the image is the stem**. Categories are `识图/first-level subfolder/second-level subfolder` (missing/deeper = `其它`), tag is `#图片题`
- 未点击「展示答案」时只显示图片；点击后显示答案并记为已答。开启记忆练习时同时显示「重来/困难/良好/简单」四级评分，评分写入 FSRS 并自动下一题；关闭记忆练习时不显示评分
  Before clicking "Show answer" only the image is shown. Clicking reveals the answer and marks the question answered. With memory practice enabled, four rating buttons (Again/Hard/Good/Easy) update FSRS and auto-advance; with memory disabled the ratings are hidden
- 图片题不计入文字题对错统计；随机考试不包含图片题；普通随机顺序时与文字题混排，非随机时文字题在前、图片题按文件名排序
  Image questions are excluded from text-question accuracy; random exams exclude them. With random order they mix with text questions; without random order text questions come first, images sorted by filename
- 标签/分类只读；收藏/掌握/重复/错题仍可编辑；进度弹窗未评分显示「图片题 #序号」，评分后显示文件名。设置页「刷新图片题库」可重新扫描图片文件夹的新增/删除/替换，保留答题记录与 FSRS 卡片
  Tags/categories are read-only; favorite/mastered/repeat/wrong remain editable. The progress dialog shows "Image #N" before rating and the filename after rating. The settings page provides "Refresh image bank" to rescan added/removed/replaced images while keeping answers and FSRS cards

### 练习模式 / Practice Modes

- **随机考试**：按当前筛选条件从**全部普通选择题**（不限未答，**不含图片题、简答题**）随机抽取作为考试集，题数可在设置中修改（默认 100，不足自适应）；答题过程中**不显示对错与正确答案**，全部答完后弹出评分（每题 1 分），关闭评分后可继续在题目列表/题目间复盘错题，退出考试模式前不会自动离开
  **Random exam**: pick a configurable number of **text** questions (default 100, respecting current filters, answered or not; image questions excluded) as an exam set. Correctness and answers stay hidden during the exam; after all questions are answered a score dialog appears (1 point per question). Closing it keeps the exam session open for review until you exit
- **按当前筛选练习**：把当前筛选结果中的**全部题目**（含图片题、简答题）随机打乱后作为一个练习集，不限制题数，答题过程与普通刷题一致（即时反馈对错；图片题/简答题展示答案后可评分）
  **Practice current filter**: shuffle all questions matching the current filters (including image questions) into one session (no question-count cap), with instant answer feedback like normal practice; image questions can be rated after revealing the answer
- **记忆练习（FSRS 间隔重复）**：基于记忆曲线的智能复习
  **Memory practice (FSRS spaced repetition)**: smart review based on memory curve
  - 选题 = 到期复习题（按紧迫度排序）+ 每日新题（数量可配置，按自然日累计，每题库独立配额）；到期/新题池忽略「未答/已答」筛选（其它筛选仍生效），避免答过的到期卡片被永久排除。图片题、简答题同样参与到期/新题选择，展示答案后选择四级评分写入 FSRS；`<>` 的正向/反向卡各占一张
    Practice set = due reviews (sorted by urgency) + daily new questions (configurable quota, per-day, per-bank). The due/new pool ignores the answered/unanswered filter (other filters still apply), so reviewed cards cannot be silently excluded forever. Image questions participate in due/new selection too; after revealing the answer, the chosen four-level rating updates FSRS
  - 答对按 FSRS 拉长复习间隔，答错进入再学习并在当天重现
    Correct answers extend intervals via FSRS; mistakes trigger relearning and reappear the same day
  - 练习集中显著标明题目来源：🆕 新题 / 🔁 复习 / ⚡ 提前复习
    Question source is clearly labeled: 🆕 new / 🔁 review / ⚡ early review
  - **提前复习**：入口无可刷题或本轮答完（剩余为 0）而今日还有**预计到期**（尚未到期）的题时，弹窗询问是否提前开始；确认后把全部预计今日内到期的题纳入练习集（每轮最多询问一次）
    **Early review**: when nothing is left to brush (or a round is finished) while questions are forecast to come due later today, a dialog asks whether to start early; confirming adds all of them to the session (asked at most once per round)
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
- 简答题只开放标签/分类编辑；答案与 `简答题方向` 请在源 CSV 中修改。`#简答题` 是保留标签：简答题不能删除，普通题不能添加
  Short answers only allow tag/category edits; edit the answer and direction in the source CSV. `#简答题` is reserved: short answers cannot remove it, choice questions cannot add it
- `<>` 的正向/反向卡共享标签、分类与标记；修改任一卡会同步到同一 CSV 行
  Forward/reverse cards share tags, categories and flags; editing either card updates the same CSV row
- 修改自动保存到**状态文件**（不修改题库文件本身）
  Changes auto-save to the **state file** (the bank file itself is not modified)
- **导出修改到 CSV**（编辑者用）：把状态文件中的标签/分类/重复修改写回题目所属 CSV 并清除对应覆盖；多 CSV manifest 会逐文件写回，`.cqv` 源跳过
  **Export changes to CSV** (for bank authors): write tag/category/repeat edits back to each question's source CSV and clear the overrides; multi-CSV manifests are written per file, `.cqv` sources are skipped

### 编译产物（.cqv）/ Compiled Bank (.cqv)

- 设置页「**优化题库**」：把 CSV 编译为同目录 `.cqv` 二进制产物（校验题号质量，可附一句备注），随产物分发
  Settings page "**Optimize Bank**": compile the CSV into a `.cqv` binary artifact next to it (ID quality validated, optional note), for distribution
- CQV v1 仍可读取；含简答题/方向或多 CSV 源时写 v2（14 字段 + 有序源文件列表），多 CSV 会按顺序合并为一个产物
  CQV v1 remains readable; short answers/directions or multiple CSV sources are written as v2 (14 fields + ordered source files); multiple CSVs are merged in order into one artifact
- 编译要求全部源为 CSV；manifest 的 content/contents 中混有 `.cqv` 时拒编。使用者把 `.cqv` 设为来源即可使用：产物只读、解析更快、不会被误改；产物更新后状态按题号自动对齐
  Compilation requires all sources to be CSV; a manifest mixing `.cqv` sources is rejected. Consumers can set the `.cqv` as the source: read-only, faster, safe from accidental edits; state stays aligned by question ID
- `.cqv` 与同名 CSV 的状态文件相互独立（同题库换格式 = 换状态）
  The `.cqv` and its CSV counterpart keep separate state files (switching format = separate state)
- **安全提示**：题干和简答答案按 Markdown 渲染（可含内嵌 HTML），请只打开来自**可信来源**的题库（CSV 或 `.cqv`）
  **Security note**: stems and short-answer answers are rendered as Markdown (embedded HTML included) — only open banks (CSV or `.cqv`) from **trusted sources**

### 进度持久化 / Persistence

- 答题记录、正确率、当前进度自动保存到状态文件
  Answers, accuracy, and current position are automatically saved to the state file
- 关闭后重新打开，自动恢复到上次位置与上次题库
  Resumes from where you left off after reopening Obsidian
- **多题库切换**：切换题库路径时保留各自进度，切换前自动落盘；有进度的题库切换时弹轻量确认
  **Multi-bank switching**: each bank keeps its own progress, flushed before switching; a light confirmation appears when switching away from a bank with progress
- **分项重置进度**：重置时可选「仅清理刷题记录 / 仅删除记忆卡片 / 重置题目顺序 / 全部重置」，筛选条件保留；全部重置会清空状态标记并重读题库。「仅清理刷题记录」保留记忆卡片，到期统计与记忆练习不受「未答/已答」筛选影响
  **Selective reset**: choose to clear answer records only, memory cards only, reset question order, or everything (filters preserved); a full reset also clears state flags and reloads the bank. "Clear records only" keeps memory cards; due stats and memory practice ignore the answered/unanswered filter

---

## 设置项 / Settings

| 设置 / Setting | 说明 / Description |
|---|---|
| 来源类型 / Source Type | csv（CSV/CQV 文件）/ image（图片文件夹）/ manifest（含 manifest.json 的复合题库）/ CSV/CQV file, image folder, or composite manifest folder |
| 来源路径 / Source Path | 文件路径或文件夹路径；根部图片/复合题库可用 / / File or folder path; / = vault root |
| 刷新题库 / Refresh Bank | 重新解析当前来源（manifest/CSV/图片的新增、删除或替换），保留答题与 FSRS 状态 / Re-resolve the current source while keeping answers and FSRS state |
| 随机题目顺序 / Random Order | 每次加载时随机排列题目 |
| 随机选项顺序 / Random Options | 每题选项顺序随机 |
| 随机考试题数 / Random Exam Count | 随机考试从当前筛选范围抽取的题数（默认 100，不足时取全部） |
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
