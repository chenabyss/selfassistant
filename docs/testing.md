# testing.md — 测试层次、命令与验收门槛

规格 §10 要求四层测试与发布门槛。本文件把 §10.1–§10.4 转写为**可执行**的测试 ID 与判定条件，
并把需求编号（`requirements.md`）与风险编号（`risks.md`）映射到测试。

---

## 1. 测试金字塔与工具

| 层次 | 范围 | 工具 | 运行时间目标 | 运行时机 |
| --- | --- | --- | --- | --- |
| L1 单元 | `domain/`、`application/` 的纯逻辑 | `package:test` | < 10 s | 每次保存 |
| L2 数据库/集成 | drift schema、迁移、事务、约束、搜索 | `package:test` + 真实 SQLite（内存/临时文件） | < 60 s | 每次提交 |
| L3 应用集成 | 用例 + 数据库 + 文件存储 + 假传输 | `package:test` + 临时目录 | < 3 min | 每次提交 |
| L4 端到端 | 真实构建产物上的用户旅程 | `integration_test`（Windows 桌面 / Android 真机或模拟器） | < 20 min | 每阶段收尾、发布前 |
| L5 破坏性/属性测试 | 崩溃、断电、并发交错、随机序列 | `package:test` + 故障注入 | < 3 min | 每阶段收尾 |

**同步核心的契约测试**：`prototype/sync-core/` 的 20 条测试是**协议规格**。
Dart 实现必须逐条移植（见 §7），原型本身不再演进。

### 命令（阶段 1 建立后冻结）

```bash
# L1 + L2 + L3
dart test app/packages/domain app/packages/application
dart test app/packages/infrastructure

# 分层守护（架构规则，见 architecture.md §2）
dart run tools/check_layering.dart

# 同步核心契约
cd prototype/sync-core && node test/run.js

# L4 端到端
flutter test integration_test -d windows
flutter test integration_test -d <android-device-id>

# 迁移与备份专项
dart test app/packages/infrastructure/test/migration
dart test app/packages/infrastructure/test/backup
```

---

## 2. L1 单元测试（规格 §10.1 逐条映射）

