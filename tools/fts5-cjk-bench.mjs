// Chinese/CJK full-text search benchmark for the V1 search decision (review item 6).
//
// Compares four candidate implementations on a >=50k mixed Chinese/English corpus:
//   1. LIKE      : `body LIKE '%q%'` full scan (the "honest baseline")
//   2. unicode61 : FTS5 default tokenizer (expected to fail on Chinese)
//   3. trigram   : FTS5 tokenize='trigram', with a short-query (1-2 char) LIKE fallback
//   4. bigram    : pre-tokenized bigram index in a plain FTS5(unicode61) table
//
// Ground truth is exact substring membership computed directly against the corpus,
// so recall/precision are measured, not assumed.
//
// Run: node tools/fts5-cjk-bench.mjs [--rows 50000] [--queries 120]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- arguments
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}
const ROWS = arg('rows', 50000);
const NQ = arg('queries', 120);
const SEED = arg('seed', 20261012);

// ------------------------------------------------------------ deterministic rng
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

// ------------------------------------------------------------------- corpus
// Vocabulary chosen so queries drawn from it have unambiguous ground truth.
const zhNouns = [
  '网格', '生成', '失败', '日志', '时间', '记录', '项目', '任务', '标签',
  '日记', '提醒', '附件', '结论', '决策', '备份', '恢复', '同步', '冲突',
  '数据库', '迁移', '索引', '搜索', '全文', '中文', '分词', '性能',
  '测试', '验证', '协议', '版本', '向量', '时钟', '偏移', '墓碑',
  '解析', '渲染', '编译', '部署', '构建', '发布', '异常', '排查',
  '服务器', '客户端', '接口', '字段', '结构', '事务', '约束', '查询',
];
const zhVerbs = [
  '检查', '修复', '重构', '优化', '分析', '评审', '记录', '整理',
  '跟踪', '复现', '验证', '排查', '清理', '归档', '合并', '拆分',
  '生成', '导出', '导入', '同步', '备份', '恢复', '测试', '对比',
];
const zhSuffix = [
  '问题', '结果', '原因', '方案', '流程', '状态', '细节', '影响',
  '风险', '成本', '收益', '限制', '边界', '条件', '依赖', '顺序',
];
const enWords = [
  'inspect', 'mesh', 'generation', 'failure', 'journal', 'time', 'entry',
  'project', 'task', 'tag', 'reminder', 'attachment', 'conclusion',
  'backup', 'restore', 'sync', 'conflict', 'database', 'migration',
  'index', 'search', 'fulltext', 'chinese', 'tokenizer', 'performance',
  'test', 'verification', 'protocol', 'version', 'vector', 'clock',
  'skew', 'tombstone', 'parse', 'render', 'compile', 'deploy', 'build',
  'release', 'exception', 'debug', 'server', 'client', 'interface',
];
const zhConnect = ['的', '了', '与', '和', '在', '对', '从', '把', '被', '为'];
const punct = ['，', '。', '；', '：', '、'];

function makeZhSentence() {
  const parts = [];
  const n = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i += 1) {
    const pattern = rnd();
    if (pattern < 0.34) parts.push(pick(zhVerbs) + pick(zhNouns));
    else if (pattern < 0.67) parts.push(pick(zhNouns) + pick(zhNouns));
    else parts.push(pick(zhNouns) + pick(zhConnect) + pick(zhNouns) + pick(zhSuffix));
  }
  return parts.join(pick(punct));
}

