// Version-constraint guard.
//
// Why this exists: the version floors in this project are not arbitrary - each one
// traces to a concrete constraint (build hooks availability, a package's own floor,
// or a fixed SQLite bug). A well-meaning "bump/downgrade" can silently break a
// hidden dependency, so the constraints live in tool/versions.yaml and this script
// asserts that app/pubspec.yaml agrees.
//
// Run: node tool/check_versions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// ---------------------------------------------------------------- tiny yaml
// The file is deliberately simple (nested maps, scalars, and one string list), so
// a focused parser is preferable to adding a dependency to the CI path.
function parseVersionsYaml(text) {
  const out = {};
  let stack = [{ indent: -1, obj: out }];
  let listKey = null;

  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) return;

    const indent = line.length - line.trimStart().length;

    // list item under the most recent key
    const itemMatch = line.trim().match(/^-\s+(.*)$/);
    if (itemMatch && listKey) {
      const holder = stack[stack.length - 1].obj;
      if (!Array.isArray(holder[listKey])) holder[listKey] = [];
      holder[listKey].push(unquote(itemMatch[1]));
      return;
    }

    const kv = line.trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) return;
    const [, key, rest] = kv;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      listKey = key;
      return;
    }

    const value = rest.trim();
    if (value.startsWith('[')) {
      parent[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      parent[key] = unquote(value);
    }
    listKey = null;
  });

  return out;
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// ------------------------------------------------------------------- load
const versionsPath = path.join(root, 'tool', 'versions.yaml');
const pubspecPath = path.join(root, 'app', 'pubspec.yaml');

if (!fs.existsSync(versionsPath)) {
  console.error(`missing ${versionsPath}`);
  process.exit(1);
}
if (!fs.existsSync(pubspecPath)) {
  console.error(`missing ${pubspecPath}`);
  process.exit(1);
}

const V = parseVersionsYaml(fs.readFileSync(versionsPath, 'utf8'));
const pubspec = fs.readFileSync(pubspecPath, 'utf8');

// ------------------------------------------------------- pubspec assertions
const sdkLine = pubspec.match(/^\s*sdk:\s*"([^"]+)"/m);
if (!sdkLine) {
  problems.push('app/pubspec.yaml: environment.sdk not found');
} else if (sdkLine[1] !== V.dart.minimum) {
  problems.push(`dart sdk constraint mismatch: pubspec "${sdkLine[1]}" vs versions.yaml "${V.dart.minimum}"`);
}// Compare semantic versions, ignoring constraint operators: pubspec writes a range
// (">=3.38.1") while versions.yaml stores the bare floor ("3.38.1"). They express the
// same requirement, so compare the version numbers, not the strings.
const semverOf = (s) => s.replace(/[<>=^~*\s]/g, '').split(/[\s,]+/)[0];
const lowerBoundOf = (s) => {
  const m = s.match(/>=\s*([0-9][0-9.]*)/);
  return m ? m[1] : semverOf(s);
};

const flutterLine = pubspec.match(/^\s*flutter:\s*"([^"]+)"/m);
if (!flutterLine) {
  problems.push('app/pubspec.yaml: environment.flutter not found');
} else {
  const pubFloor = lowerBoundOf(flutterLine[1]);
  const wantFloor = lowerBoundOf(V.flutter.minimum);
  if (pubFloor !== wantFloor) {
    problems.push(
      `flutter constraint mismatch: pubspec floor "${pubFloor}" vs versions.yaml floor "${wantFloor}"`,
    );
  }
}

// Forbidden dependencies must not appear as active dependency lines.
for (const [name, reason] of Object.entries(V.forbidden ?? {})) {
  const depRe = new RegExp(`^\\s{2}${name}:\\s*\\S`, 'm');
  if (depRe.test(pubspec)) {
    problems.push(`forbidden dependency "${name}" present in app/pubspec.yaml - ${reason}`);
  }
}

// Every pinned package that we actually depend on should be present.
const depBlock = pubspec.split('dev_dependencies:')[0];
for (const name of Object.keys(V.packages ?? {})) {
  if (!new RegExp(`^\\s{2}${name}:`, 'm').test(depBlock)) {
    // Not an error: a pinned package may legitimately not be used yet.
    console.log(`note: pinned package "${name}" is declared in versions.yaml but not yet a dependency`);
  }
}

// ------------------------------------------------------------- report
console.log('version constraint check');
console.log(`  flutter pinned : ${V.flutter.pinned} (min ${V.flutter.minimum})`);
console.log(`  dart sdk       : ${V.dart.minimum}`);
console.log(`  sqlite         : ${V.sqlite.version} (min acceptable ${V.sqlite.minimum_acceptable})`);
console.log(`  android        : min ${V.android.min_sdk}, target ${V.android.target_sdk}, page align ${V.android.required_page_alignment_kb}KB`);
console.log(`  pinned packages: ${Object.keys(V.packages ?? {}).length}`);
console.log(`  forbidden      : ${Object.keys(V.forbidden ?? {}).join(', ') || '(none)'}`);

if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nOK: app/pubspec.yaml agrees with tool/versions.yaml');
}
