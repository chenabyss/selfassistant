'use strict';

/**
 * Minimal dependency-free test runner. Kept deliberately tiny so the prototype
 * can be executed with nothing but node, in any environment.
 */
const tests = [];
let only = null;

function test(name, fn) {
  tests.push({ name, fn });
}
test.only = (name, fn) => {
  only = name;
  tests.push({ name, fn });
};

const colors = process.stdout.isTTY
  ? { red: '\u001b[31m', green: '\u001b[32m', dim: '\u001b[2m', reset: '\u001b[0m', bold: '\u001b[1m' }
  : { red: '', green: '', dim: '', reset: '', bold: '' };

async function run() {
  const selected = only ? tests.filter((t) => t.name === only) : tests;
  let passed = 0;
  const failures = [];
  for (const t of selected) {
    const started = Date.now();
    try {
      await t.fn();
      passed += 1;
      process.stdout.write(`${colors.green}PASS${colors.reset} ${t.name} ${colors.dim}(${Date.now() - started}ms)${colors.reset}\n`);
    } catch (err) {
      failures.push({ name: t.name, err });
      process.stdout.write(`${colors.red}FAIL${colors.reset} ${t.name}\n`);
    }
  }
  process.stdout.write(`\n${colors.bold}${passed}/${selected.length} passed${colors.reset}\n`);
  for (const f of failures) {
    process.stdout.write(`\n${colors.red}--- ${f.name} ---${colors.reset}\n${f.err && f.err.stack ? f.err.stack : f.err}\n`);
  }
  return failures.length === 0;
}

module.exports = { test, run };
