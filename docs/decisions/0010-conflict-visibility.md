# ADR-0010：并发修改必须用户可见（所有合并策略一致）

- 状态：**已决定**（一项行为待确认，问题 Q9d）
- 日期：2026-10-12
- 关联：规格 §8.3、§9.5、§7；`docs/sync-protocol.md` §4；`docs/data-model.md` §2.5；`docs/sync-options.md`
- 取代：ADR-0003 中关于"`lww` 字段静默取胜者"的部分（ADR-0003 其余内容仍然有效）

## 背景

ADR-0003 的原始方案只对 `strategy='text'` 的字段产生用户可见的冲突记录；
`lww` 字段（任务状态、日期、时刻、分类、单值关系）由总序直接选出胜者，
落败值仅保留在 `op` 日志中。

**设计评审指出这与 `sync-protocol.md` 的承诺直接矛盾**：

> 同一对象的并发修改必须可见，要么合并，要么产生冲突记录。

具体反例（评审原文）：用户在 Windows 上把任务标记为完成，同时在 Android 上标记为取消。
系统自动选择一个状态却不提醒用户，另一项修改虽然留在操作日志里，
**用户实际上仍不知道它被覆盖了**。

## 决策

**所有合并策略在"真并发且值不同"时都产生用户可见、可去重、可同步、可解决的冲突记录。**

### 触发条件（必须同时满足）

1. 两个写入是**真并发**的：版本向量互不支配（`concurrent`）；
2. 两边的**值不同**（结构化相等比较，非引用相等）。

### 明确不触发冲突

| 情况 | 为什么不是冲突 |
| --- | --- |
| 因果更晚的写入（"B 看到 A 的修改后才改"） | 这是普通编辑，不是分歧 |
| 并发但**值相同**（两台设备都设为 `done`） | 无事可报 |
| 顺序编辑（用户来回改多次） | 同上 |

### 冲突记录的要求

| 要求 | 实现 |
| --- | --- |
| 稳定 | `conflict_id = hash(losing_op, winning_op, field)`，确定性生成 |
| 可同步 | **冲突行本身不同步**，由两端各自从 `op` 推导；因此不需要"冲突表同步"协议 |
| 可去重 | 确定性 id + 唯一约束；重复投递不产生新行 |
| 跨设备一致 | 两台设备观察同一次冲突时，`conflict_id`/`losing_op`/`winning_op`/`losing_value` 完全相同 |
| 可见 | 对象详情显示提示，直到用户显式处理；计入待处理（**不**采用惩罚性计数） |
| 可解决 | `keep_winner` / `keep_loser` / `custom` |

### 解决 = 写一条普通 `set` op

刻意复用已测试的版本向量 + 总序机制，因此解决动作天然可同步、可收敛，
不需要另建一套"冲突解决同步协议"。

## 理由

### 为什么"值不同"这个限定是必要的

如果没有它，任何并发写入都会产生冲突，包括两台设备做了同一件事。
后果是冲突列表被噪声淹没，用户开始忽略提示，
**真正的冲突反而被漏掉**——这正好破坏了本决策想要达成的目标（风险 CC-3）。
原型有专门测试守护"值相同不报冲突"与"顺序编辑从不报冲突"
（`review: concurrent writes with the SAME value produce NO conflict`、
`review: ordinary sequential editing never creates a conflict`）。

### 为什么对 `lww` 也要记录冲突，而不是只改文档措辞

另一个选项是**放松文档承诺**，改成"仅文本冲突可见"。
否决理由：规格 §8.3 明确要求"同一对象并发修改时不得静默丢弃一方修改"，
且 §8.3 还专门要求"**任务状态、时间记录、标签和关系**需要有明确冲突策略"。
把状态类字段排除在可见性之外，等于把规格点名的类别排除掉。
对一个**个人生活记录**应用，"以为改了但其实没生效"是最难察觉、最伤信任的失败模式。

### 为什么用哈希两侧作 id，而不是以落败 op 为键

同一次冲突会在两台设备上各被观察一次（赢方应用落败 op 时、输方应用获胜 op 时）。
只以某一侧为键，两侧会推导出字段互换的两条记录，冲突列表**本身不收敛**。
对 `(落败 op, 获胜 op, 字段)` 取哈希后，两处推导出的记录完全一致。
原型测试 `review: conflict set converges regardless of the order devices pull in`
用 6 种交错顺序验证了这一点。

