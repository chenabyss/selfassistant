# dart-verification.md — Windows / Android 客户端技术方案验证结果

> 对应规格 §8.1（"Agent 必须先做最小技术验证"）与 §11 步骤 1。
>
> **诚实声明（重要）**：本文件区分三类结论：
> - **[实测]** 本次在**当前构建机**上实际执行命令得到的结果（可复现，见 §2）；
> - **[文档核实]** 通过读取上游官方文档 / pub.dev API 元数据核实的**版本与能力声明**；
> - **[未验证]** 因本机缺少必需工具链而**尚无法执行**的验证，列在 §7 的验证计划中。
>
> 本次**没有**在任何平台上运行过 Flutter 应用；**没有**在任何真实设备上验证过通知投递。
> 任何把"文档核实"当作"已实测"的表述都是不允许的。

---

## 1. 结论摘要

| 项目 | 结论 | 依据 |
| --- | --- | --- |
| 客户端框架 | **Flutter 可行**（Windows + Android 单代码库），但**本机目前无法构建** | [文档核实] + [实测] 工具链缺失 |
| 本地数据库 | **drift + `package:sqlite3` 3.x**（**不再需要** `sqlite3_flutter_libs`） | [文档核实] |
| 全文搜索（英文） | SQLite FTS5 已内置 | [文档核实] |
| 全文搜索（中文） | **存在实质风险**，FTS5 默认分词器对 CJK 无效 | [文档核实] + [待验证] |
| 通知（Android） | 可用，但**不保证精确投递**（权限 + OEM 省电） | [文档核实] |
| 通知（Windows） | 可用 Toast，**但未打包 MSIX 时无法取消/查询已显示的通知** | [文档核实] |
| 后台执行（Windows） | **基本不存在**可靠的"应用关闭后定时执行" | [文档核实] |
| 附件 | 内容寻址（sha256）本地存储可行 | [文档核实] |
| 跨设备同步 | **自建 op-log + 版本向量**方案；已用可执行原型验证语义 | [实测，见 §5] |
| 备份/恢复 | `VACUUM INTO` + ZIP + SHA256 清单；恢复流程五阶段 | [文档核实] |

**最重要的两个发现**：

1. **`sqlite3_flutter_libs` 已 EOL**，pub.dev 上的描述是
   *"Not used anymore, update to version 3.x of package:sqlite3 instead"*。
   drift ≥ 2.32 起，原生 SQLite 由 `package:sqlite3` 3.x 通过 **Dart/Flutter build hooks（native assets）**
   自动打包，无需任何额外依赖或手工配置。这简化了 Windows/Android 双端方案。
2. **本机完全没有 Flutter/Android/VS C++ 工具链**，因此"技术验证"目前是
   **文档级 + 原型级**，不是设备级。真正的平台验证必须先补工具链（§6）。

---

## 2. 实测部分（本构建机）

执行时间：2026-10-12（UTC+8）。全部命令可复现。

### 2.1 主机环境 [实测]

| 项 | 值 |
| --- | --- |
| OS | Windows 10 Pro，25H2，Build 26200.8037，AMD64 |
| PowerShell | 5.1.26100.7920 |
| 是否管理员 | **否**（`IsInRole(Administrator)` = False） |
| 长路径支持 | 已启用（`LongPathsEnabled = 1`） |
| Node.js | 已装（v26.5.0） |
| Python | 已装（3.14.6） |
| Git | 已装（2.55.0.windows.3） |
| 包管理器 | `scoop`、`winget` 可用；`choco` 缺失 |

### 2.2 工具链缺失清单 [实测]

| 工具 | 状态 | 影响 |
| --- | --- | --- |
| `flutter` | **缺失** | 无法构建/运行任何 Flutter 目标 |
| `dart` | **缺失** | 无法运行 Dart 单元测试 |
| Android SDK（`adb`, `ANDROID_HOME`） | **缺失** | 无法构建/安装 Android 产物 |
| Visual Studio / MSVC（`cl`, `msbuild`, `cmake`） | **缺失** | **无法构建 Windows 桌面产物** |
| `sqlite3` CLI | 缺失 | 不便直接检查库文件（可由 Dart 侧替代） |
| Java/JDK | 存在但无输出（疑似占位） | 需重新安装/确认版本 |

探测方式：`Get-Command` 逐个查找 + 检查 17 个常见安装路径 + 注册表 Uninstall 项
（匹配 Flutter / Android / Visual Studio / Windows SDK）。
注册表中**只有 VC++ 运行时可再发行包**，**没有** Visual Studio 或 Windows SDK。

