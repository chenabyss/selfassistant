'use strict';

const pkgs = ['file_selector', 'tray_manager', 'win32', 'msix', 'flutter_local_notifications'];
(async () => {
  for (const p of pkgs) {
    try {
      const r = await fetch(`https://pub.dev/api/packages/${p}`, { headers: { 'user-agent': 'dsh-verify' } });
      if (!r.ok) { console.log(`${p}\tHTTP ${r.status}`); continue; }
      const j = await r.json();
      const L = j.latest;
      const pl = Object.keys(L.pubspec?.flutter?.plugin?.platforms || {});
      console.log(JSON.stringify({
        pkg: p,
        latest: L.version,
        published: (L.published || '').slice(0, 10),
        platforms: pl.length ? pl.join(',') : 'pure-dart',
        sdk: L.pubspec?.environment?.sdk,
        flutter: L.pubspec?.environment?.flutter,
      }));
    } catch (e) { console.log(`${p}\tERR ${e.message}`); }
  }
})();
