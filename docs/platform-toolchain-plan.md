# platform-toolchain-plan.md — 通知能力、MSIX 验证与工具链/CI 方案

> 评审第 7 项要求："分别确定 Windows 与 Android 的提醒能力、权限失败提示和应用关闭后的行为。
> 验证 MSIX 是否有助于满足 Windows 通知需求。同时提交工具链安装或 CI 构建方案，
> 确保后续能够真实构建 Windows 与 Android 产物，并完成目标平台测试。"
>
> **诚实声明**：本文件区分 **[文档核实]** / **[推断]** / **[未验证]**。
> 本机没有 Flutter / MSVC / Android SDK，**任何构建、通知投递、MSIX 打包都未实际执行**。

---

## 1. 通知能力矩阵（要求分别确定的两平台行为）

### 1.1 能力对照表

| 能力 | Windows（未打包） | Windows（MSIX 打包） | Android |
| --- | --- | --- | --- |
| 显示 Toast 通知 | ✅ | ✅ | ✅ |
| **取消已安排/已显示的通知** | ❌ `cancel()` 无效 | ✅ | ✅ |
| **枚举当前活跃通知** | ❌ 返回空列表 | ✅ | ✅（Android 6+） |
| 重复/周期通知 | ❌ `periodicallyShow` 抛 `UnsupportedError` | ❌ 同样不支持 | ✅（但 V1 不用，见 ADR-0006） |
| 精确定时投递 | ⚠️ 仅应用运行时可安排 | ⚠️ 同上（+ 可用后台任务） | ⚠️ 需精确闹钟权限，**Android 14+ 默认不授予** |
| 应用**完全关闭**后仍能触发 | ❌ **无可靠机制** | ⚠️ 需 Windows App SDK 后台任务（**需单独验证**） | ⚠️ `AlarmManager` 可，但 force-stop 后失效、重启清空 |
| 重启后提醒仍在 | — | — | ❌ 需 `RECEIVE_BOOT_COMPLETED` 重新安排 |
| 权限被拒绝时的表现 | 无权限概念（除系统级通知开关） | 同左 | 通知不显示，但安排"成功" → **必须自行记录并提示** |

来源：`flutter_local_notifications` 22.3.2 README 的 Windows Limitations 一节（[文档核实]）、
`dart-verification.md` §3.2（已核实）。

### 1.2 权限失败 → UI 必须显示什么（规格 §4.3 硬性要求）

规格原文："提醒权限被系统拒绝时，应在界面中明确告知，**不能假装提醒已成功安排**"。
落地为 `reminder.notification_state` 的六个取值：

| `notification_state` | 触发条件 | UI 必须显示 |
| --- | --- | --- |
| `none` | 未设置提醒 | — |
| `scheduled` | 调度成功，且权限正常 | 「已安排提醒」（可信） |
| `denied` | 通知权限被拒绝（Android 13+） | **「提醒未生效：通知权限被拒绝」+ 前往设置入口** |
| `failed` | 权限被撤销 / 精确闹钟不可用 / 调度抛错 | **「提醒可能不会响」+ 原因说明** |
| `fired` | 已触发 | 「已于 <时间> 提醒」 |
| `cancelled` | 用户完成任务或删除提醒 | — |

**关键设计点**：调度结果**必须落库**（`decisions/0006`）。
只把状态放在内存里的实现无法满足"不假装成功"——进程重启后真相就丢了。

### 1.3 评审要求区分的最小状态集（与上表对应）

评审明确要求至少区分：
1. 已保存提醒 → `content`/`remind_at` 已存，但还没调度（`none`）
2. 系统提醒已成功安排 → `scheduled`
3. 通知权限被拒绝 → `denied`
4. 系统限制导致无法保证投递 → `failed`（含"Android 精确闹钟不可用"、"Windows 未打包"）
5. 提醒已过期或需要重新安排 → 启动补课时发现过期 → 本机呈现并置 `fired`，或重新安排未来提醒

**全部五项都有对应的状态值与 UI 文案，已写入需求（见 §5 的 R-REM-04 强化）。**

---

## 2. 应用关闭后的行为（评审点名）