> 结论：**当前机器不能构建本项目的任何交付产物**。见 §6 与 `design-report-v1.md` 的待决问题 Q8。

### 2.3 网络边界 [实测，重要]

| 通道 | 结果 |
| --- | --- |
| Node.js `fetch`（`https://pub.dev/...`） | ✅ HTTP 200 |
| `curl.exe` | ❌ HTTP 000，立即失败 |
| PowerShell `Invoke-WebRequest`（含强制 TLS 1.2） | ❌ "基础连接已经关闭" |

DNS 正常（`pub.dev` → 34.36.0.14），无代理环境变量，无本地代理端口监听。
因此这是**该沙箱对 curl/PowerShell 出网的策略限制**，而非网络本身不可用。
影响：本项目内的联网核验脚本**统一用 Node**（`tools/*.mjs`）编写。

### 2.4 同步核心原型 [实测]

`prototype/sync-core/`（零依赖 Node）实现了协议核心并跑通 **33/33** 测试：

```
$ node test/run.js
...
33/33 passed
```

覆盖：幂等、收敛、字段级并发、**所有策略的冲突可见性与解决**、文本冲突保留双版本、
集合语义与逐元素墓碑、墓碑传播、游标无缺口、崩溃重放、部分失败重试、
时钟偏移（慢 1 小时 / 未来 48 小时）、版本向量分类、三设备随机交错、附件内容去重。

> 修订说明：设计评审指出 `lww` 字段的并发差异对用户不可见（与协议承诺矛盾）。
> 修复该缺陷时新增 13 条冲突契约测试（20 → 33），并**额外发现并修复 5 个真实缺陷**。
> 详见 `sync-protocol.md` §4 与 §9.3、`docs/decisions/0010-conflict-visibility.md`。

### 2.5 SQLite 能力实测 [实测]

`tools/probe-sqlite.mjs` 探测本机 Node 内置 SQLite（**3.53.3**）：

| 能力 | 结果 |
| --- | --- |
| `fts5`（基本） | ✅ |
| `fts5 tokenize='unicode61'` | ✅ |
| `fts5 tokenize='trigram'` | ✅ |
| `fts5 tokenize='porter'` | ✅ |
| `fts5` 外部内容表（`content=`） | ✅ |
| `STRICT` 表 | ✅ |
| `json1` | ✅ |
| 生成列（generated column） | ✅ |
| 部分唯一索引（partial unique index） | ✅ |
| WAL-reset 修复（≥3.51.3） | ✅ 满足 |

**意义**：这让我们**不需要 Flutter 工具链**就能对中文搜索方案做真实的 5 万/20 万条基准测试
（见 `search-cjk-results.md`）。这是本轮唯一能在本机完成"实测级"验证的部分。

原型在执行过程中**发现并修复了 3 个真实设计缺陷**（详见 `sync-protocol.md` §9），
这是本次最有价值的技术验证产出——文档评审不会发现这些。

---

## 3. 平台能力核实（文档级）

### 3.1 本地数据库 [文档核实]

- drift 官方文档 *Native Drift (cross-platform)* 明确：
  *"Starting from drift version 2.32.0, all native Dart and Flutter platforms are supported without any further setup or dependencies. Older versions required the use of `sqlite3_flutter_libs` … These are no longer necessary."*
- `package:sqlite3` 3.7.0（最新稳定）通过 **build hooks** 打包预编译 SQLite，
  官方 changelog 记录：3.5.0 → **SQLite 3.53.3**，3.5.1 → **SQLite 3.53.4**。
- 预编译二进制的编译选项包含 **`SQLITE_ENABLE_FTS5`**（全文搜索）与
  `SQLITE_ENABLE_JSON1`、`SQLITE_ENABLE_MATH_FUNCTIONS`、`SQLITE_ENABLE_RTREE`、
  `SQLITE_ENABLE_DBSTAT_VTAB`，并使用 `SQLITE_DQS=0`。
- 支持的 Windows 架构：`aarch64`、`x64`、`x86`；Android：`armv7a`、`aarch64`、`x86`、`x64`。
- 二进制的**安全性**：从 GitHub Releases 下载，源码内固定 sha256 校验，
  3.5.2 起提供 SLSA level 3 attestation 与 CycloneDX SBOM。
- 可切换加密实现（无需改代码结构）：
  ```yaml
  hooks:
    user_defines:
      sqlite3:
        source: sqlite3mc   # 或 sqlcipher；默认 sqlite3
  ```
- 可改用系统 SQLite（`source: system`），但**不推荐**：系统 SQLite 的编译选项不一致，
  可能没有 FTS5（这正好是 drift 文档给出的理由）。

