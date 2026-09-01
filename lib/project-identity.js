'use strict';

const path = require('path');
const { KIND } = require('./protocol');

/**
 * Names and colours derived from where a session works.
 *
 * "Claude 1..4" tells you nothing, and picking a colour by hand for each agent
 * is a chore nobody repeats. Deriving both from the working directory makes
 * every agent on one repository look alike with nobody deciding anything.
 */

/** Must stay in sync with TAG_COLORS in public/js/sidebar.js, minus 'none'. */
const PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

/** Directories that say nothing about which project you are in. */
const UNINFORMATIVE = new Set([
  'src', 'lib', 'app', 'apps', 'packages', 'source', 'code', 'repo', 'repos',
  'projects', 'documents', 'git', 'dev', 'work', 'workspace', 'home', 'users',
  'frontend', 'backend', 'client', 'server', 'web', 'www', 'main', 'master',
]);

/**
 * The part of a path a human would name the project by: walks up past generic
 * containers, so `~/git/buyandrent/Frontend` reads as "buyandrent Frontend"
 * rather than a "Frontend" three repositories share.
 */
function projectLabel(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const parts = path.resolve(cwd).split(/[\\/]/).filter(Boolean);
  // Drop a drive letter like "C:".
  if (parts.length && /^[a-zA-Z]:$/.test(parts[0])) parts.shift();
  if (!parts.length) return '';

  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (parent && UNINFORMATIVE.has(last.toLowerCase()) && !UNINFORMATIVE.has(parent.toLowerCase())) {
    return `${parent} ${last}`;
  }
  return last;
}

/** FNV-1a. A labelling decision, not a security one. */
function hash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function normalizeKey(cwd) {
  return String(cwd || '').replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Stable colour for a directory: same directory, same colour, on any machine
 * and across restarts.
 *
 * @param {string} cwd
 * @param {Array<{cwd:string, tagColor:string}>} [siblings] live sessions, used
 *   to break ties. A session in the same directory hands over its colour; a
 *   different directory landing on a taken one walks to the next free colour,
 *   because two projects sharing a colour defeats the point.
 */
function colorFor(cwd, siblings = []) {
  const key = normalizeKey(cwd);
  if (!key) return 'none';

  const taken = new Set();
  for (const s of siblings) {
    const other = normalizeKey(s && s.cwd);
    if (!other || !s.tagColor || s.tagColor === 'none') continue;
    if (other === key) return s.tagColor;
    taken.add(s.tagColor);
  }

  const start = hash(key) % PALETTE.length;
  for (let i = 0; i < PALETTE.length; i++) {
    const candidate = PALETTE[(start + i) % PALETTE.length];
    if (!taken.has(candidate)) return candidate;
  }
  // More projects than colours: clash rather than leave a session unmarked.
  return PALETTE[start];
}

/**
 * @param {string} cwd
 * @param {string} kind
 * @param {string[]} [existingNames] taken names, so a second agent is numbered
 */
function defaultNameFor(cwd, kind, existingNames = []) {
  const label = projectLabel(cwd);
  const base = label
    ? (kind === KIND.CLAUDE ? label : `${label} ${kindWord(kind)}`)
    : kindWord(kind, true);

  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

function kindWord(kind, capitalized = false) {
  if (kind === KIND.POWERSHELL) return capitalized ? 'PowerShell' : 'pwsh';
  if (kind === KIND.CLAUDE) return capitalized ? 'Claude' : 'claude';
  return capitalized ? 'Shell' : 'shell';
}

module.exports = { PALETTE, projectLabel, colorFor, defaultNameFor };
