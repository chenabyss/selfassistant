// 第一个 Dart 测试 —— 验证工具链与依赖约束，而不是占位空测试。
//
// 为什么这个测试值得存在（而不是写个 expect(true, isTrue) 糊过去）：
// 项目的版本下限不是随手选的，每一条都对应一个具体约束；而 CI 只会在
// `flutter pub get` 时才发现"某个已 EOL 的包被悄悄引入"。把这两件事变成
// 可执行断言，能在阶段 1 的第一次 CI 就守住它们。
//
// 这里**故意不依赖任何第三方测试包**，只用 `package:test` + `dart:io`：
// 依赖越少，它在 CI 首次运行时越不容易因为环境问题失败。
//
// 所有正则都使用 **raw string**（`r'...'`）：Dart 会把普通字符串里的 `$` 当作
// 字符串插值，而正则里恰好充满 `\s` 与 `$`（行尾锚点），用普通字符串必然踩坑。

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';

/// 仓库根目录。测试在 `app/` 下运行，因此根目录是它的父目录。
Directory get _repoRoot => Directory.current.parent;

/// 读取 `tool/versions.yaml` 中某个顶层块的行（到下一个顶层键为止）。
List<String> _readBlockLines(String text, String blockKey) {
  final lines = const LineSplitter().convert(text);
  final out = <String>[];
  var inside = false;
  final header = RegExp('^' + RegExp.escape(blockKey) + r':[ \t]*$');
  for (final line in lines) {
    if (header.hasMatch(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    final isTopLevel = line.isNotEmpty && !line.startsWith(' ') && !line.startsWith('#');
    if (isTopLevel) break;
    out.add(line);
  }
  return out;
}

/// 读取**指定块内**的标量。这是读取版本约束的正确方式：
/// `minimum` 这个键在 `flutter:` 与 `dart:` 下**同时存在**，任何不带块上下文的
/// 正则都会读到先出现的那个（首版实现就把 dart 的下限错读成 Flutter 的 3.38.1）。
String? _readBlockScalar(String text, String blockKey, String key) {
  final pattern = RegExp(
    '^[ \\t]+' + RegExp.escape(key) + r':[ \t]*"?([^"\n#]+)"?',
    multiLine: true,
  );
  for (final line in _readBlockLines(text, blockKey)) {
    final match = pattern.firstMatch(line);
    if (match != null) return match.group(1)!.trim();
  }
  return null;
}

/// 语义化版本比较（只比较前 3 段，缺失段按 0 处理）。
int _compareVersions(String a, String b) {
  final pa = a.split('.').map((s) => int.tryParse(s) ?? 0).toList();
  final pb = b.split('.').map((s) => int.tryParse(s) ?? 0).toList();
  for (var i = 0; i < 3; i++) {
    final d = (pa.length > i ? pa[i] : 0) - (pb.length > i ? pb[i] : 0);
    if (d != 0) return d;
  }
  return 0;
}

void main() {
  late String versionsYaml;
  late String pubspec;

  setUpAll(() {
    final versionsFile = File('${_repoRoot.path}/tool/versions.yaml');
    final pubspecFile = File('${Directory.current.path}/pubspec.yaml');
    expect(versionsFile.existsSync(), isTrue,
        reason: 'tool/versions.yaml 必须存在（它是版本约束的唯一权威来源）');
    expect(pubspecFile.existsSync(), isTrue, reason: 'app/pubspec.yaml 必须存在');
    versionsYaml = versionsFile.readAsStringSync();
    pubspec = pubspecFile.readAsStringSync();
  });

  group('工具链版本约束', () {
    test('SQLite 打包版本不低于 WAL-reset 修复版本 3.51.3', () {
      final bundled = _readBlockScalar(versionsYaml, 'sqlite', 'version');
      final minimum = _readBlockScalar(versionsYaml, 'sqlite', 'minimum_acceptable');
      expect(bundled, isNotNull, reason: 'sqlite.version 未声明');
      expect(minimum, isNotNull, reason: 'sqlite.minimum_acceptable 未声明');
      expect(_compareVersions(bundled!, minimum!), greaterThanOrEqualTo(0),
          reason: 'SQLite $bundled 低于可接受下限 $minimum。'
              'WAL-reset 缺陷影响 3.7.0–3.51.2，而本项目存在 >=2 个连接同时写入的形态。');
    });

    test('声明的 Dart SDK 下限与 pubspec 一致', () {
      // 必须按块读取：`minimum` 在 flutter: 与 dart: 下都存在。
      final declared = _readBlockScalar(versionsYaml, 'dart', 'minimum');
      final flutterFloor = _readBlockScalar(versionsYaml, 'flutter', 'minimum');
      expect(declared, isNotNull, reason: 'dart.minimum 未声明');
      expect(flutterFloor, isNotNull, reason: 'flutter.minimum 未声明');
      expect(declared, isNot(equals(flutterFloor)),
          reason: 'dart.minimum 与 flutter.minimum 不应相同 —— '
              '相同通常意味着读取时丢掉了块上下文（读到了 Flutter 的值）');
      expect(pubspec, contains(declared!),
          reason: 'tool/versions.yaml 声明 Dart $declared，但 app/pubspec.yaml 的 '
              'environment.sdk 不一致。两处必须同步（CI 另有 check_versions.mjs 把关）。');
    });

    test('Flutter 下限与 pubspec 一致', () {
      final flutterFloor = _readBlockScalar(versionsYaml, 'flutter', 'minimum');
      expect(flutterFloor, isNotNull);
      expect(pubspec, contains(flutterFloor!),
          reason: 'app/pubspec.yaml 的 environment.flutter 必须包含 $flutterFloor');
    });
  });

  group('依赖约束', () {
    test('pubspec 未引入任何已 EOL 的依赖', () {
      final forbidden = _readBlockLines(versionsYaml, 'forbidden')
          .map((l) => RegExp(r'^\s*([a-z_0-9]+):').firstMatch(l)?.group(1))
          .whereType<String>()
          .toList();

      expect(forbidden, isNotEmpty, reason: 'tool/versions.yaml 应声明至少一个禁止依赖');

      for (final name in forbidden) {
        final declared =
            RegExp(r'^\s{2}' + RegExp.escape(name) + r':\s*\S', multiLine: true).hasMatch(pubspec);
        expect(declared, isFalse,
            reason: '$name 已 EOL，不得出现在 app/pubspec.yaml 中（详见 tool/versions.yaml）');
      }
    });

    test('已解析的依赖图中没有已 EOL 的包', () {
      // package_config.json 由 `flutter pub get` 生成，是解析结果的权威记录。
      final cfgFile = File('${Directory.current.path}/.dart_tool/package_config.json');
      if (!cfgFile.existsSync()) {
        markTestSkipped('尚未执行 pub get，跳过依赖图检查');
        return;
      }
      final cfg = jsonDecode(cfgFile.readAsStringSync()) as Map<String, dynamic>;
      final names = (cfg['packages'] as List)
          .map((p) => (p as Map<String, dynamic>)['name'] as String)
          .toSet();

      // 先确认依赖图非空，否则下面的循环会变成空转而"假通过"。
      expect(names.length, greaterThan(10), reason: '依赖图异常小，检查可能失效');

      for (final banned in const [
        'sqlite3_flutter_libs',
        'sqlcipher_flutter_libs',
        'drift_flutter',
      ]) {
        expect(names.contains(banned), isFalse,
            reason: '$banned 出现在已解析的依赖图中。'
                'drift >= 2.32 直接使用 package:sqlite3 的 build hooks，无需它。');
      }
    });

    test('FTS5 是搜索方案的硬前提，必须在版本约束中声明', () {
      final options = _readBlockLines(versionsYaml, 'sqlite')
          .where((l) => l.contains('SQLITE_'))
          .join('\n');
      expect(options, contains('SQLITE_ENABLE_FTS5'),
          reason: '中文搜索方案（trigram）依赖 FTS5；若打包的 SQLite 不含 FTS5，'
              'docs/search-cjk-results.md 的结论不成立。');
    });
  });
}