**关键版本核实：WAL reset bug**
SQLite 的 WAL-reset 缺陷影响 **3.7.0–3.51.2**，在 **3.51.3**（2026-03-13）修复，
触发条件是 **≥2 个连接同时写入/检查点**——对本项目（多 isolate + 后台任务）是真实威胁。
本项目打包的 **SQLite 3.53.4** 已超出修复版本，**不受影响**。
`manifest.json` 记录 `sqlite_version`，防止将来意外降级。

**FTS5 与中文（风险）**[文档核实 + 待验证]
FTS5 的 `unicode61` 分词器按 Unicode 词边界切分，**中文没有空格分隔**，
因此整句会被当成一个 token，导致"关键词搜索"实际不可用。
可选方案（需在阶段 6 前完成验证，问题 Q5）：
1. `trigram` 分词器（SQLite 3.34+ 内置）：支持任意子串匹配，代价是索引体积约为原文 3–5 倍；
2. 自建二元切分：写入索引前把中文切成 bigram，查询时同样切分（索引小、需自己维护）；
3. V1 降级为"LIKE 子串匹配"：明确写入已知限制，不假装有全文搜索。

### 3.2 通知 [文档核实]

`flutter_local_notifications` 22.3.2（最新稳定，平台：android, ios, macos, linux, **windows**, web）。

**Android**
- Android 13+ 需要运行时 `POST_NOTIFICATIONS` 权限。被拒绝时插件仍可"安排"，
  但**不会显示**——因此**必须**把权限状态落库并在 UI 显示"提醒未生效"（需求 R-REM-04）。
- 精确投递需要精确闹钟权限：`SCHEDULE_EXACT_ALARM` 与 `USE_EXACT_ALARM` 语义不同，
  后者可被用户/系统撤销。**权限被撤销后，已安排的精确提醒不再触发**，
  插件只记录错误。→ 需要在启动与提醒变更时重新检查并更新 `notification_state`。
- **OEM 省电策略**（小米、华为、三星等）会阻止后台应用触发已安排的通知。
  这是 OS 层限制，插件明确说明无法解决，官方指引指向 `dontkillmyapp.com`。
  插件还记录：三星实现下 `AlarmManager` 有约 500 个待安排上限。
- 结论：**V1 不得承诺"精确提醒"**，只能承诺"尽力投递 + 失败可见"。重复提醒 V1 不支持（见 `decisions/0006`）。

**Windows**
- 通过 C++/WinRT 实现 Toast 通知，支持图片、按钮、下拉框、文本输入、动态更新。
- **限制 1**：Windows 不支持重复通知，`periodicallyShow` / `periodicallyShowWithDuration` 会抛 `UnsupportedError`。
- **限制 2（重要）**：**只有具备 package identity（MSIX 打包）的应用**才能查询已显示的通知。
  未打包为 MSIX 时，`cancel()` **什么都不做**，`getActiveNotifications()` **返回空列表**。
  → 这意味着未打包时**无法撤回**已弹出的通知，也无法在 UI 里列出"当前活跃提醒"。
  这是必须在 UI 与已知限制中如实反映的行为差异（问题 Q6）。

**统一抽象**：`NotificationScheduler` port 暴露
`requestPermission()` / `schedule()` / `cancel()` / `pendingRequests()` / `capabilities()`。
`capabilities()` 返回平台真实能力（例如 Windows 未打包时 `canCancel=false`），
UI 据此**不显示做不到的承诺**。这也是"界面必须明确告知权限被拒绝"（§4.3）的实现基础。

### 3.2.1 Android 的额外硬约束（本 agent 补充核实）[文档核实]

- **应用被"强制停止"（force-stop）后，已安排的闹钟永不触发。**
- **重启后闹钟被清空**：必须声明 `RECEIVE_BOOT_COMPLETED` 并在启动广播中重新安排，
  否则"重启后提醒全部消失"——这会直接违反 §4.3 的提醒要求。
- **Android 14+ 前台服务**需要声明 `foregroundServiceType` 及配套 `FOREGROUND_SERVICE_*` 权限；
  Android 15 还增加了前台服务超时。因此**不要**为了提醒而引入常驻前台服务。
- `WorkManager` 的 `frequency` 是**最小值而非承诺**：Doze 批处理可能把"每小时"折叠成"整夜一次"，
  周期任务下限约 15 分钟。**周期备份用它，精确提醒不能用它。**

**设计后果**：通知与后台必须是"尽力而为"模型，并且**应用每次启动都要做一次补课（catch-up）**：
把已经过期但未展示的提醒在本机呈现，并重新安排未来提醒。

### 3.3 后台任务 [文档核实]

