# 题库数据模型重构方案（sidecar 架构）

> 状态：已定稿（2026-08-12）· 经 grill-with-docs 访谈完善（24 项决策已确认）· 待实施
> 涉及：多题库隔离、编译产物分发、状态与内容分离
> 版本策略：manifest 跳 **3.0.0**（破坏性大改，含迁移标记与 .bak 回滚）

## 1. 背景与目标

**现状问题**：
- CSV 是唯一事实源，且被运行时写回（favorite/mastered/repeat/wrong 列 + 标签/分类编辑），题库文件与使用者状态耦合
- `data.json` 的 `quizState` 为**单份**（一个 csvPath + 一套进度），多题库切换必须重置或互相污染（"覆盖"问题的根源）
- 分发场景无解：使用者拿到的是可写 CSV，无契约、可误改、无版本

**目标**：
1. 题库内容（有发布价值）与使用者状态（纯状态）彻底分离
2. 多题库切换零覆盖（天然隔离）
3. 编译产物作为分发格式（契约 + 防误改 + 更快的解析）
4. 状态跟随使用者（sidecar），题库更新不丢状态

## 2. 性能基线（实测，papaparse，16 列/题）

| 题库 | 体积 | CSV parse | CSV 改行+unparse |
|---|---|---|---|
| 1000 题 | 99KB | 3.2ms | 4.5ms |
| 5000 题 | 506KB | 7.4ms | 15ms |
| 20000 题 | 2MB | 25ms | 55ms |

结论：读路径毫秒级无感知；编译产物收益在**分发契约**而非速度；写路径收益靠 sidecar 差量小文件（JSON 全量重写 <5ms）。

## 3. 数据三分类模型（核心）

| 类别 | 字段 | 归属 | 发布价值 | 存储 | 可写性 |
|---|---|---|---|---|---|
| **A. 题目内容** | id、stem、optionA-D、answer | 题库作者 | ✅ 核心 | 内容源（CSV 列 / 产物） | 只读 |
| **B. 有发布价值的扩展** | repeat、tags、category1-3 | 作者（默认值）+ 使用者（覆盖） | ✅ | 内容源默认值 + sidecar 覆盖层 | 可改，改后进 sidecar |
| **C. 纯使用者状态** | favorite、mastered、wrong | 刷题者 | ❌ | **仅 sidecar** | 可改，进 sidecar |
| **C'. 使用痕迹** | answeredQuestions、correct/wrongCount、memoryCards(FSRS)、memoryNewDate/CountToday/PendingNew、memoryInitialized、displayOrder、currentIndex、filter* | 刷题者 | ❌ | **仅 sidecar** | 运行时自动写 |

**要点**：
- C/C' 不再进入任何"题库文件"（CSV 列或产物）
- B 为双层模型：读取 `sidecar 值 ?? 内容源默认值`；使用者修改只写 sidecar，内容源保持只读；**永久遮蔽**（含空串遮蔽），仅在"全部重置"时恢复默认
- A 永不可写：产物模式无编辑入口；CSV 模式维持现状（列来自 CSV）
- **每日配额**（memoryNewDate/CountToday/PendingNew）进 sidecar：每个题库每天各 `memoryDailyNew` 道新题，配额独立（每题库独立配额，跨题库不共享）

## 4. 文件布局

```
题库.csv / 题库.cqv              ← 内容源（A 全部 + B 默认值）
题库.csv.sidecar.json            ← CSV 模式专属状态
题库.cqv.sidecar.json            ← 产物模式专属状态（两种格式独立状态）
data.json
├── settings                     ← 全局设置（含 randomOrder、memoryDailyNew，全局）
└── lastQuizPath                 ← "上次打开哪个题库"指针
```

**关联机制（关键决策）**：sidecar ↔ 内容源靠**同目录同名文件**物理约定（扩展名全名拼接），移动/改名成对进行时天然跟随，**无路径校验**（不设 quizId 字段）。CSV 与 .cqv 两种格式的 sidecar **各自独立状态**——同题库换格式 = 换状态（可接受，不做格式间迁移）。