function makeEnSentence() {
  const n = 3 + Math.floor(rnd() * 5);
  const w = [];
  for (let i = 0; i < n; i += 1) w.push(pick(enWords));
  const s = w.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

/** Mixed-language record: some pure Chinese, some pure English, some mixed. */
function makeRecord() {
  const r = rnd();
  if (r < 0.45) return makeZhSentence() + makeZhSentence();
  if (r < 0.7) return makeEnSentence() + ' ' + makeEnSentence();
  return makeZhSentence() + makeEnSentence();
}

function makeTitle() {
  if (chance(0.6)) return pick(zhVerbs) + pick(zhNouns) + pick(zhSuffix);
  return pick(enWords) + ' ' + pick(enWords);
}

console.log(`# FTS5 CJK benchmark  rows=${ROWS} queries=${NQ} seed=${SEED}`);
console.log(`# sqlite=${new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v} node=${process.version}\n`);

// ---------------------------------------------------------------- build data
const records = [];
for (let i = 0; i < ROWS; i += 1) {
  records.push({ id: i + 1, title: makeTitle(), body: makeRecord() });
}

// ------------------------------------------------------------- query generation
// Draw queries FROM the corpus so ground truth is exact and recall is meaningful.
const querySpecs = [];
const lens = [
  { kind: 'zh1', weight: 0.2, len: 1 },
  { kind: 'zh2', weight: 0.25, len: 2 },
  { kind: 'zh3', weight: 0.15, len: 3 },
  { kind: 'zh4', weight: 0.15, len: 4 },
  { kind: 'zh6', weight: 0.1, len: 6 },
  { kind: 'en', weight: 0.15, len: 0 },
];

function zhSlice(rec, len) {
  // collect only CJK characters so the slice is a genuine Chinese substring
  const cjk = [...(rec.title + rec.body)].filter((c) => /[\u4e00-\u9fff]/.test(c));
  if (cjk.length < len) return null;
  const start = Math.floor(rnd() * (cjk.length - len + 1));
  return cjk.slice(start, start + len).join('');
}

while (querySpecs.length < NQ) {
  let acc = 0;
  const t = rnd();
  let spec = lens[lens.length - 1];
  for (const l of lens) {
    acc += l.weight;
    if (t <= acc) { spec = l; break; }
  }
  const rec = pick(records);
  let q = null;
  if (spec.kind === 'en') {
    const words = rec.body.toLowerCase().match(/[a-z]{4,}/g);
    if (words) q = pick(words);
  } else {
    q = zhSlice(rec, spec.len);
  }
  if (!q || q.length === 0) continue;
  if (querySpecs.some((s) => s.q === q)) continue;
  querySpecs.push({ q, kind: spec.kind });
}

// ground truth = exact substring membership
function groundTruth(q) {
  const needle = q.toLowerCase();
  const ids = [];
  for (const r of records) {
    if ((r.title + ' ' + r.body).toLowerCase().includes(needle)) ids.push(r.id);
  }
  return ids;
}

const truths = new Map();
for (const s of querySpecs) truths.set(s.q, groundTruth(s.q));

// ------------------------------------------------------------------ databases
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftscjk-'));
const dbs = {};

function openDb(name) {
  const file = path.join(tmp, `${name}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal');
  db.exec('pragma synchronous = off');
  db.exec(
    'create table record(id integer primary key, title text not null, body text not null) strict',
  );
  db.exec('create index idx_record_id on record(id)');
  return { db, file, name };
}

function sizeOf(file) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += fs.statSync(file + suffix).size; } catch { /* absent */ }
  }
  return total;
}

// --- baseline: plain table only (LIKE target) -------------------------------
{
  const o = openDb('like');
  const ins = o.db.prepare('insert into record(id,title,body) values (?,?,?)');
  o.db.exec('begin');
  for (const r of records) ins.run(r.id, r.title, r.body);
  o.db.exec('commit');
  o.buildMs = 0;
  o.sizeBytes = sizeOf(o.file);
  // LIKE with an explicit ESCAPE so that % and _ inside the query are literal.
  o.stmt = o.db.prepare(
    "select id from record where title like ? escape '\\' or body like ? escape '\\' order by id",
  );
  const esc = (s) => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  o.query = (q) => {
    const like = `%${esc(q)}%`;
    return o.stmt.all(like, like).map((r) => r.id);
  };
  dbs.like = o;
}

// --- unicode61 --------------------------------------------------------------
{
  const o = openDb('u61');
  const ins = o.db.prepare('insert into record(id,title,body) values (?,?,?)');
  o.db.exec('begin');
  for (const r of records) ins.run(r.id, r.title, r.body);
  o.db.exec('commit');
  const t0 = performance.now();
  o.db.exec(
    "create virtual table rec_fts using fts5(title, body, content='record', content_rowid='id', tokenize='unicode61')",
  );
  o.db.exec(
    "insert into rec_fts(rec_fts) values ('rebuild')",
  );
  o.buildMs = performance.now() - t0;
  o.sizeBytes = sizeOf(o.file);
  o.stmt = o.db.prepare(
    'select rowid from rec_fts where rec_fts match ? order by rowid',
  );
  o.query = (q) => {
    // FTS5 MATCH syntax: quote to avoid operators; for CJK a bare term is one token
    try {
      return o.stmt.all(`"${q.replaceAll('"', '""')}"`).map((r) => r.rowid);
    } catch {
      return [];
    }
  };
  dbs.u61 = o;
}

