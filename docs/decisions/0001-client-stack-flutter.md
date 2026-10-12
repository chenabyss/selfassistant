# ADR-0001：客户端采用 Flutter（Windows + Android）

- 状态：**提议**（等待用户确认）
- 日期：2026-10-12
- 关联：规格 §8.1、§12；`docs/dart-verification.md`

## 背景

规格要求 Windows 与 Android 双端，且明确指出"Flutter 可作为首选候选，
但 Agent 必须先做最小技术验证"。同时要求"不因跨平台本身而忽略 Windows 桌面体验"。

## 决策

采用 **Flutter**，单代码库覆盖 Windows 桌面与 Android，最低版本 **3.38.1**，
建议使用当前稳定版 **3.47**。

## 理由

1. 官方同时支持 Windows 桌面与 Android，且桌面端有键盘/快捷键与窗口管理能力（满足 §7）。
2. `package:sqlite3` 3.x 通过 Dart build hooks 打包**同一份** SQLite 构建，
   两个平台行为一致——这对"数据一致性"（§9）比 UI 一致性更重要。
3. `flutter doctor` 提供可复现的环境检查，满足"可复现构建"（§10.4）。
4. 相比 Electron/Tauri：无额外运行时、启动更快、更贴近"本地优先轻量"的定位。
5. 相比 .NET MAUI / Kotlin Multiplatform：桌面端生态与社区规模在此场景下更有利。

## 版本下限的依据（实测/核实）

| 约束 | 来源 |
| --- | --- |
| ≥ 3.38 | Flutter 3.38.0 release notes："[native assets] Enable build hooks and code assets on stable" —— `package:sqlite3` 3.x 依赖此能力 |
| ≥ 3.38.1 | `flutter_local_notifications` 22.3.2 的 pubspec `flutter: ">=3.38.1"` |
| ≥ 3.47 | `tray_manager` 0.8.0 的 pubspec `flutter: ">=3.47.0"`（仅在需要托盘常驻时） |

## 后果

- **正面**：单代码库、测试工具统一（`package:test` + `integration_test`）、
  原生 SQLite 行为一致、无需为每个平台维护两套数据层。
- **负面**：
  - Windows 桌面构建**必须**安装 MSVC C++ 工具链（Build Tools 或完整 VS），
    这是当前的阻塞项（`dart-verification.md` §6）。
  - Windows 桌面体验需要额外投入（单实例、托盘、快捷键、窗口状态持久化），
    不能默认"移动端 UI 直接跑桌面"。
  - 平台能力差异需要显式抽象（通知、后台执行），不能假装一致（见 ADR-0006）。
- **平台差异的隔离位置**：只允许出现在 `infrastructure/` 适配器实现中
  （`architecture.md` §2 的强制规则）。

## 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| Electron / Tauri | 额外运行时与体积，偏离"本地优先轻量"；Tauri 仍需 Rust 工具链 |
| .NET MAUI | Android 生态与 Flutter 相比无优势，且需维护两套 UI 思路的风险更高 |
| Kotlin Multiplatform | 桌面端生态较弱；UI 仍需分平台 |
| 原生双端（WinUI + Kotlin） | 双倍工作量，违反"单代码库"的投入产出比 |

## 待验证（本决策的开放项）

以下必须在工具链就绪后实测，否则本 ADR 只能停留在"提议"：

1. `flutter doctor -v` 在安装 **MSVC Build Tools（不装完整 IDE）** 时是否通过
   （微软官方支持只装 Build Tools，但 Flutter 文档未确认）。
2. Windows 与 Android 上 `SELECT sqlite_version()` 均 ≥ 3.53.4，`journal_mode=wal`，
   `foreign_keys=1`。
3. 中文 FTS5 检索方案（**已决定**：trigram + 短查询 LIKE 回退，见 ADR-0008 与
   `search-cjk-results.md`；**Android 真机性能仍待验证**，见问题 Q14）。
4. 通知在两平台的实际投递行为（见 ADR-0006）。