**sidecar 缺失**：提示"状态文件缺失，是否重建"（不静默重建空状态）。

## 5. sidecar schema（v1）

```jsonc
{
  "version": 1,
  "meta": {                                 // B 覆盖层 + C 合并存储（同层）
    "Q12": { "repeat": "1", "tags": "#自建", "category1": "我的分类",
             "favorite": "1", "mastered": "", "wrong": "" }
  },
  "state": {                                // C'（原 quizState 主体）
    "answeredQuestions": { "Q12": "A" },
    "correctCount": 0, "wrongCount": 0,
    "displayOrder": [], "currentIndex": 0,
    "memoryCards": { /* FSRS 卡片 */ },
    "memoryNewDate": "", "memoryNewCountToday": 0,
    "memoryPendingNew": [], "memoryInitialized": true,
    "filterText": "", "filterTags": "",
    "filterCat1": "", "filterCat2": "", "filterCat3": "",
    "filterFavorite": "", "filterMastered": "",
    "filterRepeat": "", "filterWrong": "", "filterUnanswered": ""
  }
}
```

注：B 覆盖与 C 同层存储（`meta`），字段分类是语义约定，实现统一；产物模式 B/C 同为本地状态，导出合并仅 CSV 模式存在。

## 6. 编译产物格式：简化二进制（.cqv）

**编码设计（v1，已确认）**：

```
[魔数 "CQV1" 4B]
[uint32 头部长度]                  // 未来版本可跳过未知头部扩展（向后兼容）
[uint32 formatVersion = 1]
[uint32 questionCount]
[uint32 generatedAt]               // unix 秒
[uint32 sourceCsvLen][sourceCsv UTF-8]
[uint32 noteLen][note UTF-8]       // 编译时向用户请求的一句备注，随产物分发
逐题（共 questionCount 题，每题目固定 12 个字符串字段）：
  id | stem | optionA | optionB | optionC | optionD | answer
  | tags | category1 | category2 | category3 | repeat
每字段：[uint32 字节长度 L][UTF-8 字节 ×L]
```

**解析防御（已确认）**：
- 文件长度不足头部 → 拒
- `questionCount` 与文件实际长度不符（超大/截断）→ 拒（防内存暴涨）
- 字段长度越过文件末尾 → 拒
- 魔数不匹配 → "不是有效的题库产物"
- 解码后空 id → 拒（质量门槛与 CSV 一致）
- 不引入内容 hash/CRC（保持极简）

**实现文件**：`src/cqvHandler.ts`（编解码纯函数；写队列复用 CSVWriteQueue 模式）。

**"优化题库"按钮流程**（设置页，编辑者工具）：
1. 读当前 CSV → 校验：解析防御（Papa errors）+ 空/重复 id 检查，任一失败**拒编**
2. 向用户请求一句备注文本（写入产物头部）
3. 编码生成 `题库.cqv`（同目录）
4. 产物与 CSV 的 sidecar 完全隔离（不读写 CSV sidecar）

## 7. 两种模式行为对照

| 操作 | CSV 模式（编辑者） | 编译产物模式（使用者） |
|---|---|---|
| 读题目 | CSV parse（现状，含空/重复 id 拒载） | .cqv 二进制解码 |
| wrong 标记（答错/答对清除） | sidecar（不再写 CSV 列） | sidecar |
| favorite / mastered | sidecar（不再写 CSV 列） | sidecar |
| repeat / tags / 分类 修改 | sidecar 覆盖（不再写 CSV 列） | sidecar 覆盖 |
| 标签/分类编辑 UI | 保留，读写 sidecar | 保留，读写 sidecar（不屏蔽） |
| FSRS / 顺序 / 统计 / 筛选 | sidecar | sidecar |
| 切题库 | 换 sidecar，零覆盖 | 换 sidecar，零覆盖 |
| 题库更新 | 编辑 CSV → 重新"优化" | 替换 .cqv，sidecar 状态保留（按 id 对齐） |
| 导出合并 | **导出合并时修订 CSV 本身**（B 类覆盖下沉） | 无导出（不做修改清单、不做 CSV 导出） |