| 平台 | 能力 |
| --- | --- |
| Android | `workmanager`（最新 0.10.10，平台声明为 android/ios/macos/web，**明确不含 windows**）做延迟/周期任务；受 OEM 省电策略与 Doze 影响；force-stop 与重启会清除闹钟 |
| Windows（未打包） | **标准 `flutter build windows` 产物是未打包的 Win32 exe**。Windows App SDK 的 `BackgroundTaskBuilder` **要求 MSIX 打包**；官方给出的未打包替代方案是 **Task Scheduler** 或 .NET Worker Service——即一个**独立的计划任务入口**，**不是**运行中应用的 Dart 回调。 |
| Windows（已打包 MSIX） | 可用 Windows App SDK 后台任务；但仍需处理"应用未运行时如何初始化 Dart 运行时"的问题。 |

`workmanager` 不支持 Windows；`flutter_background_service` 只声明 android/ios；
`windows_taskbar` 只管任务栏（缩略图工具栏、进度、覆盖图标、标题），**不做托盘也不做调度**；
`tray_manager` 0.8.0（需要 Flutter ≥3.47）可让进程常驻托盘，但**常驻≠调度器**。

**设计后果**：
- Windows 的"自动备份/提醒"只能在**应用运行时**发生：
  启动时检查 + 退出时执行 + （可选）托盘常驻让进程活着。
- 若确实需要"应用未打开也能唤醒"（例如加载日回顾），
  唯一可信路径是 **Task Scheduler + 独立的 `--sync-only` 入口**，且该入口必须
  自行初始化 Dart/Flutter 运行时、不启动 UI。这是**额外工程**，需用户决定是否纳入 V1（问题 Q6）。
- **不得**在 Windows 上声称"即使未打开应用也会自动备份/提醒"。
- Android 可用 `WorkManager` 做周期备份，但仍需在已知限制中说明省电策略与 force-stop 影响。

### 3.4 附件与文件 [文档核实]

- 读取（**推荐**）：`file_selector` 1.1.0（android, ios, linux, macos, web, **windows**；
  要求 Flutter ≥ 3.35）—— 这是 Flutter 官方在桌面端**推荐的**文件选择插件。
- 读取（备选）：`file_picker` 13.1.0（含 windows/android）。
  但其在 Android 10+ 上**缺少 SAF 持久化 URI 授权**（上游未决请求），
  因此**不能**假定"用户选过的目录以后一直可访问"。
- 位置：`path_provider` 2.1.6（android, ios, linux, macos, **windows**）提供应用私有目录。
- 分享/打开：`share_plus` 13.3.1、`url_launcher` 6.3.3（均含 windows）。
- 数据库文件位置：不得放到会被云盘同步的目录（风险 DL-1）。
- **方案（关键）**：**导入即复制**进 `blobs/<sha256>` 内容寻址目录，
  数据库只存**相对路径 + sha256 + 字节数**，**绝不**依赖用户原始 URI/路径。
  一次动作同时规避三类故障：Android SAF 授权被撤销、Android scoped storage 限制、
  Windows 路径不稳定。代价是大文件会占用额外空间（可接受；50 MB 上限见需求 ⚠GAP-21）。
- 仅在"必须避免复制超大媒体"时才回退到 `ACTION_OPEN_DOCUMENT` +
  `takePersistableUriPermission`，并需处理授权失效。

### 3.4.1 Android 16 KB 页面对齐要求 [文档核实]

Google Play 要求面向 64 位设备分发的应用，其**未压缩的共享库必须按 16 KB 页边界对齐**
（Android 15+ 支持 16 KB 页设备）。
`package:sqlite3` 上游声明预编译二进制已满足，但**必须在实际构建产物上验证**
（解包 APK，检查 `.so` 的对齐与是否被压缩），不能只信上游声明。

验证命令（阶段 0 执行）：
```bash
# 解包产物，检查 libsqlite3 的页对齐与压缩状态
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep '\.so'
# 对齐检查使用 Android SDK 的 zipalign/llvm 工具或 Play 的 16KB 检查工具
```
判据：`libsqlite3.so` 未被压缩（`STORED`），且 64 位 ABI 版本页对齐 ≥ 16 KB。

### 3.5 Windows 桌面特定事项 [文档核实]

