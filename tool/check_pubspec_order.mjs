// Verify pubspec dependency blocks are alphabetically sorted.
//
// Why this exists: `analysis_options.yaml` enables `sort_pub_dependencies`, and
// `flutter analyze` exits 1 on ANY issue (including `info`). The first CI run failed
// for exactly this reason, so the check is now enforced locally too - before CI.
//
// Handles nested SDK entries (`flutter:\n  sdk: flutter`) and stops each block at the
// next top-level key, so block ordering in the file does not matter.
//
// Run: node tool/check_pubspec_order.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'app', 'pubspec.yaml');

if (!fs.existsSync(file)) {
  console.error(`missing ${file}`);
  process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

/** Collect top-level dependency names under `key:` (block ends at next top-level key). */
function collect(key) {
  const names = [];
  let inside = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (new RegExp(`^${key}:\\s*$`).test(line)) {
      inside = true;
      continue;
    }
    if (inside) {
      if (/^\S/.test(line)) break; // next top-level key
      const m = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*):/);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

const blocks = [
  ['dependencies', collect('dependencies')],
  ['dev_dependencies', collect('dev_dependencies')],
];

let failed = false;
for (const [key, names] of blocks) {
  const sorted = [...names].sort();
  const ok = names.join(',') === sorted.join(',');
  console.log(`${key.padEnd(17)}: ${names.length} entries`);
  console.log(`  actual   : ${names.join(', ') || '(none)'}`);
  if (!ok) {
    failed = true;
    console.log(`  expected : ${sorted.join(', ')}`);
    console.log('  -> NOT alphabetically sorted (sort_pub_dependencies will fail CI)');
    // Point at the first out-of-order entry so the fix is obvious.
    for (let i = 1; i < names.length; i += 1) {
      if (names[i - 1] > names[i]) {
        console.log(`  -> first inversion: "${names[i - 1]}" then "${names[i]}"`);
        break;
      }
    }
  } else {
    console.log('  sorted   : YES');
  }
}

if (failed) {
  console.log('\nFAIL: pubspec dependency blocks must be alphabetically sorted.');
  console.log('Note: do NOT group dependencies by purpose with section comments -');
  console.log('grouping breaks alphabetical order and fails `flutter analyze`.');
  process.exitCode = 1;
} else {
  console.log('\nOK: both dependency blocks are alphabetically sorted');
}
