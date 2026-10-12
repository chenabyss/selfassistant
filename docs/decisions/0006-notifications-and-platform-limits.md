# ADR-0006：通知与后台执行按"尽力而为"建模，平台差异显式暴露

- 状态：**已决定**（Windows 打包路线待定，问题 Q6）
- 日期：2026-10-12
- 关联：规格 §4.3、§7、§8.5；`docs/dart-verification.md` §3.2–3.3；`docs/known-limitations.md` L-01~L-08

## 背景

规格 §4.3 要求：
- "提醒是通知属性，不应被建模成一条独立的重复待办"；
- "**提醒权限被系统拒绝时，应在界面中明确告知，不能假装提醒已成功安排**"；
- "V1 不要求复杂重复规则"。

规格 §6.4 要求"应用重启后仍能恢复正在运行的计时器状态"。

技术验证确认了若干**无法通过实现消除**的平台限制（见 ADR 引用的验证文档）：
Windows 未打包时无法取消/枚举通知、Windows 无可靠的关闭后定时执行、
Android 精确闹钟权限可撤销、OEM 省电策略可静默阻止、重启会清空闹钟。

## 决策

### 1. 提醒的调度结果必须落库

`reminder.notification_state`：
`none` / `scheduled` / `denied` / `failed` / `fired` / `cancelled`

**调度是一个有结果的业务动作，不是一次 fire-and-forget 调用。**
`NotificationScheduler.schedule()` 返回结构化结果，用例把它写入 `notification_state`。
这是"不能假装提醒已成功安排"（§4.3）的**唯一可靠实现方式**——
若只把状态放在内存里，进程重启或界面切换后就丢失了真相。

### 2. 能力查询（capabilities）而不是假设

`NotificationScheduler` 暴露：

```dart
Future<NotificationCapabilities> capabilities();
// { canSchedule, canCancel, canEnumerate, requiresExactAlarmPermission,
//   exactAlarmGranted, permissionGranted, supportsRepeating }
```

UI 依据能力**不显示做不到的承诺**：
- Windows 未打包：`canCancel=false` → 不显示"撤回提醒"，改为提示用户手动清除系统通知。
- Android 未授予精确闹钟：显示"提醒可能延迟"，并提供跳转系统设置。

### 3. 启动时补课（catch-up）

因无法保证后台触发（Windows 完全不能、Android 可能被阻止），
**每次应用启动**执行：
1. 扫描已过期但 `notification_state='scheduled'` 的提醒，在本机呈现；
2. 重新安排未来提醒（同时解决 Android 重启清空闹钟的问题）；
3. 重新查询权限状态，把因权限撤销而失效的提醒置为 `failed`。

这是"尽力而为模型"的核心补偿机制：**牺牲准点性，保住"不会静默消失"**。

### 4. 不支持重复提醒（V1）

`periodicallyShow` / `periodicallyShowWithDuration` 在 Windows 会抛 `UnsupportedError`。
为保持两端行为一致且避免平台分支，**V1 不支持重复提醒**。
代码层必须显式禁止调用这些 API（用一个不允许这些方法的接口定义来强制）。

### 5. 计时器状态落库，不落内存

计时器 = 一行 `timer_state='running'` 的 `time_entry`（见 `data-model.md` §3.5）。
跨重启恢复读取 `start_at` 重新计算已用时长，**不依赖内存计数，也不在重启时改写历史**
（满足 §6.4"设备时间变化或跨时区后不得静默重写历史时间"）。

### 6. 后台执行按平台如实声明

| 平台 | V1 策略 |
| --- | --- |
| Windows | **不声称**关闭后自动执行。自动备份在"启动时检查 + 退出时执行"（可选托盘常驻）。 |
| Android | 用 `WorkManager` 做**周期备份**（下限约 15 分钟，受 Doze 影响）；提醒用 `AlarmManager`（可能不精确）。声明 `RECEIVE_BOOT_COMPLETED` 并在启动时恢复闹钟。 |

## 理由

### 为什么"尽力而为"是正确的建模而不是妥协

平台的真实语义就是"尽力而为"：Android 的精确闹钟权限默认不授予（14+）且可撤销，
OEM 会杀后台；Windows 未打包时连取消通知都做不到。
若把模型建成"提醒一定会响"，那么权限被拒绝、Doze 批处理、
用户撤销权限、设备重启任何一种情况都会让系统**说谎**——
而规格 §4.3 与 §7 明确禁止"假装成功"和"权限失败没有可理解的状态提示"。

把不确定性显式建模进数据（`notification_state`），
UI 就能如实告诉用户"这条提醒没能安排"或"可能延迟"。

### 为什么不用前台服务保证准时

Android 14+ 要求声明 `foregroundServiceType` 并申请对应权限，Android 15 还有超时限制；
常驻前台服务对"个人生活记录"应用是过重的侵入，也会显著耗电并被用户卸载。
因此**不引入常驻前台服务**。

### 为什么 catch-up 放在启动而不是依赖后台

- Windows 根本没有可靠的后台唤醒路径（Task Scheduler 需要独立入口，是额外工程）。
- Android 的 force-stop 与重启都会清除闹钟。
- 而"用户打开应用"是**一定会发生**的事件。
  把补课绑在这个确定事件上，比赌后台唤醒可靠得多。

## 后果

- **正面**：不撒谎；两端行为可预测；无需常驻服务；数据（`notification_state`）可测试。
- **负面**：
  - **提醒可能不准时**，甚至可能只在用户下次打开应用时才被看到。
    必须写进 `known-limitations.md` 并在 UI 表达（不能承诺"准时提醒"）。
  - Windows 的"自动备份"实质上依赖用户打开应用。
  - 不支持重复提醒是功能限制（已列入 V1 范围外）。
- **额外工作**：启动补课逻辑本身需要测试（包括"权限撤销后状态被更新为 failed"）。

## 开放项（问题 Q6）

Windows 分发方式：
- **不打包**（默认）：最省事，但 `canCancel=false`，无法撤回通知。
- **MSIX**（`package:msix` 3.18.0）：可取消/枚举通知，可配后台任务；需要签名证书与旁加载说明。
- **不打包 + Task Scheduler 独立入口**：可后台唤醒，但需实现无 UI 的 `--sync-only` 入口
  并自行初始化 Dart/Flutter 运行时（额外工程）。

建议：**先按不打包实现并把能力差异暴露好**，把 MSIX 作为阶段 10 的可选增强。