| 测试 ID | 覆盖规格要求 | 需求编号 | 判定条件 |
| --- | --- | --- | --- |
| T-UNIT-TASK-STATE | 任务状态转换 | R-TASK-07, R-TASK-06 | 合法转换全部通过；非法转换（如 done→todo 直接改而不经 `previous_status`）被拒绝或明确记录；`completed_at` 与状态一致 |
| T-UNIT-REMINDER-STATE | 临时事项状态 | R-REM-05 | done/cancelled 后不再产生提醒；`notification_state` 被置为 cancelled |
| T-UNIT-INBOX-STATE | 收集记录处理状态 | R-INBOX-03/04/07 | 五状态语义独立；跨日不自动变更；processed 仍可检索 |
| T-UNIT-CONVERT-DEDUP | 转换去重 | R-INBOX-09, R-FLOW-06 | 同一 inbox 连续转换两次 → 只有一个目标对象，第二次返回既有 id |
| T-UNIT-CONVERT-UNDO | 转换撤销 | R-INBOX-06 | (a) 目标未编辑 → 撤销删除目标并解除来源；(b) 目标已编辑 → 保留目标，仅解除来源并给出提示 |
| T-UNIT-TIMERANGE | 时间区间合法性 | R-TIME-02, R-TIME-03 | `end_at <= start_at` 被拒；running 时 `end_at` 必须为 NULL；伪造结束时间被拒 |
| T-UNIT-INTERVAL-UNION | 重叠时间统计 | R-TIME-06 | 相邻 `[1,2)+[2,3)` = 2；完全包含；多重交叉；跨午夜；DST 切换日；结果与暴力算法一致 |
| T-UNIT-TAG-NORMALIZE | 标签去重规则 | R-TAG-02 | NFC；`" 工作 "` ≡ `"工作"`；`"A  B"` ≡ `"A B"`；casefold（`"WORK"` ≡ `"work"`）；全角 `"ＷＯＲＫ"`；emoji 与组合字符不被破坏 |
| T-UNIT-REL-CREATE-UNLINK | 关系创建/解除 | R-REL-01 | 建立与解除都不删除两端对象；解除后集合语义正确 |
| T-UNIT-DATE-TZ | 日期、时区、跨午夜 | R-DATA-04, 需求 §3.4 | 时区变更不改变已存瞬时；本地日期不因 DST 漂移；`Duration(days:1)` 用法被禁止（lint） |
| T-UNIT-SEARCH-FILTER | 搜索筛选逻辑 | R-FLOW-08 | 类型/日期范围/标签/项目/状态筛选组合正确；边界含端点 |
| T-UNIT-SYNC-IDEMPOTENT | 同步幂等 | R-TECH-09 | 同 op 应用两次状态不变（对应原型测试 1/2） |
| T-UNIT-VV-COMPARE | 版本向量比较 | R-TECH-11 | dominates/dominated/equal/concurrent 四类分类正确（原型测试 18） |
| T-UNIT-HLC | HLC 单调与偏移钳制 | R-TECH-07 | 墙钟回退时仍单调；远端未来时间被钳制到 `now+maxDrift`；`skewWarning` 产生 |
| T-UNIT-MIGRATION-* | 数据库迁移 | R-TECH-02/04 | 见 L2 |
| T-UNIT-TOMBSTONE | 删除墓碑处理 | R-TECH-10 | 删除与并发编辑的总序规则；墓碑不被旧 op 复活（原型测试 11/12） |
| T-UNIT-TASK-CYCLE | 子任务防环 | R-TASK-03 | 属性测试：随机建链 1000 次，永不产生环；深度上限生效 |
| T-UNIT-PROJECT-ARCHIVE | 归档一致性 | R-PROJ-03/04 | `status='archived'` 与 `entity.archived_at` 同步设置；归档不删关联 |
| T-UNIT-VISIBILITY | 可见性矩阵 | ⚠GAP-05 | active/archived/deleted/tombstoned 在 列表/搜索/聚合 三处的组合符合 `data-model.md` §2.1 |
| T-UNIT-ID-UNIQUE | ID 唯一性 | R-DATA-02 | 生成 10 万个 UUIDv7，无重复、按时间有序、版本/variant 位正确 |

---

## 3. L2 数据库与迁移测试

### 3.1 Schema 与约束

| 测试 ID | 内容 |
| --- | --- |
| T-DB-CONSTRAINTS | 每个 CHECK 与 UNIQUE 都用"违反即抛错"的方式验证，包括 `end_at > start_at`、`timer_state=running ⟺ end_at IS NULL`、`op_type`/`strategy` 枚举、`priority` 枚举 |
| T-DB-FK-ON | 每个新连接 `PRAGMA foreign_keys` 必须为 1（专门测试连接工厂） |
| T-DB-STRICT | 所有业务表都是 `STRICT`（用 `PRAGMA table_list` 断言） |
| T-DB-REPLAY | **核心不变量**：随机生成 op 序列 → 物化状态 == 按合并规则重放 op 的状态 |
| T-DB-WAL | 打开后 `journal_mode=wal`；单写多读不产生 `database is locked` |
| T-DB-FIELD-SCHEMA | 未声明字段写入抛错；`field_schema` 内容与 `data-model.md` §5 表格逐项一致（防止实现漂移） |
| T-DB-CONVERSION-TRACE | 转换来源关系双向可查（R-INBOX-05） |

### 3.2 迁移测试（规格 §10.2 "数据库升级后旧数据完整"）

每个 schema 版本提供一个**真实旧版数据库 fixture**（`test/fixtures/v<N>.db`，含关系与附件元数据）。

