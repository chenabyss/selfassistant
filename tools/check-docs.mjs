// Verify internal consistency of the design document set:
//  1. every relative markdown link resolves to an existing file
//  2. every referenced doc path mentioned in prose exists
//  3. cross-document identifier references (ADR-NNNN, T-*, R-*, GAP-*, risk ids) resolve
// Run: node tools/check-docs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const docs = walk(root);
const rel = (p) => path.relative(root, p).replaceAll('\\', '/');
const problems = [];

// --- 1. markdown links -----------------------------------------------------
const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
for (const doc of docs) {
  const text = fs.readFileSync(doc, 'utf8');
  for (const m of text.matchAll(linkRe)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const anchorless = target.split('#')[0];
    if (!anchorless) continue;
    const resolved = path.resolve(path.dirname(doc), decodeURIComponent(anchorless));
    if (!fs.existsSync(resolved)) {
      problems.push(`BROKEN LINK  ${rel(doc)}  ->  ${target}`);
    }
  }
}

// --- 2. doc paths mentioned in prose (e.g. `docs/foo.md`) -------------------
const pathRe = /`((?:docs|prototype|tools)\/[A-Za-z0-9_\-./]+\.(?:md|js|mjs))`/g;
for (const doc of docs) {
  const text = fs.readFileSync(doc, 'utf8');
  for (const m of text.matchAll(pathRe)) {
    const resolved = path.join(root, m[1]);
    if (!fs.existsSync(resolved)) problems.push(`MISSING PATH ${rel(doc)}  ->  ${m[1]}`);
  }
}

// --- 3. identifier cross-references ---------------------------------------
const corpus = docs.map((d) => fs.readFileSync(d, 'utf8'));
const joined = corpus.join('\n');

// ADR-NNNN references must have a matching decisions file
const adrRefs = new Set([...joined.matchAll(/ADR-(\d{4})/g)].map((m) => m[1]));
const adrFiles = new Set(
  fs
    .readdirSync(path.join(root, 'docs/decisions'))
    .filter((f) => /^\d{4}-/.test(f))
    .map((f) => f.slice(0, 4)),
);
for (const a of adrRefs) {
  if (!adrFiles.has(a)) problems.push(`ADR REF WITHOUT FILE  ADR-${a}`);
}
for (const a of adrFiles) {
  if (!adrRefs.has(a)) console.log(`note: ADR-${a} exists but is never cross-referenced`);
}

// T-* / R-* / GAP-* ids: report ids that are referenced but never defined
const defined = (prefix, text) => new Set([...text.matchAll(new RegExp(`\\b${prefix}[A-Z0-9-]*\\b`, 'g'))].map((m) => m[0]));

const testing = fs.readFileSync(path.join(root, 'docs/testing.md'), 'utf8');
const phases = fs.readFileSync(path.join(root, 'docs/phases.md'), 'utf8');
const risks = fs.readFileSync(path.join(root, 'docs/risks.md'), 'utf8');
const reqs = fs.readFileSync(path.join(root, 'docs/requirements.md'), 'utf8');

const T = /T-[A-Z][A-Z0-9-]*/g;
const tTesting = new Set([...testing.matchAll(T)].map((m) => m[0]));
const tPhases = new Set([...phases.matchAll(T)].map((m) => m[0]));
for (const t of tPhases) {
  // allow wildcards / families such as T-MIG-N-FORWARD, T-MIG-*, T-BAK-*
  const base = t.replace(/-[A-Z0-9]+$/, '');
  if (tTesting.has(t) || t.includes('*') || [...tTesting].some((x) => x.startsWith(base) || t.startsWith(x))) continue;
  console.log(`note: phase test id not in testing.md: ${t}`);
}

const rIds = new Set([...reqs.matchAll(/\bR-[A-Z]+-\d+\b/g)].map((m) => m[0]));
for (const doc of docs) {
  const text = fs.readFileSync(doc, 'utf8');
  for (const m of text.matchAll(/\bR-[A-Z]+-\d+\b/g)) {
    if (!rIds.has(m[0])) problems.push(`REQ REF NOT DEFINED  ${rel(doc)} -> ${m[0]}`);
  }
}

const gapIds = new Set([...reqs.matchAll(/GAP-\d+/g)].map((m) => m[0]));
for (const doc of docs) {
  const text = fs.readFileSync(doc, 'utf8');
  for (const m of text.matchAll(/GAP-\d+/g)) {
    if (!gapIds.has(m[0])) problems.push(`GAP REF NOT DEFINED  ${rel(doc)} -> ${m[0]}`);
  }
}

// Risk families: RV-* was added in the design-review revision round.
const riskIds = new Set([...risks.matchAll(/\b(?:DL|DW|CC|MG|BR|OT|RV)-\d+\b/g)].map((m) => m[0]));
for (const doc of docs) {
  const text = fs.readFileSync(doc, 'utf8');
  for (const m of text.matchAll(/\b(?:DL|DW|CC|MG|BR|OT|RV)-\d+\b/g)) {
    if (!riskIds.has(m[0])) problems.push(`RISK REF NOT DEFINED  ${rel(doc)} -> ${m[0]}`);
  }
}

// --- report ---------------------------------------------------------------
console.log(`\nscanned ${docs.length} markdown files`);
console.log(`requirements: ${rIds.size} | gaps: ${gapIds.size} | risks: ${riskIds.size} | tests in testing.md: ${tTesting.size} | ADRs: ${adrFiles.size}`);
if (problems.length) {
  console.log(`\nPROBLEMS (${problems.length}):`);
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
} else {
  console.log('\nOK: all internal links, paths and identifier references resolve');
}
