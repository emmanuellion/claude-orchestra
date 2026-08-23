/**
 * The settings panel: five tabs over the store, plus the Hooks tab that writes
 * to ~/.claude/settings.json. Everything Orchestra knows about a running agent
 * comes from Claude Code's hooks, so installing them is a visible, reversible
 * operation with the backup path shown, and a file that cannot be parsed is
 * never offered a write at all.
 */

import { HOOK_EVENT } from './protocol.js';

/** Key used by the sidebar for its own ordering, shared on purpose. */
export const SIDEBAR_SORT_PREF = 'sidebar.sort';

export const PREF_DEFAULTS = {
  theme: 'dark',
  fontSize: 14,
  confirmClose: true,
  notifications: true,
  [SIDEBAR_SORT_PREF]: 'urgency',
  shortcutPrefix: 'Ctrl+K',
  shortcuts: {},
};

export const SIDEBAR_SORTS = [
  ['urgency', 'Urgency, blocked agents first'],
  ['manual', 'Manual, drag to reorder'],
];

export const THEMES = [
  ['system', 'Follow the system'],
  ['dark', 'Dark'],
  ['light', 'Light'],
];

/**
 * Combos a binding may never take unprefixed, because a terminal owns them:
 * interrupt, EOF, reverse search, kill-word, tmux, readline, Enter, and the way
 * out of a vim mode.
 */
export const RESERVED_COMBOS = [
  'Escape', 'Ctrl+C', 'Ctrl+W', 'Ctrl+M', 'Ctrl+N', 'Ctrl+B', 'Ctrl+D', 'Ctrl+R',
];

/** The prefix key. Every default binding is "prefix, then one key". */
export const SHORTCUT_PREFIX = 'Ctrl+K';

export const SHORTCUT_ACTIONS = [
  { id: 'launcher', label: 'Open the launcher', hint: 'Start something new', combo: 'l', prefix: true },
  { id: 'newAgent', label: 'New agent in the current folder', hint: '', combo: 'a', prefix: true },
  { id: 'newShell', label: 'New shell in the current folder', hint: '', combo: 's', prefix: true },
  { id: 'closeSession', label: 'Close the current session', hint: 'Asks first unless you turn that off', combo: 'x', prefix: true },
  { id: 'renameSession', label: 'Rename the current session', hint: '', combo: 'r', prefix: true },
  { id: 'nextSession', label: 'Next session', hint: '', combo: ']', prefix: true },
  { id: 'prevSession', label: 'Previous session', hint: '', combo: '[', prefix: true },
  { id: 'jumpToIndex', label: 'Jump to session 1 to 9', hint: 'Prefix then a digit', combo: '1-9', prefix: true },
  { id: 'toggleSidebar', label: 'Show or hide the sidebar', hint: '', combo: 'b', prefix: true },
  { id: 'viewSupervision', label: 'Go to supervision', hint: '', combo: 'v', prefix: true },
  { id: 'viewApprovals', label: 'Go to approvals', hint: '', combo: 'p', prefix: true },
  { id: 'viewRace', label: 'Go to races', hint: '', combo: 'c', prefix: true },
  { id: 'search', label: 'Search the scrollback', hint: '', combo: 'f', prefix: true },
  { id: 'broadcast', label: 'Send a prompt to several agents', hint: '', combo: 'm', prefix: true },
  { id: 'settings', label: 'Open settings', hint: '', combo: ',', prefix: true },
  { id: 'zoomIn', label: 'Bigger text', hint: '', combo: '=', prefix: true },
  { id: 'zoomOut', label: 'Smaller text', hint: '', combo: '-', prefix: true },
];

/** One sentence per hook, so the Install button is not a leap of faith. */
const HOOK_DESCRIPTIONS = {
  [HOOK_EVENT.SESSION_START]: 'Tells Orchestra a panel really is a Claude session, and records its model and git branch.',
  [HOOK_EVENT.USER_PROMPT_SUBMIT]: 'Shows the prompt you just sent and flips the session to busy.',
  [HOOK_EVENT.PRE_TOOL_USE]: 'Reports the tool an agent is about to run, and is what makes approvals possible.',
  [HOOK_EVENT.POST_TOOL_USE]: 'Closes the running tool out with its duration and whether it worked.',
  [HOOK_EVENT.NOTIFICATION]: 'Surfaces the question an agent is blocked on, in the sidebar and in notifications.',
  [HOOK_EVENT.STOP]: 'Marks the turn as finished, which is the only honest source for "this agent is done".',
  [HOOK_EVENT.SUBAGENT_STOP]: 'Counts subagents as they finish, so a long task shows progress.',
  [HOOK_EVENT.SESSION_END]: 'Records why an agent session ended.',
};

const TABS = [
  ['general', 'General'],
  ['hooks', 'Hooks'],
  ['approvals', 'Approvals'],
  ['shortcuts', 'Shortcuts'],
  ['remote', 'Remote'],
];

