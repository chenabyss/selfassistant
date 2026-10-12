# 开发阶段拆分与验收条件

> 规格 §11 步骤 3 要求"分垂直切片开发"，§11 步骤 4 给出每个切片的完成定义。
>
> 本文把规格建议的顺序细化为 **10 个可独立测试的阶段**，每个阶段给出：
> 交付物、测试清单、验收条件、退出标准（Definition of Done）。
>
> **硬性纪律**：任何阶段**不得**用"只有界面"或"临时内存数据"的实现通过验收。
> 每个阶段结束时，下列三项必须同时为真：
> 1. 数据真实落到 SQLite 并通过唯一写入路径（`architecture.md` §5.1）；
> 2. 该阶段的测试全部通过，且**在目标平台实际运行过**；
> 3. `known-limitations.md` 与相关文档已更新。

---

## 阶段总览

| 阶段 | 名称 | 依赖 | 主要风险 | 平台验证要求 |
| --- | --- | --- | --- | --- |
| P0 | 工具链与技术验证 | — | **当前阻塞** | Windows + Android 各一次 |
| P1 | 应用骨架、数据库、迁移、错误处理 | P0 | 迁移与写入路径 | 两端启动 |
| P2 | 快速记录与收集箱 | P1 | **数据丢失（最高）** | 两端 |
| P3 | 长期任务与临时事项/提醒 | P2 | 状态语义、通知权限 | 两端（通知真机） |
| P4 | 项目、标签与关系 | P3 | 删除不级联、集合语义 | 两端 |
| P5 | 日记、工作日志、结论 | P4 | 文本冲突 | 两端 |
| P6 | 时间记录与统计 | P5 | 区间合法、计时持久化、重叠统计 | 两端（含杀进程） |
| P7 | 搜索、今日视图、每日回顾 | P6 | 中文搜索方案、回顾不自动完成 | 两端 |
| P8 | 备份、恢复与导出 | P7 | **实际恢复测试（硬性）** | 两端（真实恢复） |
| P9 | 同步与冲突处理 | P8 | 幂等、收敛、墓碑 | 双实例跨设备 |
| P10 | 打包、发布验证与交付 | P9 | 构建可复现、限制清单 | 两端安装包 |

> **顺序上的一个重要说明**：规格建议"同步"放在"备份恢复"之后（第 9 位），
> 本拆分保留该顺序，理由是：同步的正确性依赖备份提供的"可回退"保障；
> 若先做同步，一旦协议有缺陷污染了数据，没有恢复手段。
> 这与 `risks.md` 的风险排序一致。

---

## P0 工具链与技术验证

**目标**：把 `dart-verification.md` §7 的验证计划真正执行，
使后续阶段的每次构建都有确定的平台基线。

### 交付物
- 安装并验证 Flutter（≥3.38.1，建议 3.47）、MSVC C++ 工具链、Android SDK + JDK。
- `docs/dart-verification.md` §7 的 [未验证] 标记全部被实测结果替换。
- 一个最小 spike 应用（`app/spikes/platform_probe`），只做平台能力探测。

### 测试与验收

| 验证 | 判据 |
| --- | --- |
| V1 环境 | `flutter doctor -v` 的 Windows / Visual Studio / Android 三节**全绿**；记录 Flutter 与 Dart 版本 |
| V2 数据库 | 两端 `SELECT sqlite_version()` **≥ 3.53.4**；`journal_mode=wal`；`foreign_keys=1`；FTS5 可建表；中英文检索行为按 Q5 方案符合预期 |
| V2b 依赖链 | `flutter pub deps` 中**不出现** `sqlite3_flutter_libs` / `sqlcipher_flutter_libs` |
| V2c 16KB 对齐 | APK 中 `libsqlite3.so` 未压缩且 64 位 ABI 页对齐 ≥16 KB |
| V3 通知 | 两端各完成一次"安排 → 到点 → 观察"；拒绝权限后 UI 显示"未生效"；Windows 记录 `cancel()` 是否有效；结论写入 `known-limitations.md` |
| V4 后台 | 确认 Windows 无关闭后自动执行；Android 记录 force-stop 与重启后的行为 |
| V5 附件 | 导入即复制到 `blobs/<sha256>`；删除原文件后仍可打开；重复导入只占一份 |
| V6 并发写 | 单实例生效；读池 + 写 isolate 连续 1000 次混合读写无 `database is locked` |
| V8 同步 spike | 用 Dart 复刻原型测试 1/2/13（幂等、游标）通过 |

