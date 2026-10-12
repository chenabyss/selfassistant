# phase-0-report.md — 阶段 0 实际执行结果

> 本文报告**实际执行过的**工作与**实际得到的结果**。
> 未执行的项目明确标注为"未执行"，不以计划代替结果。

日期：2026-10-12
授权依据：用户已批准全部关键决策并授权进入阶段 0（见 `requirements.md` §16.1/§16.3）。

---

## 1. 执行结果总览

| # | 阶段 0 任务 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | 清理文档中的陈旧状态与矛盾结论 | ✅ **完成** | 陈旧状态扫描 `clean`；`check-docs.mjs` 通过 |
| 2 | 固定 Flutter/Dart/依赖/SQLite 版本约束 | ✅ **完成** | `tool/versions.yaml`；`tool/check_versions.mjs` 输出 `OK` |
| 3 | 建立 GitHub Actions 流水线 | ✅ **已推送**；⚠️ **运行情况未确认** | `.github/workflows/ci.yml`（4 个 job）已在 `main` 上 |
| 4 | 真实平台测试清单 | ✅ **完成** | `docs/platform-verification-checklist.md`（37 项，**0 项通过**） |
| 5 | 中文搜索方案实现（trigram + 短查询回退） | ⚠️ **基准已验证；应用接入未开始** | `tools/fts5-cjk-bench.mjs`；`docs/search-cjk-results.md` |
| 6 | 单一数据库入口 / 日志脱敏 / 迁移框架 / 快速记录持久化 / 可恢复备份 | ❌ **未开始** | 属于阶段 1 |
| 7 | S1/S2/S3 处理 | ✅ **S1、S2 已实现；S3 暂缓** | `prototype/sync-core/`，**43/43 测试通过** |
| 8 | 建立代码托管与首次推送 | ✅ **完成** | 远程 `chenabyss/selfassistant`，SHA `f1243e4` 已独立核验 |

**本轮真正产生可验证产出的两项**：① S1/S2 的同步契约实现；② 版本约束锁定。
其余是配置与文档，**尚未在真实环境验证**。

---

## 2. 已验证的产出（有可复现证据）

### 2.1 同步契约：S1 显式解决记录 + S2 懒生成历史

**测试从 33 条增至 43 条，全部通过**（`cd prototype/sync-core && node test/run.js`）：

```
core.test.js      20 条   基础协议契约
conflict.test.js  16 条   冲突可见性 + S1 显式解决记录
audit.test.js      7 条   S2 历史可重建证明
                  ─────
                  43 条   全部通过
```

**S1 的实际变化**（用户决定：采用显式同步解决记录）：

| 之前 | 现在 |
| --- | --- |
| 冲突关闭由各设备**本地推导**（"新写入支配两者并集"） | 冲突关闭是一条 **`op_type='resolve_conflict'` 的显式 op** |
| `keep_winner` 时字段值不变 → **其他设备永远显示待处理** | `keep_winner` 只写解决 op，**所有设备都能关闭** |
| 无审计痕迹 | 解决记录进入 op 日志，可追溯、可重放 |

新增 4 条测试证明：
- `keep_winner` 只产生一条 op（不写值）；
- `keep_winner` 的解决**传播到另一台设备并关闭冲突**（这是之前失败的确切场景）；
- 解决 op 在**重复投递 + 逆序重放**下幂等；
- 解决 op 携带 `conflict_id` 与选择，两端得到**同一个 `resolution_op`**。

**S2 的实际变化**（用户要求：先证明可完整重建，再移除重复写入）：

- 实现了 `Store.auditProjection()` —— 从 `op` 按需派生历史视图；
- **7 条测试证明可完整重建**：捕获 create/delete/状态变更/关系变更；
  空设备仅重放 op 即得到**完全相同的历史摘要**；跨设备一致；
  **任意重放顺序**（含逆序）得到相同历史；冲突解决出现在历史中；
  写入路径中**不存在**物化审计存储（有守护测试）。
- 因此 `architecture.md` §5.1 的写入路径已移除 `audit_log`。

**实现过程中发现并修复的真实缺陷**（本轮新增）：

| 缺陷 | 后果 | 修正 |
| --- | --- | --- |
| 历史投影只按 HLC 物理时间排序 | 同一毫秒内的 op 顺序**任意**，历史可能显示"in_progress → done"在初始"todo"之前 | 改为按**完整 HLC** 排序 |
| `this.conflicts` 惰性创建 | 从未遇到冲突的设备读 `.length` 抛 `TypeError`；"无冲突"与"编程错误"无法区分 | 构造时初始化为 `[]` |

### 2.2 版本约束锁定

`tool/versions.yaml` 是唯一权威来源，`tool/check_versions.mjs` 断言 `app/pubspec.yaml` 与之一致。

