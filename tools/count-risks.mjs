// Recount risk severity classes in docs/risks.md so the summary numbers in the
// documents are derived from the file rather than maintained by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'docs', 'risks.md');
const text = fs.readFileSync(file, 'utf8');

const seen = new Map();
const counts = { R1: [], R2: [], R3: [] };
const unknown = [];

// Risk ID families. RV-* was added in the design-review revision round and is
// counted with the others so the register cannot silently grow unverified.
const FAMILY = '(?:DL|DW|CC|MG|BR|OT|RV)';

// Strip markdown emphasis before reading a severity cell, e.g. "**R1**（...）".
const severityOf = (cell) => {
  const plain = cell.replace(/\*/g, '');
  const m = plain.match(/(?:^|[\s（(])R([123])(?![0-9])/);
  return m ? `R${m[1]}` : undefined;
};

// Inline table rows: "| <ID> | <risk> | <level> |" where level is R1/R2/R3.
// The ID may be wrapped in markdown emphasis (e.g. "**RV-1**"), so allow it.
for (const m of text.matchAll(new RegExp(`\\|\\s*\\*{0,2}(${FAMILY}-\\d+)\\*{0,2}\\s*\\|([^|]*)\\|([^|]*)\\|`, 'g'))) {
  const id = m[1];
  const lvl = severityOf(m[3]);
  if (!lvl) {
    unknown.push(`${id} (level cell: ${m[3].trim().slice(0, 40)})`);
    continue;
  }
  if (seen.has(id)) continue;
  seen.set(id, lvl);
  counts[lvl].push(id);
}

// Heading-style risks: "### DL-1 用云盘同步…（R1）" or "### DL-4 …（R1，直接违反 §6.1）"
for (const m of text.matchAll(new RegExp(`^#+\\s*\\*{0,2}(${FAMILY}-\\d+)\\*{0,2}([^\\n]*)$`, 'gm'))) {
  const id = m[1];
  if (seen.has(id)) continue;
  const lvl = severityOf(m[2]);
  if (!lvl) {
    unknown.push(`${id} (heading: ${m[2].trim().slice(0, 50)})`);
    continue;
  }
  seen.set(id, lvl);
  counts[lvl].push(id);
}

console.log('risk ids found:', seen.size);
for (const lvl of ['R1', 'R2', 'R3']) {
  console.log(`${lvl}: ${counts[lvl].length}  -> ${counts[lvl].sort().join(', ')}`);
}

// Cross-check against the hand-written summaries in risks.md §7.
// §7.1 covers the original 47; §7.2 covers the 14 added in the revision round.
const expected = { R1: 28, R2: 30, R3: 3 };
let drift = false;
for (const lvl of ['R1', 'R2', 'R3']) {
  if (counts[lvl].length !== expected[lvl]) {
    console.log(`DRIFT: ${lvl} counted ${counts[lvl].length}, risks.md §7 claims ${expected[lvl]}`);
    drift = true;
  }
}
if (!drift) console.log('\nOK: counts match the summary in risks.md §7');

// Risks documented under a "###" heading use the same ID scheme; report any that
// were never assigned a severity so they cannot silently escape the register.
const allIds = new Set([...text.matchAll(/\b((?:DL|DW|CC|MG|BR|OT)-\d+)\b/g)].map((m) => m[1]));
const unlevelled = [...allIds].filter((id) => !seen.has(id));
if (unlevelled.length) {
  console.log('\nIDs present but with no severity detected:');
  console.log(unlevelled.sort().join(', '));
}

if (unknown.length) {
  console.log('\nrows with no recognised severity (needs manual check):');
  console.log(unknown.join('\n'));
}
