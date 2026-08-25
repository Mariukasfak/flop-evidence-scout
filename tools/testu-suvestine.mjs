#!/usr/bin/env node
// Kompaktiska testu suvestine. Vietoj didziuliu klaidu tekstu parodo viena eilute
// vienam failui, kad bendra bukle butu matyti is pirmo zvilgsnio.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = path.join(ROOT, 'test');
const CROSS = String.fromCharCode(0x2716);
const PER_FILE_TIMEOUT_MS = 120_000;

function countOf(lines, label) {
  let value = 0;
  for (const line of lines) {
    const parts = line.trim().split(' ');
    const index = parts.indexOf(label);
    if (index !== -1 && parts.length === index + 2) {
      const parsed = Number(parts[index + 1]);
      if (Number.isInteger(parsed)) value = parsed;
    }
  }
  return value;
}

function failedNames(lines) {
  const names = new Set();
  let inFailureList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.endsWith('failing tests:')) { inFailureList = true; continue; }
    if (!inFailureList || !trimmed.startsWith(CROSS)) continue;
    let name = trimmed.slice(CROSS.length).trim();
    const timing = name.lastIndexOf(' (');
    if (timing > 0) name = name.slice(0, timing);
    if (name) names.add(name);
  }
  return [...names];
}

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', path.join(TEST_DIR, file)], {
      cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, PER_FILE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('close', () => {
      clearTimeout(timer);
      const lines = out.split(String.fromCharCode(10));
      resolve({
        file,
        timedOut,
        pass: countOf(lines, 'pass'),
        fail: countOf(lines, 'fail'),
        failed: failedNames(lines)
      });
    });
  });
}

const files = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.mjs')).sort();
const results = [];
for (const file of files) results.push(await runOne(file));

let totalPass = 0;
let totalFail = 0;
console.log('');
console.log('  TESTU SUVESTINE');
console.log('  ' + '-'.repeat(56));
for (const result of results) {
  totalPass += result.pass;
  totalFail += result.fail;
  const mark = result.timedOut ? 'KABO' : result.fail === 0 ? 'OK' : 'KRENTA';
  const name = result.file.replace('.test.mjs', '');
  console.log(`  ${mark.padEnd(7)} ${name.padEnd(24)} ${result.pass} praejo, ${result.fail} krito`);
  for (const failure of result.failed) console.log(`          -> ${failure}`);
}
console.log('  ' + '-'.repeat(56));
console.log(`  IS VISO: ${totalPass} praejo, ${totalFail} krito`);
console.log('');
if (totalFail > 0) {
  console.log('  Pastaba: dalis kritimu gali buti kito agento nebaigtas darbas.');
  console.log('  Kas siuo metu vyksta, ziurekite .codex/*-handoff.md failuose.');
  console.log('');
}
