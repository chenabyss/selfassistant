# 个人生活信息系统 V1

Windows + Android 的个人生活记录与行动管理应用。**本地优先**：SQLite 是唯一权威数据源，
离线可用，多设备通过自己的变更协议同步，备份与恢复独立于同步。

> 当前状态：**设计阶段（未开始编码）**。
> 已完成需求转写、技术验证、数据模型、同步协议、备份恢复方案、风险分析与阶段拆分。
> **等待用户确认后进入阶段 1。**
> 规格原文：`personal_life_system_v1_spec.md`

---

## 1. 文档导航

| 文档 | 内容 | 对应规格要求 |
| --- | --- | --- |
| [design-report-v1.md](docs/design-report-v1.md) | **首次响应汇总**：理解、范围、架构、决策与待决问题 | §13 |
| [review-revision-report.md](docs/review-revision-report.md) | **设计复审修订报告**（回应评审 8 项要求，含完成状态） | 评审 |
| [phase-0-report.md](docs/phase-0-report.md) | **阶段 0 实际执行结果**（已执行 vs 未执行，含证据与命令） | 阶段 0 |
| [phase-1-plan.md](docs/phase-1-plan.md) | **阶段 1 最小实现计划**（交付物、测试门槛、执行顺序、退出标准） | 阶段 1 |
| [platform-verification-checklist.md](docs/platform-verification-checklist.md) | **真实平台验证清单**（37 项，含前置/步骤/通过标准/实际结果） | 阶段 0 |
| [requirements.md](docs/requirements.md) | 可测试需求 + **规格矛盾/缺漏登记表（GAP）** | §11 步骤 2 |
| [architecture.md](docs/architecture.md) | 模块边界与依赖方向、目录结构 | §11 步骤 2 |
| [data-model.md](docs/data-model.md) | 对象、字段、关系、删除规则、迁移规则、**权威性职责** | §11 步骤 2 |
| [sync-protocol.md](docs/sync-protocol.md) | 设备、变更、**冲突可见性**、重试、墓碑规则 | §8.3 |
| [sync-options.md](docs/sync-options.md) | **同步方案复杂度评估**（四方案对比、实测代码量、已验证/未验证清单） | 评审第 2 项 |
| [relay-deployment.md](docs/relay-deployment.md) | **自建 HTTPS relay 部署方案**（技术栈/认证/TLS/备份/版本兼容/成本/维护） | 评审第 4 项 |
| [search-cjk-results.md](docs/search-cjk-results.md) | **中文搜索实测结果**（5 万/20 万条基准） | 评审第 6 项 |
| [backup-restore.md](docs/backup-restore.md) | 备份格式、版本兼容、恢复流程、导出 | §8.4 |
| [testing.md](docs/testing.md) | 测试层次、命令、阶段与发布验收门槛 | §10 |
| [phases.md](docs/phases.md) | **开发阶段拆分与每阶段验收条件** | §11 步骤 3/4 |
| [risks.md](docs/risks.md) | 数据丢失/重复写入/并发/迁移/恢复风险分析 | §13.5 |
| [dart-verification.md](docs/dart-verification.md) | Windows/Android 技术验证结果（实测 vs 文档核实） | §8.1, §11 步骤 1 |
| [known-limitations.md](docs/known-limitations.md) | 已知限制清单（诚实记录未实现的能力） | §10.4 |
| [decisions/](docs/decisions/) | 重要技术决策记录（ADR，共 10 条） | §11 步骤 2 |

**可执行原型**：[`prototype/sync-core/`](prototype/sync-core/) —— 零依赖 Node，
实现并验证同步合并语义（**33/33 测试通过**）。它是协议规格的可执行版本，
Dart 实现必须逐条移植这些测试（`testing.md` §7）。

**实测工具**：[`tools/`](tools/) —— 中文搜索基准（`fts5-cjk-bench.mjs`）、
SQLite 能力探测（`probe-sqlite.mjs`）、文档一致性检查（`check-docs.mjs`）、
风险数量校验（`count-risks.mjs`）。均因本机 PowerShell/curl 无出网而用 Node 编写。

---

## 2. 当前状态（诚实版）