### 退出标准
- 全部验证项有**实测记录**（命令 + 输出摘要），无 [未验证] 残留。
- Q5（中文搜索）与 Q6（Windows 打包）已有结论，可进入 P1。
- 若某项验证结论与本设计冲突 → **停止并回到设计**（不得绕过）。

---

## P1 应用骨架、数据库、迁移、错误处理

**目标**：建立"所有后续功能都必须遵守"的地基。

### 交付物
- `packages/domain`：`EntityId`、`Hlc`、`VersionVector`、`TimeRange`、`TzInstant`、状态机、端口接口。
- `packages/application`：用例基类、事务边界、`WriteQueue`、撤销机制骨架。
- `packages/infrastructure/db`：完整 schema（`data-model.md` §2–§3 全部表）、
  `NativeDatabase.createInBackground` + 关键 PRAGMA、**手写迁移框架**、
  **唯一写入路径**（`op` + 物化 + `field_register` + `sync_outbox` + `audit_log`）。
- `packages/infrastructure`：`Clock`、`Logger`（脱敏）。
- `apps/life_app`：应用外壳、导航、空状态、加载/错误/同步状态提示组件。
- `tools/check_layering.dart`：架构依赖方向检查。
- `docs/`：本阶段文档更新 + `known-limitations.md` 初始化。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-ARCH-LAYERING | `domain`/`application` 不 import flutter / drift / dart:io（AST 扫描通过） |
| T-DB-STRICT | 所有业务表为 `STRICT`（`PRAGMA table_list` 断言） |
| T-DB-FK-ON | 每个新连接 `foreign_keys=1` |
| T-DB-WAL | `journal_mode=wal`；并发读写无锁错误 |
| T-DB-CONSTRAINTS | 每个 CHECK/UNIQUE 都有"违反即抛错"测试 |
| T-DB-FIELD-SCHEMA | `field_schema` 内容与 `data-model.md` §5 表格**逐项一致**；未声明字段写入抛错 |
| T-DB-REPLAY | **核心不变量**：随机 op 序列 → 物化状态 == 重放状态 |
| T-MIG-1-FORWARD | 用 v1 fixture 打开并升级到当前版本成功 |
| T-MIG-ROLLBACK | 迁移中途注入失败 → 自动回滚，库为旧版本且数据完好 |
| T-MIG-TOO-NEW | `user_version` 大于代码版本 → 拒绝打开且**不写入** |
| T-MIG-PRESNAPSHOT | 迁移前快照存在且通过 `quick_check` |
| T-PRIV-NO-CONTENT | 写入含敏感正文的数据 → 扫描日志文件不含正文片段 |
| 启动验证 | Windows 与 Android 均能启动、创建数据库、显示空状态说明 |

### 退出标准
- `T-DB-REPLAY` 通过（这是后续所有功能正确性的基础）。
- 迁移框架能对一个"空库 → v1 → v2"的假迁移做完整的正向与回滚测试。
- 两端能启动并显示"如何开始"的空状态（不是空白页）。

---

## P2 快速记录与收集箱

**目标**：实现"低记录成本"这一核心承诺。**这是数据丢失风险最高的阶段。**

### 交付物
- `InboxItem` 完整实现（状态机、`deferred`、`processed`、`archived`、`deleted`）。
- 快速记录入口：全局快捷键（Windows）、触屏友好输入（Android）、任意主页面可达。
- 收集箱列表与详情。
- **草稿兜底**：写入失败或进程被杀后输入内容可恢复。
- 转换用例骨架（转任务/提醒/日志/日记/时间记录/关联/归档/删除/稍后）——本阶段只做
  "归档/删除/稍后处理"三个不需要目标对象的动作，其余在 P3–P6 落地。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-UNIT-INBOX-STATE | 五状态语义独立；跨日不自动变更；`processed` 仍可检索 |
| T-INT-RESTART-PERSIST | 提交后关闭并重开 → 记录仍在，内容全等 |
| T-PROP-CRASH-MID-WRITE | 在写入事务各点杀进程 → 要么全生效要么全不生效；输入不丢 |
| 写失败注入 | 注入数据库写失败 → 输入保留在输入框 + 明确错误态 + 可重试；**不显示成功** |
| 离线验证 | 断网提交 → 成功（"已保存到本机"），待同步计数 +1 |
| L4 旅程 C（部分） | 创建多条 → 处理一部分 → 推迟一部分 → 重开 → 未处理仍在 |
| 性能 | 连续提交 100 条，输入到显示"已保存"的延迟 < 100 ms（不含同步） |
| 两端 UI | Windows 可纯键盘完成"新建 → 输入 → 提交"；Android 触屏快速录入可用 |