**关键行为变更（CSV 模式）**：迁移后 favorite/mastered/wrong/repeat/tags/分类**不再随答题自动写回 CSV**，仅通过"导出合并"按钮显式写回并修订 CSV 文件。

**导出合并（已确认）**：
- 仅导出 sidecar **有记录的题**，B 类字段（repeat/tags/分类）覆盖写入 CSV 列
- 导出后对应 sidecar 覆盖清除（回到无覆盖态，合并即同步）
- C 类（favorite/mastered/wrong）**永不导出**（无发布价值，只存 sidecar）

## 8. 多题库切换（核心收益）

```
切换 = 设置路径（现有文件选择器，来源类型 = 路径扩展名，无新设置项）
     → 有 sidecar 状态时弹轻量确认（信息性确认，防误切）
     → flush 当前 sidecar（切换即落盘）→ 读新内容源 + 读新 sidecar
```

- **切换即落盘**：切出前 `unloadSidecar`（取消挂起防抖 + 立即写当前 sidecar），再载入新题库；接受单次同步写盘延迟
- 新路径有 sidecar → 恢复该题库进度；无 sidecar → 初始化（默认值 + defaultFilter*）
- 切换后立即 `refreshMemoryReminder()`（状态栏更新为新题库的待复习数）
- 移除"路径变更 → 强制重置"逻辑；保留"sidecar 不存在时初始化"路径
- 无状态 sidecar（新题库首次使用）→ 直接切，不弹确认
- 不显示当前题库标识（维持现状）

## 9. 重置体系（同步改造）

| 操作 | sidecar 化后 |
|---|---|
| records | 清 sidecar.state.answeredQuestions / 统计 |
| cards | 清 sidecar.state.memoryCards / 配额字段，保留 memoryInitialized |
| order | 清 sidecar.state.displayOrder；randomOrder 全局设置不变，auto-off 逻辑保留 |
| all | 清空 sidecar（保留文件，避免重建）+ 重读内容源（CSV 模式）；B/C 覆盖与状态全清（恢复内容源默认值） |

- 新增"放弃 sidecar 重建"路径（sidecar 损坏/迁移失败时等同全新使用者）
- `resetQuizProgress` 无视图分支（main.ts）与 `applyResetChoice`（quizView）全部改写为 sidecar 操作
- 产物模式下"全部重置" = 清 sidecar，无重读复杂流程

## 10. 外部修改检测（分化为两类）

| 检测 | 对象 | 行为 |
|---|---|---|
| sidecar 外部修改 | 内存 vs sidecar 文件（复用 quizStateEquals） | **复用现有"使用当前 / 使用外部"弹窗**，仅存储对象从 data.json 换为 sidecar |
| 内容源被替换 | 加载时 mtime 快照 vs 当前 mtime（quizId 用路径，零成本） | 提示"题库已更新"→ 按 id 对齐 sidecar（新 id 保留状态、删除 id 清理、悬空清理） |

两类提示文案区分。mtime 检测为粗粒度（无法区分"改了答案"vs"只是保存过"），接受此局限；两模式（编辑者/使用者）统一提示，不做区分。

## 11. StateManager 重构

- 职责变为"当前题库的 sidecar 管理器"：`getState()`/`clearState()`/`saveStateImmediately()` → 操作当前 sidecar
- 新增 `loadSidecar(path)` / `unloadSidecar()`（切换 API，unload 携带 **flush 语义**：取消挂起防抖 + 立即写盘）
- main.ts 无视图分支（resetQuizProgress / reorderQuestions / updateMemoryReminder 状态栏）全部跟随
- 心跳脏检查（lastSavedState 快照对比）对比对象 → sidecar，逻辑复用；心跳 5 秒 + 切换即落盘组合自洽（脏检查挡无变化写入）
- 写队列：sidecar 独立串行队列（复用 CSVWriteQueue 模式）

