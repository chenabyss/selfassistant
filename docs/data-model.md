# data-model.md — 对象、字段、关系与删除规则

本文件是 V1 的权威数据模型。所有表名/字段名一旦进入阶段 1 即冻结，
后续变更必须走版本化迁移（见 `backup-restore.md` §5 与 `testing.md` T-MIG-*）。

约定：
- 所有时间戳 = **SQLite INTEGER，UTC epoch 毫秒**（不用 TEXT，避免排序/时区歧义）。
- 所有 `id` = **TEXT，UUIDv7**（时间有序、离线可生成、74 bit 随机）。
- 所有实体都带 `created_at/updated_at`，软删除用 `deleted_at`（NULL = 未删除）。
- 布尔用 INTEGER 0/1；枚举用 TEXT + CHECK 约束（可读、迁移时可直接改）。
- 每张业务表都用 `STRICT` 建表（SQLite 3.37+），防止类型漂移。

---

## 1. 为什么是"操作日志 + 物化状态"双结构

规格同时要求：稳定 ID（§9.1）、重要状态变化可追溯（§9.8）、同步幂等（§9.7）、
并发不静默丢弃（§8.3）、迁移保留关联（§9.10）。单个"直接改行"的表结构无法同时满足。

因此采用：

| 结构 | 作用 | 是否权威 |
| --- | --- | --- |
| `op`（追加不可变） | 变更的**因果与来源**，同步的搬运单位 | 是（历史） |
| 物化业务表（`task`、`time_entry`…） | 当前状态，供查询与 UI | 是（当前值，由 op 推导） |
| `field_register` | 每个字段的版本向量 + HLC | 是（合并判定依据） |
| `entity` | 对象身份、类型、创建/更新时间、墓碑 | 是 |
| `conflict` | 未决的文本冲突副本 | 是（待用户处理） |
| `sync_outbox` / `sync_cursor` | 同步待发队列与拉取游标 | 是（同步状态） |
| `search_fts` | 全文索引 | **否**，可随时重建（§9.11） |
| `audit_log` | 面向用户的历史展示 | 否，可由 `op` 重建 |

> 关键不变量：**物化状态永远等于把 `op` 按合并规则重放的结果**。
> 阶段 1 就要有测试：随机生成 op 序列 → 物化状态 vs 重放状态必须一致（T-DB-REPLAY）。

### 1.1 权威性职责（评审第 3 项要求写精确）

"SQLite 是唯一权威数据源"这种说法容易被后续开发者误读。准确表述如下：

| 角色 | 是什么 | **不是**什么 | 可否重建 |
| --- | --- | --- | --- |
| **SQLite 数据库** | 设备本地的**持久化载体** | 不是"权威"本身——它只是承载权威数据的容器 | ❌ |
| **`op` 操作日志** | **唯一的变更事实来源**：同步、重放、审计、撤销都依据它 | 不是缓存，不可丢弃，不可压缩掉因果信息 | ❌ |
| **物化业务表** | 当前状态的**物化表示**，由 `op` 推导 | **不是权威**；必须与 `op` 保持一致 | ✅ 由 op 重放 |
| **`field_register` / `set_element`** | 合并判定所需的元数据（版本向量、HLC、墓碑） | 不是用户数据 | ⚠️ 部分（由 op 重放可重建） |
| **`conflict`** | 待用户处理的并发分歧记录 | 不是同步单位；**由两端各自从 op 推导**，不跨设备同步行 | ✅ 由 op 重新推导 |
| **`search_fts`** | 纯索引 | **非权威**，可随时整表重建（规格 §9.11） | ✅ |
| **审计视图** | 由 `op` 投影出的历史视图（**不作为表存在**） | 不是第二套权威数据；**S2 已采纳：懒生成**，不在写入路径中持久化 | ✅ 由 op 重建 |
| **`sync_outbox` / `sync_cursor`** | 同步的待发队列与游标 | 不是业务数据 | ⚠️ 重建会重发，但 op 幂等所以安全 |
| **relay 服务端** | 变更**传输**与游标管理 | **不是独立业务账本**：不合并、不解决冲突、不存业务规则 | ✅（可从各设备重建，但不应依赖） |

