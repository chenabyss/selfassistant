# phase-1-plan.md — 阶段 1 最小实现计划

> 依据用户授权："完成阶段 0 的可复现构建后，进入阶段 1，开始应用骨架和数据库的实际编码。
> 不要等待通知、MSIX、Android 性能等所有后续验证结束才开始基础开发。"
>
> 本计划只覆盖**阶段 1 的最小范围**，不提前做后续切片的功能。

---

## 1. 阶段 1 的目标（一句话）

**建立"所有后续功能都必须遵守"的地基**：单一数据库入口、手写迁移框架、
唯一写入路径、快速记录的可靠持久化、日志脱敏、可恢复的备份骨架。

阶段 1 **不实现**任务/项目/时间记录/搜索/同步的完整功能——那些是后续切片。

---

## 2. 交付物清单

### 2.1 目录结构（阶段 1 创建）

```
app/
├─ pubspec.yaml                     ✅ 已创建（阶段 0）
├─ analysis_options.yaml            ☐ 启用严格 lint + 自定义规则
├─ packages/
│  ├─ domain/                       ☐ 纯 Dart，无 Flutter/drift/dart:io 依赖
│  │  ├─ lib/src/value_objects/     EntityId, Hlc, VersionVector, TimeRange, TzInstant
│  │  ├─ lib/src/entities/          InboxItem 及通用实体基类
│  │  ├─ lib/src/rules/             状态机、标签规范化、区间并集、UUIDv7
│  │  └─ lib/src/ports/             Clock, Logger, AttachmentStore, BackupTarget
│  ├─ application/                  ☐ 纯 Dart，用例与事务边界
│  │  └─ lib/src/use_cases/         CaptureInboxItem, ArchiveInboxItem, ...
│  └─ infrastructure/               ☐ drift / sqlite3 / 平台适配
│     ├─ lib/src/db/                connection.dart（单一入口）, schema, migrations
│     ├─ lib/src/logging/           脱敏 Logger 实现
│     └─ lib/src/backup/            BackupWriter 骨架
└─ apps/life_app/                   ☐ UI 外壳
   ├─ lib/main.dart
   └─ lib/src/pages/                空状态、收集箱占位
```

### 2.2 具体交付项

| # | 交付物 | 验收要点 | 对应需求 |
| --- | --- | --- | --- |
| 1 | **单一数据库入口** `connection.dart` | 全部 PRAGMA 集中设置（WAL / foreign_keys / busy_timeout / synchronous）；**加密开关只需改这一处** | R-TECH-36 |
| 2 | **手写迁移框架** | `v1→v2` 假迁移的正向 + 回滚测试；迁移前自动 `VACUUM INTO` 快照并验证 | R-TECH-02/04、T-MIG-* |
| 3 | **完整 schema v1** | `data-model.md` §2–§3 全部表；`STRICT`；CHECK/FK 约束；`field_schema` 预声明 | T-DB-STRICT、T-DB-FK-ON、T-DB-FIELD-SCHEMA |
| 4 | **唯一写入路径** | 单事务写 `op` + 物化 + `field_register` + `sync_outbox`；**不含 `audit_log`**（S2） | ADR-0007 |
| 5 | **快速记录持久化** | 提交即落库；写失败保留输入 + 草稿兜底；杀进程后不丢 | R-INBOX-01/02、T-INT-RESTART-PERSIST |
| 6 | **日志脱敏** | 日志不含正文/密钥；有扫描测试 | R-TECH-25、T-PRIV-NO-CONTENT |
| 7 | **备份骨架** | `VACUUM INTO` 一致性快照 + `manifest.json` + `SHA256SUMS`；恢复拒绝路径不改现场 | R-TECH-18~21 |
| 8 | **分层守护脚本** | `tool/check_layering.dart`：domain/application 不得 import Flutter/drift/dart:io | T-ARCH-LAYERING |
| 9 | **auditProjection 移植** | 把原型的历史投影逻辑移植为 Dart 并测试 | S2 |
| 10 | **UI 外壳** | 5 个主导航 + 空状态说明（不是空白页）+ 快速记录入口 | R-UX-05、规格 §3 |

---

## 3. 阶段 1 必须通过的测试

从 `testing.md` 与 `phases.md` P1 摘取，作为阶段 1 的准入条件。

### 3.1 架构与约束

| 测试 | 判据 |
| --- | --- |
| T-ARCH-LAYERING | `domain`/`application` 不 import flutter / drift / dart:io（AST 扫描） |
| T-DB-STRICT | 所有业务表为 `STRICT`（`PRAGMA table_list` 断言） |
| T-DB-FK-ON | **每个新连接** `foreign_keys=1`（不是一次全局） |
| T-DB-WAL | `journal_mode=wal`；并发读写无 `database is locked` |
| T-DB-CONSTRAINTS | 每个 CHECK/UNIQUE 都有"违反即抛错"测试 |
| T-DB-FIELD-SCHEMA | `field_schema` 内容与 `data-model.md` §5 表格**逐项一致**；未声明字段写入抛错 |

### 3.2 核心不变量

| 测试 | 判据 |
| --- | --- |
| **T-DB-REPLAY** | 随机 op 序列 → **物化状态 == 重放 op 的状态**。这是后续一切正确性的基础 |
| T-OPLOG-COMPACT | 压缩后每个对象的当前状态与压缩前全等（ADR-0005） |

### 3.3 迁移