// --- trigram ----------------------------------------------------------------
{
  const o = openDb('trigram');
  const ins = o.db.prepare('insert into record(id,title,body) values (?,?,?)');
  o.db.exec('begin');
  for (const r of records) ins.run(r.id, r.title, r.body);
  o.db.exec('commit');
  const t0 = performance.now();
  o.db.exec(
    "create virtual table rec_fts using fts5(title, body, content='record', content_rowid='id', tokenize='trigram')",
  );
  o.db.exec("insert into rec_fts(rec_fts) values ('rebuild')");
  o.buildMs = performance.now() - t0;
  o.sizeBytes = sizeOf(o.file);
  o.stmt = o.db.prepare('select rowid from rec_fts where rec_fts match ? order by rowid');
  o.likeStmt = o.db.prepare(
    'select id from record where title like ? or body like ? order by id',
  );
  o.query = (q) => {
    // FTS5 trigram requires >= 3 characters; shorter queries fall back to LIKE.
    if ([...q].length < 3) {
      const like = `%${q}%`;
      return o.likeStmt.all(like, like).map((r) => r.id);
    }
    try {
      return o.stmt.all(`"${q.replaceAll('"', '""')}"`).map((r) => r.rowid);
    } catch {
      const like = `%${q}%`;
      return o.likeStmt.all(like, like).map((r) => r.id);
    }
  };
  dbs.trigram = o;
}

// --- bigram (pre-tokenized) -------------------------------------------------
// Insert-side: CJK -> overlapping bigrams + single chars; ASCII -> lowercase words.
// Query-side: for CJK we match the necessary bigram/char tokens with AND (not a
// phrase), because the insert stream interleaves 'b' and 's' tokens so a phrase
// would require impossible adjacency. AND is a necessary-condition filter and is
// therefore recall-safe; exactness is then confirmed by an explicit substring
// check on the candidates (this is what a real implementation would do).
function cjkBigrams(text) {
  const cjk = [...text.toLowerCase()].filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c));
  const out = [];
  for (let i = 0; i + 1 < cjk.length; i += 1) out.push('b' + cjk[i] + cjk[i + 1]);
  for (const c of cjk) out.push('s' + c);
  return { bigrams: out, chars: cjk };
}
function asciiWords(text) {
  return [...text.toLowerCase().matchAll(/[a-z0-9]{2,}/g)].map((m) => 'w' + m[0]);
}
function tokenizeIndex(text) {
  const { bigrams, chars } = cjkBigrams(text);
  const singles = [...new Set(chars)].map((c) => 's' + c);
  return [
    ...new Set(bigrams),
    ...singles,
    ...asciiWords(text),
  ].join(' ');
}

