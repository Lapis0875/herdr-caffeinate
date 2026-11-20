// Layer rule (docs/CONTRACTS.md): core/ imports nothing outside core/ and never
// reads the clock or randomness. Passes while core/ is empty or missing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../mods/herdr-caffeinate/core/', import.meta.url));

// Clock and randomness reads; `new Date(ms)`, `Date.parse` and `Date.UTC` stay allowed.
const FORBIDDEN = [
  [/\bDate\.now\b/, 'Date.now'],
  [/\bnew\s+Date\b(?!\s*\(\s*[^\s)])/, 'new Date() without arguments'],
  [/(?<![\w$.]|\bnew\s+)\bDate\s*\(/, 'Date() called as a function'],
  [/\bperformance\.now\b/, 'performance.now'],
  [/\bprocess\.hrtime\b/, 'process.hrtime'],
  [/\bTemporal\.Now\b/, 'Temporal.Now'],
  [/\bMath\.random\b/, 'Math.random'],
  [/\bcrypto\b/, 'crypto'],
];

async function jsFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await jsFiles(path));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

// Whole-line `//` comments and block comments that start a line, so prose such as
// "never calls Date.now" is not flagged; trailing comments after code are still scanned.
const stripComments = (text) => text.replace(/^\s*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

// Every module specifier: import/export … from, bare import, dynamic import(), require().
function specifiers(source) {
  const found = [];
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;'"`()=]*?\bfrom\s*(['"])(.*?)\1/gm)) found.push(m[2]);
  for (const m of source.matchAll(/^\s*import\s*(['"])(.*?)\1/gm)) found.push(m[2]);
  for (const m of source.matchAll(/\bimport\s*\(\s*(?:(['"])(.*?)\1\s*\))?/g)) found.push(m[1] ? m[2] : '<dynamic import>');
  for (const _ of source.matchAll(/\brequire\s*\(/g)) found.push('<require>');
  return found;
}

function insideCore(file, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return false;
  const rel = relative(root, resolve(dirname(file), spec));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function violations(file, text) {
  const source = stripComments(text);
  const found = [];
  for (const spec of specifiers(source)) if (!insideCore(file, spec)) found.push(`imports ${spec}`);
  for (const [pattern, label] of FORBIDDEN) if (pattern.test(source)) found.push(`uses ${label}`);
  return found;
}

test('core modules import only core/ and never read the clock or randomness', async () => {
  for (const file of await jsFiles(root)) {
    const found = violations(file, await readFile(file, 'utf8'));
    assert.equal(found.length, 0, `${relative(root, file)}: ${found.join(', ')}`);
  }
});

test('the purity scan flags outside imports, clock and randomness', () => {
  const file = join(root, 'sample.js');
  const clean = [
    "/** Pure: uses no Math.random. */",
    "import {step} from './machine.js';",
    "export {en} from './catalog/en.js';",
    "// Never calls Date.now(); events carry now.",
    "export const at = (ms) => new Date(ms).toISOString() + Date.UTC(2026, 0, 1) + Array.from('ab');",
  ].join('\n');
  assert.deepEqual(violations(file, clean), []);
  const dirty = {
    "import {exec} from 'herdr';": 'imports herdr',
    "import {readFile} from 'node:fs/promises';": 'imports node:fs/promises',
    "import '../sys/engine.js';": 'imports ../sys/engine.js',
    "export * from '../views/menu.js';": 'imports ../views/menu.js',
    'const m = await import(name);': 'imports <dynamic import>',
    "const fs = require('fs');": 'imports <require>',
    'const t = Date.now();': 'uses Date.now',
    'const t = new Date();': 'uses new Date() without arguments',
    'const t = String(Date());': 'uses Date() called as a function',
    'const t = performance.now();': 'uses performance.now',
    'const r = Math.random();': 'uses Math.random',
    'const id = crypto.randomUUID();': 'uses crypto',
  };
  for (const [line, expected] of Object.entries(dirty)) {
    const found = violations(file, line);
    assert.deepEqual(found, [expected], `${line} -> ${JSON.stringify(found)}`);
  }
});