- Windows 桌面构建需要 **「Desktop development with C++」工作负载**
  （workload ID `Microsoft.VisualStudio.Workload.NativeDesktop`），Flutter 官方文档要求用
  `flutter doctor -v` 检查 **Windows version** 与 **Visual Studio - develop Windows apps** 两节。
  文档措辞是安装 Visual Studio（IDE）；但微软官方说明 **可以只装 MSVC Build Tools 独立包**
  （"You don't need to install the Visual Studio IDE if you don't plan to use it"）。
  Flutter 的 Windows 构建实际调用 CMake + MSBuild（生成的 `windows/CMakeLists.txt`
  要求 `cmake_minimum_required(VERSION 3.14)`），CMake 随 Build Tools 一起安装。
  **但"`flutter doctor` 是否接受 Build-Tools-only 安装"未被上游文档确认**，
  列为阶段 0 必须实测的项目（`flutter doctor -v` 通过则省下数 GB 与管理员权限需求）。
- 当前 Flutter 稳定版为 **3.47**（官方站点公告）；`tray_manager` 0.8.0 要求 ≥3.47。
- **native assets / build hooks 需要 Flutter 3.38+**：
  3.38.0 release notes 列出 *"[native assets] Enable build hooks and code assets on stable"*。
  `flutter_local_notifications` 22.3.2 的 pubspec 声明 `flutter: ">=3.38.1"`。
  → **最低 Flutter 版本取 3.38.1；若要用托盘则需 ≥3.47**。
- **单实例**：多实例同时写同一个 SQLite 文件会互相阻塞/出错。
  需要单实例保障：`windows_single_instance` 1.2.0（仅 windows）或
  `flutter_alone` 4.1.0（windows/macos/linux）。
  即使有单实例，**仍必须**开启 WAL + `busy_timeout`（防御后台任务与同步 isolate）。
- **数据目录**：用 `path_provider` 的 `getApplicationSupportDirectory()`
  （Windows 下为 `%APPDATA%\<app>`），**不要**用 `getApplicationDocumentsDirectory()`
  （文档目录更容易被用户放进云盘）。
- 应用标识：`flutter_local_notifications` 的 Windows 初始化需要
  `appName` / `appUserModelId` / `guid`，这些必须固定并写入文档，否则 Toast 可能不显示。
- **打包方式（待决策，问题 Q6）**：
  | 方案 | 通知可取消/可枚举 | 后台唤醒 | 工程成本 |
  | --- | --- | --- | --- |
  | 未打包（`flutter build windows` 默认） | ❌ | ❌ | 最低 |
  | MSIX（`package:msix` 3.18.0） | ✅ | ✅（可配 Windows App SDK 后台任务） | 需要签名证书；分发需旁加载说明 |
  | 未打包 + Task Scheduler + 独立 `--sync-only` 入口 | ❌ | ✅ | 需要独立的无 UI 入口并自行初始化运行时 |
- **单实例与托盘**：`win32` 6.4.0（纯 Dart FFI）可直接调用 Win32 API，
  因此单实例与 Task Scheduler 交互也可不依赖第三方插件（降低依赖风险）。

### 3.6 辅助包平台核实汇总 [文档核实]

| 包 | 版本 | 平台 | 用途 |
| --- | --- | --- | --- |
| `drift` | 2.35.2 | 纯 Dart（原生全平台） | ORM/查询/迁移 |
| `package:sqlite3` | 3.7.0 | 打包 SQLite（含 FTS5） | 数据库引擎 |
| `drift_flutter` | 0.3.1 | 纯 Dart | 便捷打开数据库（仍声明 `sqlite3_flutter_libs` 依赖，需注意） |
| `flutter_local_notifications` | 22.3.2 | android, ios, macos, linux, **windows**, web | 提醒（要求 Flutter ≥3.38.1） |
| `workmanager` | 0.10.10 | android, ios, macos, web（**无 windows**） | Android 后台 |
| `flutter_timezone` | 5.1.1 | android, ios, linux, macos, **windows**, web | 取 IANA 时区 |
| `timezone` | 0.11.1 | 纯 Dart | `TZDateTime` 与时区库 |
| `file_selector` | 1.1.0 | android, ios, linux, macos, web, **windows** | **推荐**的文件选择（桌面官方推荐） |
| `file_picker` | 13.1.0 | 含 windows/android | 备选；Android 缺 SAF 持久授权 |
| `path_provider` | 2.1.6 | 含 windows/android | 数据目录 |
| `share_plus` | 13.3.1 | 含 windows/android | 分享导出 |
| `url_launcher` | 6.3.3 | 含 windows/android | 打开外部链接 |
| `windows_single_instance` | 1.2.0 | 仅 windows | 单实例 |
| `flutter_alone` | 4.1.0 | windows, macos, linux | 单实例（跨桌面） |
| `tray_manager` | 0.8.0 | 桌面 | 托盘常驻（要求 Flutter ≥3.47） |
| `win32` | 6.4.0 | 纯 Dart FFI | 直接调 Win32（单实例、Task Scheduler） |
| `msix` | 3.18.0 | 纯 Dart | MSIX 打包（如选择打包路线） |
| `archive` | 4.5.1 | 纯 Dart | ZIP 备份归档 |
| `crypto` | 3.0.7 | 纯 Dart | sha256 |

