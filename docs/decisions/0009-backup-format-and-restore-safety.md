# ADR-0009：备份采用 `VACUUM INTO` 快照 + ZIP 清单，恢复采用五阶段交换

- 状态：**已决定**
- 日期：2026-10-12
- 关联：规格 §8.4、§8.2；`docs/backup-restore.md`

## 背景

规格 §8.4 的硬性要求：
手动备份、可配置自动备份或明确限制、备份含数据库与必要附件或明确标示、
包含版本信息、恢复前检查版本兼容性与完整性、
**"恢复失败不得覆盖唯一可用的数据"**、
**"必须执行实际恢复测试，而不仅是测试备份文件能否生成"**、
导出提供可读格式（CSV/JSON）并明确限制。

关键难点是**一致性快照**与**恢复安全**，这两点在规格里只给了要求，没给方法。

## 决策

### 1. 一致性快照：`VACUUM INTO`

```sql
VACUUM INTO '/tmp/backup-staging/database.sqlite';
```

先写临时路径，校验通过后才打包。

### 2. 归档格式：ZIP + `manifest.json` + `SHA256SUMS`

```
life-backup-<ISO8601>-<deviceShortId>.zip
├─ manifest.json      # format_version, schema_version, sqlite_version, tzdb_version,
│                     # created_at, device_id, counts, attachments[], includes/excludes
├─ SHA256SUMS         # 逐文件校验和
├─ database.sqlite    # VACUUM INTO 产物
├─ attachments/<sha256>
└─ README.txt
```

### 3. 恢复：五阶段，任何失败路径都不修改现场

```
阶段 1  解包到暂存区 + 校验 SHA256SUMS + 读 manifest
阶段 2  只读打开暂存库：quick_check → foreign_key_check → user_version → 行数比对
阶段 3  为当前数据做保护性快照（VACUUM INTO pre_restore_*.db）并验证
阶段 4  用户显式确认后：加恢复锁 → 关闭连接 → 旧 db+(-wal)+(-shm) 作为整体移入 rollback 目录
        → rename 暂存库到位 → 按需迁移
阶段 5  启动自检；失败则用 pre_restore 回滚，并保留两份现场供诊断
```

### 4. 可选加密：AES-256-GCM + Argon2id，**默认关闭**

### 5. 导出与备份分离

备份 = 一等可恢复格式；导出 = JSON / CSV / Markdown（只读快照）+ `export-manifest.json`。

## 理由

### 为什么用 `VACUUM INTO` 而不是文件复制或在线备份 API

SQLite 官方文档对三者的表述：

| 方法 | 官方表述 | 结论 |
| --- | --- | --- |
| 原始文件复制 | 事务进行中的复制"might contain some old and some new content, and thus be corrupt" | **危险** |
| 复制 db + `-wal` | WAL "is part of the persistent state of the database and should be kept with the database"；分离会丢已提交事务**或损坏文件** | **危险且易错** |
| 在线备份 API | 目标"becomes a bit-wise identical copy … as it was when the copying commenced"；可增量、锁窗口短 | 可行 |
| `VACUUM INTO` | "an alternative to the backup API for generating backup copies of a live database"；事务性、**一致性快照**、产物紧凑并清除已删除内容 | **采用** |

`VACUUM INTO` 胜出的决定性理由是**消除了一整类故障**：
不需要记得带 `-wal`，不需要管理锁窗口，一条语句给出事务性快照，
顺带压缩（清除已删除页）。对一个"必须实测恢复"的个人应用，
少一个可能的失误点比多一个性能选项重要。

**已知代价（必须处理）**：
- 目标文件必须不存在（故先写临时路径）；
- 产物约为库大小的 2 倍峰值空间 → 备份前检查剩余空间；
- **被打断可能留下不完整产物**（故先写 `.tmp`，校验通过后才打包）；
- 会改变没有 `INTEGER PRIMARY KEY` 的表的 ROWID（本项目全部用 TEXT 主键，规避）。

### 为什么恢复要分五阶段且"任何失败路径都不修改现场"

规格原文是"恢复失败不得覆盖唯一可用的数据"。达成它的唯一可靠方式
是让**所有可能失败的操作都发生在一个不影响现场的位置**：

- 阶段 1–3 只读现场或只写新文件；
- 只有阶段 4 才动现场，且此前**一定**存在 `pre_restore` 快照；
- 阶段 5 失败仍可回滚。

### 为什么 `.db` 与 `-wal`/`-shm` 必须作为整体移动

SQLite 官方列出的损坏原因包括："overwriting a database file without also deleting
any hot journal associated with the original database"。
SQLite 靠**同名同目录**寻找热日志，错配是明确列出的损坏场景。
因此交换用 `rename`，且三件套一起移动。

### 为什么用 ZIP 而不是 tar

Windows 原生工具支持 ZIP；备份文件很可能是用户在 Windows 上直接查看/解压的。
附件（已压缩格式如 JPEG/PNG）用 `STORED` 存储避免二次压缩浪费 CPU。

### 为什么记录 `tzdb_version`

时区规则更新会重新解释历史本地时间（例如某国取消夏令时）。
没有它，恢复后"某天几点"可能变化，且无法复现。这是时间语义完整性的必要组成部分。

### 为什么加密默认关闭

- 与规格 §8.5"不把本地优先宣传成绝对安全或自动加密"一致。
- "用户忘记口令 → 备份等于没有"是备份系统的经典失效模式，
  而备份的**首要**目标是能恢复。
- 因此：默认不加密（可恢复性优先），提供可选加密并明确告知无法找回。
- 相对地，**数据库本身**是否加密是另一个问题（Q4），
  它的取舍是"设备丢失时的隐私 vs 忘记口令时全库不可读"。

## 后果

- **正面**：快照一致性有官方文档背书；恢复的失败路径不触碰现场；
  附件可选；导出与备份职责清晰；备份可被第三方工具检查（ZIP + 明文清单）。
- **负面**：
  - `VACUUM INTO` 需要 2 倍峰值磁盘空间（需要空间检查与用户提示）。
  - 备份期间会持有一个读事务，可能短暂影响写入（可接受；否则会引入不一致）。
  - ZIP 内的数据库未加密时，任何拿到文件的人都能读取全部日记内容
    （必须在文档中明确，且引导用户把备份放在安全位置）。
- **强制测试**（规格 §8.4 要求"必须执行实际恢复测试"）：
  T-BAK-ROUNDTRIP、T-BAK-CONSISTENT-SNAPSHOT、T-BAK-TRUNCATED、T-BAK-CORRUPT-DB、
  T-BAK-VERSION-OLD、T-BAK-VERSION-NEW、T-BAK-RESTORE-FAIL-ROLLBACK、
  T-BAK-ATTACH-MISSING、T-BAK-ENCRYPTED。见 `backup-restore.md` §8。

## 相关决策

- ADR-0005：软删除保留 180 天，因此备份并不是"找回误删"的唯一途径。
- ADR-0002：迁移前自动做同样的 `VACUUM INTO` 快照。