| 项 | 状态 |
| --- | --- |
| 需求与 GAP 登记 | ✅ 完成（33 项 GAP，其中 6 项阻塞） |
| 技术选型验证 | ⚠️ **文档级 + 原型级 + SQLite 实测**，**未在任何 Flutter 平台上实测** |
| 数据模型 | ✅ 完成（已冻结到建表级，含权威性职责） |
| 同步协议 | ✅ 完成 + **33/33 可执行测试验证**（含冲突可见性） |
| 同步复杂度评估 | ✅ 完成（`sync-options.md`，含实测代码量与削减建议） |
| 同步通道部署方案 | ✅ 完成（`relay-deployment.md`）；**尚未部署任何 relay** |
| 中文搜索 | ✅ **已实测选型**（trigram + LIKE 回退）；⚠️ 移动端性能未验证 |
| 备份/恢复方案 | ✅ 完成 |
| 隐私与加密决策 | ✅ **已决定**（传输必做 / 备份与本地库默认不加密 / V1 不做 E2E）见 `privacy-encryption.md` |
| 通知与工具链方案 | ✅ **已决定**：通知尽力而为 + MSIX 先验证；CI 已编写（`platform-toolchain-plan.md`、`.github/workflows/ci.yml`） |
| 版本约束锁定 | ✅ `tool/versions.yaml` + `tool/check_versions.mjs`（已通过） |
| 平台验证清单 | ✅ 37 项已登记，**当前 0 项通过**（`platform-verification-checklist.md`） |
| 风险分析 | ✅ 完成（**61 项，28 项 R1**） |
| 阶段拆分与验收条件 | ✅ 完成（10 个阶段，见 `phases.md`） |
| 应用代码 | ❌ **未开始**（按要求等待确认） |
| 构建工具链 | ❌ **本机未安装**（Flutter / MSVC / Android SDK 全缺） |

**必须知道的三点**：

1. 本机**无法构建任何 Flutter 产物**（缺 Flutter、MSVC、Android SDK）。
   见 `dart-verification.md` §6 与待决问题 Q8。
2. 中文搜索方案**已用 5 万/20 万条实测选定**（trigram + LIKE 回退），
   但**移动端性能未验证**——在 Android 真机实测通过前**不得宣称"中文搜索已可用"**。
   见 `search-cjk-results.md` §8 与问题 Q14。
3. **未部署任何 relay**，因此"跨网络同步 / 双设备端到端 / 附件跨设备传输"
   目前**全部属于未完成**，不得声称 V1 已具备同步能力。
   见 `relay-deployment.md` §10。

---

## 3. 技术栈（提议）

| 层 | 选择 | 版本依据 |
| --- | --- | --- |
| 客户端 | Flutter（Windows + Android 单代码库） | 当前稳定 3.47；最低 3.38.1 |
| 状态管理/UI | Material 3 + 自建用例层（不引入重型框架） | — |
| 数据库 | SQLite（`package:sqlite3` 3.7.0 打包，内含 SQLite **3.53.4**，含 FTS5） | 已核实版本与编译选项 |
| ORM/迁移 | `drift` 2.35.2（**手写迁移**，不用生成器） | — |
| 同步 | **自建 op-log + 字段级版本向量 + 服务端单调游标** | 见 `decisions/0003` |
| 通知 | `flutter_local_notifications` 22.3.2（尽力而为模型） | 见 `decisions/0006` |
| 备份 | `VACUUM INTO` + ZIP + `manifest.json` + SHA256 清单 | 见 `decisions/0009` |
| 附件 | 内容寻址（sha256），导入即复制到应用私有目录 | 见 `decisions/0004` |

> **注意**：**不要**使用 `sqlite3_flutter_libs` / `sqlcipher_flutter_libs`——
> 它们已 EOL 且 `+eol` 版本移除了全部代码。drift ≥2.32 直接使用 `package:sqlite3` 3.x 的
> Dart build hooks 打包原生 SQLite。

---

## 4. 运行方式（工具链就绪后）

```bash
# 0) 先确认工具链
flutter --version          # 需要 >= 3.38.1
flutter doctor -v          # Windows toolchain / Visual Studio / Android toolchain 必须全绿

# 1) 依赖
cd app && flutter pub get

# 2) 分层守护（架构规则）
dart run ../tools/check_layering.dart

# 3) 单元 / 集成测试
dart test app/packages/domain app/packages/application
dart test app/packages/infrastructure

# 4) 同步核心原型（协议契约）
cd prototype/sync-core && node test/run.js

# 5) 运行
flutter run -d windows
flutter run -d <android-device-id>

# 6) 端到端
flutter test integration_test -d windows
flutter test integration_test -d <android-device-id>
```

