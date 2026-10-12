# architecture.md — 模块边界与依赖方向

## 1. 目标与约束

- **本地优先**：任何核心记录动作不依赖网络。设备本地 SQLite 是**持久化载体**，
  `op` 操作日志是**唯一的变更事实来源**（精确的权威性划分见 `data-model.md` §1.1——
  不要简写成"SQLite 是唯一权威"，那会被误读为物化表也是权威）。
- **可测试**：业务规则必须在**不启动 UI、不连接网络**的情况下可测。
- **可替换**：同步通道、通知、附件存储都是可替换适配器。
- **不越界**：不做通用关系/字段构建器，不做 AI 自动改正式数据。

## 2. 分层与依赖方向

依赖**只能向内**（上层依赖下层，下层不知道上层）。箭头方向 = 允许的依赖方向。

```
┌──────────────────────────────────────────────────────────────────────┐
│ apps/life_app  (UI 层)                                                │
│   pages/ (今日/收集箱/任务项目/时间日记/搜索) widgets/ shortcuts/       │
│   只做：渲染、输入、导航、把用户意图翻译成 UseCase 调用                  │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 调用
┌───────────────▼──────────────────────────────────────────────────────┐
│ application  (用例层，纯 Dart，无 Flutter 依赖)                        │
│   CaptureInbox · ProcessInboxItem · ConvertInboxItem · UndoConversion │
│   CompleteTask · StartTimer · StopTimer · LogTimeManually             │
│   BuildDailyReview · BuildProjectAggregate · GlobalSearch             │
│   BackupNow · RestoreFromBackup · SyncNow · ResolveConflict           │
│   事务边界在这里；每个用例 = 一个原子事务（或一个显式步骤序列）           │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 依赖接口
┌───────────────▼──────────────────────────────────────────────────────┐
│ domain  (领域层，纯 Dart)                                             │
│   entities/  (InboxItem, Task, Reminder, Project, TimeEntry,          │
│               LogEntry, JournalEntry, Conclusion, Tag, Attachment)    │
│   value_objects/ (EntityId, Hlc, VersionVector, TimeRange, TzInstant) │
│   rules/     (状态机、时间区间校验、标签规范化、重叠统计、转换去重)        │
│   ports/     (抽象接口，见 §3)                                         │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 实现
┌───────────────▼──────────────────────────────────────────────────────┐
│ infrastructure  (适配器实现)                                          │
│   db/        drift schema, migrations, DAOs, FTS5 索引, 事务           │
│   sync/      HttpRelayAdapter | FileFolderAdapter | NoopSyncAdapter   │
│   notif/     LocalNotificationsAdapter | NoopNotificationsAdapter     │
│   files/     ContentAddressedStore (sha256), 文件选择, 失效检测         │
│   backup/    BackupWriter, BackupReader, RestoreEngine                │
│   clock/     SystemClock | TestClock                                   │
│   logging/   结构化日志（**禁止**写入正文内容）                          │
└──────────────────────────────────────────────────────────────────────┘
```

**强制规则（可用测试守护）**

- `domain/` 与 `application/` **不得** import `package:flutter/*`、`dart:io`、drift、任何插件包。
  用 `dart analyze` + 自定义 lint/测试脚本守护（见 `testing.md` T-ARCH-LAYERING）。
- `domain/` 不依赖具体存储；它只认识 `ports/` 里的抽象接口。
- UI **不得**直接写数据库；所有写入经过 application 层用例（保证事务与审计一致）。

## 3. Ports（抽象接口）

| Port | 职责 | V1 实现 | 替换理由 |
| --- | --- | --- | --- |
| `Clock` | 提供当前时间与 HLC 打点 | `SystemClock` / `HlcClock` | 测试需要可控时间与时钟偏移 |
| `SyncTransport` | 推送/拉取变更批次、blob 上传下载 | `HttpRelayAdapter`、`FileFolderAdapter`、`NoopSyncAdapter` | 规格 §8.3 明确要求可替换 Sync Adapter |
| `NotificationScheduler` | 安排/取消提醒、查询权限 | `LocalNotificationsAdapter` | 平台能力差异必须可测试与可降级 |
| `AttachmentStore` | 内容寻址写入/读取/失效检测 | `LocalContentAddressedStore` | 备份与同步都要注入 fake |
| `BackupTarget` | 备份文件落盘位置 | 用户选择目录 | 测试用临时目录 |
| `Logger` | 结构化日志（脱敏） | `FileLogger` | §8.5 禁止记录正文 |

## 4. 模块清单与职责边界