**注意**：`drift_flutter` 0.3.1 仍声明依赖 `sqlite3_flutter_libs: ^0.6.0+eol` 与
`sqlcipher_flutter_libs: ^0.7.0+eol`。这两个包的 `+eol` 版本**已移除全部代码**
（其 pubspec description 就是"不再使用，请升级到 `package:sqlite3` 3.x"），
因此不会引入额外原生代码，但会留下一个**已弃用的依赖链**。
→ **决策：不用 `drift_flutter`**，直接手写 `NativeDatabase.createInBackground`
（见 §4.2），彻底绕开 EOL 依赖。阶段 0 需用 `flutter pub deps` 确认依赖树中不再出现它们。

---

## 4. 技术选型决定（依据上文）

### 4.1 客户端：Flutter [文档核实]

保留规格 §8.1 的默认选择，理由：
- 单代码库覆盖 Windows + Android（规格明确要求两端）。
- 桌面不是二等公民：Flutter 官方支持 Windows 并有键盘/快捷键 API。
- `package:sqlite3` 的 build hooks 让两个平台用**同一份** SQLite 构建，行为一致。

**不选**其他跨平台方案的原因（简要）：Electron/Tauri 需要额外运行时而偏离"本地优先轻量"；
.NET MAUI 在 Windows 上得心应手但 Android 生态与 Flutter 相比无优势；
Kotlin Multiplatform 桌面 + Android 同样要两套 UI 思路，且桌面生态更弱。
（这些是工程判断，不构成对规格的改动。）

### 4.2 数据库：drift + `package:sqlite3` [文档核实]

```dart
// 直接使用 NativeDatabase，不经 drift_flutter，完全绕开已 EOL 的兼容包
LazyDatabase(() async {
  final dir = await getApplicationSupportDirectory();
  final file = File(p.join(dir.path, 'life.sqlite'));
  return NativeDatabase.createInBackground(
    file,
    setup: (db) {
      db.execute('PRAGMA journal_mode = WAL;');
      db.execute('PRAGMA foreign_keys = ON;');
      db.execute('PRAGMA busy_timeout = 5000;');
      db.execute('PRAGMA synchronous = NORMAL;');
    },
    readPool: 2,   // 单写 + 多读；WAL 下安全
  );
});
```

要点：
- `createInBackground` 把数据库放到后台 isolate，避免同步写阻塞 UI 线程。
- `readPool` 需要 WAL，否则会 `database is locked`（drift 文档明确说明）。
- `PRAGMA foreign_keys` 是**每连接**设置，必须在 `setup` 里设（不是一次全局）。
- `synchronous = NORMAL` 是 WAL 下的常规取舍（牺牲"最后若干事务"换取吞吐）；
  **备份/迁移等关键操作前**可临时切到 `FULL`。

### 4.3 全文搜索：FTS5 + 中文方案待定（问题 Q5）

见 §3.1。阶段 6 之前必须完成 trigram vs bigram vs LIKE 的实测对比（体积、查询延迟、召回率）。

---

## 5. 同步方案对比（决策依据）

评估了现成同步引擎（均可用于 Flutter），重点关注 **Windows 桌面支持** 与 **许可/依赖**。

| 方案 | Windows 桌面 | 许可 / 成本 | 需服务端 | 冲突模型 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **自建 op-log + 版本向量**（本设计） | ✅ 纯 Dart，无插件 | 自有代码 | 需要（可自建，也可文件交换） | 自己定义（字段级 LWW + 文本保留双版本 + 集合并集） | **采用** |
| PowerSync | ✅ 官方矩阵含 Windows | 客户端开放；服务 FSL-1.1-ALv2（两年后转 Apache-2.0，禁止竞争性使用） | 需要 + 上游 Postgres/MySQL/Mongo | 服务端权威；简单后端 = 逐字段 LWW | 备选：若已有 Postgres 且接受服务依赖 |
| Couchbase Lite (`cbl`/`cbl_flutter_ce`) | ✅ Windows ≥10 x86-64 | Apache-2.0，但官方声明"非官方产品"；企业版 P2P/加密需付费 | 需要 Sync Gateway 4 | 文档版本向量（v4）；v3→v4 单向升级 | 备选：想买现成的版本向量同步时 |
| Turso / libSQL embedded replicas | ✅（社区维护包） | MIT 客户端 + 付费云 | 需要 | **页面级单向复制，无合并**；官方警告"同步中打开本地库会损坏" | 拒绝：不是合并引擎，且有明确损坏陷阱 |
| ElectricSQL | ❌ 无可用 Dart 客户端 | Apache-2.0 + 云 | 需要 | 旧设计为 CRDT | 拒绝 |
| Realm / Atlas Device Sync | — | — | — | — | 拒绝：已停止服务 |
| WatermelonDB | ❌ 仅 React Native | MIT | 自建 | 自定义 | 拒绝 |
| ObjectBox | ✅ 数据库支持 Windows | 核心 Apache-2.0；**Sync 需商业授权** | 需要 | 未公开足够细节 | 拒绝：无法评估 |
| Ditto | ⚠️ **文档自相矛盾**（pub.dev 列 Windows，README 写 "Planned"） | 商业报价 | 可选（可无服务器 P2P） | CRDT | 拒绝：不实测不采用 |