{
  const o = openDb('bigram');
  o.db.exec('create table rec_tok(id integer primary key, toks text not null) strict');
  const ins = o.db.prepare('insert into record(id,title,body) values (?,?,?)');
  o.db.exec('begin');
  for (const r of records) ins.run(r.id, r.title, r.body);
  o.db.exec('commit');
  const t0 = performance.now();
  o.db.exec("create virtual table tok_fts using fts5(toks, tokenize='unicode61')");
  const insTok = o.db.prepare('insert into tok_fts(rowid, toks) values (?,?)');
  o.db.exec('begin');
  for (const r of records) insTok.run(r.id, tokenizeIndex(r.title + ' ' + r.body));
  o.db.exec('commit');
  o.buildMs = performance.now() - t0;
  o.sizeBytes = sizeOf(o.file);
  o.stmt = o.db.prepare('select rowid from tok_fts where tok_fts match ? order by rowid');
  const confirm = o.db.prepare(
    "select id from record where (title || char(1) || body) like ? escape '\\' order by id",
  );
  const esc = (s) => s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  o.query = (q) => {
    const lower = q.toLowerCase();
    const { bigrams } = cjkBigrams(lower);
    const words = asciiWords(lower);
    const terms = [...new Set([...bigrams, ...words])];
    if (terms.length === 0) {
      // pure single CJK char or no indexable token: fall back to confirmation scan
      return confirm.all(`%${esc(lower)}%`).map((r) => r.id);
    }
    const matchExpr = terms.map((t) => `"${t}"`).join(' AND ');
    let cand;
    try {
      cand = o.stmt.all(matchExpr).map((r) => r.rowid);
    } catch {
      return [];
    }
    // exactness pass: verify the literal substring (mirrors a real post-filter)
    const ids = [];
    for (const id of cand) {
      const rec = records[id - 1];
      if ((rec.title + '\u0001' + rec.body).toLowerCase().includes(lower)) ids.push(id);
    }
    return ids;
  };
  dbs.bigram = o;
}

// ------------------------------------------------------------------- measure
function measure(fn, q, reps) {
  let best = Infinity;
  let out = [];
  for (let i = 0; i < reps; i += 1) {
    const t0 = performance.now();
    out = fn(q);
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return { ms: best, ids: out };
}

function stats(ids, truth) {
  const set = new Set(ids);
  const t = new Set(truth);
  let tp = 0;
  for (const id of set) if (t.has(id)) tp += 1;
  // A query with NO matching records carries no recall information; including it
  // as "recall = 1" would inflate the average. Report it separately instead.
  if (t.size === 0) {
    return { found: set.size, truth: 0, tp: 0, recall: null, precision: set.size === 0 ? 1 : 0, vacuous: true };
  }
  const recall = tp / t.size;
  const precision = set.size === 0 ? 1 : tp / set.size;
  return { found: set.size, truth: t.size, tp, recall, precision, vacuous: false };
}

const methods = ['like', 'u61', 'trigram', 'bigram'];
const results = {};
for (const m of methods) {
  results[m] = {
    perKind: {},
    all: [],
    recallSum: 0,
    recallN: 0, // only non-vacuous queries
    precisionSum: 0,
    precisionN: 0,
    exact: 0,
    total: 0,
    vacuous: 0,
    vacuousFalsePositives: 0,
    latency: [],
  };
}

// warm up (first call compiles statements / touches pages)
for (const m of methods) for (const s of querySpecs.slice(0, 5)) dbs[m].query(s.q);

for (const s of querySpecs) {
  const truth = truths.get(s.q);
  for (const m of methods) {
    const { ms, ids } = measure(dbs[m].query, s.q, 3);
    const st = stats(ids, truth);
    const R = results[m];
    R.all.push(st);
    R.total += 1;
    R.precisionSum += st.precision;
    R.precisionN += 1;
    R.latency.push(ms);
    if (st.vacuous) {
      R.vacuous += 1;
      if (st.found > 0) R.vacuousFalsePositives += 1;
    } else {
      R.recallSum += st.recall;
      R.recallN += 1;
      if (st.recall === 1 && st.precision === 1) R.exact += 1;
    }
    const k = s.kind;
    R.perKind[k] ??= { n: 0, recall: 0, recallN: 0, precision: 0, latency: [] };
    R.perKind[k].n += 1;
    R.perKind[k].precision += st.precision;
    R.perKind[k].latency.push(ms);
    if (!st.vacuous) {
      R.perKind[k].recall += st.recall;
      R.perKind[k].recallN += 1;
    }
  }
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const msFmt = (x) => (x >= 10 ? x.toFixed(1) : x.toFixed(2)) + 'ms';
const mb = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';

function p(arr, q) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.floor(a.length * q))];
}

console.log('## Storage & index build cost\n');
console.log('| method | db size | vs base | index build |');
console.log('| --- | --- | --- | --- |');
const baseSize = dbs.like.sizeBytes;
for (const m of methods) {
  const d = dbs[m];
  const ratio = (d.sizeBytes / baseSize).toFixed(2) + 'x';
  console.log(`| ${m} | ${mb(d.sizeBytes)} | ${ratio} | ${msFmt(d.buildMs)} |`);
}