| 模块 | 负责 | **不**负责 |
| --- | --- | --- |
| `db` | schema、迁移、事务、约束、索引 | 业务规则、UI 文案 |
| `sync` | 变更日志生成/读取、批次收发、游标、冲突落库 | 冲突的 UI 呈现（只产生"冲突"数据） |
| `backup` | 一致性快照、清单、校验和、恢复引擎 | 同步 |
| `search` | 索引维护、查询翻译 | 权威数据（索引可重建） |
| `notif` | 提醒调度、权限状态 | 提醒的业务含义（那属于 Reminder 实体） |
| `application` | 用例编排、事务边界、撤销 | 平台细节 |
| `ui` | 呈现与输入 | 直接持久化 |

## 5. 关键横切机制

### 5.1 写入路径（唯一)

所有写入都走「用例 → 事务 → 变更日志 → 物化状态」，即：

```
UseCase.mutate(entity, field, value)
  └─ BEGIN IMMEDIATE
       ├─ 校验（域规则）
       ├─ INSERT INTO op(op_id, entity_id, entity_type, op_type, field, value,
       │                 vv, hlc, device_id, strategy)   -- 追加，不可变
       ├─ UPSERT 物化表（task / time_entry / ...）
       ├─ UPSERT field_register(entity_id, field, vv, hlc, op_id)
       └─ INSERT INTO sync_outbox(op_id)                 -- 待推送
     COMMIT
```

**`audit_log` 不在写入路径内。** 它可由 `op` 重建（`data-model.md` §1.1 的分类），
因此在每次写入时同步落盘属于纯写放大。设计评审第 2 项建议（S2）将其改为
**懒生成 / 查询时投影**——见 `sync-options.md` §1 与待决问题 Q9c。
若采纳，写入行数减少约 20–25%。**在用户确认 Q9c 前，本图不包含 `audit_log`，
但实现时保留"需要时就地生成"的能力。**

这条单一写入路径同时满足：原子性、可追溯（§9.8）、可同步（§8.3）、可撤销、可测试。
**禁止**任何绕过它的直接 UPDATE。

### 5.1.1 冲突的产生与关闭（评审修订轮）

冲突**不在写入路径内产生**，而是在**应用远端 op 时**由合并判定产生：

```
applyOp(op)
  ├─ observeRemoteClock(op)                 -- 必须在此处，不能只在 pull()
  ├─ 判定：版本向量互不支配（真并发）？
  │     ├─ 否 → 普通编辑（apply / drop）
  │     └─ 是 → 值是否不同？
  │            ├─ 否 → 静默合并（并发但值相同不是冲突）
  │            └─ 是 → 写入 conflict 行（conflict_id 由两侧 op 哈希而成）
  ├─ 落败写入：无条件合并其版本向量（否则数据不可恢复）
  └─ 关闭判定：某次新写入支配了落败与获胜的并集 → 置 resolved
```

**四条必须遵守的规则**（每条都有原型测试守护，见 `testing.md` §7.2）：

1. 只在"真并发 **且** 值不同"时产生冲突；
2. 落败写入**必须**合并版本向量；
3. 关闭判据要求当前 op **既非落败也非获胜**（否则冲突会在创建瞬间被关闭）；
4. 冲突行**不参与同步**，由两端各自从 `op` 推导——因此不存在"冲突表同步"协议。

### 5.2 读取路径

- 列表/详情：直接读物化表（快）。
- 聚合视图（项目详情、今日、回顾）：**视图/查询**，不建缓存表（§9.4）。
- 搜索：FTS5 虚拟表 + 结构化筛选，索引可由 `search` 模块整表重建（§9.11）。

### 5.3 撤销模型

- 撤销 = 写入一条**新的反向操作**（补偿事务），不是删除历史。
- 转换撤销特别处理（§4.1 规则）：仅在目标对象**未被独立编辑**时自动删除；
  若有后续编辑，则只解除来源关系并提示（`UndoConversion` 的两个分支都有测试）。

### 5.4 冲突数据流

```
pull 批次 → MergeEngine.apply(op)
   ├─ lww  → 总序取胜者；**并发且值不同 → 落败值写入 conflict 表**
   ├─ text → 同上，且两版正文都保留在冲突记录中
   └─ set  → 逐元素合并（无冲突：并集保留）
conflict 表 → 冲突页面 / 对象详情横幅 → ResolveConflict 用例 → 新写一条 op
```

> **评审修订**：原设计只让 `text` 产生冲突记录，`lww` 的落败值仅留在 op 日志里。
> 这与"并发修改必须可见"矛盾，且落败写入未合并版本向量会导致数据**不可恢复**。
> 现规则见 §5.1.1。对应 `decisions/0010`。

### 5.5 冲突的 UI 契约

| 要求 | 实现 |
| --- | --- |
| 可见 | 对象详情页显示冲突提示；独立的冲突列表页 |
| 持久 | 冲突提示持续显示，**直到用户显式处理**（不自动消失） |
| 可解决 | 保留当前版 / 恢复落败版 / 自定义 |
| 计数 | 计入"待处理"，但**不**采用惩罚性文案（规格 §7） |
| 一致性 | 两台设备对同一次冲突显示**相同**的 `conflict_id` 与落败值 |