### 退出标准
- 规格 §6.1 的五条规则全部满足，尤其"提交后必须立即持久化"与"失败时保留输入"。
- `known-limitations.md` 记录本阶段任何未完成项。
- **不得**用内存列表冒充收集箱（必须能重启后仍在）。

---

## P3 长期任务与临时事项/提醒

### 交付物
- `Task` 完整实现：状态机、`previous_status`、`project_id`（可空）、`parent_task_id` 防环、
  `scheduled_date` 与 `due_at` 分离、`priority`。
- `ReminderItem`：`remind_at` 与 `due_at` 分离、`notification_state` 落库。
- `NotificationScheduler` port + 真实实现（含 `capabilities()`）+ `Noop` 假实现。
- 收集箱 → 任务 / 提醒的转换（含去重与撤销）。
- **启动补课**逻辑（过期提醒本机呈现 + 重新安排 + 权限复查）。
- 任务详情与临时事项列表。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-UNIT-TASK-STATE | 合法转换通过；非法转换被拒或明确记录；`completed_at` 与状态一致；`previous_status` 可回退 |
| T-UNIT-TASK-CYCLE | 属性测试：随机建链 1000 次永不产生环；深度上限生效 |
| T-UNIT-REMINDER-STATE | done/cancelled 后不再产生提醒；`notification_state` 正确 |
| T-UNIT-CONVERT-DEDUP | 连续转换两次 → 只有一个目标对象 |
| T-UNIT-CONVERT-UNDO | 目标未编辑 → 撤销删除目标；目标已编辑 → 保留目标仅解除来源 |
| T-INT-CONVERT-TRACE | 双向可追溯（inbox ↔ 正式对象） |
| 通知权限拒绝 | 拒绝权限后创建带提醒的事项 → UI 明确显示"提醒未生效"，`notification_state='denied'` |
| 通知权限撤销 | 授予后再撤销 → 启动补课把状态更新为 `failed` 并提示 |
| 改提醒时间 | 修改 `remind_at` → **旧调度被取消**，系统中只有一个待触发提醒 |
| 完成任务 | 完成后**不**创建时间记录（§4.2） |
| L4 旅程 B | 完整走通；含权限拒绝与改时间两个分支 |
| 两端 | Windows 与 Android 真机各跑一次旅程 B |

### 退出标准
- 规格 §4.2、§4.3 全部规则满足。
- "不假装提醒已成功安排"在**真实拒绝权限的设备上**验证过。
- `known-limitations.md` 更新：提醒尽力而为、不支持重复提醒、Windows 未打包的通知限制。

---

## P4 项目、标签与关系

### 交付物
- `Project`：状态、归档（`status='archived'` 与 `entity.archived_at` 一致）。
- `Tag`：`name` + `name_key` 规范化（NFC → trim → 折叠空白 → casefold）。
- `set_element` 的完整集合语义（增删、逐元素墓碑）。
- 项目详情**聚合视图**（只读关联，不复制）。
- 归档/删除的可见性矩阵实现。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-UNIT-TAG-NORMALIZE | NFC、trim、折叠空白、casefold、全角、emoji、组合字符全部符合规则 |
| T-UNIT-REL-CREATE-UNLINK | 建立/解除都不删除两端对象 |
| T-UNIT-PROJECT-ARCHIVE | 归档状态与 `entity.archived_at` 始终一致 |
| T-UNIT-VISIBILITY | active/archived/deleted/tombstoned × 列表/搜索/聚合 符合矩阵 |
| T-INT-PROJECT-AGGREGATE | 聚合结果与直接查询一致，且**不产生新记录**（断言 `entity` 行数不变） |
| T-INT-PROJECT-DELETE-KEEPS-HISTORY | 归档或删除项目后，任务/日志/时间记录**全部仍在** |
| T-INT-DANGLING-REF | 被引用对象删除 → 引用显示"已删除"，不静默指向他物、不自动移除 |
| T-INT-UNLINK | 解除关联不删对象 |
| T-INT-MULTI-VIEW-SAME-OBJECT | 从项目详情/今日/搜索取得的对象 id 全等 |
| T-UNIT-ID-UNIQUE | 10 万个 UUIDv7 无重复、时间有序、版本/variant 位正确 |

