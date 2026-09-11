// Tiny DOM helpers so UI code stays declarative without a framework.

/** h('button', { class: 'x', onClick: fn, text: 'Hi' }, child, ...) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

/** True when keyboard input should go to a text field rather than to app shortcuts. */
export function isEditable(target) {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

export function truncate(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];

const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** "3 hours ago", "yesterday", "just now"; compact: "5m ago", "2h ago", "3d ago", "4 Sep". */
export function timeAgo(iso, { compact = false } = {}) {
  const seconds = (new Date(iso) - Date.now()) / 1000;
  if (compact) {
    const age = -seconds;
    if (age < 60) return 'just now';
    if (age < 3600) return `${Math.round(age / 60)}m ago`;
    if (age < 86400) return `${Math.round(age / 3600)}h ago`;
    if (age < 7 * 86400) return `${Math.round(age / 86400)}d ago`;
    return shortDate.format(new Date(iso));
  }
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** How a shortcut is shown: "Ctrl+Shift+T", "→", "Page Down". */
export function prettyKeys(combo) {
  const names = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓', PageDown: 'Page Down', PageUp: 'Page Up', Delete: 'Del' };
  return combo.split('+').map((k) => names[k] ?? k).join('+');
}

/** Tooltip text for a command, e.g. "Zoom in (Ctrl++)". */
export function commandTitle(command) {
  const hint = command.hint ?? command.keys?.[0];
  return hint ? `${command.label} (${hint})` : command.label;
}
