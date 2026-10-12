// Lightweight structural sanity check for Dart sources.
//
// Why this exists: the dev machine has no Dart/Flutter, so a Dart file cannot be
// compiled or analyzed locally. This catches the most likely hand-editing mistakes
// before pushing (unbalanced brackets, unterminated strings, stray tabs) - it is NOT
// a parser and does not replace `flutter analyze`, which remains the authority in CI.
//
// It is deliberately conservative: when it cannot decide, it reports "unknown" rather
// than a false failure, because a noisy checker gets ignored.
//
// Run: node tool/check_dart_syntax.mjs [file...]   (defaults to app/**/*.dart)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.dart_tool' || e.name === 'build' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.dart')) out.push(p);
  }
  return out;
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => path.resolve(p))
  : walk(path.join(root, 'app'));

if (files.length === 0) {
  console.log('no .dart files found (nothing to check yet)');
  process.exit(0);
}

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set(Object.values(OPEN));

/** Strip line comments and string literals so brackets inside them are ignored. */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let blockDepth = 0; // /* */ nesting (Dart allows nested block comments)
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (blockDepth > 0) {
      if (c === '/' && next === '*') { blockDepth += 1; out += '  '; i += 2; continue; }
      if (c === '*' && next === '/') { blockDepth -= 1; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }

    if (c === '/' && next === '*') { blockDepth = 1; out += '  '; i += 2; continue; }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }

    // Raw strings (r'...' / r"...") have no escapes.
    const isRaw = (c === 'r' || c === 'R') && (next === "'" || next === '"');
    if (isRaw || c === "'" || c === '"') {
      const quote = isRaw ? next : c;
      const triple = src.startsWith(quote.repeat(3), isRaw ? i + 1 : i);
      const delim = triple ? quote.repeat(3) : quote;
      let j = (isRaw ? i + 1 : i) + delim.length;
      let closed = false;
      while (j < n) {
        if (!triple && src[j] === '\\' && !isRaw) { j += 2; continue; }
        if (src.startsWith(delim, j)) { closed = true; j += delim.length; break; }
        if (!triple && src[j] === '\n') break; // unterminated single-line string
        j += 1;
      }
      // Preserve newlines so line numbers stay meaningful.
      for (let k = i; k < j; k += 1) out += src[k] === '\n' ? '\n' : ' ';
      if (!closed) return { text: out, unterminatedAt: i };
      i = j;
      continue;
    }

    out += c;
    i += 1;
  }
  return { text: out, unterminatedAt: null };
}

let failures = 0;

for (const file of files) {
  const rel = path.relative(root, file).replaceAll('\\', '/');
  const src = fs.readFileSync(file, 'utf8');
  const { text, unterminatedAt } = stripCommentsAndStrings(src);

  const problems = [];

  if (unterminatedAt !== null) {
    const line = src.slice(0, unterminatedAt).split('\n').length;
    problems.push(`unterminated string literal starting near line ${line}`);
  }

  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (OPEN[ch]) {
      stack.push({ ch, i });
    } else if (CLOSE.has(ch)) {
      const top = stack.pop();
      if (!top || OPEN[top.ch] !== ch) {
        const line = text.slice(0, i).split('\n').length;
        problems.push(`unbalanced '${ch}' at line ${line}`);
        break;
      }
    }
  }
  if (stack.length) {
    const line = text.slice(0, stack[stack.length - 1].i).split('\n').length;
    problems.push(`${stack.length} unclosed opener(s), innermost '${stack[stack.length - 1].ch}' from line ${line}`);
  }

  if (/\t/.test(src)) problems.push('contains tab characters (Dart style uses spaces)');
  if (src.length && !src.endsWith('\n')) problems.push('file does not end with a newline');

  const tests = (src.match(/^\s*test\(/gm) || []).length;
  const groups = (src.match(/^\s*group\(/gm) || []).length;

  if (problems.length) {
    failures += 1;
    console.log(`FAIL  ${rel}`);
    for (const p of problems) console.log(`        - ${p}`);
  } else {
    console.log(`OK    ${rel}  (${tests} tests, ${groups} groups, ${src.split('\n').length} lines)`);
  }
}

console.log(
  `\nNOTE: 这是结构检查，不是解析器，也不替代 CI 中的 \`flutter analyze\`。`,
);
if (failures) {
  console.log(`FAIL: ${failures} 个文件存在结构问题`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${files.length} 个 Dart 文件结构检查通过`);
}