| 场景 | Windows | Android |
| --- | --- | --- |
| 应用在前台 | ✅ 正常 | ✅ 正常 |
| 应用在后台（未关闭） | ⚠️ 已安排的 Toast 由系统投递，但**应用无法取消**（未打包时） | ✅ `AlarmManager` 投递 |
| 应用被关闭（用户退出） | ❌ **已安排的通知可能仍投递，但应用无法管理**；且没有机制在关闭后**新建**提醒 | ⚠️ `AlarmManager` 仍可投递 |
| 应用被 force-stop | ❌ 无 | ❌ **闹钟永不触发** |
| 设备重启 | — | ❌ **闹钟被清空**，需开机广播重新安排 |

### 2.1 因此的统一模型：**尽力而为 + 启动补课**

`decisions/0006` 已定，此处重申执行细节：

```
每次应用启动：
  1. 扫描 notification_state='scheduled' 且 remind_at < now 的提醒
     → 在本机以应用内方式呈现（不依赖系统通知）
     → 置 notification_state='fired'
  2. 重新安排所有未来的提醒
     （同时修复 Android 重启清空闹钟的问题）
  3. 重新查询权限与精确闹钟能力
     → 若权限已丢失，把 scheduled 改为 failed 并提示
  4. Windows：查询 capabilities()，若 canCancel=false 则在 UI 隐藏"撤回提醒"入口
```

**这是"牺牲准点性、保住'不会静默消失'"的取舍**，必须写入 `known-limitations.md`。

---

## 3. MSIX 是否有助于满足 Windows 通知需求

评审要求"验证 MSIX 是否有助于满足 Windows 通知需求"。以下是**文档核实的结论 + 待实测项**。

### 3.1 结论：MSIX 解决两个具体问题，但不解决"关闭后触发"

| 需求 | 未打包 | MSIX | MSIX 是否解决 |
| --- | --- | --- | --- |
| 能取消已显示的通知 | ❌ | ✅ | **是** —— `package identity` 是 `cancel()` 生效的前提 |
| 能枚举活跃通知 | ❌（返回空） | ✅ | **是** |
| Toast 的激活回调（用户点击后启动应用/处理动作） | ⚠️ 受限 | ✅ | **是** —— 需要 `toast_activator` CLSID 配置（[文档核实]） |
| 应用**完全关闭**后按计划新建提醒 | ❌ | ⚠️ **不自动解决** | **否** —— 需要额外接 Windows App SDK 后台任务，或用 Task Scheduler 起独立入口 |
| 开机自启 | ❌ | ✅ 可配置 `enable_at_startup` | **部分**（托盘常驻可让进程活着，但这不是调度器） |

### 3.2 MSIX 打包的可行性（[文档核实]）

`package:msix` 3.18.0（Flutter Favorite）提供 `dart run msix:create`，支持：

| 配置 | 用途 |
| --- | --- |
| `identity_name` / `publisher` / `msix_version` | **package identity**（通知可取消/可枚举的前提） |
| `certificate_path` / `certificate_password` | 签名证书；开发时默认用自签测试证书 |
| `toast_activator`（`clsid` / `arguments` / `display_name`） | **Toast 激活**（点击通知后的行为） |
| `enable_at_startup` | 开机自启 |
| `capabilities` | 声明网络等能力 |
| `publish_folder_path` + `dart run msix:publish` | App Installer 分发（appinstaller 文件） |
| `--store` | 提交 Microsoft Store |

**注意**：默认会安装自签测试证书到本机（`--install-certificate false` 可禁用）。
对外分发需要真实证书；旁加载需要用户信任证书。

### 3.3 MSIX 的代价（必须计入决策）

| 代价 | 说明 |
| --- | --- |
| **签名证书** | 分发需要证书；自签证书会让用户看到安全警告 |
| 分发方式变复杂 | 不再是"解压即用"，需旁加载或 Store |
| 调试流程变化 | 需要先 `flutter build windows` 再 `msix:create` |
| **数据目录可能变化** | package identity 应用的数据目录语义与未打包应用不同 → **必须先验证数据库路径**，否则升级会导致"数据不见了" |
| CI 复杂度 | 需要管理证书密钥（GitHub Secrets） |
| 不能解决"关闭后触发" | 见 §3.1 |