## 12. 写入与备份机制

**原子写入（已确认）**：写 `题库.sidecar.json.tmp` → 成功后 `vault.adapter.rename` 覆盖（tmp + rename 原子化），避免写一半损坏。

**备份机制（已确认）**：
- 随心跳计时的"活跃 30 分钟"触发（面板打开才计时）
- 覆盖式单份 `题库.sidecar.json.bak`（每题库保留一个）
- **仅读损坏时**自动从 bak 恢复 + 提示"状态文件损坏，已从备份恢复"
- 写失败维持现状（保留内存 + 提示保存失败，不覆盖内存）
- **级联损坏**（sidecar 与 bak 均损坏）→ 显式提示"状态与备份均损坏，是否重建新状态"（不静默重建）

## 13. 迁移与回滚

**升级迁移（每次启动检查）**：
1. 每次启动检测 `data.json.quizState` 非空（空则跳过）
2. 校验源 CSV 干净（空/重复 id）——**脏则拒绝迁移** + 提示用户修好后再迁移（不迁错位状态）
3. 干净 → 把 quizState 整体写入该文件的 sidecar；**原 data.json 备份为 `data.json.bak`（保留，回滚时手工导回）**
4. data.json 清空为 settings + lastQuizPath 指针
5. 迁移完成后标记，避免重复迁移

**回滚策略**：旧版插件不读 sidecar——回滚需**手工从 data.json.bak 导回**（把 bak 覆盖回 data.json）。README/迁移提示中说明。

**僵尸清理**：保留 pruneMemoryCards；新增 sidecar 对内容源的对齐清理（替换产物后删除已不存在 id 的 meta 条目）。

## 14. 质量门槛（id 策略）

- **CSV 模式**：打开时检查，存在空 id 或重复 id → **拒绝加载**（showError 提示用户修改 CSV），不清除已有 sidecar 状态
- **编译按钮**：对源 CSV 应用同一质量门槛，失败拒编
- **产物模式**：天然免疫（编译时已保证 id 干净）
- **不自动补 id**：反转 v1.4.3 的 `__auto_N` 自动生成逻辑（改为拒绝）
- `checkDuplicateIds`（现仅 Notice）升级为拒绝加载，保留对已有 sidecar 的保护
- **语义**：id 由用户维护，改 id = 新题 = 状态清空

## 15. 版本与兼容（决策记录）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | id 策略 | 不自动生成；空/重复 id 拒绝加载/拒编（质量门槛前移） |
| 2 | B 类覆盖语义 | 永久遮蔽（含空串遮蔽）；仅"全部重置"恢复默认；无单题恢复按钮 |
| 3 | 导出合并 | 仅导出有记录的题，B 类覆盖下沉 CSV 列；导出后清除覆盖（同步动作）；C 类永不导出 |
| 4 | 内容源变更检测 | 两模式统一 mtime 提示（不区分编辑者/使用者）；quizId=路径，零成本 |
| 5 | 切换竞态 | 切换即落盘（unloadSidecar flush 语义） |
| 6 | 文件关联 | 同目录同名物理约定；无路径校验；CSV/.cqv 独立状态；缺失提示重建 |
| 7 | 写入频率 | 心跳 5s + 切换落盘自洽，脏检查挡无变化写入 |
| 8 | 备份机制 | 活跃 30min 覆盖式单份 .bak；仅读损坏自动恢复；tmp+rename 原子写 |
| 9 | 迁移触发 | 每次启动检查；源 CSV 脏则拒绝迁移 |
| 10 | 多窗口 | 接受现状（文档声明不支持跨窗口并发） |
| 11 | 状态栏 | 切换题库时立即 refreshMemoryReminder() |
| 12 | 练习会话 | 切换题库自动退出练习；memoryInitialized 进 sidecar state（其余会话级） |
| 13 | 产物模式导出 | 不做修改清单、不做 CSV 导出（无导出/反馈通道） |
| 14 | 产物模式 B/C | 同层 meta（零额外复杂度） |
| 15 | 编译按钮 | 校验 + sourceCsv + generatedAt + 备注文本（编译时询问） |
| 16 | quizId 字段 | 删除（关联靠文件名约定） |
| 17 | 切换 UI | 维持现状文件选择器；有 sidecar 状态才弹确认；无状态直接切；不显示题库标识 |
| 18 | 二进制编码 | 头部长度字段支持向后兼容；四重解析防御；无内容 hash |
| 19 | 来源类型 | 路径扩展名即模式，无新设置项 |
| 20 | 空题库 | 保持现状（解析 0 题 → 不触碰 sidecar + showError） |
| 21 | 每日配额 | 进 sidecar（每题库独立配额，跨题库不共享） |
| 22 | 外部修改弹窗 | 复用现有逻辑，仅存储对象换为 sidecar |
| 23 | 版本 | manifest 跳 3.0.0 |
| 24 | 级联损坏 | sidecar 与 bak 全损坏 → 显式提示重建 |