| 测试 ID | 内容 | 判定 |
| --- | --- | --- |
| T-MIG-N-FORWARD | 用 `v<N>.db` 打开 → 升级到当前版本 | 无异常；`user_version` = 当前 |
| T-MIG-N-DATA-PRESERVED | 升级前后逐表行数比对 | **每张表行数不减少**（除明确迁移说明的合并表） |
| T-MIG-N-RELATIONS | 升级前后关联（`set_element`）数量与内容比对 | 全等 |
| T-MIG-N-FIELDS | 关键字段值抽样比对（含时间戳 UTC 值不变） | 全等 |
| T-MIG-N-ROLLBACK | 在迁移中途注入失败 | 自动回滚，库仍为旧版本且数据完好 |
| T-MIG-N-PRESNAPSHOT | 迁移前快照存在且通过 `quick_check` | 存在且通过 |
| T-MIG-CHAIN | 从最老 fixture 一路升到当前 | 成功，数据完整 |
| T-MIG-TOO-NEW | 库 `user_version` > 代码版本 | **拒绝打开**并给出明确错误；**不得写入** |

### 3.3 保留期与压缩测试（对应 ADR-0005）

保留期策略会**主动删除**数据，因此它本身就是一个数据丢失风险源，必须有测试。

| 测试 ID | 内容 | 判定 |
| --- | --- | --- |
| T-OPLOG-COMPACT | 压缩 90 天前的 op 日志 | 压缩后**每个对象的当前状态与压缩前全等**；create/delete/状态变更/转换事件仍可查（§9.8 仍成立） |
| T-RETENTION-TOMBSTONE | 模拟离线设备上传 12 个月前的旧 op | 已删除对象**不被复活**；墓碑正确压制旧 op |
| T-RETENTION-PURGE | 软删除对象到期（180 天）执行清理 | 正文内容不再出现在库中任何位置（含 FTS 索引与 op 日志）；墓碑行仍在且不含内容 |
| T-RETENTION-ORPHAN-BLOB | 孤儿 blob 保留 30 天后清理 | 有引用的 blob **绝不**被删除；无引用的被删除 |
| T-RETENTION-CONFIG | 用户修改保留期配置 | 配置生效；设为 0 被拒绝（默认值不得为 0） |

**强制规则**：`T-MIG-*` 全部用真实文件，不用内存库；迁移测试**必须同时断言数据正确**，
而不是只断言"没有抛异常"（对应风险 MG-8）。

---

## 4. L3 应用集成测试（规格 §10.2 逐条映射）

| 测试 ID | 规格要求 | 判定条件 |
| --- | --- | --- |
| T-INT-RESTART-PERSIST | 新建对象后重启应用，数据仍存在 | 关闭 store → 重新打开同一文件 → 全部对象、关系、附件元数据一致 |
| T-INT-CONVERT-TRACE | 快速记录转换后源信息仍可追溯 | 从 inbox 能到正式对象，从正式对象能回到 inbox |
| T-INT-PROJECT-AGGREGATE | 项目详情能找到所有相关任务、日志、时间记录 | 聚合结果集合与直接查询一致；**不产生**新记录（断言 `entity` 行数不变） |
| T-INT-MULTI-VIEW-SAME-OBJECT | 同一记录从多个视图进入仍指向同一对象 | 从今日/搜索/项目详情取得的 id 全等 |
| T-INT-PROJECT-DELETE-KEEPS-HISTORY | 删除或归档项目不误删历史记录 | 归档后任务/日志/时间记录全部仍在；删除项目后它们仍在且引用显示"已删除" |
| T-INT-DANGLING-REF | 被引用对象删除显示明确状态 | 引用处返回"已删除"，**不**静默指向他物、**不**自动移除引用 |
| T-INT-SEARCH-NAVIGATE | 搜索结果进入正确对象 | 点击结果进入的对象 id == 搜索结果 id |
| T-INT-SEARCH-REBUILD | 搜索索引可重建 | 删除 FTS 表 → 重建 → 搜索结果集合全等 |
| T-INT-OFFLINE-THEN-SYNC | 离线修改后联网可以同步 | 两端离线各改 → 联网同步 → 状态收敛（对应原型测试 3/19） |
| T-INT-DUP-SYNC | 重复同步不生成重复对象 | 连续同步 5 次 → `op` 与 `entity` 行数不变（原型测试 1/12） |
| T-INT-CONFLICT-POLICY | 并发修改触发预定冲突策略 | 对 `lww`/`text`/`set` 三类字段分别断言：lww 有唯一胜者、text 产生 conflict 记录、set 取并集 |
| T-INT-CONFLICT-CANONICAL | 冲突记录跨设备一致 | 两侧 `losing_op`/`winning_op` 相同（原型测试 5） |
| T-INT-UNLINK | 解除关联不删对象 | 解除后两端对象都存在 |
| T-INT-REF-STABLE | 标题/正文不作关联键 | 改标题后所有引用不变 |
| T-INT-AUDIT | 重要状态变化可追溯 | 状态变更/转换/删除都能在审计或 op 日志中查到 |
| T-INT-TIME-INDEPENDENT | 时间记录不因任务状态变化而改变 | 任务改为 done/cancelled 后时间记录字段不变 |
| T-INT-SYNC-RETRY-VISIBLE | 导入/同步失败可见可重试 | 注入失败 → `sync_cursor.last_error` 有值、UI 有错误态、可手动重试且成功后恢复 |
| T-INT-BACKUP-ROUNDTRIP | 备份后恢复，记录、关系和附件仍完整 | 见 `backup-restore.md` §8；详细判据在 T-BAK-ROUNDTRIP |
| T-INT-MIG-DATA | 数据库升级后旧数据完整 | 见 T-MIG-* |
| T-ARCH-LAYERING | 架构依赖方向 | `domain`/`application` 不得 import flutter/drift/dart:io（AST 扫描） |
| T-PRIV-NO-CONTENT | 日志不含日记正文 | 写入敏感正文 → 扫描所有日志文件 → 不含正文片段（风险 OT-7） |