> **S2 的含义**：`audit_log` 不作为独立表存在于写入路径中。
> 历史视图由 `op` 按需投影得到（`architecture.md` §5.1 的写入路径已不含它）。
> 这已在原型中实现并**证明可完整重建**
> （`prototype/sync-core/test/audit.test.js` 共 7 条测试，覆盖跨设备与跨重放顺序的历史一致性）。

**两条必须守住的推论：**

1. **`op` 日志不能被压缩掉因果信息。** 客户端可以压缩本地历史
   （`decisions/0005`），但必须保留 create / delete / 状态变更 / 转换事件；
   而**服务端日志不可随意截断**，否则长期离线的设备会失去因果依据
   （完整规则见 `relay-deployment.md` §6.3–6.4）。
2. **relay 不是权威。** 服务端不做合并与冲突解决，
   因此"服务端数据损坏"不会凭空改变业务语义——但会丢历史，所以服务端**同样必须备份**。

---

## 2. 通用表

### 2.1 `entity`（对象身份表）

```sql
CREATE TABLE entity (
  id           TEXT    NOT NULL PRIMARY KEY,      -- UUIDv7
  entity_type  TEXT    NOT NULL,                  -- inbox_item|task|reminder|project|
                                                  -- time_entry|log_entry|journal_entry|
                                                  -- conclusion|tag|attachment|external_ref
  created_at   INTEGER NOT NULL,                  -- epoch ms UTC
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,                           -- 软删除时间；NULL = 未删除
  archived_at  INTEGER,                           -- 归档时间；与删除不同
  delete_hlc   TEXT,                              -- 墓碑的 HLC，用于解决"删除 vs 并发编辑"
  pending_ops  INTEGER NOT NULL DEFAULT 0,        -- UI 用于显示"待同步"，非权威
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
) STRICT;
CREATE INDEX idx_entity_type_alive ON entity(entity_type, deleted_at, updated_at DESC);
```

**统一可见性矩阵（解决 ⚠GAP-05）**

| 状态 | `deleted_at` | `archived_at` | 默认列表 | 全局搜索 | 聚合视图 | 可恢复 |
| --- | --- | --- | --- | --- | --- | --- |
| active | NULL | NULL | ✅ | ✅ | ✅ | — |
| archived | NULL | 非空 | ❌（有"显示归档"开关） | ✅（标记为归档） | ✅（标记为归档） | ✅ 取消归档 |
| deleted（软删除） | 非空 | — | ❌ | ❌（仅"回收站"） | ❌ | ✅ 180 天内 |
| tombstoned（同步墓碑） | 非空 | — | ❌ | ❌ | ❌ | 见 §7 |

### 2.2 `op`（不可变操作日志）

```sql
CREATE TABLE op (
  op_id       TEXT    NOT NULL PRIMARY KEY,   -- UUIDv7，同时是同步幂等键
  device_id   TEXT    NOT NULL,
  entity_id   TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,
  op_type     TEXT    NOT NULL,               -- create|set|set_add|set_remove|delete|restore|resolve_conflict
  field       TEXT,                           -- create/delete 时 NULL；resolve_conflict 时存 conflict_id
  value_json  TEXT,                           -- 序列化值（TEXT/NULL 语义显式区分）
  strategy    TEXT    NOT NULL,               -- lww|text|set，冗余存储便于自解释
  vv_json     TEXT    NOT NULL,               -- 版本向量 {"device-A": 7, ...}
  hlc_p       INTEGER NOT NULL,               -- HLC 物理分量（epoch ms）
  hlc_l       INTEGER NOT NULL,               -- HLC 逻辑分量
  hlc_d       TEXT    NOT NULL,               -- HLC 设备分量
  local_seq   INTEGER NOT NULL,               -- 本设备产生顺序（出站排序）
  conflict_of TEXT,                           -- 若该 op 是解决冲突产生的，指向被解决的 conflict
  created_at  INTEGER NOT NULL,
  CHECK (op_type IN ('create','set','set_add','set_remove','delete','restore','resolve_conflict')),
  CHECK (strategy IN ('lww','text','set')),
  -- 字段级 op 必须有 field；create/delete/restore 没有 field；
  -- resolve_conflict 的 field 承载 conflict_id（见下方说明）
  CHECK ((op_type IN ('create','delete','restore')) = (field IS NULL))
) STRICT;
CREATE INDEX idx_op_entity ON op(entity_id, hlc_p, hlc_l);
CREATE INDEX idx_op_local_seq ON op(local_seq);
-- 冲突解决 op 必须唯一且可查（用于派生"冲突是否已解决"）
CREATE UNIQUE INDEX idx_op_resolution ON op(field) WHERE op_type = 'resolve_conflict';
```

