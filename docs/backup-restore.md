# backup-restore.md — 备份格式、版本兼容与恢复流程

> 规格 §8.4 要求。核心原则：**同步 ≠ 备份**。同步保证"多设备一致"，
> 备份保证"能回到过去"。误删、错误合并、库损坏、迁移失败，同步都救不了。
> 规格 §8.4 还明确要求"必须执行实际恢复测试，而不仅是测试备份文件能否生成"。

## 1. 为什么必须与同步分开

| 场景 | 同步能救吗 | 备份能救吗 |
| --- | --- | --- |
| 手机离线写了 3 天 | ✅ | ❌（旧备份没有这些数据） |
| 误删一条日记，10 分钟后发现 | ⚠️ 仅当墓碑/审计还在，且没有第 4 台设备复活 | ✅ |
| 某次错误合并且已传播到所有设备 | ❌ | ✅ |
| 数据库文件损坏 | ❌ | ✅ |
| 迁移把字段写错 | ❌ | ✅ |
| 设备丢失 | ✅（其他设备有数据） | ✅ |

结论：两者都要，且**互不替代**。UI 上要分别显示"上次同步"与"上次备份"。

## 2. 备份内容与格式

### 2.1 归档结构

```
life-backup-2026-10-12T09-30-00Z-<deviceShortId>.zip
├─ manifest.json
├─ SHA256SUMS                  # 逐文件校验和
├─ database.sqlite             # 一致性快照（VACUUM INTO 产生）
├─ attachments/
│   └─ <sha256>                # 内容寻址，无扩展名（媒体类型在 manifest 里）
└─ README.txt                  # 纯文本说明：如何恢复、格式版本
```

### 2.2 `manifest.json`

```json
{
  "format_version": 1,
  "app_version": "0.1.0+1",
  "schema_version": 7,
  "sqlite_version": "3.53.4",
  "tzdb_version": "2026a",
  "created_at_utc_ms": 1791796800000,
  "device_id": "0192f...",
  "device_name": "Windows-Desktop",
  "platform": "windows",
  "counts": { "entity": 8123, "op": 45120, "task": 231, "time_entry": 1890 },
  "attachments": [
    { "sha256": "ab12…", "bytes": 20480, "media_type": "image/png", "display_name": "grid-failure.png" }
  ],
  "includes": { "database": true, "attachments": true, "blobs_pending": 0 },
  "excludes": ["本地设备设置", "通知调度状态", "第三方凭据"],
  "archive_sha256": "…",
  "notes": "attachments 默认包含；blobs_pending>0 表示有附件未被包含（见 §2.4）"
}
```

**`schema_version` 与 `format_version` 分开**：前者是数据库结构版本（决定迁移路径），
后者是归档容器版本（决定能否被当前版本解析）。两者都要检查。

**`tzdb_version` 必须记录**：时区规则更新会重新解释历史本地时间
（例如某国取消夏令时），没有它就无法复现当时的"某天几点"。

### 2.3 快照生成方法（决定性选择）

| 方法 | 是否一致性快照 | 是否安全用于使用中的库 | 结论 |
| --- | --- | --- | --- |
| 直接复制 `.db` 文件 | ❌ | ❌ 事务进行中可能得到"半旧半新"的损坏文件 | **禁止** |
| 复制 `.db` + `-wal` + `-shm` | ⚠️ 需严格同时点 | ❌ 极易漏文件；WAL 是持久状态的一部分，分离会丢已提交事务或损坏库 | **禁止** |
| SQLite 在线备份 API | ✅ | ✅ 可增量、锁窗口短 | 可选 |
| **`VACUUM INTO 'path'`** | ✅ 事务性一致性快照 | ✅ 单条语句，产物紧凑并清除已删除内容 | **采用** |

**采用 `VACUUM INTO` 的理由**：一条语句、事务性、天然一致性、产物紧凑
（等于顺便做了压缩），并且彻底消除"忘记带 `-wal`"这一整类故障。