### 退出标准
- 规格 §4.4、§4.8、§5 全部规则满足。
- "删除项目不误删历史"有专门测试且通过。
- 聚合视图确认无数据复制。

---

## P5 日记、工作日志、结论

### 交付物
- `LogEntry`（多值关系：任务/项目/结论/附件）。
- `JournalEntry`（同一天允许多篇、日历聚合、自由叙述、引用不复制）。
- `Conclusion`（`source_refs` 可追溯、轻量记录类型，**不建模板引擎**）。
- `text` 合并策略的**业务落地**：冲突写入 `conflict` 表 + 对象详情横幅 + 冲突页面 +
  `ResolveConflict` 用例（解决后写入新 op）。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-LOG-INDEPENDENT | 日志正文与任务描述**不得**自动互相覆盖（改写一方不影响另一方） |
| T-JRN-MULTI-PER-DAY | 同一天创建多篇 → 全部保留；日历聚合展示正确 |
| T-JRN-REF-NO-COPY | 日记引用任务 → 任务正文变化不改变日记内容，且不复制正文 |
| T-CON-TRACEABLE | 结论可追溯到全部 `source_refs`；不自动从日志推断结论 |
| T-INT-CONFLICT-POLICY | `lww`/`text`/`set` 三类字段分别断言：唯一胜者 / conflict 记录 / 并集 |
| T-INT-CONFLICT-CANONICAL | 两侧 `losing_op`/`winning_op` 相同（对应原型测试 5） |
| 冲突解决 | 用户选择保留版本 → 写入新 op（向量递增）；被弃版本仍在 op 日志 |
| 冲突 UI | 冲突在对象详情持续可见，直到用户显式处理（不静默消失） |
| T-ARCH-LAYERING | 复跑（新增代码未破坏分层） |

### 退出标准
- 规格 §4.6、§4.7、§4.10 全部规则满足。
- 文本冲突**端到端可见**（不只是数据层记录了）。
- **不得**出现"三方自动合并"（ADR-0003 明确不做）。

---

## P6 时间记录与统计

### 交付物
- `TimeEntry`：手动补录/修改/删除、`end_at > start_at` 约束、
  计时器（`timer_state='running'`，**落库**）、`tz_id`。
- 区间并集算法（`domain/rules/interval_union.dart`）。
- 统计视图：**原始记录时长** 与 **去重覆盖时长** 并列 + 重叠明细入口。
- 时区处理：`TimeEntry` / `Reminder` 用瞬时 + `tz_id`；日记/计划用本地日期。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-UNIT-TIMERANGE | `end_at <= start_at` 被拒；running ⇔ `end_at IS NULL`；伪造结束时间被拒 |
| T-UNIT-INTERVAL-UNION | 相邻 `[1,2)+[2,3)`=2；完全包含；多重交叉；跨午夜；DST 切换日；与暴力算法全等 |
| T-UNIT-DATE-TZ | 时区变更不改变已存瞬时；本地日期不因 DST 漂移 |
| T-RUNNING-UNIQUE | 同一设备最多一行 running（部分唯一索引生效） |
| T-INT-TIME-INDEPENDENT | 任务改 done/cancelled 后时间记录字段不变 |
| T-INT-PROJECT-DELETE-KEEPS-HISTORY | 时间记录在项目删除后仍在 |
| L4 旅程 D | 开始计时 → 杀进程 → 重启（计时仍在，时长基于 `start_at`）→ 结束 → 修改区间 → 统计正确 |
| 统计正确性 | 两条重叠 30 分钟的记录 → 原始 2h / 覆盖 1.5h，两者都可见且标注含义 |
| 时区切换 | 系统时区从 UTC+8 改为 UTC-5 → 历史 `start_at` 的 UTC 值不变 |

### 退出标准
- 规格 §4.5 的 10 条规则与 §6.4 全部满足。
- 计时器**真正跨重启恢复**（在两端真机上验证，不只是单测）。
- 重叠统计有明确规则且用户可见。

---

## P7 搜索、今日视图、每日回顾

### 交付物
- 搜索：全文关键词 + 类型/日期范围/标签/项目/任务状态筛选；结果点击进入正式对象。
- `search_fts`（`content=''` 外部内容表）+ **重建命令与测试**。
- 中文搜索方案落地（Q5 决策：trigram / bigram / LIKE 降级）。
- 今日视图：今日计划、临时提醒、未处理收集记录、当天时间记录。
- 每日回顾：`inbox` + 已到期 `deferred`；逐条与批量处理；
  **关闭页面不自动完成**；允许推迟与归档。