#### `resolve_conflict` op（S1，设计决策已采纳）

冲突的**解决**是一条显式 op，而不是各设备本地推导的状态：

| 列 | 内容 |
| --- | --- |
| `op_type` | `'resolve_conflict'` |
| `field` | `conflict_id`（因此 `field` 在语义上是"被解决的对象 id"） |
| `value_json` | 选择：`keep_winner` / `keep_loser` / `custom` |
| `entity_id` | 冲突所属对象 |
| 附加字段 | `value_op_id`（若该解决同时写入了一个值，指向那条值 op） |

**为什么必须显式同步**：用户在一台设备上选择"保留当前版本"时**字段值不变**，
其他设备没有任何可观察的信号，导致冲突长期显示待处理。
显式 op 让所有设备看到**同一条**解决记录（同 `op_id`），因此收敛且可审计。

**派生而非存储**：`conflict.resolved_at` / `resolution` 等字段是由 op 日志派生的
缓存值（每个设备从 `op` 重新计算），不是各自的真相来源——
这避免了"两台设备对同一次冲突是否已解决产生分歧"。

**`strategy` 冗余存储在 op 上，但合并时以 `field_schema` 为准**（原型实测到的缺陷，见 §8）。

### 2.3 `field_register`（合并判定依据）

```sql
CREATE TABLE field_register (
  entity_id  TEXT    NOT NULL,
  field      TEXT    NOT NULL,
  vv_json    TEXT    NOT NULL,
  hlc_p      INTEGER NOT NULL,
  hlc_l      INTEGER NOT NULL,
  hlc_d      TEXT    NOT NULL,
  op_id      TEXT    NOT NULL,
  PRIMARY KEY (entity_id, field),
  FOREIGN KEY (entity_id) REFERENCES entity(id) ON DELETE CASCADE
) STRICT;
```

### 2.4 `set_element`（集合语义：标签、多值关系）

```sql
CREATE TABLE set_element (
  entity_id  TEXT    NOT NULL,
  field      TEXT    NOT NULL,
  element    TEXT    NOT NULL,          -- 标签 id 或被引用对象 id
  present    INTEGER NOT NULL,          -- 1=在集合中，0=已被移除（逐元素墓碑）
  vv_json    TEXT    NOT NULL,
  hlc_p      INTEGER NOT NULL,
  hlc_l      INTEGER NOT NULL,
  hlc_d      TEXT    NOT NULL,
  op_id      TEXT    NOT NULL,
  PRIMARY KEY (entity_id, field, element),
  FOREIGN KEY (entity_id) REFERENCES entity(id) ON DELETE CASCADE
) STRICT;
```

> 为什么集合元素也要带墓碑：若无 `present=0` 记录，
> 「A 移除 / B 并发添加」会在下次同步时把已移除的元素"复活"。
> 原型 T-SETS-* 三条测试专门守护这一点。

### 2.5 `conflict`（并发修改的可见记录）

> **评审修订**：原设计把 `strategy='text'` 作为冲突记录的条件，
> 于是 `lww` 字段（任务状态、日期、单值关系）的并发写入被静默取舍，
> 与"并发修改必须可见"（§8.3）矛盾。现在**所有策略**在
> "真并发 + 值不同"时都写入本表，`strategy` 只用于区分呈现方式。