## 16. 实现阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 1 | `IQuestionStore` 抽象 + sidecar 读写模块（含 tmp+rename 原子写）+ 写队列 | 无 |
| 2 | StateManager 重构（当前 sidecar 语义）+ 切换 flush API + 重置体系改造 | 1 |
| 3 | 外部修改检测分化（sidecar/内容源）+ 路径切换轻量确认 + 状态栏刷新 | 2 |
| 4 | 迁移逻辑（每次检查 + 脏拒迁 + .bak 备份）+ 备份机制（30min .bak + 恢复） | 2 |
| 5 | 质量门槛（空/重复 id 拒载）+ 反转 __auto_N 生成 | 4 |
| 6 | .cqv 产物模式接入（cqvHandler 编解码 + 解析防御）+ 覆盖合并 + 僵尸对齐清理 | 1-5 |
| 7 | "优化题库"按钮（校验 + 备注询问）+ 导出合并（B 类下沉修订 CSV）+ 设置页 UI | 6 |

## 17. 风险清单

1. id 稳定性是 sidecar 关联核心依赖（id 由用户维护，改 id = 状态清空；质量门槛保证源头干净）
2. CSV 模式状态列不再自动写回——编辑者需接受"导出合并"工作流
3. 多 sidecar 小文件 → Obsidian Sync 冲突面从 1 个 data.json 变 N 个独立小文件（净收益，需验证）
4. 二进制格式无人类可读性——靠四重解析防御 + 魔数校验 + 文档保证安全
5. 迁移一次性且可回退（.bak），但回滚为手工操作
6. 多窗口多实例不受支持（现状声明）

## 术语表

| 术语 | 定义 |
|---|---|
| 内容源 | 题库的只读内容载体：CSV 文件或编译产物 .cqv |
| sidecar | 与内容源同目录同名的状态文件（`*.csv.sidecar.json` / `*.cqv.sidecar.json`），存该题库全部使用者状态 |
| 编译产物 (.cqv) | 编辑者通过"优化题库"从 CSV 生成的二进制分发格式，含 A+B 数据与头部元信息 |
| A 类 / B 类 / C 类 / C' 类 | 数据分类：题目内容 / 可发布扩展（可覆盖）/ 纯状态 / 使用痕迹 |
| 覆盖层 (meta) | sidecar 中 B/C 类字段，读取时遮蔽内容源默认值 |
| 导出合并 | CSV 模式编辑者操作：B 类覆盖下沉写回 CSV 列后清除覆盖 |
| 质量门槛 | 空/重复 id 拒绝加载或拒编的校验 |
| 切换即落盘 | 切换题库前 flush 当前 sidecar 的写入语义 |
| quizId | 已废弃概念（原计划的内容源标识字段，删除，关联靠文件名约定） |