> **备份/恢复测试的权威定义在 [`backup-restore.md`](backup-restore.md) §8**（共 11 项 `T-BAK-*`）。
> 本文件只重复其中会出现在阶段门槛里的几项；如需完整清单（含 `T-BAK-ENCRYPTED`、
> `T-BAK-EXPORT-CSV-JSON`、`T-BAK-LARGE`、`T-BAK-VERSION-NEW`）以该文档为准。

### 4.1 按功能域的集成测试（阶段 P3–P7 的准入条件）

`phases.md` 各阶段引用的测试 ID 在此给出统一定义；阶段文档只引用，不重复定义。

| 测试 ID | 阶段 | 内容与判定条件 |
| --- | --- | --- |
| T-LOG-INDEPENDENT | P5 | 修改日志正文不影响任何任务描述，反之亦然；两者**不得**自动互相覆盖（§4.6） |
| T-JRN-MULTI-PER-DAY | P5 | 同一天创建 3 篇日记 → 全部保留（无 UNIQUE 冲突）；日历聚合按日期正确分组（§4.7） |
| T-JRN-REF-NO-COPY | P5 | 日记引用某任务 → 修改任务正文后日记内容不变；断言未复制正文（§4.7） |
| T-CON-TRACEABLE | P5 | 结论可回溯到全部 `source_refs`；从日志**不自动**生成结论（§4.10） |
| T-RUNNING-UNIQUE | P6 | 本机同时只能有一行 `timer_state='running'`（部分唯一索引生效）；开启第二个计时被拒绝或提示（§4.5） |
| T-FLOW-REVIEW-CLOSE | P7 | 在仍有未处理记录时关闭回顾页面 → **没有任何记录**被标记 processed/archived（§6.2） |
| T-FLOW-REVIEW-DEFERRED | P7 | `deferred_until` 到期后该记录重新出现在回顾列表；未到期的不出现（§6.2） |
| T-FLOW-REVIEW-BATCH | P7 | 批量处理 N 条 → N 条的状态与关联关系全部正确更新，无一条被漏掉或重复处理（§6.2） |
| T-BAK-CONSISTENT-SNAPSHOT | P8 | 备份进行中持续并发写入 → 快照仍通过 `quick_check` + `foreign_key_check`（风险 BR-2） |
| T-BAK-CORRUPT-DB | P8 | 故意破坏快照中的页 → 恢复被检出并**拒绝**，现场不变（风险 BR-3） |
| T-BAK-ATTACH-MISSING | P8 | 只用"仅数据库"模式备份 → 恢复后附件引用显示 `missing` 占位，**不**静默消失（§4.9、风险 BR-10） |

