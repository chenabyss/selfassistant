// Verify the push landed by fetching committed content over HTTPS (no git, no API).
//
// Local HEAD is passed by the caller when available:
//   node tool/verify_remote.mjs $(git rev-parse HEAD)
// If omitted, it falls back to reading HEAD via git, then to skipping the comparison.
//
// History note: under the earlier, narrower sandbox this file could not spawn git
// (piped stdio returned EPERM), so the argument form was mandatory. The fallback is
// kept because it costs nothing and makes the tool usable in either environment.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'chenabyss/selfassistant';

let expectSha = process.argv[2] ?? null;
if (!expectSha) {
  try {
    expectSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    console.log(`(local HEAD read via git: ${expectSha.slice(0, 12)})`);
  } catch {
    console.log('(could not read local HEAD; skipping in-sync comparison)');
  }
}

const targets = [
  'README.md',
  '.github/workflows/ci.yml',
  'tool/versions.yaml',
  'docs/phase-0-report.md',
  'docs/platform-verification-checklist.md',
  'prototype/sync-core/test/audit.test.js',
];

(async () => {
  let ok = 0;
  for (const p of targets) {
    const url = `https://raw.githubusercontent.com/${repo}/main/${p}`;
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'dsh-verify' } });
      const body = r.ok ? await r.text() : '';
      console.log(`${r.ok ? 'OK  ' : 'MISS'} ${String(r.status).padEnd(4)} ${p}${r.ok ? `  (${body.length} bytes)` : ''}`);
      if (r.ok) ok += 1;
    } catch (e) {
      console.log(`ERR       ${p}  ${e.message}`);
    }
  }

  console.log(`\nfetched ${ok}/${targets.length} files from branch main`);

  // Commit listing via the commits Atom feed needs no auth.
  try {
    const r = await fetch(`https://github.com/${repo}/commits/main.atom`, {
      headers: { 'user-agent': 'dsh-verify' },
    });
    if (r.ok) {
      const xml = await r.text();
      const ids = [...xml.matchAll(/<id>tag:github\.com,2008:Grit::Commit\/([0-9a-f]{40})<\/id>/g)].map((m) => m[1]);
      console.log(`\ncommits on remote: ${ids.length}`);
      console.log(`newest remote sha: ${ids[0] ?? '(none)'}`);
      if (expectSha) {
        console.log(`local  HEAD   sha: ${expectSha}`);
        console.log(`IN SYNC          : ${ids.includes(expectSha) ? 'YES' : 'NO (local HEAD not found on remote)'}`);
      }
      const titles = [...xml.matchAll(/<title>\s*([^<]+?)\s*<\/title>/g)].map((m) => m[1]).slice(1, 4);
      for (const t of titles) console.log(`  - ${t.split('\n')[0].slice(0, 74)}`);
    } else {
      console.log(`\natom feed: HTTP ${r.status} (private repo or rate limited)`);
    }
  } catch (e) {
    console.log(`atom feed error: ${e.message}`);
  }
})();