> 阶段 1 会把这些命令收敛为一个 `tool/verify.dart`，作为"可复现的构建、测试与发布步骤"
> （规格 §10.4 要求）。

---

## 5. 仓库结构

```
assistant/
├─ personal_life_system_v1_spec.md   # 原始规格（基准，不修改）
├─ README.md                         # 本文件
├─ docs/                             # 设计与决策文档
│  ├─ design-report-v1.md
│  ├─ requirements.md                # 含 GAP 登记表
│  ├─ architecture.md
│  ├─ data-model.md
│  ├─ sync-protocol.md
│  ├─ backup-restore.md
│  ├─ testing.md
│  ├─ risks.md
│  ├─ dart-verification.md
│  ├─ known-limitations.md
│  └─ decisions/                     # ADR
├─ prototype/sync-core/              # 同步语义可执行原型（Node，零依赖）
│  ├─ src/{hlc,vvec,merge,store,relay,schema,hash}.js
│  └─ test/{core.test.js,harness.js,run.js}
├─ tools/                            # 联网核验脚本（Node；本机 PowerShell/curl 无出网）
│  ├─ verify-sqlite-version.mjs
│  ├─ verify-aux-packages.mjs
│  └─ verify-file-plugins.mjs
└─ app/                              # Flutter 应用（阶段 1 创建）
   ├─ packages/domain/               # 纯 Dart：实体、值对象、规则、ports
   ├─ packages/application/          # 纯 Dart：用例、事务边界、撤销
   ├─ packages/infrastructure/       # drift、同步适配器、通知、文件、备份
   └─ apps/life_app/                 # UI
```

---

## 6. 交付纪律（规格 §11 步骤 3/4 的硬性要求）

1. **按垂直切片开发**，每个切片包含：数据模型 + 界面 + 测试 + 文档更新。
2. **不接受"只有界面、使用临时内存数据"的实现**。任何功能必须有：
   - 数据落到 SQLite（且经单一写入路径，见 `architecture.md` §5.1）；
   - 单元测试 + 集成测试；
   - 关键错误路径处理；
   - 迁移覆盖（若涉及结构变化）；
   - 在**目标平台实际运行**过。
3. 每个切片完成时更新 `known-limitations.md` 与对应文档。
4. 不得把未实现的能力标记为完成（规格 §10.4）。

---

## 7. 下一步

**等待用户确认待决问题**（完整清单与理由见 `docs/design-report-v1.md` §6）。

### A. 阻塞开发（必须先回答）

| # | 问题 | 影响 |
| --- | --- | --- |
| Q1 | V1 是否必须交付**可用**的多设备同步？还是可只交付 Sync Adapter 接口并明确标注"未完成"？ | 规格 §2.1/§10.4 与 §8.3 末段相互矛盾（⚠GAP-02）；决定发布范围与验收门槛 |
| Q2 | 同步通道选择（自建 relay / 局域网 / 用户自有 WebDAV / 云服务） | 隐私、成本、工程量 |
| Q5 | 中文全文搜索方案（trigram / 自研 bigram / 降级为子串匹配） | 搜索能力与索引体积 |
| Q4 | 本地数据库是否需要加密 | 设备丢失时的隐私；加密不能后期原地加，须阶段 1 前定 |
| Q8 | 是否由用户配合安装工具链（Flutter + MSVC Build Tools + Android SDK/JDK） | **当前阻塞全部平台验证与构建** |

### B. 影响范围与体验（建议 P1 前回答）

| # | 问题 | 影响 |
| --- | --- | --- |
| Q3 | 墓碑**永久保留**是否接受？软删除 180 天 / op 日志 90 天 / 孤儿附件 30 天 | 数据可恢复性与库体积 |
| Q6 | Windows 打包方式（未打包 / MSIX / Task Scheduler 独立入口） | 通知可取消性、后台唤醒 |
| Q7 | Android 最低版本与目标版本 | 权限与存储复杂度 |
| Q9 | 确认"字段级 op + 每字段版本向量 + 预声明合并策略"方向 | 数据模型核心取舍（写入放大 vs 并发不丢改） |
| Q10 | 提醒"尽力而为"是否可接受（可能延迟；Windows 应用未打开时不触发） | 平台硬限制带来的预期管理 |
| Q11 | 墓碑永久保留（内容已清除，仅留 id/时间/类型）是否接受 | 隐私 vs 同步正确性 |
| Q12 | 是否需要"数据目录可自定义位置" | 影响云盘误用风险 DL-1 的提示策略 |