**采用自建方案的理由**：
1. 规格 §8.3 要求冲突策略必须明确到"任务状态、时间记录、标签、关系"——
   现成引擎要么不给你这个控制（PowerSync 服务端权威），要么要求整套服务与许可。
2. 我们要的语义很小：字段级 LWW + 文本双版本 + 集合并集 + 游标同步。
   已用 **20 条可执行测试**证明可实现且正确（§2.4），复杂度可控。
3. 无插件、无 Rust/CGo 构建步骤、无服务依赖 → Windows 与 Android 构建风险最低。
4. 数据自主：日记这类内容不应默认经过第三方服务（§8.5 隐私）。

**代价（如实记录）**：需要自己维护 relay（或选择文件交换降级方案），
以及自己承担协议演进与兼容性。这正是待决问题 Q1/Q2。

---

## 6. 待补工具链（阻塞项）

要真正完成规格 §8.1 要求的"最小技术验证"，必须先安装：

| # | 组件 | 用途 | 备注 |
| --- | --- | --- | --- |
| 1 | Flutter SDK（≥3.38.1；建议 3.47） | 全部构建 | 需约 3 GB；`sqlite3` 的 build hooks 需要 ≥3.38 |
| 2 | **MSVC Build Tools**（勾选「Desktop development with C++」） | **Windows 构建必需** | 可**只装 Build Tools 不装 IDE**（微软官方支持）；`flutter doctor` 是否接受需实测。仍需管理员权限 |
| 3 | Android SDK + 平台工具（`adb`）+ JDK 17+ | Android 构建 | 可用 Android Studio 一并安装 |
| 4 | （可选）Android 真机 | 通知与后台验证 | **模拟器无法验证 OEM 省电策略**，也无法真实验证 16 KB 页对齐设备 |

本机当前：**无管理员权限**、`flutter`/`dart`/Android SDK/MSVC 全部缺失，
`winget`/`scoop` 可用，Node 26 与 Python 3.14 可用。
安装 MSVC Build Tools 与 Android SDK **需要管理员权限与用户确认**（问题 Q8）。

> 阶段 0 的第一项工作就是补齐上表并在 `flutter doctor -v` 上取得绿色结果。
> 在此之前，`docs/testing.md` 中的 L1–L3 测试**可以**先跑（纯 Dart，不需要 VS/Android SDK），
> 但 L4 端到端与所有平台验证（§7）**必须**等工具链就绪。

---

## 7. 平台验证计划（工具链就绪后执行）

每项给出**具体命令**与**通过判据**，结果回填到本文件并替换对应 [未验证] 标记。

### V1 环境与构建
```bash
flutter --version              # 记录版本，需 ≥3.38.1
flutter doctor -v              # Windows 节与 Visual Studio 节必须无 error
flutter config --enable-windows-desktop
flutter config --enable-android
```
判据：`flutter doctor` 中 Windows toolchain 与 Android toolchain 均 OK。

### V2 最小应用 + 数据库 + FTS5
建 `app/apps/life_app`，加 `drift`、`sqlite3`，实现：
建库 → 建 `STRICT` 表 → 开 WAL → 写入中文与英文 → FTS5 查询。

判据（**必须实际运行，不能只看编译通过**）：
- `SELECT sqlite_version()` 打印 **≥ 3.53.4**；
- `PRAGMA journal_mode` 返回 `wal`；`PRAGMA foreign_keys` 返回 1；
- 英文关键词检索命中；**中文关键词检索**按所选方案命中（这是 Q5 的决策依据）；
- Windows 与 Android 上结果一致。

