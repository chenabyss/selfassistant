# 技术决策记录（ADR）

本目录保存影响架构的决策。每条 ADR 记录：背景、决策、理由、后果、被否决的方案、开放项。

格式约定：
- 文件名 `NNNN-短标题.md`，编号一旦分配不复用。
- 状态：**提议** / **已决定** / **已废弃（由 ADR-NNNN 取代）**。
- 修改已决定的事项时，**新增**一条 ADR 并把旧的标为已废弃，不直接改写历史。

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-client-stack-flutter.md) | 客户端采用 Flutter（Windows + Android） | 提议（待工具链实测） |
| [0002](0002-local-database-drift-sqlite.md) | 本地数据库采用 SQLite（drift + `package:sqlite3` 3.x，手写迁移） | 已决定 |
| [0003](0003-sync-model-op-log-and-version-vectors.md) | 同步采用自建 op-log + 字段级版本向量 | 已决定（通道待 Q2） |
| [0004](0004-attachments-content-addressed.md) | 附件内容寻址存储，与外部链接分成两个实体 | 已决定 |
| [0005](0005-tombstone-retention.md) | 墓碑策略与保留期 | 提议（数值待 Q3） |
| [0006](0006-notifications-and-platform-limits.md) | 通知与后台按"尽力而为"建模 | 已决定（打包待 Q6） |
| [0007](0007-single-write-path-oplog.md) | 写入路径唯一化：操作日志 + 物化状态双结构 | 已决定 |
| [0008](0008-fts-cjk-search.md) | 中文全文搜索采用 FTS5 `trigram` + 短查询 `LIKE` 回退 | **已决定**（依据实测；移动端待验证） |
| [0009](0009-backup-format-and-restore-safety.md) | 备份格式与恢复安全（`VACUUM INTO` + 五阶段恢复） | 已决定 |
| [0010](0010-conflict-visibility.md) | **并发修改必须用户可见（所有合并策略一致）** | 已决定（一项行为待 Q9d） |

## 决策速查

**已锁定的关键决策**

1. SQLite 3.53.4（由 `package:sqlite3` 3.x 打包，含 FTS5），drift 作访问层，**手写迁移**。
   **不用** `sqlite3_flutter_libs`（已 EOL）与 `drift_flutter`（依赖链含 EOL 包）。
2. 搬运单位是**字段级 op**，不是表行；每字段一份**版本向量** + **HLC** 总序。
3. 三种合并策略 `lww` / `text`（保留双版本）/ `set`（并集 + 逐元素墓碑），
   在 `field_schema` 中**预先声明**；**无 additive 合并**。
   **所有策略在"真并发且值不同"时都产生用户可见、可解决的冲突记录**（ADR-0010，
   修订了 ADR-0003 中"`lww` 静默取胜者"的部分）。
4. 删除走**墓碑**，`entity` 墓碑行**永久保留**（防止离线设备复活已删数据）。
5. 写入只有一条路径：`op` + 物化 + `field_register` + `sync_outbox` + `audit_log`，单事务。
6. 备份用 `VACUUM INTO` 一致性快照 + ZIP + `manifest.json` + `SHA256SUMS`；
   恢复分五阶段，**任何失败路径都不修改现场**。
7. 附件内容寻址（sha256），导入即复制，**不依赖用户原始路径**。
8. 通知与后台按"尽力而为"建模：调度结果落库、能力查询、启动补课。

**仍有待用户回答的问题**：见 `docs/design-report-v1.md` §6 与 `docs/requirements.md` §16。