注意事项：
- 目标文件必须**不存在**（或为空），因此写到临时路径再打包。
- 产物约为库大小的 2 倍峰值空间——备份前要检查剩余空间。
- **被打断可能留下不完整产物**，所以先写到 `.tmp`，校验通过后才改名/打包。
- 它会改变没有 `INTEGER PRIMARY KEY` 的表的 ROWID。
  我们的模型全部使用 TEXT 主键，天然规避；但仍需在恢复后跑一致性校验。

备份前可选执行 `PRAGMA wal_checkpoint(TRUNCATE)` 让产物更干净。

### 2.4 附件包含策略

- **默认包含**（规格 §8.4 要求"必须说明附件是否包含在内"，默认值必须明确写出）。
- 提供"仅数据库"模式（体积小、快），此时 `manifest.includes.attachments=false`，
  恢复后附件显示为 `remote_only`/`missing` 占位，**不静默丢失引用**。
- 归档 > 200 MB 时提示用户改用"仅数据库"。单个附件上限 50 MB（需求 ⚠GAP-21）。
- 未能包含的附件计入 `attachments.blobs_pending`，并在 UI 明确显示数量。

### 2.5 加密（⚠GAP-19）

- **默认不加密**。理由：与服务 §8.5"不把本地优先宣传成绝对安全或自动加密"一致，
  且避免"用户忘记口令 → 备份等于没有"的经典失效。
- 提供**可选**口令加密：AES-256-GCM，密钥由 **Argon2id** 从口令派生。
  加密时不压缩（先压缩再加密，且不泄露长度分布以外信息）。
- 界面必须明确：**忘记口令无法恢复**（没有后门、没有恢复码）。
- 若用户启用加密，`manifest.json` 保持明文（只含元数据，不含内容），
  便于恢复前检查版本兼容性；正文与附件加密。

## 3. 完整性校验

打包时计算并写入 `SHA256SUMS`；归档本身也在 `manifest.archive_sha256` 中登记。

恢复前依次执行（**顺序有意义**）：

1. ZIP 结构可读、条目齐全（`manifest.json` + `database.sqlite`）。
2. 逐文件比对 `SHA256SUMS`（检测传输/存储损坏）。
3. `PRAGMA application_id` 匹配（防止把别的应用的 SQLite 当备份导入）。
4. 打开快照 **只读**，执行 `PRAGMA quick_check`
   （O(N)，比 `integrity_check` 快；跳过 UNIQUE 与索引内容校验）。
5. 若 `quick_check` 有疑问或用户显式选择"完整校验"，再跑 `PRAGMA integrity_check`
   （O(N log N)，默认最多报 100 个错误）。
6. **`PRAGMA foreign_key_check`**——`integrity_check` **不检查外键**，必须单独跑。
7. `PRAGMA user_version` == `manifest.schema_version`。
8. 行数与 `manifest.counts` 对照（允许"备份后无变化"之外的差异必须解释）。
9. blob 哈希抽检（至少全部附件的哈希与文件名一致）。

**`integrity_check` 检测不到的**（必须在文档中写明，避免虚假安全感）：

- **逻辑错误**：schema 合法但数据语义错（时区写错、错误合并）。任何 PRAGMA 都测不出。
- 外键违规（需 `foreign_key_check`）。
- 部分检查 `integrity_check(tablename)` 无法发现空闲页/重复使用页。
- 若曾用已废弃的 `case_sensitive_like` 重定义 LIKE，`integrity_check` 会**误报**损坏。
- SQLite 不提供冗余，假设硬件/OS 会报告位错误。

