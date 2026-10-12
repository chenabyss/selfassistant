// Verify the push landed by fetching committed content over HTTPS (no git, no API).
// Works for public repos; a private repo returns 404 unauthenticated, which is
// itself informative (we then fall back to reporting what we can conclude).
const repo = 'chenabyss/selfassistant';
const expectSha = 'f1243e420d8afed3a9759406931b0a841a69c54d';

const targets = [
  'README.md',
  '.github/workflows/ci.yml',
  'tool/versions.yaml',
  'docs/phase-0-report.md',
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

  // Commit listing via the commits Atom feed needs no auth for public repos.
  try {
    const r = await fetch(`https://github.com/${repo}/commits/main.atom`, {
      headers: { 'user-agent': 'dsh-verify' },
    });
    if (r.ok) {
      const xml = await r.text();
      const ids = [...xml.matchAll(/<id>tag:github\.com,2008:Grit::Commit\/([0-9a-f]{40})<\/id>/g)].map((m) => m[1]);
      console.log(`\ncommits in atom feed: ${ids.length}`);
      console.log(`newest sha: ${ids[0] ?? '(none)'}`);
      console.log(`matches local HEAD: ${ids[0] === expectSha ? 'YES' : 'NO'}`);
      const titles = [...xml.matchAll(/<title>\s*([^<]+?)\s*<\/title>/g)].map((m) => m[1]).slice(1, 3);
      for (const t of titles) console.log(`  title: ${t.split('\n')[0].slice(0, 70)}`);
    } else {
      console.log(`\natom feed: HTTP ${r.status} (private repo or rate limited)`);
    }
  } catch (e) {
    console.log(`atom feed error: ${e.message}`);
  }
})();