### 为什么落败写入必须合并版本向量

这是修复本问题时发现的**潜在缺陷**：丢弃落败写入时若不合并其版本向量，则

1. 该 op 在之后每次同步时都被重新评估、重新丢弃；
2. 更严重：第三台设备的写入到达后，被丢弃的值**在原理上都无法再恢复**，
   因为寄存器已不知道"曾观察到这个落败版本"。

即这不只是"用户看不到"，而是"数据真的找不回来了"。
因此无条件合并版本向量是**正确性要求**，不是记账。

## 后果

- **正面**：
  - 满足规格 §8.3 的可见性要求，覆盖规格点名的全部类别；
  - 冲突行不参与同步，因此不引入额外的同步协议与不一致面；
  - 解决动作复用既有机制，无需新协议。
- **负面**：
  - 冲突列表在真并发场景下会变长（由"值不同"限定与"顺序编辑不报"控制）；
  - 需要 UI：冲突页面 + 对象详情提示 + 解决交互（新增工作量）；
  - **写放大增加**：并发场景下额外的 `conflict` 行（非并发场景无影响）；
  - 需要一条明确的关闭规则，而这条规则有微妙之处（见下）。

### 一个刻意的行为（待确认 Q9d）

用户选择 `keep_winner`（保留已经是当前值的那一版）时字段值不变，
因此**其他设备上该冲突仍显示为待处理**。

理由：其他设备仍需要知道"这里发生过并发编辑"。
`keep_loser` 会发出新写入，因此在所有设备上都会关闭。

若认为不合适，正确做法是**显式同步一条解决记录**，而不是放松
"必须产生新写入"的判据（`sync-options.md` 建议 S1 即为此）。

## 修复过程中发现并修复的另外 5 个真实缺陷

把本决策写成可执行测试后，暴露了 5 个文档评审看不到的问题：

| # | 缺陷 | 后果 |
| --- | --- | --- |
| 1 | `orderOps` 最终并列判据读 `op.op_id`，寄存器用 `opId` | 寄存器与 op 比较时判据**静默失效** |
| 2 | `snapshot()` 只读 `opId` | 对传入 op 取快照时 `opId` 恒为 `undefined`，JSON 丢掉该字段 → 冲突记录**丢失 `losing_op`**，无法解决也无法收敛 |
| 3 | 落败写入未合并版本向量 | 见上，数据不可恢复 |
| 4 | `observeRemoteClock` 只在 `pull()` 内 | 其他 apply 路径在未推进 HLC 时应用 op → **错误排序与虚假冲突** |
| 5 | 冲突在创建同一毫秒被自动关闭 | 首次修复尝试自身引入；用户永远看不到冲突 |

第 5 项尤其说明：**并发相关的逻辑必须写成测试**，因为错误的实现看起来是"正常工作"的。

## 验证

原型 `prototype/sync-core/test/conflict.test.js`，13 条测试，全部通过：

```
21 concurrent scalar (lww) writes produce a VISIBLE, open conflict
22 conflicting value is recoverable and both sides agree on the loser
23 a causally-later write produces NO conflict
24 concurrent writes with the SAME value produce NO conflict
25 ordinary sequential editing never creates a conflict
26 re-delivering the same ops does not duplicate conflict records
27 conflict set converges regardless of the order devices pull in
28 choosing the losing value resolves and converges on all devices
29 resolving the same conflict twice is rejected as already resolved
30 resolving cannot resurrect a value without a new op (auditability)
31 a discarded losing write still merges its version vector
32 concurrent set-membership removal vs add still converges to union rules
33 text conflicts remain visible and resolvable end to end
```

Dart 实现必须逐条移植这 13 条（连同 `core.test.js` 的 20 条），
作为阶段 9 的准入条件（`testing.md` §7）。

## 对 ADR-0003 的影响

ADR-0003 的以下内容**被本 ADR 取代**：
- "三种合并策略 `lww` / `text` / `set`"中关于 `lww` **不出现在用户可见冲突列表**的表述。

ADR-0003 的其余决策**继续有效**：字段级 `op`、版本向量、HLC、服务端极简、
游标与变更同事务、附件内容寻址、墓碑永久保留。