- 未处理数量的**非惩罚性**呈现（§7 明确要求）。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-UNIT-SEARCH-FILTER | 各筛选维度与组合正确；日期范围含端点 |
| T-INT-SEARCH-REBUILD | 删除 FTS 表 → 重建 → 搜索结果集合全等 |
| T-INT-SEARCH-NAVIGATE | 点击结果进入的对象 id == 结果 id |
| 中文搜索 | 按 Q5 方案：构造 100 条已知答案，召回率符合方案承诺；延迟 < 500 ms @ 5 万条 |
| T-FLOW-REVIEW-CLOSE | 关闭回顾页面 → **不**标记任何记录完成 |
| T-FLOW-REVIEW-DEFERRED | `deferred` 到期后重新出现在回顾 |
| T-FLOW-REVIEW-BATCH | 批量处理 N 条 → N 条状态与关联都正确更新 |
| L4 旅程 C | 完整走通（创建多条 → 处理一部分 → 推迟一部分 → 重开 → 未处理仍在 → 已处理仍可查询） |
| 文案检查 | 未处理数量文案不含羞辱性表述；空状态解释如何开始 |

### 退出标准
- 规格 §6.2、§6.5、§7 相关条款满足。
- 搜索索引确认**可重建**（§9.11）。
- 中文搜索能力如实写入 `known-limitations.md`。

---

## P8 备份、恢复与导出

### 交付物
- `BackupWriter`：`VACUUM INTO` 快照 → `manifest.json` → `SHA256SUMS` → ZIP（可选加密）。
- `BackupReader` + `RestoreEngine`：五阶段恢复流程。
- 迁移前自动快照。
- 导出：JSON / CSV / Markdown + `export-manifest.json`，明确限制。
- 备份 UI：上次备份时间、备份列表、恢复向导、明确的警示文案。
- 自动备份：Windows 启动时检查；Android `WorkManager` 周期任务。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| T-BAK-ROUNDTRIP | 含关系/附件/软删除/计时中 → 备份 → **空库**恢复 → 逐表 + 关系 + 附件哈希全等 |
| T-BAK-CONSISTENT-SNAPSHOT | 备份过程中持续并发写入 → 快照仍通过 `quick_check` + `foreign_key_check` |
| T-BAK-TRUNCATED | 截断归档 → **拒绝恢复**且**现场不变** |
| T-BAK-CORRUPT-DB | 破坏快照页 → 检出并拒绝，现场不变 |
| T-BAK-VERSION-OLD | v(N-1) 备份在 vN 应用恢复 → 迁移链执行成功 |
| T-BAK-VERSION-NEW | 更高版本备份 → 明确拒绝，现场不变 |
| T-BAK-RESTORE-FAIL-ROLLBACK | 阶段 5 注入失败 → 自动回滚，数据等于恢复前 |
| T-BAK-ATTACH-MISSING | 不含附件的备份恢复 → 引用显示缺失而非消失 |
| T-BAK-ENCRYPTED | 错口令拒绝；对口令成功 |
| T-BAK-EXPORT | 导出 JSON 后逐对象全等；CSV 关系文件正确；缺失附件被标注 |
| T-FUZZ-ARCHIVE | 1000 次随机损坏归档 → 每次拒绝且现场不变 |
| 两端真实恢复 | Windows 与 Android 各完成一次真实备份 + 恢复 |

### 退出标准
- 规格 §8.4 全部条款满足，尤其是**"必须执行实际恢复测试"**——
  必须在两个真实平台上完成，不接受只在单测里通过。
- 恢复的五条关键不变量有测试守护（`backup-restore.md` §4）。

---

## P9 同步与冲突处理

### 交付物
- `SyncTransport` 接口 + 至少两个实现（`HttpRelayAdapter` + `NoopSyncAdapter`；
  视 Q2 决定是否加 `FileFolderAdapter`）。
- 参考 relay（若 Q1 决定交付可用同步）。
- 客户端同步循环（push outbox → pull 游标 → 事务内推进游标）。
- 字段级合并引擎（lww / text / set）、HLC、版本向量、墓碑、时钟偏移检测。
- 同步状态 UI：上次同步、待同步计数、错误与重试、时钟警告。
- 附件 blob 的上传/下载与缺失占位。