```sql
CREATE TABLE conflict (
  conflict_id     TEXT    NOT NULL PRIMARY KEY,   -- hash(losing_op, winning_op, field)
  entity_id       TEXT    NOT NULL,
  field           TEXT    NOT NULL,
  strategy        TEXT    NOT NULL,               -- lww|text|set，决定呈现方式
  losing_value    TEXT,                           -- 落败值（JSON 编码）
  losing_op       TEXT    NOT NULL,               -- 落败写入的 op id
  losing_hlc_p    INTEGER NOT NULL,
  losing_hlc_d    TEXT    NOT NULL,
  losing_vv_json  TEXT    NOT NULL,               -- 落败版本的版本向量
  winning_value   TEXT,
  winning_op      TEXT    NOT NULL,
  winning_vv_json TEXT,                           -- 获胜版本的版本向量
  detected_at     INTEGER NOT NULL,
  resolved_at     INTEGER,
  resolution      TEXT,                           -- keep_winner|keep_loser|custom|superseded
  resolution_op   TEXT,                           -- 解决动作产生的 op id
  both_versions_retained INTEGER NOT NULL DEFAULT 0,  -- text 策略为 1
  FOREIGN KEY (entity_id) REFERENCES entity(id) ON DELETE CASCADE,
  CHECK (resolution IS NULL OR resolution IN ('keep_winner','keep_loser','custom','superseded')),
  CHECK (losing_op <> winning_op)
) STRICT;
CREATE INDEX idx_conflict_open ON conflict(resolved_at, detected_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_conflict_entity ON conflict(entity_id, field);
```

**关键设计点（每条都有原型测试守护）：**

1. **`conflict_id = hash(losing_op, winning_op, field)`**，确定性生成。
   同一次冲突会在两台设备上各被观察一次（赢方应用落败 op 时、输方应用获胜 op 时），
   对**两侧**取哈希才能保证两处推导出**同一条**记录。
2. **`losing_vv_json` 与 `winning_vv_json` 都必须存**。
   关闭冲突时判据是"某次新写入的版本向量支配了两者的并集"，
   只有落败侧不足以区分 `keep_winner`（值不变）与"尚未处理"。
3. **冲突行本身不同步**，由两端各自从 `op` 推导；因此不存在"冲突表同步"这一额外协议，
   也不会有冲突行跨设备不一致的问题。
4. **`losing_op`/`winning_op` 均 `NOT NULL`**。原型中真实发生过
   `snapshot()` 读错字段名导致 `losing_op` 为 `undefined`、被 JSON 丢掉的情况，
   结果是冲突既无法解决也无法收敛。实现层对缺失 op id **直接抛错**，
   数据库层用 `NOT NULL` 与 `CHECK (losing_op <> winning_op)` 兜底。
5. **不记录也不展示"值相同的并发写入"**：那不是冲突。

### 2.6 `field_schema`（字段合并规则，**必须先声明**）

```sql
CREATE TABLE field_schema (
  entity_type TEXT NOT NULL,
  field       TEXT NOT NULL,
  strategy    TEXT NOT NULL,      -- lww|text|set
  PRIMARY KEY (entity_type, field),
  CHECK (strategy IN ('lww','text','set'))
) STRICT;
```

由代码在启动时 `INSERT OR IGNORE` 声明（内容见 `prototype/sync-core/src/schema.js`，
Dart 侧同表）。**未声明的字段写入必须抛错**，不得默认 LWW：
原型实测，若允许"先写后声明"，任何提前触碰该字段的代码路径（例如创建对象时写初始值）
会把它永久钉死在错误策略上。

### 2.7 同步状态表

```sql
CREATE TABLE sync_outbox (
  op_id     TEXT NOT NULL PRIMARY KEY,
  created_at INTEGER NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY (op_id) REFERENCES op(op_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE sync_cursor (
  peer_id      TEXT NOT NULL PRIMARY KEY,   -- relay 标识
  applied_seq  INTEGER NOT NULL DEFAULT 0,  -- 已应用的远端单调序号
  last_sync_at INTEGER,
  last_error   TEXT
) STRICT;

CREATE TABLE device (
  device_id   TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  last_seen_hlc_p INTEGER,
  skew_warned_at  INTEGER,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE blob (
  sha256     TEXT NOT NULL PRIMARY KEY,   -- 内容寻址（附件与备份导出共用）
  bytes      INTEGER NOT NULL,
  local_path TEXT,                        -- 相对 app 数据目录；NULL = 本设备没有该 blob
  state      TEXT NOT NULL,               -- present|missing|remote_only
  last_verified_at INTEGER,
  CHECK (state IN ('present','missing','remote_only'))
) STRICT;
```

