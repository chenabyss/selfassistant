// Probe the SQLite build that ships with this Node runtime.
// Purpose: establish whether we can run REAL FTS5 benchmarks locally instead of
// estimating Chinese-search behaviour from documentation.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');

const q = (sql) => db.prepare(sql).get();

console.log('sqlite_version :', q('select sqlite_version() as v').v);
console.log('sqlite_source  :', q('select sqlite_source_id() as v').v);

function tryExec(label, sql) {
  try {
    db.exec(sql);
    console.log(`${label.padEnd(22)}: OK`);
    return true;
  } catch (e) {
    console.log(`${label.padEnd(22)}: FAIL -> ${e.message}`);
    return false;
  }
}

tryExec('fts5 basic', "create virtual table t_basic using fts5(a)");
tryExec('fts5 unicode61', "create virtual table t_u61 using fts5(a, tokenize='unicode61')");
tryExec('fts5 trigram', "create virtual table t_tri using fts5(a, tokenize='trigram')");
tryExec('fts5 porter', "create virtual table t_por using fts5(a, tokenize='porter')");
tryExec(
  'fts5 external content',
  "create table base(id integer primary key, body text); create virtual table t_ext using fts5(body, content='base', content_rowid='id', tokenize='trigram')",
);
tryExec('sqlite strict table', 'create table t_strict(a text not null) strict');
tryExec('sqlite json1', "create table t_json(a text); insert into t_json values ('{\"x\":1}')");
tryExec('generated column', 'create table t_gen(a text, b text generated always as (upper(a)) virtual)');
tryExec('partial unique index', 'create table t_pu(a text, b text); create unique index i_pu on t_pu(a) where b = \'x\'');

console.log(
  'json1 extract   :',
  (() => {
    try {
      return q("select json_extract('{\"a\":42}', '$.a') as v").v;
    } catch (e) {
      return 'FAIL -> ' + e.message;
    }
  })(),
);

// The WAL-reset bug (SQLite 3.7.0–3.51.2, fixed 3.51.3) needs >=2 concurrent
// connections; report whether this build is past the fix.
const ver = q('select sqlite_version() as v').v.split('.').map(Number);
const past = ver[0] > 3 || (ver[0] === 3 && (ver[1] > 51 || (ver[1] === 51 && ver[2] >= 3)));
console.log(`WAL-reset fix (>=3.51.3): ${past ? 'YES' : 'NO'}`);