### 测试与验收

| 测试 ID | 判据 |
| --- | --- |
| **原型 20 条契约测试** | `testing.md` §7 的 20 条**逐条移植为 Dart 测试**并全部通过 |
| T-INT-OFFLINE-THEN-SYNC | 两端离线各改 → 联网 → 收敛 |
| T-INT-DUP-SYNC | 连续同步 5 次 → `op`/`entity` 行数不变 |
| T-PROP-MERGE-COMMUTATIVE | 随机 op 集合按不同顺序应用 → 最终状态摘要全等 |
| T-PROP-MERGE-IDEMPOTENT | 随机 op 重复投递 1–5 次 → 状态与投递一次相同 |
| T-PROP-CRASH-MID-SYNC | 在 apply 事务各点崩溃 → 从游标安全重放；**游标绝不先于数据推进** |
| T-PROP-CLOCK-FUZZ | 随机时钟偏移（-24h~+48h）+ 随机交错 → 收敛；超限产生警告 |
| T-INT-SYNC-RETRY-VISIBLE | 注入失败 → `last_error` 有值、UI 有错误态、可重试且成功后恢复 |
| T-ARCH-LAYERING | 复跑通过 |
| L4 旅程 E | Windows + Android 各作一台设备：创建 → 同步 → 改同一记录 → 冲突处理 → 备份 → 恢复 → 全等 |
| 冲突 UI | 文本冲突在两端显示一致（`losing_op` 相同） |

### 退出标准
- 20 条契约测试全过（这是本阶段唯一的**硬性**准入条件）。
- 双实例真实同步在 Windows + Android 上跑通旅程 E。
- 若 Q1 决定不交付可用同步：本阶段只交付接口 + `NoopSyncAdapter`，
  且 `known-limitations.md` 明确写"多设备同步**未完成**"，
  **不得**声称 V1 具备同步能力（§8.3 最后一段、§10.4）。

---

## P10 打包、发布验证与交付

### 交付物
- Windows 安装包（`.exe` 或 MSIX，视 Q6）。
- Android APK/AAB（含 16 KB 对齐验证）。
- `tool/verify.dart`：一条命令跑完全部检查（可复现的构建、测试、发布步骤）。
- 自动化测试报告。
- 数据库升级说明、备份恢复说明。
- **已知限制与未完成项目清单**（最终版）。
- 源码 + 构建说明。

### 测试与验收

| 项 | 判据 |
| --- | --- |
| 干净环境构建 | 在一台**没有本项目缓存**的机器上按 README 从零构建成功 |
| 安装启动 | Windows 与 Android 均能安装、启动、完成核心流程 |
| 覆盖安装升级 | 安装旧版本 → 产生数据 → 安装新版本 → **数据完整**、迁移成功 |
| 全部 L1–L3 | 通过 |
| 全部 L4 | 五条旅程在两端通过 |
| 全部迁移测试 | 通过 |
| 备份/恢复 | 两端真实恢复通过 |
| T-FUZZ / T-PROP | 通过 |
| T-LOAD-100K | 启动 <3 s、搜索 <500 ms、备份/恢复不 OOM，并有性能记录 |
| R1 风险覆盖 | `risks.md` 所有 R1 项都有通过的对应测试；未覆盖的必须列入已知限制 |
| 限制清单对照 | 逐项评审 `known-limitations.md` 与实现，确认无"声称已完成但实际未实现" |

### 退出标准
- 规格 §10.4 的**全部九条**发布验收门槛满足。
- 任一 R1 风险无测试覆盖 → **不得**发布，必须补齐或明确列为已知缺陷并降级声明。

---

## 阶段间的强制规则

1. **不得跳阶段**：P2 的持久化保证是 P3+ 一切功能的基础。
   P8 的恢复能力是 P9 同步的安全网。
2. **每个阶段结束必须更新文档**：至少 `known-limitations.md`，
   以及该阶段涉及的 `requirements.md`（勾掉已实现项）与 `testing.md`（补充实际测试名）。
3. **不得降低既有测试的严格度**。若某阶段发现先前设计有缺陷，
   必须**修正设计文档与 ADR**，而不是放宽测试。
4. **每个阶段都必须在两个目标平台实际运行**；
   仅在一个平台通过的功能视为该阶段未完成。
5. **性能与体积有记录**：从 P1 起每个阶段记录启动时间与数据库大小趋势，
   避免到 P10 才发现不可接受。