**版本相关的已知缺陷**：SQLite 的 **WAL reset bug** 影响 3.7.0–3.51.2，
在 3.51.3（2026-03-13）修复，触发条件是 ≥2 个连接同时写入/检查点。
本项目通过 `package:sqlite3` 打包 **SQLite 3.53.4**（已核实其 changelog：
3.5.0→3.53.3、3.5.1→3.53.4），不受影响。
`manifest.sqlite_version` 记录实际值，防止将来降级。

## 4. 恢复流程（"恢复失败不得覆盖唯一可用数据"）

```
RestoreFromBackup(archivePath, mode):
  ── 阶段 1：解包到暂存区（绝不直接落到 app 数据目录）
     staging = <appTemp>/restore-<uuid>/
     解压 + 校验 SHA256SUMS + 读 manifest
     失败 → 删除暂存区，结束（现场未动）

  ── 阶段 2：只读验证暂存区的库
     open(readOnly) → quick_check → foreign_key_check → user_version → 行数
     失败 → 删除暂存区，结束（现场未动）

  ── 阶段 3：为"当前数据"做保护性快照
     preRestore = <appData>/pre_restore_<ts>.db   （VACUUM INTO）
     验证 preRestore（同阶段 2 的检查）
     失败 → 中止（宁可不恢复，也不要在无保护的情况下动现场）

  ── 阶段 4：确认与交换（需要用户显式确认）
     acquire restore lock（拒绝并发的 sync / 后台任务）
     关闭所有数据库连接
     把旧的 db / -wal / -shm 作为**一个整体**移入 rollback 目录
     rename(暂存区/database.sqlite → appData/life.sqlite)   [同卷操作]
     迁移到当前 schema（若备份来自更旧版本）
     重建 FTS 索引、清理 sync_outbox/sync_cursor 的过期状态

  ── 阶段 5：启动自检与收尾
     打开新库，跑 application 层自检（关键查询）
     成功 → 保留 preRestore 与 rollback 目录，UI 提示"可回退"（保留 7 天）
     失败 → 用 preRestore 回滚，报告失败原因，**保留两份现场**供诊断
```

关键不变量：

1. **任何失败路径都不修改现场**（阶段 1–3 全部只读或只写新文件）。
2. **交换是一个整体动作**：`.db` 与 `-wal`/`-shm` 必须一起移动。
   SQLite 靠文件名在同目录寻找热日志，错配是官方列出的损坏原因之一。
3. **交换前一定存在至少一份不依赖本次恢复动作的副本**（`preRestore`），
   且在 app 数据目录之外另有一份不可变副本（用户的备份文件本身就是）。
4. 交换用 `rename`（同卷原子），不用"复制后删除"。
5. 恢复后按当前版本执行迁移；迁移失败则回滚到 `preRestore`。

## 5. 迁移与备份的关系

### 5.1 升级前自动备份（§8.2 要求）

每次数据库 schema 迁移前，自动执行 `VACUUM INTO pre_migration_v<N>_<ts>.db`，
验证通过后才执行迁移。迁移失败 → 自动回退并保留现场。

保留策略：最近 3 次迁移前快照 + 最近 7 天，超出自动清理（并在 UI 可见）。

### 5.2 恢复旧版本备份

| 备份 schema | 当前 schema | 行为 |
| --- | --- | --- |
| 相同 | 相同 | 直接恢复 |
| 更旧 | 更新 | 恢复后**顺序执行**迁移链（v5→v6→v7…），每步都有测试覆盖 |
| 更新 | 更旧 | **拒绝**，提示"该备份来自更新版本的应用"，给出升级应用的建议 |

`format_version` 与 `schema_version` 不同组合都要有明确文案，**不得**猜测。

## 6. 导出（§8.4 要求的可读格式）

导出与备份是两件事：备份是**一等可恢复**格式，导出是**给别人/别的工具看**的格式。

