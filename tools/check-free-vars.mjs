/**
 * Catch the bug `node --check` cannot see: a name nothing declares.
 *
 * `poemText` survived a refactor inside a branch the dry run never reached and
 * crashed a live pass between proposing a roster and inviting anyone to it.
 * Syntax checking does not resolve names and there is no linter in this repo,
 * so this is the cheapest thing that would have caught it: collect every
 * identifier the file reads, subtract everything it declares and everything the
 * runtime provides, and print what is left.
 *
 * It is a heuristic, not a scope analysis -- it does not know which block a
 * declaration belongs to, so it finds names that exist nowhere at all, which is
 * exactly the mistake that shipped. Property accesses and object keys are
 * skipped because those are not variable reads.
 *
 * Known limit: regex literals are not parsed. A pattern containing an
 * apostrophe, such as /[a-z]+(?:'[a-z]+)*$/, reads as the start of a string
 * here and swallows the code after it, which can hide real declarations and
 * produce false alarms. So grep for a flagged name before believing it -- and
 * a file full of findings usually means a regex ate it, not that the file is
 * broken.
 *
 *   node tools/check-free-vars.mjs tools/sonnet2-agent.mjs
 */
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/check-free-vars.mjs <file.mjs> [...]');
  process.exit(2);
}

const GLOBALS = new Set([
  'globalThis', 'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'fetch', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'structuredClone', 'crypto', 'performance', 'Math', 'JSON', 'Date', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy',
  'Reflect', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError',
  'ReferenceError', 'URIError', 'AggregateError', 'Function', 'Infinity', 'NaN', 'undefined',
  'null', 'true', 'false', 'this', 'arguments', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'Intl', 'import', 'new',
  'typeof', 'instanceof', 'void', 'delete', 'in', 'of', 'return', 'await', 'async', 'yield'
]);

const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw',
  'export', 'extends', 'super', 'static', 'get', 'set', 'from', 'as']);

let bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');

  /**
   * Strip comments and string/template bodies -- but keep ${...} expressions,
   * and keep every newline, or the line numbers this prints point at the wrong
   * place. The first version reported a name on line 80, which is prose inside
   * a block comment.
   */
  const keepLines = (m) => m.replace(/[^\n]/g, ' ');
  let code = src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + keepLines(m.slice(p.length)));
  /**
   * A quote inside a regex character class is not a string.
   *
   * `/[^a-z']/` reads as the start of a string here, and everything up to the
   * next apostrophe -- often the rest of the file -- disappears with it, taking
   * real declarations along and turning the report into a wall of English. Only
   * brackets that look like a character class are disarmed, so an ordinary
   * array of strings is left alone.
   */
  code = code.replace(
    /(^|[=(,:;&|!?{[+\s])\/(?![/*])(?:\\.|\[(?:\\.|[^\]\n\\])*\]|[^/\n\\])+\/[gimsuyd]*/g,
    (m, p) => p + m.slice(p.length).replace(/['"]/g, ' ')
  );
  code = code
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  code = code.replace(/`(?:\\.|[^`\\])*`/g, (lit) => {
    const parts = [...lit.matchAll(/\$\{([\s\S]*?)\}/g)].map((m) => m[1]);
    return parts.length ? ` ${parts.join(' ; ')} ` : '``';
  });

  /** Everything the file declares or imports, however it declares it. */
  const declared = new Set();
  const add = (names) => { for (const n of String(names).match(/[A-Za-z_$][\w$]*/g) || []) declared.add(n); };
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|[A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\bimport\s+([\s\S]*?)\s+from\b/g)) add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  /**
   * Parameter lists: arrow functions, methods and plain functions alike.
   *
   * The preceding word matters. `if (poemText) {` has the shape of a parameter
   * list, so the first version of this counted `poemText` as declared -- and
   * quietly gave the file a clean bill of health for the exact bug it was
   * written to catch.
   */
  const NOT_PARAMS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'in', 'of']);
  for (const m of code.matchAll(/(\w*)\s*\(([^()]*)\)\s*(?:=>|\{)/g)) {
    if (NOT_PARAMS.has(m[1])) continue;
    add(m[2]);
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([^;)]*?)\s+(?:of|in)\b/g)) add(m[1]);

  /** Every identifier that is read: not after a dot, not an object key. */
  const used = new Map();
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*(:?)/g)) {
      const name = m[2];
      if (m[3] === ':' && !/\?\s*$/.test(m[1])) continue;   // object key or label
      /**
       * Regex literals are not parsed here, so a character class like [a-z]
       * leaves its letters behind as bare names. Nothing worth catching is one
       * or two characters long, and every real find so far has been a word.
       */
      if (name.length <= 2) continue;
      if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
      if (!used.has(name)) used.set(name, i + 1);
    }
  });

  if (used.size) {
    bad++;
    console.log(`${file}: ${used.size} name(s) nothing declares`);
    for (const [name, line] of used) console.log(`  ${file}:${line}  ${name}`);
  } else {
    console.log(`${file}: every name is declared`);
  }
}
process.exit(bad ? 1 : 0);