---

## 5. L4 端到端测试（规格 §10.3 五条旅程）

在**真实构建产物**上执行（Windows 桌面 exe；Android APK/真机）。
每条旅程都要在"冷启动一次 + 热运行一次"两种情况下跑。

| 旅程 | 步骤（规格原文） | 额外断言（本设计补充） |
| --- | --- | --- |
| **A 快速记录到完成任务** | 添加"检查网格生成失败" → 进收集箱 → 转长期任务 → 关联项目 → 创建时间记录和工作日志 → 完成任务 → 从项目详情和全局搜索都能找到 | 任务完成后**不**自动创建时间记录（R-TASK-04）；从两处进入的对象 id 相同；转换后 inbox 仍可查（R-INBOX-04） |
| **B 临时事项提醒** | 创建"明天带实验报告" → 设置提醒 → 确认通知权限 → 修改提醒时间 → 完成 → 完成后不再触发 | 拒绝权限的场景单独跑一遍：必须显示"提醒未生效"（R-REM-04）；改时间后**旧调度被取消**（断言系统中只有一个待触发提醒）；完成后 `notification_state=cancelled` |
| **C 每日回顾** | 创建多条快速记录 → 处理一部分 → 推迟一部分 → 关闭应用重开 → 未处理仍在收集箱 → 已处理不再被要求处理但仍可查询 | 关闭回顾页面**不**自动全标完成（R-FLOW-05）；`deferred` 到期后重新出现在回顾；未处理数量**不**显示惩罚性文案（R-UX-08） |
| **D 时间记录** | 开始计时 → 关闭并重启应用 → 结束计时 → 修改时间区间 → 检查统计确认重叠不被无条件重复累计 | 重启后计时仍在运行且已用时长基于 `start_at`（R-TIME-04）；统计同时显示"原始时长"与"去重覆盖时长"（R-TIME-06）；修改区间后统计随之更新 |
| **E 跨设备与恢复** | A 创建记录 → 同步到 B → B 修改同一记录 → 按预定冲突策略处理 → 备份 → 在测试环境恢复 → 检查对象/关系/附件/状态完整 | 冲突处理产生可见结果（文本冲突进 conflict 表）；恢复后逐表与附件哈希比对全等；**额外**跑一次"恢复失败注入"确认现场未被覆盖 |

**L4 环境矩阵**

| 旅程 | Windows | Android | 备注 |
| --- | --- | --- | --- |
| A | ✅ | ✅ | |
| B | ✅（含"未打包 MSIX"的限制场景） | ✅（含权限拒绝与 OEM 省电场景） | 见 `dart-verification.md` §3 |
| C | ✅ | ✅ | |
| D | ✅ | ✅（含杀进程） | Android 上需验证被杀后计时恢复 |
| E | ✅ | ✅ | 双实例：Windows + Android 各自作为一台设备 |

---

## 6. L5 破坏性与属性测试

| 测试 ID | 内容 | 判定 |
| --- | --- | --- |
| T-PROP-MERGE-COMMUTATIVE | 随机 op 集合按不同顺序应用 | 最终状态摘要全等（对应原型测试 19） |
| T-PROP-MERGE-IDEMPOTENT | 随机 op 重复投递 1–5 次 | 状态与投递一次相同 |
| T-PROP-CRASH-MID-SYNC | 在 apply 事务的各个点注入崩溃 | 重启后从游标安全重放，最终收敛；**绝不**出现游标先于数据推进 |
| T-PROP-CRASH-MID-WRITE | 在写入事务中途杀进程 | 要么全部生效要么全不生效；输入内容不丢（草稿兜底） |
| T-PROP-CLOCK-FUZZ | 随机时钟偏移（-24h ~ +48h）+ 随机交错 | 收敛；偏移超限产生警告 |
| T-FUZZ-ARCHIVE | 随机截断/翻转位/删条目的备份归档 1000 次 | 每次都必须**拒绝恢复**且**现场不变**，绝不产生半恢复状态 |
| T-LOAD-100K | 10 万对象 + 1 GB 附件 | 启动 < 3 s；搜索 < 500 ms；备份/恢复不 OOM；有性能记录 |