| 格式 | 内容 | 明确限制 |
| --- | --- | --- |
| JSON | 全部对象 + 关系 + 字段（含 `id`、时间戳、时区） | 完整，推荐用于再导入 |
| CSV | 每种对象一个文件（`task.csv`、`time_entry.csv`…） | 关系导出为 `relations.csv`（三列：来源 id / 字段 / 目标 id）；正文中的换行/引号按 RFC 4180 转义 |
| Markdown | 日记、日志、结论（按日期） | **仅正文**，不含关系与附件；明确标注"只读导出" |
| 附件 | ZIP 中的 `attachments/` | 仅本机已存在（`present`）的 blob；缺失的在 `export-manifest.json` 中列为 `missing` |

导出**必须**同时产出 `export-manifest.json`（版本、时间、条目数、缺失项），
并在 UI 明确写出限制（§8.4 要求"富文本、附件和关系的完整导出需要明确限制"）。

> 与 Obsidian 的边界（§4.10、§12）：Markdown 导出是**单向快照**，
> V1 **不**实现双向同步、不解析 Obsidian 的 `[[wikilink]]`。

## 7. 自动备份（§8.4 "或明确说明 V1 的限制"）

V1 采用**明确的有限方案**，不假装拥有平台不具备的能力：

| 平台 | 能力 | V1 行为 |
| --- | --- | --- |
| Windows | 应用关闭后无可靠的定时执行（见 `dart-verification.md` §4） | 启动时检查"距上次备份 > N 天" → 提示一键备份；可选"退出时自动备份" |
| Android | `WorkManager` 可在应用未运行时执行（受 OEM 省电策略影响） | 每日/每周定期自动备份到应用私有目录或用户选的 SAF 目录 |
| 两者 | — | 备份数量上限（默认 7 份）、保留周期可配置 |

**限制必须写进 `known-limitations.md`**：Windows 上"应用从未启动则不会自动备份"。
不得在 UI 上声称"已自动备份"而实际依赖用户手动操作。

## 8. 测试要求（§8.4 "必须执行实际恢复测试"）

| 测试 | 内容 | 门槛 |
| --- | --- | --- |
| T-BAK-ROUNDTRIP | 造数据（含关系/附件/软删除/计时中）→ 备份 → 空库恢复 → 逐表比对 + 关系比对 + 附件哈希比对 | 全等 |
| T-BAK-CONSISTENT-SNAPSHOT | 备份过程中持续并发写入 → 快照仍通过 `quick_check` + `foreign_key_check` | 通过 |
| T-BAK-TRUNCATED | 截断归档 → 必须**拒绝恢复**且**现场不变** | 拒绝且不变 |
| T-BAK-CORRUPT-DB | 故意破坏快照中的页 → 必须检出并拒绝，现场不变 | 检出且不变 |
| T-BAK-VERSION-OLD | 用 v5 备份在 v7 应用恢复 → 迁移链执行成功 | 成功 |
| T-BAK-VERSION-NEW | 用"v9"备份在 v7 应用恢复 → 明确拒绝，现场不变 | 拒绝且不变 |
| T-BAK-RESTORE-FAIL-ROLLBACK | 在阶段 5 注入失败 → 自动回滚，数据等于恢复前 | 全等 |
| T-BAK-ATTACH-MISSING | 只备份数据库不含附件 → 恢复后引用显示缺失而非消失 | 显示缺失 |
| T-BAK-EXPORT-CSV-JSON | 导出后 JSON 再导入（阶段 8+）逐对象全等 | 全等 |
| T-BAK-ENCRYPTED | 加密备份：错口令拒绝、对口令恢复成功 | 通过 |
| T-BAK-LARGE | 10 万对象 + 1 GB 附件：备份/恢复时间与内存有记录，不 OOM | 记录并可接受 |

**发布门槛（§10.4）**：T-BAK-ROUNDTRIP、T-BAK-RESTORE-FAIL-ROLLBACK、
T-BAK-VERSION-OLD、T-BAK-TRUNCATED 必须在 Windows 与 Android 两个真实设备上通过，
不接受"只在单元测试里通过"。