function makeLogger(logger) {
  const c = typeof console !== 'undefined' ? console : null;
  const bind = (name) => {
    if (logger && typeof logger[name] === 'function') return logger[name].bind(logger);
    if (c && typeof c[name] === 'function') return c[name].bind(c);
    return () => {};
  };
  return { debug: bind('debug'), info: bind('info'), warn: bind('warn'), error: bind('error') };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function button(className, label, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function field(label, control, hint) {
  const row = el('label', 'settings-field');
  row.appendChild(el('span', 'settings-field-label', label));
  row.appendChild(control);
  if (hint) row.appendChild(el('span', 'settings-field-hint', hint));
  return row;
}

function shortDate(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleString();
}

/**
 * Canonical spelling of a key combo, so "ctrl+K" and "Control+k" compare equal.
 * @returns {string|null} null while only a modifier is held
 */
export function comboFromEvent(e) {
  const key = e.key;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let name = key;
  if (name === ' ') name = 'Space';
  else if (name.length === 1) name = name.toLowerCase();
  parts.push(name);
  return parts.join('+');
}

function normalizeCombo(value) {
  if (typeof value !== 'string') return '';
  const parts = value.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return '';
  const key = parts.pop();
  const mods = new Set(parts.map((p) => {
    const low = p.toLowerCase();
    if (low === 'control' || low === 'ctrl') return 'Ctrl';
    if (low === 'alt' || low === 'option') return 'Alt';
    if (low === 'shift') return 'Shift';
    if (low === 'meta' || low === 'cmd' || low === 'command') return 'Meta';
    return p;
  }));
  const ordered = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => mods.has(m));
  const name = key.length === 1 ? key.toLowerCase() : key;
  return [...ordered, name].join('+');
}

/**
 * The reserved list in canonical spelling. A recorded key always arrives
 * lowercased, so "Ctrl+C" would never match the raw table.
 */
const RESERVED_SET = new Set(RESERVED_COMBOS.map(normalizeCombo));

export function isReservedCombo(combo) {
  return RESERVED_SET.has(normalizeCombo(combo));
}

/** Display spelling: combos are stored lowercased but read better uppercase. */
export function formatCombo(combo) {
  const parts = String(combo ?? '').split('+');
  const key = parts.pop() || '';
  return [...parts, key.length === 1 ? key.toUpperCase() : key].join('+');
}

export function defaultShortcuts() {
  const out = {};
  for (const action of SHORTCUT_ACTIONS) {
    out[action.id] = { combo: action.combo, prefix: action.prefix };
  }
  return out;
}

/**
 * Drops the bindings that collide or that a terminal owns, so the caller always
 * gets a usable map plus the list of what was refused.
 * @returns {{ok:boolean, errors:Array<{id:string,message:string}>, map:Object}}
 */
export function validateShortcuts(map) {
  const errors = [];
  const out = defaultShortcuts();
  const seen = new Map();

  for (const action of SHORTCUT_ACTIONS) {
    const raw = map && map[action.id];
    const binding = raw && typeof raw === 'object'
      ? { combo: normalizeCombo(raw.combo) || action.combo, prefix: raw.prefix !== false }
      : { combo: action.combo, prefix: action.prefix };

    if (!binding.prefix && isReservedCombo(binding.combo)) {
      errors.push({ id: action.id, message: `${formatCombo(binding.combo)} belongs to the terminal and cannot be taken.` });
      continue;
    }
    const key = `${binding.prefix ? `${SHORTCUT_PREFIX} ` : ''}${binding.combo}`;
    if (seen.has(key)) {
      errors.push({ id: action.id, message: `${formatCombo(key)} is already used by "${seen.get(key)}".` });
      continue;
    }
    seen.set(key, action.label);
    out[action.id] = binding;
  }
  return { ok: errors.length === 0, errors, map: out };
}

/**
 * Applies a preference to the document. Exported so the app can call it once at
 * boot with the stored values and get exactly the same result.
 */
export function applyPreference(key, value) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (key === 'theme') {
    if (value === 'dark' || value === 'light') root.setAttribute('data-theme', value);
    else root.removeAttribute('data-theme');
    return;
  }
  if (key === 'fontSize') {
    const px = Math.min(32, Math.max(8, Number(value) || PREF_DEFAULTS.fontSize));
    root.style.setProperty('--term-font-size', `${px}px`);
  }
}

// QR encoder: byte mode, error correction level M with a fallback to L,
// versions 1 to 40. Written here on purpose: the alternative was pulling a
// library into a page that is meant to run with no network at all.

const QR_ECC_CODEWORDS = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
};

const QR_ECC_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
};

const QR_FORMAT_BITS = { L: 1, M: 0 };

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return Array.from(result);
}

function qrRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function qrDataCodewords(version, ecl) {
  return Math.floor(qrRawDataModules(version) / 8)
    - QR_ECC_CODEWORDS[ecl][version] * QR_ECC_BLOCKS[ecl][version];
}

function qrAlignPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function qrInterleave(data, version, ecl) {
  const numBlocks = QR_ECC_BLOCKS[ecl][version];
  const blockEccLen = QR_ECC_CODEWORDS[ecl][version];
  const rawCodewords = Math.floor(qrRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    // Short blocks get a placeholder so every block has the same length; the
    // interleaver below skips that exact slot.
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) out.push(blocks[j][i]);
    }
  }
  return out;
}

function qrMaskAt(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class QrMatrix {
  constructor(version, ecl) {
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    this.modules = [];
    this.isFunction = [];
    for (let y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }
  }

  _set(x, y, dark) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFunctionPatterns() {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this._set(6, i, i % 2 === 0);
      this._set(i, 6, i % 2 === 0);
    }
    this._finder(3, 3);
    this._finder(size - 4, 3);
    this._finder(3, size - 4);

    const pos = qrAlignPositions(this.version);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const corner = (i === 0 && j === 0)
          || (i === 0 && j === pos.length - 1)
          || (i === pos.length - 1 && j === 0);
        if (!corner) this._alignment(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  _finder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this._set(x + dx, y + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  _alignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this._set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(mask) {
    const size = this.size;
    const data = (QR_FORMAT_BITS[this.ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this._set(8, i, bit(i));
    this._set(8, 7, bit(6));
    this._set(8, 8, bit(7));
    this._set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this._set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this._set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this._set(8, size - 15 + i, bit(i));
    this._set(8, size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this._set(a, b, dark);
      this._set(b, a, dark);
    }
  }

  drawCodewords(data) {
    const size = this.size;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y][x] && qrMaskAt(mask, x, y)) {
          this.modules[y][x] = !this.modules[y][x];
        }
      }
    }
  }

  _finderPenaltyAdd(runLength, history) {
    if (history[0] === 0) runLength += this.size;
    history.pop();
    history.unshift(runLength);
  }

  _finderPenaltyCount(history) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0)
      + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }

  _finderPenaltyEnd(runColor, runLength, history) {
    let length = runLength;
    if (runColor) {
      this._finderPenaltyAdd(length, history);
      length = 0;
    }
    length += this.size;
    this._finderPenaltyAdd(length, history);
    return this._finderPenaltyCount(history);
  }

  /**
   * Rules 1 and 3 of the penalty score, over one axis. `cellAt(line, i)` reads
   * the module so the caller decides whether a line is a row or a column.
   */
  _runPenalty(cellAt) {
    const N1 = 3;
    const N3 = 40;
    let result = 0;
    for (let line = 0; line < this.size; line++) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < this.size; i++) {
        const dark = cellAt(line, i);
        if (dark === runColor) {
          runLength++;
          if (runLength === 5) result += N1;
          else if (runLength > 5) result++;
        } else {
          this._finderPenaltyAdd(runLength, history);
          if (!runColor) result += this._finderPenaltyCount(history) * N3;
          runColor = dark;
          runLength = 1;
        }
      }
      result += this._finderPenaltyEnd(runColor, runLength, history) * N3;
    }
    return result;
  }

  penalty() {
    const size = this.size;
    const N2 = 3;
    const N4 = 10;
    let result = this._runPenalty((y, x) => this.modules[y][x])
      + this._runPenalty((x, y) => this.modules[y][x]);

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          result += N2;
        }
      }
    }

    let dark = 0;
    for (const row of this.modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * N4;
  }
}

