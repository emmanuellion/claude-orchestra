/**
 * DOM helpers with no innerHTML path for data.
 *
 * Session names and directory paths echoed from the PTY are attacker-shaped
 * markup if they ever reach innerHTML, so everything here goes through
 * createElement/textContent and there is deliberately no `html` prop: a view
 * that wants markup has to build nodes.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Keys assigned as DOM properties instead of attributes. Everything else goes
 * through setAttribute, which avoids writing to a read-only property (a
 * TypeError in module strict mode).
 */
const PROPERTY_KEYS = new Set([
  'value',
  'checked',
  'indeterminate',
  'selected',
  'disabled',
  'readOnly',
  'multiple',
  'hidden',
  'draggable',
  'spellcheck',
  'tabIndex',
  'scrollTop',
  'scrollLeft',
  'contentEditable',
  'textContent',
]);

function isNode(v) {
  return !!v && typeof v === 'object' && typeof v.nodeType === 'number';
}

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }
  if (isNode(child)) {
    parent.appendChild(child);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

function applyClass(el, value) {
  if (value === null || value === undefined || value === false) return;
  if (Array.isArray(value)) {
    const names = value.filter(Boolean).map(String);
    if (names.length) el.setAttribute('class', names.join(' '));
    return;
  }
  if (typeof value === 'object') {
    const names = Object.keys(value).filter(k => value[k]);
    if (names.length) el.setAttribute('class', names.join(' '));
    return;
  }
  el.setAttribute('class', String(value));
}

function camelToKebab(s) {
  return s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
}

function applyStyle(el, value) {
  if (!value) return;
  if (typeof value === 'string') {
    el.style.cssText = value;
    return;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || raw === false) continue;
    const v = String(raw);
    if (key.startsWith('--')) el.style.setProperty(key, v);
    else el.style.setProperty(camelToKebab(key), v);
  }
}

function applyListener(el, key, value) {
  // onClick and onclick both become "click"; onDoubleClick becomes
  // "doubleclick", not "dblclick", so spell DOM event names as they are.
  const type = key.slice(2).toLowerCase();
  if (typeof value === 'function') {
    el.addEventListener(type, value);
    return;
  }
  if (value && typeof value === 'object' && typeof value.handler === 'function') {
    const { handler, ...opts } = value;
    el.addEventListener(type, handler, opts);
    return;
  }
  if (value === null || value === undefined || value === false) return;
  console.warn(`dom.h: ignoring "${key}", expected a function or {handler, ...options}`);
}

function applyProp(el, key, value) {
  if (value === null || value === undefined) return;
  if (key === 'class' || key === 'className') return applyClass(el, value);
  if (key === 'style') return applyStyle(el, value);
  if (key === 'text') {
    el.textContent = value === false ? '' : String(value);
    return;
  }
  if (key === 'dataset') {
    if (typeof value !== 'object') {
      console.warn('dom.h: "dataset" expects an object');
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === false) continue;
      el.dataset[k] = String(v);
    }
    return;
  }
  if (key === 'ref') {
    if (typeof value === 'function') value(el);
    else console.warn('dom.h: "ref" expects a function');
    return;
  }
  if (key === 'html' || key === 'innerHTML') {
    console.warn('dom.h: innerHTML is not supported, build nodes instead');
    return;
  }
  if (key.length > 2 && key.startsWith('on')) return applyListener(el, key, value);
  if (PROPERTY_KEYS.has(key)) {
    el[key] = value;
    return;
  }
  if (value === false) {
    el.removeAttribute(key);
    return;
  }
  el.setAttribute(key, value === true ? '' : String(value));
}

/**
 * Builds an element.
 *
 *   h('div', {class: 'row', dataset: {id}, onClick: fn}, h('span', {text: name}))
 *
 * Recognised props: class/className, dataset, style (object or cssText string),
 * text (textContent), ref, on* handlers; anything else becomes an attribute.
 * null/undefined values are skipped, `false` removes.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props && typeof props === 'object' && !isNode(props) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) applyProp(el, key, value);
  } else if (props !== null && props !== undefined) {
    // Called as h('div', child, child): treat the second argument as a child.
    appendChild(el, props);
  }
  for (const child of children) appendChild(el, child);
  return el;
}

/**
 * Builds an inline icon from one or more `d` attributes.
 *
 * @param {string|string[]} pathData
 * @param {{viewBox?:string, class?:string, size?:number, stroke?:string,
 *          fill?:string, strokeWidth?:number, title?:string}} [opts]
 */
export function svg(pathData, opts = {}) {
  const {
    viewBox = '0 0 24 24',
    class: className,
    size,
    stroke = 'currentColor',
    fill = 'none',
    strokeWidth = 1.8,
    title,
  } = opts;

  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('fill', fill);
  root.setAttribute('stroke', stroke);
  root.setAttribute('stroke-width', String(strokeWidth));
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  if (className) root.setAttribute('class', className);
  if (size) {
    root.setAttribute('width', String(size));
    root.setAttribute('height', String(size));
  }
  if (title) {
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = String(title);
    root.appendChild(t);
    root.setAttribute('role', 'img');
  } else {
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('focusable', 'false');
  }

  const list = Array.isArray(pathData) ? pathData : [pathData];
  for (const d of list) {
    if (!d) continue;
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', String(d));
    root.appendChild(p);
  }
  return root;
}

/** Removes every child of `el`. Returns `el`. */
export function clear(el) {
  if (!el) return el;
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * addEventListener that hands back its own undo, so a view that re-renders can
 * drop the listeners it registered instead of stacking a new set on each pass.
 *
 * @returns {() => void} idempotent unsubscribe
 */
export function on(el, event, handler, opts) {
  if (!el || typeof el.addEventListener !== 'function') {
    console.warn(`dom.on: no event target for "${event}"`);
    return () => {};
  }
  if (typeof handler !== 'function') {
    console.warn(`dom.on: handler for "${event}" is not a function`);
    return () => {};
  }
  el.addEventListener(event, handler, opts);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    el.removeEventListener(event, handler, opts);
  };
}

/**
 * A bag of teardown functions. Views collect their listeners, timers and store
 * subscriptions here and call dispose() when they are replaced.
 */
export class Disposables {
  constructor() {
    /** @type {Array<() => void>} */
    this._items = [];
    this._disposed = false;
  }

  /**
   * @param {(() => void)|{dispose:() => void}} item
   * @returns the same item, for chaining
   */
  add(item) {
    if (!item) return item;
    const fn = typeof item === 'function'
      ? item
      : (typeof item.dispose === 'function' ? () => item.dispose() : null);
    if (!fn) {
      console.warn('Disposables.add: expected a function or an object with dispose()');
      return item;
    }
    if (this._disposed) {
      // Already torn down: run it now rather than leak it.
      fn();
      return item;
    }
    this._items.push(fn);
    return item;
  }

  /** Registers a listener and returns its unsubscribe. */
  listen(el, event, handler, opts) {
    const off = on(el, event, handler, opts);
    this.add(off);
    return off;
  }

  /** Runs every teardown, newest first. Safe to call twice. */
  dispose() {
    this._disposed = true;
    const items = this._items;
    this._items = [];
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i]();
      } catch (err) {
        console.error('Disposables.dispose: teardown threw', err);
      }
    }
  }
}

/** Alias for `h`. Some views read better as `el('div', ...)`. */
export const el = h;