### V3 通知（两平台各一遍）
```bash
# Android：安排 1 分钟后提醒 → 锁屏等待 → 检查是否弹出
# Android：拒绝通知权限后重复 → 检查 UI 是否显示"提醒未生效"
# Android：撤销精确闹钟权限后 → 检查已安排提醒的状态
# Windows：安排 1 分钟后提醒（先不打包 MSIX）→ 观察能否弹出
# Windows：调用 cancel() → 记录是否真的撤回（预期：未打包时无效）
# Windows：打包 MSIX 后重复上面两项
```
判据：行为与 §3.2 的文档描述一致；差异必须记入 `known-limitations.md`。

### V4 后台与恢复
```bash
# Android：杀进程后 WorkManager 是否按时执行；重启手机后计时器状态是否恢复
# Windows：关闭应用后是否存在任何自动执行（预期：无）
```
判据：确认 §3.3 的结论；Windows 的自动备份策略据此定为"启动时检查"。

### V5 附件与文件
判据：导入文件后**复制**进 `blobs/<sha256>`；删除原文件后应用仍能打开附件；
重复导入同一文件只占一份空间（哈希去重）。

### V6 单实例与并发写
判据：启动第二个实例被正确转交并退出；后台 isolate + 同步 isolate 同时写不出现
`database is locked`（连续 1000 次混合读写无失败）。

### V7 备份/恢复实测（规格 §8.4 硬性要求）
判据：`VACUUM INTO` 快照在**持续写入**情况下仍通过 `quick_check` + `foreign_key_check`；
在真实设备上完成一次"备份 → 空库恢复 → 逐表比对"；
完成一次"恢复失败注入 → 确认现场未被覆盖"。

### V8 双设备同步
判据：Windows 与 Android 各作为一台设备，各自离线编辑 → 联网 → 收敛；
重放同步 5 次无重复对象；强制制造文本冲突 → 两侧冲突记录一致。

### V9 性能
判据：10 万对象下启动 < 3 s、搜索 < 500 ms、备份/恢复不 OOM。

---

## 8. 已知限制（本次验证即已确认，须写入 `known-limitations.md`）

**Windows**
1. **Windows 未打包 MSIX 时通知无法取消、无法列出活跃通知**（`cancel()` 无效、
   `getActiveNotifications()` 返回空）。UI 必须据此降级，不显示"可撤回"的假承诺。
2. **Windows 无可靠的"应用关闭后自动执行"**：未打包应用唯一路径是 Task Scheduler，
   而那是**独立的计划任务入口**，不是运行中应用的 Dart 回调；需要额外工程（问题 Q6）。
   因此自动备份/提醒**默认只发生在应用运行时**。
3. **Windows 不支持重复通知**（`periodicallyShow*` 抛 `UnsupportedError`）；
   本项目 V1 本就不做重复提醒，但需在代码层显式禁止调用。
4. Windows 稳定版需 Flutter ≥3.38.1；使用托盘需 ≥3.47。

**Android**
5. **Android 不保证精确投递**：`POST_NOTIFICATIONS`（13+）与精确闹钟权限均可被拒绝/撤销；
   Android 14 起精确闹钟默认**不授予**，且 `USE_EXACT_ALARM` 需 Play 审核（不适合个人应用）。
6. **应用被强制停止后闹钟不触发；重启会清空闹钟**，
   必须声明 `RECEIVE_BOOT_COMPLETED` 并在启动时重新安排，否则"重启后提醒消失"。
7. **OEM 省电策略**（小米/华为/三星等）可静默阻止后台触发；缓解只能靠引导用户设置。
8. **`WorkManager` 周期下限约 15 分钟且受 Doze 批处理影响**，不能用来做"准点提醒"。
9. **16 KB 页面**：Play 要求 64 位设备上未压缩共享库按 16 KB 对齐；
   上游声称已满足，**必须在产物上实测**。
10. `file_picker` 在 Android 10+ **没有** SAF 持久化 URI 授权，
    因此附件方案必须是"导入即复制"，不能依赖用户选定目录长期可访问。

**通用**
11. **中文全文搜索需要额外方案**（FTS5 默认分词器对 CJK 无效），
    在 Q5 决策前不能声称"支持中文全文搜索"。
12. **`sqlite3_flutter_libs` / `sqlcipher_flutter_libs` 已 EOL**，
    其 `+eol` 版本**移除了全部代码**；任何仍要求它们的文档或示例都已过时。
    替代品是 `package:sqlite3` ^3.0.0（本项目用 3.7.0，内含 SQLite 3.53.4）。
13. 本机**无 Flutter/MSVC/Android 工具链**，因此 §7 全部验证项目前**均未执行**。