**数据目录风险是本项最需要注意的**：`path_provider` 的
`getApplicationSupportDirectory()` 在**打包与未打包**两种形态下返回的路径**可能不同**。
若用户先用了未打包版本再换 MSIX 版本，会出现"数据消失"的观感。
**必须在阶段 0 实测确认两者路径，并在切换发行形态时提供迁移或明确提示。**

### 3.4 MSIX 验证方案（工具链就绪后执行）

| # | 验证项 | 命令/操作 | 判据 |
| --- | --- | --- | --- |
| M1 | 无 MSIX 时通知可显示 | 安排 1 分钟后提醒 | Toast 弹出 |
| M2 | 无 MSIX 时 `cancel()` 无效 | 显示后立即 `cancel()` | **确认无效**（记录为已知限制） |
| M3 | 无 MSIX 时 `getActiveNotifications()` | 调用 | **返回空列表**（确认） |
| M4 | 打包 MSIX | `dart run msix:create` | 产物生成且签名成功 |
| M5 | MSIX 安装与启动 | 旁加载安装 | 应用可启动 |
| M6 | MSIX 时 `cancel()` 生效 | 重复 M2 | **通知被撤回** |
| M7 | MSIX 时枚举生效 | 重复 M3 | **返回活跃通知列表** |
| M8 | Toast 激活回调 | 配置 `toast_activator`，点击通知 | 应用被激活并处理 payload |
| M9 | **数据目录一致性** | 分别记录打包/未打包的 `getApplicationSupportDirectory()` | 记录实际路径；若不同，制定迁移策略 |
| M10 | 关闭后行为 | 关闭应用，等待提醒时间 | 记录是否投递（预期：已安排的会投递，但无法新建） |
| M11 | 自签证书的安装体验 | 在干净机器旁加载 | 记录用户需要几步、是否有警告 |

**M9 是必须先做的**——它可能改变整个发行策略（见 §3.3）。

---

## 4. 工具链安装方案

### 4.1 三条路线（评审要求"安装或 CI 构建方案"）

| 路线 | 适用 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 本机安装** | 需要真机/模拟器调试、MSIX 实测 | 能跑 UI 与真机测试 | 需管理员权限，数 GB 下载 |
| **B. CI 构建（GitHub Actions）** | 验证"能构建"、产出安装包 | **不需要本机管理员权限**；可复现；可归档产物 | 无法替代真机通知/性能测试 |
| **C. A + B 组合**（推荐） | 实际开发 | B 保证可复现构建，A 做真机验证 | 需要两者都配 |

**评审要求"确保后续能够真实构建 Windows 与 Android 产物"**。
路线 B 可以在**不解决本机工具链问题**的前提下先满足"能构建"，
并让构建可复现（规格 §10.4 要求"提供可复现的构建、测试和发布步骤"）。
**但真机验证（通知、性能、MSIX）只能靠路线 A 或一台配好的机器。**

### 4.2 本机安装清单（路线 A）

| # | 组件 | 版本 | 备注 |
| --- | --- | --- | --- |
| 1 | Flutter SDK | ≥3.38.1（建议 3.47） | `sqlite3` 的 build hooks 需 ≥3.38；`tray_manager` 需 ≥3.47 |
| 2 | **MSVC Build Tools**（「Desktop development with C++」） | 最新 | 微软支持**只装 Build Tools 不装 IDE**；`flutter doctor` 是否接受**需实测** |
| 3 | Android SDK + platform-tools + JDK 17+ | — | 可用 Android Studio 一并安装，或 `cmdline-tools` |
| 4 | Android 真机 | Android 10+（Q7 候选） | **模拟器无法验证 OEM 省电策略与 16 KB 页对齐** |

### 4.3 Windows 上的网络问题（本机实测到的真实障碍）

`dart-verification.md` §2.3 实测：本机 **PowerShell 与 curl 无出网，Node 有出网**。
Flutter/pub/Android SDK 下载依赖 HTTP 客户端，**可能受同一限制影响**。

可用的应对手段（[文档核实] `flutter-action` README 支持镜像）：

```powershell
# Flutter 国内镜像（官方文档推荐给中国用户）
$env:FLUTTER_STORAGE_BASE_URL = "https://storage.flutter-io.cn"
$env:PUB_HOSTED_URL           = "https://pub.flutter-io.cn"
```