console.log('\n## Aggregate accuracy & latency (all queries)\n');
console.log('| method | avg recall | avg precision | exact matches | vacuous q | p50 | p95 | max |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const m of methods) {
  const R = results[m];
  const recall = R.recallN ? pct(R.recallSum / R.recallN) : 'n/a';
  console.log(
    `| ${m} | ${recall} (n=${R.recallN}) | ${pct(R.precisionSum / R.precisionN)} | ` +
      `${R.exact}/${R.recallN} | ${R.vacuous} | ${msFmt(p(R.latency, 0.5))} | ${msFmt(p(R.latency, 0.95))} | ${msFmt(p(R.latency, 1))} |`,
  );
}

console.log('\n## Recall by query length (the decisive dimension)\n');
const kinds = ['zh1', 'zh2', 'zh3', 'zh4', 'zh6', 'en'];
console.log('| method | ' + kinds.map((k) => k).join(' | ') + ' |');
console.log('| --- |' + kinds.map(() => ' --- |').join(''));
for (const m of methods) {
  const row = kinds.map((k) => {
    const v = results[m].perKind[k];
    if (!v) return '—';
    if (!v.recallN) return `n/a (n=${v.n})`;
    return `${pct(v.recall / v.recallN)} (n=${v.recallN})`;
  });
  console.log(`| ${m} | ${row.join(' | ')} |`);
}

console.log('\n## Latency by query length (best of 3)\n');
console.log('| method | ' + kinds.map((k) => k).join(' | ') + ' |');
console.log('| --- |' + kinds.map(() => ' --- |').join(''));
for (const m of methods) {
  const row = kinds.map((k) => {
    const v = results[m].perKind[k];
    return v ? msFmt(p(v.latency, 0.5)) : '—';
  });
  console.log(`| ${m} | ${row.join(' | ')} |`);
}

// Worst offenders per method: useful to see *which* queries fail, not just how often.
console.log('\n## Worst recall cases per method (recall < 100%)\n');
for (const m of methods) {
  const bad = querySpecs
    .map((s, i) => ({ ...s, st: results[m].all[i] }))
    .filter((s) => !s.st.vacuous && s.st.recall < 1)
    .sort((a, b) => a.st.recall - b.st.recall)
    .slice(0, 8);
  if (!bad.length) {
    console.log(`- **${m}**: none (perfect recall on all non-vacuous queries)`);
    continue;
  }
  console.log(`- **${m}**: ${bad.length} of ${results[m].recallN} non-vacuous queries imperfect. Worst:`);
  for (const b of bad) {
    console.log(
      `  - \`${b.q}\` (${b.kind}, len=${[...b.q].length}) recall=${pct(b.st.recall)} found=${b.st.found} truth=${b.st.truth}`,
    );
  }
}

// Sanity: prove the harness's ground truth is non-trivial
const emptyTruth = querySpecs.filter((s) => truths.get(s.q).length === 0).length;
const avgTruth = (querySpecs.reduce((a, s) => a + truths.get(s.q).length, 0) / NQ).toFixed(1);
console.log(`\n## Harness sanity\n`);
console.log(`- queries with zero matching records (excluded from recall, counted as "vacuous"): ${emptyTruth}`);
console.log(`- average matching records per query: ${avgTruth}`);
console.log(`- corpus rows: ${ROWS}, temp dir: ${tmp}`);

fs.writeFileSync(
  path.join(tmp, 'results.json'),
  JSON.stringify(
    {
      rows: ROWS,
      queries: NQ,
      seed: SEED,
      size: Object.fromEntries(methods.map((m) => [m, dbs[m].sizeBytes])),
      buildMs: Object.fromEntries(methods.map((m) => [m, dbs[m].buildMs])),
      results: Object.fromEntries(
        methods.map((m) => [
          m,
          {
            avgRecall: results[m].recallSum / results[m].total,
            avgPrecision: results[m].precisionSum / results[m].total,
            p50: p(results[m].latency, 0.5),
            p95: p(results[m].latency, 0.95),
          },
        ]),
      ),
    },
    null,
    2,
  ),
);
console.log(`- machine-readable results: ${path.join(tmp, 'results.json')}`);