### 2.8 附件与外部引用分开（解决 ⚠GAP-04）

```sql
-- 本地文件：内容寻址，本体在 blobs/ 目录，数据库只存元数据
CREATE TABLE attachment_meta (
  entity_id    TEXT NOT NULL PRIMARY KEY REFERENCES entity(id) ON DELETE CASCADE,
  sha256       TEXT NOT NULL REFERENCES blob(sha256),
  display_name TEXT NOT NULL,
  media_type   TEXT,
  bytes        INTEGER NOT NULL,
  captured_at  INTEGER
) STRICT;

-- 外部链接：只有 URL，无本体，不参与 blob 同步
CREATE TABLE external_ref_meta (
  entity_id TEXT NOT NULL PRIMARY KEY REFERENCES entity(id) ON DELETE CASCADE,
  url       TEXT NOT NULL,
  title     TEXT,
  last_checked_at INTEGER,
  reachable INTEGER            -- NULL=未检测, 1/0=上次检测结果
) STRICT;
```

**引用关系**用 `set_element(entity_id=<宿主对象>, field='attachments'|'external_refs', element=<附件/链接 id>)`。
删除宿主对象**不**删除 blob（§4.9）；blob 由孤儿清理任务处理（见 `backup-restore.md` §6）。

---

## 3. 业务对象表

以下各表都通过 `entity_id` 关联 `entity`，并带 `FOREIGN KEY ... ON DELETE CASCADE`。
所有 FK 都开启（`PRAGMA foreign_keys=ON`，每个连接都要设）。

### 3.1 `inbox_item`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `content` | TEXT NOT NULL | 原始内容，**必填**（§4.1） |
| `status` | TEXT NOT NULL | `inbox`/`deferred`/`processed`/`archived`/`deleted` |
| `deferred_until` | INTEGER | 稍后处理的时间点 |
| `deferred_reason` | TEXT | ⚠GAP-07 增补 |
| `processed_at` | INTEGER | ⚠GAP-07 增补 |
| `process_action` | TEXT | ⚠GAP-07 增补：`task`/`reminder`/`log`/`journal`/`time_entry`/`link`/`archive`/`delete` |
| `source_type` | TEXT | `manual`/`share`/`import`/`shortcut` |
| `source_inbox_id` | — | 不适用（自身即来源） |

```sql
CHECK (status IN ('inbox','deferred','processed','archived','deleted')),
CHECK (status <> 'deferred' OR deferred_until IS NOT NULL),
CHECK (status <> 'processed' OR processed_at IS NOT NULL)
```

### 3.2 `task`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `title` | TEXT NOT NULL | |
| `description` | TEXT | text 策略（冲突保留两版） |
| `status` | TEXT NOT NULL | `todo`/`in_progress`/`done`/`cancelled` |
| `previous_status` | TEXT | ⚠GAP-10 增补（"状态可恢复"） |
| `status_changed_at` | INTEGER | ⚠GAP-10 增补 |
| `project_id` | TEXT | 可空 FK → `entity(id)`；**单值**，1:1 |
| `parent_task_id` | TEXT | 可空 FK；**单值**，需防环 |
| `scheduled_date` | TEXT | `YYYY-MM-DD`（本地日，非时刻） |
| `due_at` | INTEGER | UTC 时刻（与上一行**不同语义**） |
| `next_action` | TEXT | text 策略 |
| `priority` | TEXT NOT NULL DEFAULT 'none' | `none`/`low`/`high`/`urgent`（⚠GAP-12） |
| `completed_at` | INTEGER | |

```sql
CHECK (status IN ('todo','in_progress','done','cancelled')),
CHECK (priority IN ('none','low','high','urgent')),
CHECK (status <> 'done' OR completed_at IS NOT NULL),
CHECK (parent_task_id IS NULL OR parent_task_id <> entity_id)
```