/**
 * @returns {{size:number, modules:boolean[][], version:number, ecl:string}}
 * @throws when the text does not fit in a version 40 symbol
 */
export function qrEncode(text) {
  const bytes = new TextEncoder().encode(String(text));
  for (const ecl of ['M', 'L']) {
    for (let version = 1; version <= 40; version++) {
      const capacityBits = qrDataCodewords(version, ecl) * 8;
      const lenBits = version <= 9 ? 8 : 16;
      const needed = 4 + lenBits + bytes.length * 8;
      if (needed > capacityBits) continue;
      if (bytes.length >= (1 << lenBits)) continue;

      const bits = [];
      const push = (value, count) => {
        for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
      };
      push(0b0100, 4);
      push(bytes.length, lenBits);
      for (const b of bytes) push(b, 8);

      push(0, Math.min(4, capacityBits - bits.length));
      push(0, (8 - (bits.length % 8)) % 8);
      const codewords = [];
      for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        codewords.push(byte);
      }
      for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) {
        codewords.push(pad);
      }

      const interleaved = qrInterleave(codewords, version, ecl);
      const matrix = new QrMatrix(version, ecl);
      matrix.drawFunctionPatterns();
      matrix.drawCodewords(interleaved);

      let bestMask = 0;
      let bestPenalty = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        matrix.applyMask(mask);
        matrix.drawFormatBits(mask);
        const p = matrix.penalty();
        if (p < bestPenalty) {
          bestPenalty = p;
          bestMask = mask;
        }
        matrix.applyMask(mask);
      }
      matrix.applyMask(bestMask);
      matrix.drawFormatBits(bestMask);

      return { size: matrix.size, modules: matrix.modules, version, ecl };
    }
  }
  throw new Error('That URL is too long to fit in a QR code.');
}

/**
 * Renders a matrix as an SVG element. Black on white whatever the theme is:
 * a phone camera needs the contrast, not the palette.
 */
