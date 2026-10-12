'use strict';

// Entry point for the sync-core prototype test suite.
//
//   node test/run.js              # everything
//   node test/run.js --only <name> # one test
//
// Three suites:
//   core.test.js     - the original 20 protocol contract tests
//   conflict.test.js - conflict visibility for scalar fields, no false positives,
//                      idempotency, order independence, explicit resolution (S1)
//   audit.test.js    - proof that the history view is rebuildable from ops (S2)
const { run } = require('./harness');

require('./core.test');
require('./conflict.test');
require('./audit.test');

run().then((ok) => process.exit(ok ? 0 : 1));