**防环**在 application 层实现（沿 `parent_task_id` 向上遍历，深度上限 16），
数据库层只做自引用 CHECK；测试用 property test 随机建链（T-UNIT-TASK-CYCLE）。

### 3.3 `reminder`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `content` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | `open`/`done`/`cancelled` |
| `remind_at` | INTEGER | 提醒时刻（可空） |
| `due_at` | INTEGER | 到期时刻（可空，**与提醒分开**） |
| `related_task_id` | TEXT | 可空 FK，单值 |
| `source_inbox_id` | TEXT | ⚠GAP-08 增补 |
| `completed_at` | INTEGER | |
| `notification_state` | TEXT NOT NULL DEFAULT 'none' | `none`/`scheduled`/`denied`/`failed`/`fired`/`cancelled` |

`notification_state` 是**规格 §4.3 的落地机制**：权限被拒绝时必须能显示"未生效"，
因此调度结果必须落库，不能只存在内存里。见 `decisions/0006`。

### 3.4 `project`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `name` | TEXT NOT NULL | |
| `description` | TEXT | |
| `status` | TEXT NOT NULL | `active`/`paused`/`completed`/`archived` |
| `start_date` | TEXT | `YYYY-MM-DD` |
| `target_date` | TEXT | `YYYY-MM-DD` |

`archived` 状态与 `entity.archived_at` 的关系：项目归档 = `status='archived'` **且** 写 `entity.archived_at`，
由同一个用例保证，测试守护两者一致（T-UNIT-PROJECT-ARCHIVE-CONSISTENT）。

### 3.5 `time_entry`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `start_at` | INTEGER NOT NULL | UTC ms |
| `end_at` | INTEGER | NULL = 仍在计时 |
| `tz_id` | TEXT NOT NULL | IANA 时区 ID（如 `Asia/Shanghai`），⚠GAP-04/§4.5 要求 |
| `category` | TEXT NOT NULL | 受控短列表 + 用户自定义（存 `label` 表，⚠GAP-11） |
| `description` | TEXT | |
| `timer_state` | TEXT NOT NULL DEFAULT 'stopped' | `stopped`/`running` |
| `source` | TEXT NOT NULL DEFAULT 'manual' | `manual`/`timer`（**移除 import**，⚠GAP-11） |

```sql
CHECK (end_at IS NULL OR end_at > start_at),           -- §4.5 / §8.2 硬约束
CHECK (timer_state IN ('stopped','running')),
CHECK ((timer_state = 'running') = (end_at IS NULL)),  -- running ⇔ 无结束时间，禁止伪造
CHECK (source IN ('manual','timer'))
```

**计时器持久化（⚠GAP-15）**：计时器 = 一行 `timer_state='running'` 的 `time_entry`。
跨重启恢复读取 `start_at` 重新计算已用时长，**不**依赖内存计数，也**不**在重启时改写历史。
同一设备同时最多一行 running（部分唯一索引）：

```sql
CREATE UNIQUE INDEX idx_time_running_one ON time_entry(timer_state) WHERE timer_state='running';
```

> 注意：多设备可能各自有 running 计时器，同步后会出现两行。
> 这是**合法**的（两台设备真的可以同时在计时），冲突策略见 `sync-protocol.md` §5.6。

任务/项目归属用 `set_element`（`field='task_refs'` / `'project_refs'`），
因为 §4.5 要求"任务或项目删除/归档时，历史时间记录不得无提示丢失"——
用集合关系 + 缺失指针提示实现，而不是外键级联。

### 3.6 `log_entry`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `title` | TEXT | 可空 |
| `body` | TEXT NOT NULL | text 策略 |
| `occurred_at` | INTEGER | 可空 |
| `source_inbox_id` | TEXT | ⚠GAP-09 增补 |

多任务/多项目/多结论/多附件全部走 `set_element`（解决 ⚠GAP-03）。