```
version constraint check
  flutter pinned : 3.47.0 (min 3.38.1)
  dart sdk       : >=3.10.0 <4.0.0
  sqlite         : 3.53.4 (min acceptable 3.51.3)
  android        : min 29, target 35, page align 16KB
  pinned packages: 11
  forbidden      : sqlite3_flutter_libs, sqlcipher_flutter_libs, drift_flutter

OK: app/pubspec.yaml agrees with tool/versions.yaml
```

每个下限都带原因注释。**特别锁定 SQLite ≥ 3.51.3**：WAL-reset 缺陷影响 3.7.0–3.51.2，
触发条件是 ≥2 连接同时写入/检查点 —— 正是本项目的形态。

**明确禁止**三个已弃用依赖，CI 会因它们失败。

### 2.3 文档状态清理

| 项 | 结果 |
| --- | --- |
| 陈旧状态/前向引用扫描 | `clean`（修掉了 6 处"待下一轮"、多处旧测试数、旧风险数） |
| 内部一致性（链接 / 路径 / ADR/T-/R-/GAP-/RV-/L- 交叉引用） | `OK` |
| 风险登记数量校验 | `OK`（61 项 = R1 28 / R2 30 / R3 3） |
| 规模 | 122 需求 / 41 GAP / 61 风险 / 91 测试 ID / 10 ADR |

**`review-revision-report.md` 的状态表述已与文件清单对齐**（这是用户明确指出的问题）。

---

## 3. 已编写但**未执行**的产出（必须如实看待）

### 3.1 CI 流水线（已推送，运行情况未确认）

`.github/workflows/ci.yml` 包含 4 个 job：

| job | 内容 | 环境 |
| --- | --- | --- |
| `analyze-and-test` | 同步契约测试、文档一致性、风险数量、版本约束、`pub get`、**禁止依赖断言**、格式、分析、单元测试 | ubuntu |
| `build-windows` | `flutter build windows --release` + 归档 | windows |
| `build-android` | `flutter build apk --release` + **16 KB 页对齐校验** + 归档 | ubuntu |
| `search-benchmark` | 5 万条中文搜索基准 + **断言 trigram 保持 100% 召回** | ubuntu |

**该文件已推送到 `main`，但从未被确认执行。** 本机无法验证，因为
GitHub API 未认证访问受限，且本机无 Flutter/MSVC/Android SDK。
**首次 CI 运行结果需要用户到 Actions 页面查看**（见 §7）。
**CI 构建成功也不等于真机验证通过。**

### 3.2 平台验证清单（0/37 通过）

`docs/platform-verification-checklist.md` 登记 37 项，每项含前置条件、步骤、通过标准、实际结果占位：

| 组 | 项数 | 通过 | 阻塞 |
| --- | --- | --- | --- |
| A 构建与安装 | 4 | 0 | 本机无工具链 |
| B Windows 桌面 | 9 | 0 | 同上 |
| C Android 真机 | 8 | 0 | 待用户提供真机型号/版本 |
| D 备份与恢复 | 6 | 0 | 无构建产物 |
| E 同步端到端 | 6 | 0 | **未部署 relay** |
| F 性能与规模 | 4 | 0 | 无构建产物 |

**当前真实状态：0/37 通过。**

### 3.3 中文搜索（方案已定，接入未开始）

- **方案**：`trigram` + 查询 <3 字符时回退 `LIKE`（ADR-0008 已由"待验证"改为"已决定"）；
- **实测依据**：5 万与 20 万条（`search-cjk-results.md`）；
- **未做**：尚未写入应用代码（`domain/rules/search_query.dart` 属于阶段 7 的搜索切片）；
- **限制**：Android 真机性能未验证 → **不得宣称移动端可用**（用户已确认此口径）。

---

## 4. 阶段 0 的退出判据核对

用户设定的阶段 0 目标是"搭建可复现的构建环境"。

| 判据 | 状态 |
| --- | --- |
| 版本约束已固定且可机器校验 | ✅ **达成** |
| 存在可复现的构建与测试流水线定义 | ✅ 定义存在；⚠️ **未运行过** |
| 与 Flutter 无关的检查可在本机运行 | ✅ **达成**（同步契约 43 条、文档一致性、风险数量、版本约束） |
| 真实平台验证有独立清单且每项可判定 | ✅ **达成**（37 项） |
| **可复现构建被实际执行过一次** | ❌ **未达成** —— 需要 GitHub 推送或本机工具链 |

**结论：阶段 0 部分达成。** 与 Flutter 无关的部分已可复现执行；
"真实构建过一次"仍缺外部条件。

用户已明确：**不要因工具链问题停止基础开发**。
因此下一步进入阶段 1，同时把"CI 首次运行成功"与真机验证保留为未完成项。

---

## 5. 阶段 0 未解决的风险（透明登记）