**待验证**：本机 Flutter 安装与 `pub get` 是否能走通网络（未测）。

### 4.4 安装步骤（PowerShell，需管理员权限）

```powershell
# --- Flutter ---
# 方式 1：scoop（本机已装 scoop，无需管理员）
scoop install flutter
# 方式 2：官方 zip（手动解压到无空格路径，加入 PATH）

# --- MSVC Build Tools（必须管理员）---
# 下载 vs_BuildTools.exe 后：
#   .\vs_BuildTools.exe --quiet --wait --norestart `
#     --add Microsoft.VisualStudio.Workload.NativeDesktop `
#     --includeRecommended
# 判据：flutter doctor -v 的 "Visual Studio - develop Windows apps" 一栏无 error

# --- Android ---
scoop install openjdk17
# Android cmdline-tools 解压后：
#   sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
#   flutter config --android-sdk <path>
# 判据：flutter doctor -v 的 "Android toolchain" 一栏无 error

# --- 验证 ---
flutter --version
flutter doctor -v        # Windows / Visual Studio / Android 三节全绿
flutter devices          # 至少一个 windows 设备；接上真机后有 android 设备
```

### 4.5 CI 构建方案（路线 B，可复现的构建步骤）

评审要求"提交工具链安装或 CI 构建方案"。以下是可直接使用的
GitHub Actions 配置（结构取自 `subosito/flutter-action` 官方 README [文档核实]，
**未在本机执行过**）。

#### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  # 快速反馈：纯 Dart 逻辑与文档一致性（不需要 MSVC / Android SDK）
  analyze-and-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          cache: true
      - run: flutter --version
      - run: flutter pub get
      - run: dart format --output=none --set-exit-if-changed .
      - run: flutter analyze
      # 分层守护（architecture.md §2 的强制规则）
      - run: dart run tools/check_layering.dart
      - run: flutter test
      # 同步协议契约测试（Node，零依赖）
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: node prototype/sync-core/test/run.js
      # 文档内部一致性（链接 / 交叉引用 / 数量声明）
      - run: node tools/check-docs.mjs
      - run: node tools/count-risks.mjs

  # Windows 产物
  build-windows:
    runs-on: windows-latest
    needs: analyze-and-unit
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          cache: true
      - run: flutter pub get
      - run: flutter build windows --release
      # 可选：MSIX 打包（需要证书；用 Secrets 注入）
      # - run: dart run msix:create
      #   env:
      #     MSIX_CERT_PASSWORD: ${{ secrets.MSIX_CERT_PASSWORD }}
      - uses: actions/upload-artifact@v4
        with:
          name: windows-release
          path: build/windows/x64/runner/Release/

  # Android 产物
  build-android:
    runs-on: ubuntu-latest
    needs: analyze-and-unit
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          cache: true
      - run: flutter pub get
      - run: flutter build apk --release
      # 16 KB 页对齐验证（Google Play 要求，见 dart-verification.md §3.4.1）
      - name: Verify 16KB page alignment
        run: |
          unzip -l build/app/outputs/flutter-apk/app-release.apk | grep '\.so' || true
          # TODO: 用 zipalign / llvm-readelf 断言 64 位 .so 未被压缩且 16KB 对齐
      - uses: actions/upload-artifact@v4
        with:
          name: android-release
          path: build/app/outputs/flutter-apk/app-release.apk
```

#### 国内网络环境的变体

若 CI runner 访问 Flutter/pub 受限，加环境变量（[文档核实]）：

```yaml
      - uses: subosito/flutter-action@v2
        env:
          FLUTTER_STORAGE_BASE_URL: https://storage.flutter-io.cn
        with:
          channel: stable
          cache: true
```

#### 这个方案的边界（必须说清楚）

| 能做 | 不能做 |
| --- | --- |
| 证明代码在 Windows/Android 上**能构建** | 证明**通知真的会响** |
| 产出可安装的 APK 与 Windows 产物 | 验证 MSIX 旁加载体验 |
| 保证构建可复现（规格 §10.4） | 验证 OEM 省电策略 |
| 跑纯 Dart 单元/集成测试 | 跑真机端到端旅程（规格 §10.3） |
| 归档测试报告 | 验证中文搜索的移动端性能 |