| 测试 | 判据 |
| --- | --- |
| T-MIG-1-FORWARD | v1 fixture 打开并升级成功 |
| T-MIG-ROLLBACK | 迁移中途注入失败 → 自动回滚，库为旧版本且数据完好 |
| T-MIG-TOO-NEW | `user_version` > 代码版本 → **拒绝打开且不写入** |
| T-MIG-PRESNAPSHOT | 迁移前快照存在且通过 `quick_check` |

### 3.4 持久化与隐私

| 测试 | 判据 |
| --- | --- |
| T-INT-RESTART-PERSIST | 提交后关闭并重开 → 记录仍在，内容全等 |
| T-PROP-CRASH-MID-WRITE | 写入事务各点杀进程 → 要么全生效要么全不生效；输入不丢 |
| T-PRIV-NO-CONTENT | 写入含敏感正文 → 扫描日志文件不含正文片段 |
| T-BAK-TRUNCATED | 截断归档 → **拒绝恢复且现场不变** |
| T-BAK-ROUNDTRIP（骨架级） | 空库恢复逐表比对全等 |

### 3.5 同步契约移植（阶段 1 就开始，不等到阶段 9）

| 测试 | 判据 |
| --- | --- |
| 43 条契约测试 | `prototype/sync-core/` 的 43 条**逐条移植为 Dart 测试**并全部通过 |

> **为什么提前到阶段 1**：这些测试是纯逻辑，不需要 UI 或真机，
> 而阶段 2 起的所有写入都要经过这条路径。
> 用户已明确："33 条同步契约测试继续作为同步阶段的最低准入条件"，
> 且"每次修复并发逻辑时，必须补充对应的回归测试"。

---

## 4. 明确的非目标（阶段 1 不做）

| 不做 | 原因 |
| --- | --- |
| 任务/项目/标签/时间记录/日记的完整功能 | 属于阶段 2–6 切片 |
| 同步的实际推送/拉取 | 阶段 9；且需先部署 relay |
| 通知调度实现 | 阶段 3 |
| 搜索实现（trigram 接入） | 阶段 7；方案已定，但接入不在骨架里 |
| 本地库加密引擎 | Q4b 已定 L0；只预留接口 |
| 任何 UI 美化 | 阶段 1 只要"能启动 + 空状态可读 + 快速记录可用" |

---

## 5. 执行顺序（每步都可独立验证）

```
S1. 创建 packages 骨架 + analysis_options + check_layering.dart
    → 验证：T-ARCH-LAYERING 通过（此时还没有实现，只验证依赖方向）

S2. domain 值对象（EntityId/UUIDv7、Hlc、VersionVector、TimeRange、TzInstant）
    → 验证：单元测试 + T-UNIT-ID-UNIQUE + T-UNIT-VV-COMPARE + T-UNIT-HLC

S3. 移植原型合并逻辑为 Dart（merge/vvec/hlc/field_schema）
    → 验证：43 条契约测试全部通过（此时用内存存储，不接 SQLite）

S4. infrastructure/db：connection.dart + schema v1 + 迁移框架
    → 验证：T-DB-STRICT/FK-ON/WAL/CONSTRAINTS/FIELD-SCHEMA + T-MIG-*

S5. 唯一写入路径 + 物化表读写
    → 验证：T-DB-REPLAY（核心不变量）

S6. application：CaptureInboxItem 等最小用例 + 草稿兜底
    → 验证：T-INT-RESTART-PERSIST + T-PROP-CRASH-MID-WRITE + 写失败注入

S7. 日志脱敏
    → 验证：T-PRIV-NO-CONTENT

S8. 备份骨架
    → 验证：T-BAK-TRUNCATED + 骨架级 T-BAK-ROUNDTRIP

S9. UI 外壳 + 空状态 + 快速记录入口
    → 验证：两端能启动；Windows 可纯键盘完成"新建→输入→提交"

S10. 阶段 1 收尾：更新文档、known-limitations、平台验证清单状态
```

**每步都要求在两个目标平台上"实际运行"**（`phases.md` 的纪律），
但受工具链限制，平台运行项在工具链就绪前登记为"待执行"。

---

## 6. 阶段 1 的已知风险与对策

| 风险 | 对策 |
| --- | --- |
| 本机无法编译 Flutter → 无法验证 | 纯 Dart 部分（S1–S7）可先做；Flutter 相关（S9）需工具链或 CI |
| 移植 43 条测试工作量大 | 但这正是"字段级同步"的成本，且提前做能避免后续返工 |
| 写放大（RV-8） | 阶段 1 结束时记录数据库增长趋势，为 F3 提供基线 |
| 迁移框架是高风险路径 | 从一开始就用手写迁移 + 快照 + 回滚测试（不等到有真实用户数据） |

---

## 7. 阶段 1 退出标准

同时满足以下全部条件才算完成：

1. 上表 **§3 的全部测试通过**（43 条契约测试 + T-DB-REPLAY 为硬性门槛）；
2. 应用在**至少一个目标平台**上能启动并完成"快速记录 → 重启 → 仍在"；
3. 备份骨架能产出归档，且**截断归档被拒绝恢复**；
4. 日志脱敏测试通过；
5. `README.md`、`known-limitations.md`、`platform-verification-checklist.md` 状态已更新；
6. 未完成项**明确登记**，不得标记为已完成。

**注意**：条件 2 在工具链就绪前无法完全满足。
此时阶段 1 的状态记为"**代码完成，平台验证待执行**"，
而不是"阶段 1 完成"——两者必须区分（用户明确要求）。
