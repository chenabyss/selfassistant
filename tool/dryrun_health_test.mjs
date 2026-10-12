// Dry-run the algorithm used in app/test/health_test.dart, against the real files.
//
// Why: Dart/Flutter are not installed on the dev machine, so the Dart test cannot be
// executed locally. This script replicates the same parsing and assertions in Node so
// the *logic* is verified before pushing; the Dart syntax itself is only verified by CI.
//
// Run: node tool/dryrun_health_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionsYaml = fs.readFileSync(path.join(root, 'tool', 'versions.yaml'), 'utf8');
const pubspec = fs.readFileSync(path.join(root, 'app', 'pubspec.yaml'), 'utf8');

// --- mirrors of the Dart helpers -------------------------------------------
function readVersionScalar(text, key) {
  // NOTE: [ \t]* rather than \s* — JS \s also matches newlines, which would let a
  // key match the *next* line's value. This exact bug made dart.minimum read as
  // 3.38.1 (the Flutter floor) during the first dry run of the Dart test.
  const pattern = new RegExp('^[ \\t]*' + escapeRe(key) + ':[ \\t]*"?([^"\\n#]+)"?', 'm');
  const m = pattern.exec(text);
  return m ? m[1].trim() : null;
}

function readBlockLines(text, blockKey) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inside = false;
  const header = new RegExp('^' + escapeRe(blockKey) + ':[ \\t]*$');
  for (const line of lines) {
    if (header.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    const isTopLevel = line.length > 0 && !line.startsWith(' ') && !line.startsWith('#');
    if (isTopLevel) break;
    out.push(line);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read a scalar from a NAMED block. This is the correct way to read version
 * constraints here: the key `minimum` exists under BOTH `flutter:` and `dart:`, so
 * any context-free regex returns whichever appears first. The first version of the
 * Dart test read `dart.minimum` as 3.38.1 (the Flutter floor) for exactly this reason.
 */
function readBlockScalar(text, blockKey, key) {
  const pattern = new RegExp('^[ \\t]+' + escapeRe(key) + ':[ \\t]*"?([^"\\n#]+)"?');
  for (const line of readBlockLines(text, blockKey)) {
    const m = pattern.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function compareVersions(a, b) {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// --- assertions -------------------------------------------------------------
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!cond) failures += 1;
};

const bundled = readBlockScalar(versionsYaml, 'sqlite', 'version');
const minimum = readBlockScalar(versionsYaml, 'sqlite', 'minimum_acceptable');
check('sqlite.version 可解析', bundled !== null, `-> ${bundled}`);
check('sqlite.minimum_acceptable 可解析', minimum !== null, `-> ${minimum}`);
check(
  `SQLite ${bundled} >= ${minimum}（WAL-reset 修复版本）`,
  compareVersions(bundled, minimum) >= 0,
);

const dartMin = readBlockScalar(versionsYaml, 'dart', 'minimum');
const flutterMin = readBlockScalar(versionsYaml, 'flutter', 'minimum');
check('dart.minimum 可解析（块内）', dartMin !== null, `-> ${dartMin}`);
check('flutter.minimum 可解析（块内）', flutterMin !== null, `-> ${flutterMin}`);
check(
  'dart.minimum 与 flutter.minimum 不同（证明块上下文未丢失）',
  dartMin !== flutterMin,
  `dart=${dartMin} flutter=${flutterMin}`,
);
check('pubspec 含 dart 下限', pubspec.includes(dartMin), `-> ${dartMin}`);
check('pubspec 含 flutter 下限', pubspec.includes(flutterMin), `-> ${flutterMin}`);

const forbidden = readBlockLines(versionsYaml, 'forbidden')
  .map((l) => (/^\s*([a-z_0-9]+):/.exec(l) || [])[1])
  .filter(Boolean);
check('forbidden 块解析出条目', forbidden.length > 0, `-> ${forbidden.join(', ')}`);

for (const name of forbidden) {
  const declared = new RegExp('^\\s{2}' + escapeRe(name) + ':\\s*\\S', 'm').test(pubspec);
  check(`pubspec 未声明 ${name}`, !declared);
}

const sqliteBlock = readBlockLines(versionsYaml, 'sqlite')
  .filter((l) => l.includes('SQLITE_'))
  .join('\n');
check('sqlite 块含 SQLITE_ENABLE_FTS5 声明', sqliteBlock.includes('SQLITE_ENABLE_FTS5'));

// The "resolved dependency graph" test requires pub get; report honestly.
const cfg = path.join(root, 'app', '.dart_tool', 'package_config.json');
console.log(
  `${fs.existsSync(cfg) ? 'PASS' : 'SKIP'}  依赖图检查（${fs.existsSync(cfg) ? 'package_config.json 存在' : '尚未 pub get，Dart 侧会 markTestSkipped'}）`,
);

console.log(`\n${failures === 0 ? 'OK: 干跑全部通过（算法与真实文件一致）' : `FAIL: ${failures} 项不通过`}`);
process.exitCode = failures === 0 ? 0 : 1;