**结论**：CI 解决"能构建 + 可复现"，**不解决**"真实平台验证"。
规格 §10.4 的"Windows 和 Android 均能安装、启动和完成核心流程"
与 §8.4 的"必须执行实际恢复测试"**仍然需要一台配好工具链的机器 + 真机**。

---

## 5. 对需求文档的影响（评审第 8 项相关）

以下强化项需写入 `requirements.md`：

| 编号 | 强化内容 |
| --- | --- |
| **R-REM-04（强化）** | 提醒状态必须区分并展示**五种**情形：已保存未安排 / 已成功安排 / 权限被拒绝 / 系统限制无法保证投递 / 已过期需重排。判定：五条路径各有独立 UI 文案与状态值 |
| **R-REM-07（新增）** | 应用每次启动必须执行"补课"：呈现已过期提醒、重新安排未来提醒、复查权限并把失效的置为 `failed`。判定：杀进程后跨过提醒时间再启动，提醒被呈现且状态不为 `scheduled` |
| **R-REM-08（新增）** | Windows 未打包形态下，`capabilities().canCancel == false` 时 UI **不得**显示"撤回提醒"入口。判定：能力查询为假时该入口不存在 |
| **R-TECH-32（新增）** | 服务端日志不得包含任何记录内容（`value_json`）。判定：T-RELAY-NO-CONTENT-LOG（服务端日志扫描断言） |
| **R-TECH-33（新增）** | 构建必须可通过 CI 复现，且产物在 Windows 与 Android 上可安装启动。判定：干净的 CI runner 上 `flutter build windows` 与 `flutter build apk` 成功并归档产物 |
| **R-TECH-34（新增）** | Android 产物必须满足 16 KB 页对齐要求。判定：解包 APK 断言 64 位 `libsqlite3.so` 未被压缩且 16 KB 对齐 |

---

## 6. 待决问题（本文件相关）

| # | 问题 | 选项与代价 |
| --- | --- | --- |
| **Q6（更新）** | Windows 发行形态？ | (1) 未打包（最省事，但**通知不可取消/不可枚举**，用户点了就没了）(2) **MSIX**（解决通知管理与激活，需证书与旁加载，**必须先验证数据目录一致性 M9**）(3) 未打包 + Task Scheduler 独立入口（可后台唤醒，额外工程） |
| **Q8（更新）** | 工具链落地方式？ | (1) 本机安装（需管理员权限，可做真机验证）(2) 仅 CI（可构建、可复现，**不能**做真机通知/性能/MSIX 验证）(3) 两者都做（推荐） |
| **Q15（新增）** | 若选 CI 路线，代码托管在哪里？（GitHub / 自建 GitLab / 本地） | 决定 CI 配置能否直接使用 |
| **Q16（新增）** | Android 真机是否可用？（型号与系统版本） | 直接决定 §1 的通知行为、OEM 省电策略、16 KB 对齐、中文搜索移动端性能能否验证 |
| **Q17（新增）** | Windows 测试机是否允许安装 MSIX 与自签证书？ | 决定 M4–M8、M11 能否执行 |

---

## 7. 诚实声明汇总

| 内容 | 状态 |
| --- | --- |
| 通知在两平台的能力与限制（§1.1） | ✅ **[文档核实]**（插件 README + 上轮研究） |
| MSIX 能解决"取消/枚举/激活"（§3.1） | ✅ **[文档核实]**（插件 README 明确"需要 MSIX/package identity"；`msix` 包提供 toast_activator 配置） |
| **MSIX 不解决"关闭后新建提醒"** | ⚠️ **[推断]**：Windows App SDK 后台任务需 MSIX 是文档核实的，但"MSIX + flutter_local_notifications 是否足以在关闭后触发"**未验证** |
| 打包/未打包的**数据目录是否相同**（M9） | ❌ **[未验证] 且高风险** |
| `msix` 包的配置项与命令（§3.2） | ✅ **[文档核实]** |
| CI 工作流结构（§4.5） | ✅ **[文档核实]** 基于 `subosito/flutter-action` 官方 README；**未执行过** |
| 本机能否走通 Flutter 网络下载 | ❌ **[未验证]**（本机 PowerShell/curl 实测无出网） |
| **任何 Flutter 构建、通知投递、MSIX 打包** | ❌ **全部未执行** |
