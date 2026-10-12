'use strict';

// Verify which upstream SQLite version package:sqlite3 3.7.0 bundles.
// This matters: the WAL-reset bug affected SQLite 3.7.0-3.51.2 and was fixed in
// 3.51.3 (2026-03-13). A bundled build at or above 3.51.3 is required.
(async () => {
  const res = await fetch('https://api.github.com/repos/simolus3/sqlite3.dart/releases/tags/sqlite3-3.7.0', {
    headers: { 'user-agent': 'dsh-verify', accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    console.log('github API HTTP', res.status, await res.text().then((t) => t.slice(0, 300)));
    return;
  }
  const j = await res.json();
  console.log('tag:', j.tag_name, '| published:', j.published_at);
  console.log('name:', j.name);
  console.log('--- body (first 2500 chars) ---');
  console.log((j.body || '').slice(0, 2500));
  const assets = (j.assets || []).map((a) => a.name);
  console.log('--- asset count:', assets.length, '---');
  console.log(assets.filter((n) => /win|android|arm64|x64/i.test(n)).slice(0, 25).join('\n'));
})();