## 6. 状态与并发

- **UI 隔离**：drift 用 `NativeDatabase.createInBackground`，数据库在后台 isolate，
  避免同步写事务卡住 UI 线程（见 `dart-verification.md`）。
- **单写者**：SQLite WAL 允许"一写多读"。写入串行化在 application 层通过
  一个 `WriteQueue`（单串行队列）保证，避免 `database is locked`。
- **同步与写入互斥**：同步应用的远程批次必须在**一个事务**内完成，
  且与本地写入队列互斥；游标推进在**同一事务**内，保证崩溃后重放安全。

## 7. 目录结构（提议）

```
assistant/
├─ personal_life_system_v1_spec.md     # 原始规格（基准）
├─ README.md
├─ docs/
│  ├─ requirements.md            # 需求 + GAP 登记（41 项）
│  ├─ architecture.md            # 本文件
│  ├─ data-model.md              # 含权威性职责划分（§1.1）
│  ├─ sync-protocol.md           # 含冲突可见性规则（§4）
│  ├─ sync-options.md            # 同步方案复杂度评估
│  ├─ relay-deployment.md        # 自建 relay 部署方案
│  ├─ search-cjk-results.md      # 中文搜索实测结果
│  ├─ privacy-encryption.md      # 隐私与加密（四种边界分别分析）
│  ├─ platform-toolchain-plan.md # 通知能力 / MSIX / 工具链 / CI
│  ├─ backup-restore.md
│  ├─ testing.md
│  ├─ phases.md                  # 阶段拆分与退出标准
│  ├─ risks.md                   # 风险登记（47 项）
│  ├─ dart-verification.md       # 平台与技术验证结果
│  ├─ design-report-v1.md        # 首次响应汇总
│  ├─ review-revision-report.md  # 设计复审修订报告
│  ├─ known-limitations.md
│  └─ decisions/                 # ADR（10 条）
│     ├─ 0001-client-stack-flutter.md
│     ├─ 0002-local-database-drift-sqlite.md
│     ├─ 0003-sync-model-op-log-and-version-vectors.md
│     ├─ 0004-attachments-content-addressed.md
│     ├─ 0005-tombstone-retention.md
│     ├─ 0006-notifications-and-platform-limits.md
│     ├─ 0007-single-write-path-oplog.md
│     ├─ 0008-fts-cjk-search.md
│     ├─ 0009-backup-format-and-restore-safety.md
│     └─ 0010-conflict-visibility.md
├─ tools/                        # 实测与校验脚本（Node）
│  ├─ fts5-cjk-bench.mjs         # 中文搜索基准
│  ├─ probe-sqlite.mjs           # SQLite 能力探测
│  ├─ check-docs.mjs             # 文档内部一致性
│  └─ count-risks.mjs            # 风险数量校验
├─ prototype/sync-core/          # 同步核心可执行原型（Node，33 条测试）
└─ app/                          # Flutter 应用（阶段 1 起创建）
   ├─ packages/domain/           # 纯 Dart
   ├─ packages/application/      # 纯 Dart
   ├─ packages/infrastructure/   # drift / 插件适配
   └─ apps/life_app/             # UI
```

> 为什么先有 `prototype/sync-core/`：规格要求"编码前先设计同步协议"。
> 该原型把合并/幂等/墓碑/游标/冲突语义变成**可执行、可回归**的规格，
> 并已捕获 **8 个真实设计缺陷**（见 `sync-protocol.md` §9.3）。
> Dart 实现必须逐条移植这 33 条测试。

## 8. 构建与发布拓扑

| 目标 | 构建产物 | 关键依赖 |
| --- | --- | --- |
| Windows | `life_app.exe` + 依赖目录；可选 MSIX | Flutter desktop + Visual Studio「Desktop development with C++」 |
| Android | APK / AAB | Flutter + Android SDK + JDK |

两个平台共用同一份 Dart 代码；平台差异只允许出现在 `infrastructure/` 的适配器实现。

## 9. 明确不走的技术路线（及原因）

| 方案 | 拒绝原因 |
| --- | --- |
| 用云盘同步 SQLite 文件 | 规格 §8.2 明令禁止；且必然产生 `.db-wal` 撕裂与不可恢复冲突 |
| 用整行 `updated_at` LWW 覆盖 | 会静默丢弃同一对象不同字段的并发修改（§8.3 禁止） |
| 用 CRDT/OT 全文合并（Automerge/Yjs 等） | V1 文本只需"保留两版 + 人工合并"，引入 CRDT 会带来体积、复杂度与迁移风险 |
| `sqflite` | 桌面支持弱；drift 原生方案在 Windows/Android 上统一且自带 FTS5 |
| 引入通用实体/字段构建器 | §2.2 明确排除 |
| 用 `drift_dev` 生成迁移 | 迁移必须逐版本手写并测试；自动生成的迁移难以审查（见 `decisions/0002`） |