### 3.7 `journal_entry`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `journal_date` | TEXT NOT NULL | `YYYY-MM-DD`（本地日） |
| `body` | TEXT NOT NULL | text 策略 |
| `mood` | TEXT | V1 可不实现（保留列，默认 NULL） |
| `source_inbox_id` | TEXT | ⚠GAP-09 增补 |

同一日期允许多篇（`UNIQUE(journal_date)` **不加**）；提供 `(journal_date)` 索引供日历聚合。
引用任务/项目/日志/时间记录/结论走 `set_element(field='refs')`（解决 ⚠GAP-03）。

### 3.8 `conclusion`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `title` | TEXT NOT NULL | |
| `body` | TEXT NOT NULL | |
| `scope` | TEXT | 可空 |
| `occurred_at` | INTEGER | ⚠GAP-09 增补 |
| `source_inbox_id` | TEXT | ⚠GAP-09 增补 |

来源记录走 `set_element(field='source_refs')`（§4.10 要求可追溯）。

### 3.9 `tag`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `entity_id` | TEXT PK | |
| `name` | TEXT NOT NULL | 保留用户原始形态 |
| `name_key` | TEXT NOT NULL | **规范化后的比较键**（⚠GAP-13） |
| `color` | TEXT | 可空 |

```sql
CREATE UNIQUE INDEX idx_tag_name_key ON tag(name_key) WHERE name_key <> '';
```

`name_key` 生成规则（**冻结**）：`NFC → trim → 内部连续空白折叠为单个空格 → Unicode casefold`。
存储两个字段而不是只存规范形态，是为了既能去重、又保留用户输入的原始大小写。
测试：T-UNIT-TAG-NORMALIZE（含全角、emoji、组合字符）。

### 3.10 `relation`

规格 §5 列出的关系分为两类，**不建通用关系表**，而是复用 `set_element`：

| 规格关系 | 实现 |
| --- | --- |
| Task → Project | `task.project_id`（单值列） |
| Task → Parent Task | `task.parent_task_id`（单值列） |
| TimeEntry → Task/Project | `set_element(field='task_refs'/'project_refs')` |
| LogEntry → Task/Project | `set_element(field='task_refs'/'project_refs')` |
| JournalEntry → Task/Project/Log/Time/Conclusion | `set_element(field='refs')` |
| Conclusion → Log/Attachment/ExternalRef | `set_element(field='source_refs'/'attachments'/'external_refs')` |
| InboxItem → 生成的正式对象 | `set_element(field='conversion_refs')` |
| 任意对象 → Tag | `set_element(field='tags')` |
| 任意对象 → Attachment/ExternalRef | `set_element(field='attachments'/'external_refs')` |

这满足 §5 的"只实现上述明确关系，不做通用关系编辑器"，同时天然获得集合语义的并发安全。

**引用完整性**：`set_element.element` 不设 FK（可能指向已删除对象）。
读取时必须 join `entity` 并区分三种状态：存在 / 已归档 / **已删除（显示为"已删除的对象"）**。
测试：T-INT-DANGLING-REF（§5 + §9.6 + R-DATA-08）。

---

## 4. 派生视图（不复制数据，§6.6 / §9.4）

```sql
CREATE VIEW v_task_open AS ...
CREATE VIEW v_project_aggregate AS ...        -- 项目 + 未完成/已完成任务计数
CREATE VIEW v_daily_review AS ...             -- inbox + 已到期 deferred
CREATE VIEW v_today AS ...                    -- 今日计划 + 提醒 + 今日时间记录
CREATE VIEW v_time_overlap AS ...             -- 检测重叠区间（§4.5）
```

**统计的两个数值（⚠GAP-14，已决策"两者都做"）**：

- 原始记录时长 = `SUM(end_at - start_at)`
- 去重覆盖时长 = **区间并集长度**（扫描线算法，在 `domain/rules/interval_union.dart` 实现并单测）
- 另有 `overlap_pairs` 供"检测到重叠时提示用户"

区间并集必须处理：接续相邻（`[1,2)` + `[2,3)` = 2 个单位，不是 3）、完全包含、多重交叉。
测试：T-UNIT-INTERVAL-UNION（含 DST 切换日与跨午夜）。

