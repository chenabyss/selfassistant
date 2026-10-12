# ADR-0002：本地数据库采用 SQLite（drift + `package:sqlite3` 3.x，手写迁移）

- 状态：**已决定**
- 日期：2026-10-12
- 关联：规格 §8.2、§9.10、§9.11；`docs/data-model.md`；`docs/dart-verification.md` §3.1

## 背景

规格要求：本地关系型数据库（例如 SQLite）、schema 变化必须版本化迁移、
升级失败要保留可恢复数据、事务、约束保护 ID/外键/时间区间。
同时明确"不通过通用云盘直接同步正在使用的 SQLite 数据库文件"。

## 决策

1. **引擎**：SQLite，由 **`package:sqlite3` 3.7.0** 通过 Dart build hooks 打包
   （内含 **SQLite 3.53.4**，编译选项含 `SQLITE_ENABLE_FTS5`）。
2. **访问层**：`drift` 2.35.2（类型安全查询 + `NativeDatabase.createInBackground`）。
3. **不使用** `sqlite3_flutter_libs` / `sqlcipher_flutter_libs`（已 EOL）。
4. **不使用** `drift_flutter`（其依赖链仍指向上述 EOL 包）；
   改为手写 `NativeDatabase.createInBackground`。
5. **迁移手写**，不使用 `drift_dev` 的迁移生成器。

## 理由

### 为什么不用 `sqlite3_flutter_libs`

pub.dev 上 `sqlite3_flutter_libs` 最新版本为 `0.6.0+eol`，其 description 为
*"Not used anymore, update to version 3.x of package:sqlite3 instead"*，
且 `+eol` 版本**移除了包内全部代码**。
drift 官方文档明确：*"Starting from drift version 2.32.0, all native Dart and Flutter platforms
are supported without any further setup or dependencies. Older versions required the use of
`sqlite3_flutter_libs` … These are no longer necessary."*
继续依赖它等于把项目钉在已弃用路径上。

### 为什么打包 SQLite 而不用系统 SQLite

drift 文档给出的理由：系统自带的 SQLite 编译选项**不一致**，可能没有 FTS5，
版本也可能过旧。打包方案带来：
- 两个平台使用**同一份**构建 → 行为一致（对数据一致性至关重要）；
- 确定包含 FTS5、JSON1、RTREE、数学函数；
- 二进制有 sha256 校验 + SLSA level 3 attestation（3.5.2 起）。

代价：应用体积增加（数 MB），需在构建时下载预编译二进制（首次构建需要网络）。

### 为什么手写迁移而不用生成器

- 迁移是**最危险**的代码路径（风险 MG-1/2/4/5/8）。
- 自动生成的迁移难以审查，且容易在"重命名列/改约束"时生成破坏性 DDL。
- 手写迁移可以强制附加**断言**（行数、关联数、关键字段值），
  而生成器不会给你这个位置。
- 规格 §9.10 要求"迁移必须保留已有记录和关联"——这需要显式校验，不能靠生成器保证。

### 关键 PRAGMA（每个连接都必须设置）

```sql
PRAGMA journal_mode = WAL;      -- 一写多读；drift readPool 的前提
PRAGMA foreign_keys = ON;       -- 每连接生效，不是一次全局
PRAGMA busy_timeout = 5000;     -- 缓解 database is locked
PRAGMA synchronous = NORMAL;    -- WAL 下的常规取舍
```

### 版本安全（WAL reset bug）

SQLite 的 WAL-reset 缺陷影响 **3.7.0–3.51.2**，在 **3.51.3**（2026-03-13）修复；
触发条件是 **≥2 个连接同时写入/检查点**——正是本项目（单写 isolate + 读池 + 后台任务）的形态。
打包的 **3.53.4** 已超出修复版本。**因此本 ADR 明确要求**：
- 不允许降级到低于 3.51.3 的 SQLite；
- `manifest.json` 记录实际 `sqlite_version`；
- 阶段 0 的 V2 验证必须打印并断言 `sqlite_version()`。

## 后果

- **正面**：两端行为一致、FTS5 确定可用、依赖链干净、迁移可审查、加密可后置切换。
- **负面**：
  - 首次构建需联网下载 SQLite 预编译二进制（可按需改用内网镜像 `url_pattern`）。
  - 应用体积增加。
  - 手写迁移工作量更大（但这是刻意的取舍）。
  - `STRICT` 表要求 SQLite ≥3.37（已满足）。
- **切换加密的代价**（若 Q4 决定加密）：改 `pubspec.yaml` 的 hooks user_defines 为
  `source: sqlite3mc` 或 `sqlcipher`，并用新引擎重开数据库（需要一次性重写数据，
  不能原地加密）。因此**加密决策最好在阶段 1 之前确定**。

## 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 系统 SQLite（`source: system`） | 编译选项不确定，可能无 FTS5 |
| `sqflite` | 桌面支持弱，且不提供 FTS5/类型安全 |
| `drift_flutter` | 依赖链含 EOL 包 |
| `drift_dev` 迁移生成器 | 难以审查，不适合高风险路径 |
| ObjectBox / Realm / Hive | 非关系型；Realm 已停止服务；约束（CHECK/FK/STRICT）能力弱 |
