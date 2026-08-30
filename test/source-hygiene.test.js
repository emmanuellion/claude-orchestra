'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['lib', 'public/js', 'hooks', 'bin', 'test'];
const FILES = ['server.js', 'package.json', 'public/index.html', 'public/popout.html', 'public/style.css'];
const EXT = /\.(js|json|css|html|md|webmanifest)$/;

function sourceFiles() {
  const out = [];
  const walk = dir => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (EXT.test(entry.name)) out.push(rel);
    }
  };
  DIRS.forEach(walk);
  for (const f of FILES) {
    if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  }
  return out;
}

/**
 * A literal NUL once reached lib/args-policy.js in place of the `\0` escape it
 * was meant to be. Node still parsed it, the tests still passed, and git
 * quietly reclassified the file as binary, so every future diff on it would
 * have been unreadable. Nothing else caught it.
 */
test('no source file contains a NUL or stray control character', () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      // Tab, LF, CR and formfeed are the only control bytes source may carry.
      if (c < 9 || (c > 13 && c < 32)) {
        offenders.push(`${rel}: byte 0x${c.toString(16).padStart(2, '0')} at offset ${i}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `control characters found:\n${offenders.join('\n')}`);
});

test('no source file is empty or unreadable', () => {
  const empty = sourceFiles().filter(rel => fs.statSync(path.join(ROOT, rel)).size === 0);
  assert.deepEqual(empty, [], `empty files: ${empty.join(', ')}`);
});

test('every lib and hook module parses and loads', () => {
  const failures = [];
  for (const rel of sourceFiles()) {
    if (!rel.startsWith('lib') && !rel.startsWith('hooks')) continue;
    if (!rel.endsWith('.js')) continue;
    // The hooks read stdin on load, so only lib is required outright.
    if (rel.startsWith('hooks')) continue;
    try {
      require(path.join(ROOT, rel));
    } catch (err) {
      failures.push(`${rel}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});
