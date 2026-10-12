'use strict';

// Verify platform-support metadata for auxiliary packages needed by the design.
const pkgs = [
  'windows_single_instance',
  'flutter_alone',
  'timezone',
  'flutter_timezone',
  'file_picker',
  'share_plus',
  'url_launcher',
  'path_provider',
  'crypto',
  'archive',
  'sqlite_async',
  'drift_flutter',
];

(async () => {
  for (const p of pkgs) {
    try {
      const r = await fetch(`https://pub.dev/api/packages/${p}`, { headers: { 'user-agent': 'dsh-verify' } });
      if (!r.ok) {
        console.log(`${p}\tHTTP ${r.status}`);
        continue;
      }
      const j = await r.json();
      const L = j.latest;
      const platforms = Object.keys(L.pubspec?.flutter?.plugin?.platforms || {});
      console.log(
        JSON.stringify({
          pkg: p,
          latest: L.version,
          published: (L.published || '').slice(0, 10),
          platforms: platforms.length ? platforms.join(',') : (L.pubspec?.flutter ? 'flutter-no-plugin-section' : 'pure-dart'),
          discontinued: !!j.isDiscontinued,
        }),
      );
    } catch (e) {
      console.log(`${p}\tERR ${e.message}`);
    }
  }
})();