export function qrToSvg(matrix, opts = {}) {
  const quiet = Number.isFinite(opts.quiet) ? opts.quiet : 4;
  const px = Number.isFinite(opts.size) ? opts.size : 200;
  const dim = matrix.size + quiet * 2;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`);
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', opts.label || 'QR code');
  svg.setAttribute('shape-rendering', 'crispEdges');

  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(dim));
  bg.setAttribute('height', String(dim));
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  let d = '';
  for (let y = 0; y < matrix.size; y++) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.modules[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < matrix.size && matrix.modules[y][x + run]) run++;
      d += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run;
    }
  }
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.appendChild(path);
  return svg;
}

export class SettingsPanel {
  /**
   * @param {HTMLElement} root the overlay container, `#settings-root`
   * @param {object} deps.store         `getPref`, `setPref`
   * @param {object} [deps.connection]  read only, for the remote token
   * @param {object} deps.api           `get`, `post`, `delete`; plain fetch without one
   * @param {object} [deps.notifications] a Notifications instance, for the test button
   */
  constructor(root, deps = {}) {
    if (!root) throw new Error('SettingsPanel requires a root element');
    this.root = root;
    this.store = deps.store || null;
    this.connection = deps.connection || null;
    this.api = deps.api || null;
    this.notifications = deps.notifications || null;
    this.log = makeLogger(deps.logger);

    this.tab = 'general';
    this.open = false;
    this._nodes = {};
    this._mounted = false;

    this.hooks = { data: null, loaded: false, loading: false, error: null, busy: false, result: null };
    this.approvals = { rules: [], loaded: false, loading: false, error: null, gateError: null };
    this.shortcutErrors = [];
    this.recording = null;

    this._onKeyDown = (e) => this._handleKeyDown(e);
  }

  mount() {
    if (this._mounted) return this;
    this._mounted = true;
    this._build();
    this.root.hidden = true;
    return this;
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown, true);
    clear(this.root);
    this._nodes = {};
    this._mounted = false;
    this.open = false;
  }

  openPanel(tab) {
    if (!this._mounted) this.mount();
    if (tab) this.tab = tab;
    this.open = true;
    this.root.hidden = false;
    document.addEventListener('keydown', this._onKeyDown, true);
    this._renderTabs();
    this._renderPane();
    if (this._nodes.close) this._nodes.close.focus();
  }

  closePanel() {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    this.recording = null;
    document.removeEventListener('keydown', this._onKeyDown, true);
  }

  toggle(tab) {
    if (this.open) this.closePanel();
    else this.openPanel(tab);
  }

  isOpen() {
    return this.open;
  }

  setTab(tab) {
    if (!TABS.some(([id]) => id === tab)) return;
    this.tab = tab;
    this._renderTabs();
    this._renderPane();
  }

  _handleKeyDown(e) {
    if (!this.open) return;
    if (this.recording) {
      e.preventDefault();
      e.stopPropagation();
      const combo = comboFromEvent(e);
      if (!combo) return;
      this._finishRecording(combo === 'Escape' ? null : combo);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closePanel();
    }
  }

  _build() {
    clear(this.root);
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.closePanel();
    });

    const panel = el('div', 'settings-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Settings');

    const head = el('header', 'settings-head');
    head.appendChild(el('h2', 'settings-title', 'Settings'));
    const close = button('settings-close', 'Close', () => this.closePanel());
    close.setAttribute('aria-label', 'Close settings');
    head.appendChild(close);
    panel.appendChild(head);

    const tabs = el('nav', 'settings-tabs');
    tabs.setAttribute('role', 'tablist');
    panel.appendChild(tabs);

    const pane = el('div', 'settings-body');
    panel.appendChild(pane);

    this.root.appendChild(panel);
    this._nodes = { panel, tabs, pane, close };
    this._renderTabs();
    this._renderPane();
  }

  _renderTabs() {
    const tabs = this._nodes.tabs;
    if (!tabs) return;
    clear(tabs);
    for (const [id, label] of TABS) {
      const b = button(`settings-tab${this.tab === id ? ' is-active' : ''}`, label, () => this.setTab(id));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', this.tab === id ? 'true' : 'false');
      tabs.appendChild(b);
    }
  }

  _renderPane() {
    const pane = this._nodes.pane;
    if (!pane) return;
    clear(pane);
    if (this.tab === 'general') this._renderGeneral(pane);
    else if (this.tab === 'hooks') this._renderHooks(pane);
    else if (this.tab === 'approvals') this._renderApprovals(pane);
    else if (this.tab === 'shortcuts') this._renderShortcuts(pane);
    else this._renderRemote(pane);
  }

  _renderGeneral(pane) {
    const section = el('section', 'settings-section');

    section.appendChild(this._select('Theme', 'theme', THEMES));

    const size = el('input', 'settings-range');
    size.type = 'range';
    size.min = '8';
    size.max = '28';
    size.step = '1';
    size.value = String(this._pref('fontSize'));
    const sizeOut = el('output', 'settings-range-out', `${size.value} px`);
    size.addEventListener('input', () => {
      sizeOut.textContent = `${size.value} px`;
      this._setPref('fontSize', Number(size.value));
    });
    const sizeWrap = el('span', 'settings-range-wrap');
    sizeWrap.appendChild(size);
    sizeWrap.appendChild(sizeOut);
    section.appendChild(field('Terminal font size', sizeWrap, 'Applies to every panel straight away.'));

    section.appendChild(this._checkbox(
      'Ask before closing a session',
      'confirmClose',
      'A running agent is never closed by accident.',
    ));

    section.appendChild(this._checkbox(
      'Desktop notifications',
      'notifications',
      'Only when a turn ends, an agent asks something, a permission is pending, a session exits, or an agent stalls.',
    ));

    const notifRow = el('div', 'settings-inline');
    const state = this.notifications ? this.notifications.permission : 'unknown';
    notifRow.appendChild(el('span', 'settings-note', `Browser permission: ${state}`));
    notifRow.appendChild(button('settings-btn', 'Send a test notification', () => this._testNotification(notifRow)));
    section.appendChild(notifRow);

    section.appendChild(this._select('Sidebar order', SIDEBAR_SORT_PREF, SIDEBAR_SORTS));

    pane.appendChild(section);
  }

  /** A labelled `<select>` whose value is a stored preference and nothing else. */
  _select(label, prefKey, options) {
    const select = el('select', 'settings-select');
    for (const [value, text] of options) {
      const option = el('option', null, text);
      option.value = value;
      select.appendChild(option);
    }
    select.value = this._pref(prefKey);
    select.addEventListener('change', () => this._setPref(prefKey, select.value));
    return field(label, select);
  }

  async _testNotification(row) {
    if (!this.notifications) {
      row.appendChild(el('span', 'settings-error', 'No notification service is wired up.'));
      return;
    }
    const permission = await this.notifications.requestPermission();
    if (permission !== 'granted') {
      const msg = this.notifications.lastError || `Permission is "${permission}".`;
      row.appendChild(el('span', 'settings-error', msg));
      return;
    }
    const shown = await this.notifications.notify({
      reason: 'test',
      title: 'Claude Orchestra',
      body: 'Notifications work. You will only see these when this window is not focused.',
      force: true,
    });
    if (!shown) {
      row.appendChild(el('span', 'settings-error', this.notifications.lastError || 'The browser refused to show it.'));
    }
  }

  /** @returns {{wrap:HTMLElement, input:HTMLInputElement}} caller wires the input */
  _checkboxRow(label, hint) {
    const wrap = el('label', 'settings-check');
    const input = el('input');
    input.type = 'checkbox';
    wrap.appendChild(input);
    wrap.appendChild(el('span', 'settings-check-label', label));
    if (hint) wrap.appendChild(el('span', 'settings-field-hint', hint));
    return { wrap, input };
  }

  /** A checkbox whose state is a stored preference and nothing else. */
  _checkbox(label, prefKey, hint) {
    const { wrap, input } = this._checkboxRow(label, hint);
    input.checked = this._pref(prefKey) !== false;
    input.addEventListener('change', () => this._setPref(prefKey, input.checked));
    return wrap;
  }

  _renderHooks(pane) {
    const section = el('section', 'settings-section');
    section.appendChild(el('h3', 'settings-h3', 'Claude Code hooks'));
    section.appendChild(el(
      'p',
      'settings-lead',
      'Hooks are how Orchestra knows what an agent is doing. Without them a panel is just a terminal:'
      + ' no status, no tool feed, no approvals, no honest "done" notification.',
    ));

    if (this.hooks.loading) {
      section.appendChild(el('p', 'settings-note', 'Reading settings.json...'));
      pane.appendChild(section);
      return;
    }
    if (this.hooks.error) {
      const err = el('div', 'settings-alert settings-alert-error');
      err.appendChild(el('strong', null, 'Could not read the hook status. '));
      err.appendChild(el('span', null, this.hooks.error));
      err.appendChild(button('settings-btn', 'Retry', () => this._loadHooks()));
      section.appendChild(err);
      pane.appendChild(section);
      return;
    }
    if (!this.hooks.data) {
      section.appendChild(el('p', 'settings-note', 'The server returned no hook status.'));
      section.appendChild(button('settings-btn settings-btn-primary', 'Check hook status', () => this._loadHooks()));
      pane.appendChild(section);
      // Only auto fetch once: a server that keeps answering nothing must not
      // put this pane in a render loop.
      if (!this.hooks.loaded) this._loadHooks();
      return;
    }

    const s = this.hooks.data;

    const pathRow = el('p', 'settings-path');
    pathRow.appendChild(el('span', 'settings-path-label', 'Settings file'));
    pathRow.appendChild(el('code', null, s.settingsPath || 'unknown'));
    section.appendChild(pathRow);

    if (s.node && s.node.path) {
      const nodeRow = el('p', 'settings-path');
      nodeRow.appendChild(el('span', 'settings-path-label', 'Node used by the hooks'));
      nodeRow.appendChild(el('code', null, s.node.path));
      if (s.node.temporary || s.node.ephemeral) {
        nodeRow.appendChild(el('span', 'settings-warn', 'This node looks temporary, the hooks may stop working after a reboot.'));
      }
      section.appendChild(nodeRow);
    }

    const writable = s.parsable !== false;
    if (!writable) {
      const alert = el('div', 'settings-alert settings-alert-error');
      alert.appendChild(el('strong', null, 'This file cannot be parsed, so Orchestra will not write to it.'));
      alert.appendChild(el('code', 'settings-alert-path', s.settingsPath || ''));
      if (s.error) alert.appendChild(el('p', null, s.error));
      alert.appendChild(el(
        'p',
        null,
        'Fix the JSON by hand, or move the file aside, then come back and press Check again.'
        + ' Nothing here will overwrite a file it could not read.',
      ));
      alert.appendChild(button('settings-btn', 'Check again', () => this._loadHooks()));
      section.appendChild(alert);
      pane.appendChild(section);
      return;
    }

    const events = Array.isArray(s.events) && s.events.length ? s.events : Object.keys(HOOK_DESCRIPTIONS);
    const installed = new Set(Array.isArray(s.installed) ? s.installed : []);
    section.appendChild(this._hookList(events, installed));

    section.appendChild(this._statusLineNote(s.statusLine || {}));

    if (s.approvals && s.approvals.installed) {
      section.appendChild(el('p', 'settings-note', 'Approval hook: installed, PreToolUse can block on a human answer.'));
    } else {
      section.appendChild(el('p', 'settings-note', 'Approval hook: not installed, tool calls run without asking.'));
    }

    if (Array.isArray(s.foreign) && s.foreign.length) {
      section.appendChild(this._foreignHooks(s.foreign));
    }

    // `scripts` arrives either as a bare array or wrapped in {ok, dir, scripts,
    // missing}, depending on the server build.
    const scriptList = Array.isArray(s.scripts)
      ? s.scripts
      : (s.scripts && Array.isArray(s.scripts.scripts) ? s.scripts.scripts : []);
    const broken = scriptList.filter((sc) => sc && !sc.readable);
    if (broken.length) {
      const alert = el('div', 'settings-alert settings-alert-warn');
      alert.appendChild(el('strong', null, 'Hook scripts are missing from the install: '));
      alert.appendChild(el('span', null, broken.map((b) => b.name).join(', ')));
      alert.appendChild(el(
        'p',
        null,
        'Installing now would write hook commands pointing at files that are not there.'
        + ' Reinstall Orchestra, or restore these files, before installing.',
      ));
      section.appendChild(alert);
    }

    const actions = el('div', 'settings-actions');
    const missing = Array.isArray(s.missing) ? s.missing : [];
    const install = button(
      'settings-btn settings-btn-primary',
      missing.length ? `Install ${missing.length} missing hook${missing.length === 1 ? '' : 's'}` : 'Reinstall hooks',
      () => this._installHooks(events),
    );
    install.disabled = this.hooks.busy;
    actions.appendChild(install);
    const uninstall = button('settings-btn settings-btn-danger', 'Uninstall Orchestra hooks', () => this._uninstallHooks());
    uninstall.disabled = this.hooks.busy || installed.size === 0;
    actions.appendChild(uninstall);
    actions.appendChild(button('settings-btn settings-btn-ghost', 'Refresh', () => this._loadHooks()));
    section.appendChild(actions);

    if (this.hooks.result) section.appendChild(this._hookResult(this.hooks.result));

    pane.appendChild(section);
  }

  _hookList(events, installed) {
    const list = el('ul', 'settings-hooks');
    for (const name of events) {
      const here = installed.has(name);
      const li = el('li', `settings-hook${here ? ' is-installed' : ' is-missing'}`);
      const head = el('div', 'settings-hook-head');
      head.appendChild(el('span', 'settings-hook-name', name));
      head.appendChild(el('span', 'settings-hook-state', here ? 'installed' : 'missing'));
      li.appendChild(head);
      li.appendChild(el('p', 'settings-hook-why', HOOK_DESCRIPTIONS[name] || 'Feeds the session timeline.'));
      list.appendChild(li);
    }
    return list;
  }

  _statusLineNote(sl) {
    if (!sl.ours || !sl.stale) {
      const row = el('p', 'settings-note');
      if (sl.ours) row.textContent = 'Status line: managed by Orchestra, so the quota shows up in Claude Code itself.';
      else if (sl.present) row.textContent = 'Status line: configured by something else, Orchestra leaves it alone.';
      else row.textContent = 'Status line: not configured. Installing adds the Orchestra quota line.';
      return row;
    }

    // An Orchestra status line left over from an older install: Claude Code
    // runs that command on every render, so a moved or deleted script fails
    // silently there. Saying "managed by Orchestra" here would be a lie.
    const alert = el('div', 'settings-alert settings-alert-warn');
    alert.appendChild(el('strong', null, 'Status line: registered by Orchestra but pointing at another command. '));
    alert.appendChild(el('span', null, 'Claude Code still runs the old one, which may no longer exist.'));
    for (const [label, value] of [['Registered: ', sl.command], ['Expected: ', sl.expected]]) {
      if (!value) continue;
      const row = el('p', 'settings-note');
      row.appendChild(el('span', null, label));
      row.appendChild(el('code', null, value));
      alert.appendChild(row);
    }
    alert.appendChild(el('p', null, 'Reinstall the hooks below to repoint it.'));
    return alert;
  }

  _foreignHooks(list) {
    const box = el('div', 'settings-foreign');
    box.appendChild(el('h4', 'settings-h4', `${list.length} hook${list.length === 1 ? '' : 's'} from something else`));
    box.appendChild(el('p', 'settings-note', 'These are left exactly as they are, by install and by uninstall.'));
    const ul = el('ul', 'settings-foreign-list');
    for (const entry of list) {
      const li = el('li', 'settings-foreign-item');
      li.appendChild(el('span', 'settings-foreign-event', entry.event));
      if (entry.matcher) li.appendChild(el('span', 'settings-foreign-matcher', entry.matcher));
      li.appendChild(el('code', 'settings-foreign-cmd', entry.command));
      ul.appendChild(li);
    }
    box.appendChild(ul);
    return box;
  }

  _hookResult(r) {
    const box = el('div', `settings-alert ${r.ok === false ? 'settings-alert-error' : 'settings-alert-ok'}`);
    box.appendChild(el('p', null, r.message));
    if (r.backup) {
      const bk = el('p', 'settings-note');
      bk.appendChild(el('span', null, 'Backup written to '));
      bk.appendChild(el('code', null, r.backup));
      box.appendChild(bk);
    }
    for (const w of Array.isArray(r.warnings) ? r.warnings : []) {
      box.appendChild(el('p', 'settings-warn', typeof w === 'string' ? w : `${w.code}: ${w.message}`));
    }
    return box;
  }

  /** The Approvals tab reads the same status, so both tabs repaint on a load. */
  async _loadHooks() {
    if (this.hooks.loading) return;
    this.hooks.loading = true;
    this.hooks.error = null;
    this._renderHookTabs();
    try {
      this.hooks.data = await this._request('GET', '/api/hooks/status');
    } catch (e) {
      this.hooks.error = e && e.message ? e.message : String(e);
      this.log.error(`settings: GET /api/hooks/status failed: ${this.hooks.error}`);
    } finally {
      this.hooks.loaded = true;
      this.hooks.loading = false;
      this._renderHookTabs();
    }
  }

  _renderHookTabs() {
    if (this.tab === 'hooks' || this.tab === 'approvals') this._renderPane();
  }

  /**
   * Writes to ~/.claude/settings.json, then reloads the status so the panel
   * shows the file as it now is rather than what was asked for. The route
   * answers HTTP 200 even when it refuses to write, so `ok === false` is the
   * only sign that nothing happened.
   *
   * @param {(res:Object|null) => string} success message for an accepted call
   */
  async _hookWrite(path, body, verb, success) {
    if (this.hooks.busy) return;
    this.hooks.busy = true;
    this.hooks.result = null;
    this._renderPane();
    try {
      const res = await this._request('POST', path, body);
      const refused = !!(res && res.ok === false);
      this.hooks.result = {
        ok: !refused,
        message: refused ? `${verb} refused: ${res.reason || 'unknown reason'}.` : success(res),
        backup: (res && res.backup) || null,
        warnings: (res && res.warnings) || null,
      };
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      this.log.error(`settings: POST ${path} failed: ${message}`);
      this.hooks.result = { ok: false, message, backup: null, warnings: null };
    } finally {
      this.hooks.busy = false;
      await this._loadHooks();
    }
  }

  _installHooks(events) {
    return this._hookWrite('/api/hooks/install', { events }, 'Install', (res) => {
      const installed = Array.isArray(res && res.installed) ? res.installed.length : 0;
      return `Installed ${installed} hook${installed === 1 ? '' : 's'}.`;
    });
  }

  _uninstallHooks() {
    return this._hookWrite(
      '/api/hooks/uninstall',
      {},
      'Uninstall',
      () => 'Orchestra hooks removed. Anything else in settings.json was left alone.',
    );
  }

  _renderApprovals(pane) {
    const section = el('section', 'settings-section');
    section.appendChild(el('h3', 'settings-h3', 'Tool approvals'));
    section.appendChild(el(
      'p',
      'settings-lead',
      'With approvals on, PreToolUse blocks the agent and waits for you. It needs the PreToolUse hook installed.',
    ));

    section.appendChild(this._approvalGate());

    // The deadline belongs to the server: it holds the blocked hook and denies
    // it on expiry. No route changes it, so this is stated rather than offered
    // as an editable box that would quietly do nothing.
    const timeoutNote = el('div', 'settings-field');
    timeoutNote.appendChild(el('span', 'settings-field-label', 'Give up after'));
    const timeoutText = el('p', 'settings-field-hint');
    timeoutText.appendChild(el('span', null, 'Decided by the server, not by this browser. It is set with '));
    timeoutText.appendChild(el('code', null, 'ORCHESTRA_APPROVAL_TIMEOUT'));
    timeoutText.appendChild(el(
      'span',
      null,
      ' (seconds, 300 by default) when Orchestra starts. When it expires the tool call is denied, never allowed,'
      + ' and each pending request shows its own countdown in the approvals view.',
    ));
    timeoutNote.appendChild(timeoutText);
    section.appendChild(timeoutNote);

    const rules = el('div', 'settings-rules');
    rules.appendChild(el('h4', 'settings-h4', 'Standing rules'));
    if (this.approvals.loading) {
      rules.appendChild(el('p', 'settings-note', 'Loading rules...'));
    } else if (this.approvals.error) {
      const err = el('div', 'settings-alert settings-alert-error');
      err.appendChild(el('span', null, this.approvals.error));
      err.appendChild(button('settings-btn', 'Retry', () => this._loadApprovals()));
      rules.appendChild(err);
    } else if (!this.approvals.rules.length) {
      rules.appendChild(el('p', 'settings-note', 'No standing rules. Choosing "always" on a permission creates one here.'));
    } else {
      const ul = el('ul', 'settings-rule-list');
      for (const rule of this.approvals.rules) {
        const li = el('li', `settings-rule is-${rule.decision}`);
        const head = el('div', 'settings-rule-head');
        head.appendChild(el('span', 'settings-rule-decision', rule.decision));
        head.appendChild(el('span', 'settings-rule-tool', rule.tool));
        li.appendChild(head);
        if (rule.pattern) {
          li.appendChild(el('code', 'settings-rule-pattern', rule.exact ? rule.pattern : `${rule.pattern} (pattern)`));
        }
        const meta = el('div', 'settings-rule-meta');
        if (rule.cwd) meta.appendChild(el('code', 'settings-rule-cwd', rule.cwd));
        meta.appendChild(el('span', null, `${rule.hits || 0} use${rule.hits === 1 ? '' : 's'}`));
        meta.appendChild(el('span', null, shortDate(rule.createdAt)));
        li.appendChild(meta);
        li.appendChild(button('settings-btn settings-btn-danger', 'Revoke', () => this._revokeRule(rule.id)));
        ul.appendChild(li);
      }
      rules.appendChild(ul);
    }
    rules.appendChild(button('settings-btn settings-btn-ghost', 'Refresh', () => this._loadApprovals()));
    section.appendChild(rules);

    pane.appendChild(section);
    if (!this.approvals.loaded && !this.approvals.loading) this._loadApprovals();
    if (!this.hooks.loaded && !this.hooks.loading) this._loadHooks();
  }

  /**
   * The blocking PreToolUse hook, as a checkbox. Its state comes from
   * GET /api/hooks/status, never from a stored preference: the hook lives in a
   * file shared by every browser on this machine, so a box remembering its own
   * last click would promise a gate another device had already removed.
   */
  _approvalGate() {
    const box = el('div', 'settings-gate');
    const { wrap, input } = this._checkboxRow(
      'Ask me before a tool runs',
      'The agent is frozen until you answer, or until the server deadline below runs out and the call is denied. '
        + 'Turning this on installs the blocking PreToolUse hook; turning it off removes it.',
    );
    const gate = this.hooks.data ? this.hooks.data.approvals : null;
    input.checked = !!(gate && gate.installed);
    input.disabled = !gate || this.hooks.loading;
    input.addEventListener('change', () => this._setApprovalGate(input));
    box.appendChild(wrap);

    if (this.hooks.loading || !this.hooks.loaded) {
      box.appendChild(el('p', 'settings-note', 'Reading settings.json to see whether the gate is installed...'));
    } else if (this.hooks.error) {
      const err = el('div', 'settings-alert settings-alert-error');
      err.appendChild(el('span', null, `Could not read the hook status: ${this.hooks.error}`));
      err.appendChild(button('settings-btn', 'Retry', () => this._loadHooks()));
      box.appendChild(err);
    } else if (!gate) {
      box.appendChild(el('p', 'settings-note', 'The server returned no hook status, so this cannot be changed from here.'));
    }

    if (this.approvals.gateError) {
      const err = el('div', 'settings-alert settings-alert-error');
      err.appendChild(el('span', null, this.approvals.gateError));
      box.appendChild(err);
    }
    return box;
  }

  /**
   * Installs or removes the gate, then repaints from the server's answer rather
   * than from the click. The route replies HTTP 200 with `ok:false` when it
   * refuses the write, so watching only for a thrown error would report a
   * safeguard that was never written.
   */
  async _setApprovalGate(input) {
    const wanted = input.checked;
    const verb = wanted ? 'install' : 'remove';
    input.disabled = true;
    try {
      const res = await this._request('POST', '/api/hooks/install', { approvals: wanted });
      this.approvals.gateError = res && res.ok === false
        ? `Could not ${verb} the approval hook: ${res.message || res.reason || 'the server refused the write'}`
        : null;
    } catch (err) {
      this.approvals.gateError = `Could not ${verb} the approval hook: ${err.message}`;
    }
    await this._loadHooks();
  }

  async _loadApprovals() {
    if (this.approvals.loading) return;
    this.approvals.loading = true;
    this.approvals.error = null;
    if (this.tab === 'approvals') this._renderPane();
    try {
      const res = await this._request('GET', '/api/approvals');
      this.approvals.rules = Array.isArray(res && res.rules) ? res.rules : [];
    } catch (e) {
      this.approvals.error = e && e.message ? e.message : String(e);
      this.log.error(`settings: GET /api/approvals failed: ${this.approvals.error}`);
    } finally {
      this.approvals.loaded = true;
      this.approvals.loading = false;
      if (this.tab === 'approvals') this._renderPane();
    }
  }

  async _revokeRule(id) {
    try {
      await this._request('DELETE', `/api/approvals/rules/${encodeURIComponent(id)}`);
      this.approvals.rules = this.approvals.rules.filter((r) => r.id !== id);
    } catch (e) {
      this.approvals.error = e && e.message ? e.message : String(e);
      this.log.error(`settings: DELETE /api/approvals/rules/${id} failed: ${this.approvals.error}`);
    }
    if (this.tab === 'approvals') this._renderPane();
  }

  _shortcutMap() {
    const stored = this._pref('shortcuts');
    return validateShortcuts(stored && typeof stored === 'object' ? stored : {}).map;
  }

  _renderShortcuts(pane) {
    const section = el('section', 'settings-section');
    section.appendChild(el('h3', 'settings-h3', 'Keyboard'));
    section.appendChild(el(
      'p',
      'settings-lead',
      `Every shortcut is a prefix followed by one key. The prefix is ${this._pref('shortcutPrefix')}.`
      + ' Nothing here shadows Escape, Ctrl+C, Ctrl+D, Ctrl+R or the other keys a shell needs.',
    ));

    const prefix = el('input', 'settings-combo');
    prefix.type = 'text';
    prefix.readOnly = true;
    prefix.value = this._pref('shortcutPrefix');
    prefix.addEventListener('click', () => this._startRecording('__prefix__'));
    if (this.recording === '__prefix__') {
      prefix.classList.add('is-recording');
      prefix.value = 'press a combo...';
    }
    section.appendChild(field('Prefix', prefix, 'Pick something a terminal does not use. Ctrl+K is the default.'));

    if (this.shortcutErrors.length) {
      const alert = el('div', 'settings-alert settings-alert-error');
      for (const err of this.shortcutErrors) alert.appendChild(el('p', null, err.message));
      section.appendChild(alert);
    }

    const map = this._shortcutMap();
    const list = el('ul', 'settings-shortcuts');
    for (const action of SHORTCUT_ACTIONS) {
      const binding = map[action.id];
      const li = el('li', 'settings-shortcut');
      const label = el('div', 'settings-shortcut-label');
      label.appendChild(el('span', 'settings-shortcut-name', action.label));
      if (action.hint) label.appendChild(el('span', 'settings-field-hint', action.hint));
      li.appendChild(label);

      const combo = el('button', 'settings-combo');
      combo.type = 'button';
      const recording = this.recording === action.id;
      combo.textContent = recording
        ? 'press a key'
        : `${binding.prefix ? `${formatCombo(this._pref('shortcutPrefix'))} ` : ''}${formatCombo(binding.combo)}`;
      if (recording) combo.classList.add('is-recording');
      if (action.id === 'jumpToIndex') {
        combo.disabled = true;
        combo.title = 'Fixed: the prefix followed by a digit.';
      } else {
        combo.addEventListener('click', () => this._startRecording(action.id));
      }
      li.appendChild(combo);
      list.appendChild(li);
    }
    section.appendChild(list);

    const actions = el('div', 'settings-actions');
    actions.appendChild(button('settings-btn settings-btn-ghost', 'Reset to defaults', () => {
      this.shortcutErrors = [];
      this._setPref('shortcuts', defaultShortcuts());
      this._setPref('shortcutPrefix', SHORTCUT_PREFIX);
      this._renderPane();
    }));
    section.appendChild(actions);
    pane.appendChild(section);
  }

  _startRecording(id) {
    this.recording = id;
    this.shortcutErrors = [];
    this._renderPane();
  }

  _finishRecording(combo) {
    const id = this.recording;
    this.recording = null;
    if (!id || !combo) {
      this._renderPane();
      return;
    }
    const normalized = normalizeCombo(combo);

    if (id === '__prefix__') {
      if (isReservedCombo(normalized)) {
        this.shortcutErrors = [{ id, message: `${formatCombo(normalized)} belongs to the terminal and cannot be the prefix.` }];
      } else if (!/\+/.test(normalized)) {
        this.shortcutErrors = [{ id, message: 'The prefix needs a modifier, otherwise it swallows a plain key.' }];
      } else {
        this._setPref('shortcutPrefix', normalized);
      }
      this._renderPane();
      return;
    }

    const map = this._shortcutMap();
    const prefixed = map[id] ? map[id].prefix : true;
    const candidate = { ...map, [id]: { combo: normalized, prefix: prefixed } };
    const check = validateShortcuts(candidate);
    if (!check.ok) {
      this.shortcutErrors = check.errors.filter((e) => e.id === id);
      if (!this.shortcutErrors.length) this.shortcutErrors = check.errors;
      this._renderPane();
      return;
    }
    this.shortcutErrors = [];
    this._setPref('shortcuts', check.map);
    this._renderPane();
  }

  _renderRemote(pane) {
    const section = el('section', 'settings-section');
    section.appendChild(el('h3', 'settings-h3', 'Open on another device'));

    const url = this._remoteUrl();
    const host = typeof location !== 'undefined' ? location.hostname : '';
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';

    const urlBox = el('div', 'settings-url');
    const urlInput = el('input', 'settings-url-input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.value = url;
    urlInput.setAttribute('aria-label', 'Address of this Orchestra');
    urlInput.addEventListener('focus', () => urlInput.select());
    urlBox.appendChild(urlInput);
    const copied = el('span', 'settings-note', '');
    urlBox.appendChild(button('settings-btn', 'Copy', () => {
      this._copy(url).then((ok) => {
        copied.textContent = ok ? 'Copied.' : 'Copy failed, select the field and copy by hand.';
      });
    }));
    urlBox.appendChild(copied);
    section.appendChild(urlBox);

    const qrBox = el('div', 'settings-qr');
    try {
      const matrix = qrEncode(url);
      qrBox.appendChild(qrToSvg(matrix, { size: 220, label: 'QR code for this Orchestra' }));
      qrBox.appendChild(el('p', 'settings-note', `QR version ${matrix.version}, level ${matrix.ecl}. The token is in the link, so treat it like a password.`));
    } catch (e) {
      this.log.warn(`settings: QR encoding failed: ${e && e.message}`);
      qrBox.appendChild(el('p', 'settings-qr-fallback', url));
      qrBox.appendChild(el('p', 'settings-note', `No QR code: ${e && e.message}. Copy the address above instead.`));
    }
    section.appendChild(qrBox);

    const binding = el('div', loopback ? 'settings-alert settings-alert-ok' : 'settings-alert settings-alert-warn');
    if (loopback) {
      binding.appendChild(el('strong', null, 'Bound to loopback.'));
      binding.appendChild(el(
        'p',
        null,
        'Nothing outside this machine can reach it, which also means the QR code will not work from a phone.'
        + ' To change that, start the server with HOST set to the LAN address and ORCHESTRA_ALLOW_REMOTE=1,'
        + ' then reopen this tab on that address.',
      ));
    } else {
      binding.appendChild(el('strong', null, `Reachable on the network as ${host}.`));
      binding.appendChild(el(
        'p',
        null,
        'Anything that can route to this address can try to open a shell here. The token in the link is'
        + ' the only thing standing in the way, the traffic is plain HTTP, and there is no second factor.'
        + ' Use it on a network you trust, and stop the server when you are done.',
      ));
    }
    section.appendChild(binding);

    pane.appendChild(section);
  }

  _remoteUrl() {
    const origin = typeof location !== 'undefined' ? location.origin : '';
    const token = this._token();
    // `?token=` is the spelling Connection reads and then strips from history.
    if (!token) return origin || '';
    return `${origin}/?token=${encodeURIComponent(token)}`;
  }

  _token() {
    const c = this.connection;
    if (c && typeof c.token === 'string' && c.token) return c.token;
    const boot = typeof window !== 'undefined' ? window.__ORCHESTRA__ : null;
    return boot && typeof boot.token === 'string' ? boot.token : '';
  }

  async _copy(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        this.log.warn(`settings: clipboard write failed: ${e && e.message}`);
      }
    }
    return false;
  }

  _pref(key) {
    const store = this.store;
    const fallback = PREF_DEFAULTS[key];
    if (store && typeof store.getPref === 'function') {
      const value = store.getPref(key, fallback);
      return value === undefined || value === null ? fallback : value;
    }
    if (store && store.prefs && Object.prototype.hasOwnProperty.call(store.prefs, key)) {
      return store.prefs[key];
    }
    return fallback;
  }

  _setPref(key, value) {
    const store = this.store;
    if (!store || typeof store.setPref !== 'function') {
      this.log.error(`settings: cannot persist "${key}", the store has no setPref`);
      return;
    }
    store.setPref(key, value);
    applyPreference(key, value);
  }

  async _request(method, path, body) {
    const api = this.api;
    const verb = method.toUpperCase();
    if (api) {
      if (verb === 'GET' && typeof api.get === 'function') return api.get(path);
      if (verb === 'POST' && typeof api.post === 'function') return api.post(path, body);
      if (verb === 'DELETE') {
        const del = api.del || api.delete;
        if (typeof del === 'function') return del.call(api, path);
      }
      if (typeof api.request === 'function') return api.request(verb, path, body);
    }
    const headers = { Accept: 'application/json' };
    const token = this._token();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method: verb,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        if (!res.ok) throw new Error(text.slice(0, 300));
        throw new Error(`unreadable server response: ${e.message}`);
      }
    }
    if (!res.ok) {
      const message = parsed && (parsed.error || parsed.message);
      throw new Error(message || `HTTP ${res.status}`);
    }
    return parsed;
  }
}

export default SettingsPanel;