| 风险 | 说明 | 何时能关闭 |
| --- | --- | --- |
| RV-9 | 同步协议代码量大 → 实现自身出 bug 概率高 | 阶段 9 移植 43 条测试后部分缓解 |
| RV-8 / L-35 | 写放大未实测 | 清单 F3（10 万条） |
| RV-12 | MSIX 可能改变数据目录 | 清单 B8（M9） |
| RV-14 / L-27 | 中文搜索移动端未验证 | 清单 C7 |
| L-26 | 跨网络同步与附件传输**未完成** | 清单 E 组（需先部署 relay） |
| — | CI 从未运行，构建配置可能有误 | 推送后首次运行 |
| — | 所有平台相关项 0/37 | 见清单 |

这些**不影响开始阶段 1 的基础编码**，但**禁止**在任何交付物中把对应能力标记为已完成。

---

## 6. 复用方式（命令）

```bash
# 与 Flutter 无关，本机可运行（已实际通过）
node prototype/sync-core/test/run.js     # 43/43 同步契约测试
node tools/check-docs.mjs                # 文档一致性
node tools/count-risks.mjs               # 风险数量校验
node tool/check_versions.mjs             # 版本约束一致性
node tools/probe-sqlite.mjs              # SQLite 能力探测
node tools/fts5-cjk-bench.mjs --rows 50000 --queries 120   # 中文搜索基准

# 需要工具链（本机不可运行）
cd app && flutter pub get && flutter analyze && flutter test
cd app && flutter build windows --release
cd app && flutter build apk --release
```

CI 执行的是同一组命令（`.github/workflows/ci.yml`），因此本机与 CI 的检查项一致。

---

## 7. 代码托管与首次推送（本轮新增）

| 项 | 值 |
| --- | --- |
| 远程 | `git@github.com:chenabyss/selfassistant.git` |
| 分支 | `main` |
| 首个提交 | `f1243e420d8afed3a9759406931b0a841a69c54d` |
| 提交内容 | 61 个文件（设计文档 + 原型 + 阶段 0 配置 + CI） |
| 核实方式 | **独立于 git**：通过 HTTPS 拉取远程文件与 commits feed |

**核实证据**（`node tool/verify_remote.mjs`）：

```
OK   200  README.md  (7369 bytes)
OK   200  .github/workflows/ci.yml  (6887 bytes)
OK   200  tool/versions.yaml  (1954 bytes)
OK   200  docs/phase-0-report.md  (5782 bytes)
OK   200  prototype/sync-core/test/audit.test.js  (7812 bytes)

fetched 5/5 files from branch main
commits in atom feed: 1
newest sha: f1243e420d8afed3a9759406931b0a841a69c54d
matches local HEAD: YES
```

### 7.1 沙箱限制（已解决，但需要用户知悉）

本机沙箱**阻止 git 自带的 MSYS `sh.exe` 创建命名对象**，任何需要通过 shell 的 git
远端操作都会失败，报：

```
sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
sh.exe: *** fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022
```

这是**沙箱边界，不是凭据问题** —— 同一个部署密钥用系统 OpenSSH 直接测试是通过的：

```
$ ssh -i ~/.ssh/repo_deploy -T git@github.com
Hi chenabyss/selfassistant! You've successfully authenticated, but GitHub does not provide shell access.
```

**处置**：对推送这一条命令申请了一次更宽的沙箱权限并成功
（`main -> main`）。后续每次推送都需要同样处理，或由用户在自己的终端执行
（终端不受此沙箱限制）。

**建议用户在本地终端配置一次**，以免每轮都要申请：
```powershell
# 方案 A：复制示例配置到 ssh config
copy tool\ssh-config.example $env:USERPROFILE\.ssh\config

# 方案 B：只在仓库内设置（不影响其他项目）
git config core.sshCommand "ssh -i ~/.ssh/repo_deploy -o IdentitiesOnly=yes"
```
示例文件见 `tool/ssh-config.example`。

### 7.2 需要用户确认的一件事

**CI 是否真的跑起来了。** 请打开：
`https://github.com/chenabyss/selfassistant/actions`

需要看的是 4 个 job 的结果（`analyze-and-test` / `build-windows` /
`build-android` / `search-benchmark`）。
本机无法确认，原因：GitHub API 未认证访问被限流，且本机无 Flutter 工具链。

**如果首次运行失败，请把失败日志贴回来** —— 配置是我写的，从未执行过，
首次失败是正常现象，我会据此修正。

---

## 8. 本轮新增的阻塞与解除

| 项 | 变化 |
| --- | --- |
| Q15 代码托管 | ✅ **解除** —— GitHub 已确认并完成首次推送 |
| Android 真机 | ✅ **设备信息已提供** —— 华为 Mate 20 X / EVR-AL00 / HarmonyOS 4.0.0 / 麒麟 980 |
| Android 部署 | ❌ **新阻塞** —— 本机**没有 `adb`**，也没有 Android SDK，无法部署到已就绪的真机 |
| CI 首次运行 | ⚠️ **待确认** —— 已推送，需用户在 Actions 页面查看 |