**属性测试必须有固定随机种子并记录**，失败可复现。

---

## 7. 同步核心契约测试（原型 → Dart 移植清单）

`prototype/sync-core/` 的 **33 条**测试是**协议的可执行规格**（`node test/run.js`）。
Dart 实现必须逐条移植，测试名保持一致，作为阶段 9 的准入门槛。

### 7.1 基础契约（`test/core.test.js`，20 条）

```
1  idempotency: re-pushing the same batch creates no duplicate rows
2  idempotency: applying the same op twice locally is a no-op
3  convergence: concurrent edits on A and B converge to identical state
4  convergence: same-field concurrent writes resolve identically on all devices
5  conflict: concurrent body edits keep both versions and flag a conflict
6  conflict: a causally-later edit is NOT reported as a conflict
7  schema: an undeclared field cannot be written (guards the merge rule)
8  sets: concurrent tag adds converge to the union
9  sets: a removal concurrent with an add is not resurrected
10 sets: a genuinely later re-add wins over an earlier removal
11 tombstones: a delete propagates and a concurrent stale edit cannot resurrect the row
12 tombstones: replaying a delete many times keeps exactly one tombstone
13 cursor: incremental pulls see every op exactly once, with no gaps
14 cursor: a crash mid-pull replays safely from the last durable cursor
15 retry: a partially-failed push retried in full neither duplicates nor loses ops
16 clock skew: a device whose clock is an hour behind does not overwrite newer data
17 clock skew: a device with a far-future clock is flagged and cannot run away with time
18 version vectors: comparison classifies dominated/equal/concurrent correctly
19 three devices: random interleavings converge to one state
20 attachments: identical content hashes are stored once
```

### 7.2 冲突可见性与解决契约（`test/conflict.test.js`，13 条）

设计评审发现的**实质缺陷**（`lww` 字段的并发差异对用户不可见）修复后新增。
这 13 条是"并发修改必须可见"这一承诺的验收条件，**不得删减或放松**。

```
21 review: concurrent scalar (lww) writes produce a VISIBLE, open conflict
22 review: conflicting value is recoverable and both sides agree on the loser
23 review: a causally-later write produces NO conflict
24 review: concurrent writes with the SAME value produce NO conflict
25 review: ordinary sequential editing never creates a conflict
26 review: re-delivering the same ops does not duplicate conflict records
27 review: conflict set converges regardless of the order devices pull in
28 review: choosing the losing value resolves and converges on all devices
29 review: resolving the same conflict twice is rejected as already resolved
30 review: resolving cannot resurrect a value without a new op (auditability)
31 review: a discarded losing write still merges its version vector
32 review: concurrent set-membership removal vs add still converges to union rules
33 review: text conflicts remain visible and resolvable end to end
```

### 7.3 冲突契约的判定条件（移植时必须保持）

| 判定 | 要求 |
| --- | --- |
| 触发冲突 | **真并发**（版本向量互不支配）**且值不同** |
| 不触发 | 因果更晚的写入；并发但值相同；顺序编辑 |
| 记录 id | `hash(losing_op, winning_op, field)`，两设备必须得到**同一个 id** |
| 去重 | 重复投递同一批 op 不新增冲突行 |
| 顺序无关 | 任意拉取/应用顺序下，冲突集合与状态摘要都必须收敛 |
| 解决 | `keep_winner`/`keep_loser`/`custom` 各写一条普通 `set` op |
| 解决后收敛 | `keep_loser` 在所有设备收敛并关闭冲突；`keep_winner` 关闭解决方，其他设备保持"待处理"（刻意行为，见 `sync-protocol.md` §4.1） |
| 幂等 | 重复解决同一冲突为 no-op |
| 版本向量 | 被丢弃的落败写入**必须**合并版本向量 |