---

## 5. 字段合并策略总表（写入 `field_schema`）

| 实体 | lww | text | set |
| --- | --- | --- | --- |
| inbox_item | status, deferred_until, source_type, process_action | content | conversion_refs, tags, attachment_refs |
| task | status, previous_status, project_id, parent_task_id, scheduled_date, due_at, priority, completed_at | title, description, next_action | tags |
| reminder | status, remind_at, due_at, related_task_id, completed_at, notification_state | content | tags |
| project | status, start_date, target_date | name, description | tags |
| time_entry | start_at, end_at, tz_id, category, timer_state, source | description | task_refs, project_refs |
| log_entry | occurred_at, source_inbox_id | title, body | tags, task_refs, project_refs, attachments, external_refs |
| journal_entry | journal_date, mood | body | tags, refs, attachments |
| conclusion | scope, occurred_at | title, body | tags, source_refs, attachments, external_refs |
| tag | name, name_key, color | — | — |
| attachment | sha256, display_name, media_type, bytes | — | refs |
| external_ref | url, title | — | refs |

**没有任何字段使用 additive/counter 合并**：跨设备求和会在重投递时重复计数。
所有"总和"都是查询派生值。

---

## 6. 删除 / 归档 / 完成 / 取消的语义（§9.5）

| 动作 | 效果 | 可逆 | 关联对象 | 同步 |
| --- | --- | --- | --- | --- |
| **完成** (task→done) | 状态变化 + `completed_at` | ✅ 改回 | 不动 | 普通 set |
| **取消** (task→cancelled) | 状态变化 | ✅ | 不动 | 普通 set |
| **归档** | `entity.archived_at` + 对象 status | ✅ 取消归档 | 不动 | 普通 set |
| **软删除** | `entity.deleted_at` | ✅ 180 天内 | 不动（引用显示"已删除"） | `delete` op + 墓碑 |
| **硬删除** | 物理删除行 | ❌ | 引用变 dangling | **不同步**，仅本机清理（180 天后） |
| **解除关联** | `set_element.present=0` | ✅ | 不删除两端 | set_remove op |

**禁止**：任何"删除项目 → 级联删除任务/日志/时间记录"的行为（§4.4、§5、R-PROJ-03）。
所有 FK 的 `ON DELETE CASCADE` 只用于 `entity` → 自身元数据表（同一对象的附属行），
**不**跨对象类型级联。

---

## 7. 墓碑与保留期（解决 ⚠GAP-01/05/06）

| 数据 | 保留期 | 到期动作 |
| --- | --- | --- |
| 软删除对象（用户可见的"回收站"） | 180 天 | 硬删除 + 写 `delete` 墓碑 |
| `delete` 墓碑（`entity` 行保留，内容清空） | **永久**（体积极小：仅 id/类型/时间/HLC） | 不清理 |
| `op` 日志 | 90 天 | 压缩：保留每对象最后状态 + 关键事件（create/delete/status/转换） |
| `conflict` 已解决记录 | 90 天 | 归档到审计表 |
| 孤儿 blob（无任何引用） | 30 天 | 删除文件 |

墓碑必须永久保留的原因：设备 C 离线一年后上线，若墓碑已清理，
它的旧数据会**复活**已删除对象，或触发"未知对象"冲突。
墓碑行体积极小（约 100 字节），一万条删除约 1 MB，可接受。

**用户可配置**，但默认值不可为 0。

---

## 8. 迁移规则（§8.2 / §9.10）

- 迁移**逐版本手写**，不用生成器（理由见 `decisions/0002`）。
- 每次迁移一个函数 `Future<void> v7ToV8(GeneratedDatabase db) async`，注册在 `schemaVersion` 表中。
- 迁移前**自动备份**：`VACUUM INTO` 到 `pre_migration_v<N>_<ts>.db`（失败可回退）。
- 迁移在**单事务**中执行；SQLite 的 DDL 支持事务，因此失败自动回滚。
- 每个迁移必须有：升级前数据快照 → 升级 → 断言（行数、关联数、关键字段）→ 回滚测试。
- 迁移**不得**依赖 UI 或网络。
