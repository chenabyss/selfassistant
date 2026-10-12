// Verify the push landed by fetching committed content over HTTPS (no git, no API).
//
// Why not just use git here: this environment blocks (a) git's bundled MSYS sh.exe
// from creating named objects, and (b) a Node program from spawning git with piped
// stdio (EPERM). So local HEAD is passed in by the caller instead:
//
//   node tool/verify_remote.mjs $(git rev-parse HEAD)
//   node tool/verify_remote.mjs              # skips the in-sync comparison
const repo = 'chenabyss/selfassistant';
const expectSha = process.argv[2] ?? null;

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