---

## 8. 阶段验收门槛

每个阶段的"完成定义"（规格 §11.4）：功能实现 + 单元测试 + 集成测试 + 关键错误路径 + 迁移覆盖 + 文档更新 + **在目标平台实际运行** + 已知问题记录。

| 阶段 | 准入门槛（必须全部满足） | 阻断性测试 |
| --- | --- | --- |
| P0 骨架 | 应用在 Windows 与 Android 都能启动；数据库创建与迁移框架可用 | T-DB-STRICT, T-DB-FK-ON, T-MIG-1-FORWARD, T-ARCH-LAYERING |
| P1 快速记录 | 提交即持久化；重启不丢；写失败保留输入 | T-INT-RESTART-PERSIST, L4 部分旅程 C |
| P2 任务与临时事项 | 状态机 + 转换去重/撤销 + 提醒状态落库 | T-UNIT-TASK-STATE, T-UNIT-CONVERT-*, T-UNIT-REMINDER-STATE |
| P3 项目标签关系 | 聚合不复制；删除不级联；标签规范化 | T-INT-PROJECT-AGGREGATE, T-INT-PROJECT-DELETE-KEEPS-HISTORY, T-UNIT-TAG-NORMALIZE |
| P4 日志与日记 | 正文不互相覆盖；引用不复制 | T-INT-MULTI-VIEW-SAME-OBJECT, T-PROP-MERGE-COMMUTATIVE |
| P5 时间记录 | 区间约束 + 计时持久化 + 两种统计 | T-UNIT-TIMERANGE, T-UNIT-INTERVAL-UNION, L4 旅程 D |
| P6 搜索与回顾 | 搜索 + 索引可重建 + 回顾不自动完成 | T-INT-SEARCH-REBUILD, L4 旅程 C |
| P7 备份恢复 | 真实恢复 + 失败回滚 + 迁移链 | T-BAK-ROUNDTRIP, T-BAK-RESTORE-FAIL-ROLLBACK, T-BAK-VERSION-OLD, T-BAK-TRUNCATED |
| P8 同步 | 20 条契约测试全过 + 双实例真实同步 | §7 全部 + L4 旅程 E |
| P9 发布 | Windows 与 Android 均能安装启动完成核心流程；无未覆盖 R1 风险 | 规格 §10.4 全部条款 |

---

## 9. 发布验收门槛（规格 §10.4 逐条对照）

| 规格条款 | 对应验证 |
| --- | --- |
| Windows 和 Android 均能安装、启动和完成核心流程 | L4 旅程 A–E 在两平台通过 |
| 所有核心数据对象有自动化测试 | 每个实体至少一条 L1 + 一条 L3 测试；覆盖率不设百分比目标，改设"每个实体每个字段策略都有测试" |
| 所有关键用户旅程通过端到端测试 | L4 五条旅程 |
| 数据库迁移测试通过 | T-MIG-* 全部 fixture |
| 备份与实际恢复测试通过 | T-BAK-ROUNDTRIP 等（§8 表格） |
| 不存在已知的高严重度数据丢失、重复写入或同步覆盖缺陷 | `risks.md` 所有 R1 项都有对应通过的测试；未覆盖的列入 `known-limitations.md` |
| 失败操作有清楚反馈，用户输入不会无提示丢失 | T-INT-RESTART-PERSIST 的失败注入分支 + L4 旅程 C |
| 提供可复现的构建、测试和发布步骤 | `README.md` + 构建脚本在干净环境验证 |
| 提供已知限制清单，不将未实现能力标记为完成 | `docs/known-limitations.md` 与实现逐项对照评审 |

---

## 10. 测试数据与隐私

- 测试 fixture 中**不得**包含真实个人数据。
- 崩溃报告与日志的脱敏由 `T-PRIV-NO-CONTENT` 守护。
- 备份/恢复测试在临时目录进行，不触碰用户真实数据目录。
- 大型测试（T-LOAD-100K）默认跳过，由显式标志启用，避免拖慢日常提交。
