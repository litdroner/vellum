import { isEditable } from './dom.js';

// Keyboard combos are named from the physical key (e.code), so "Ctrl+=" works the same
// with or without Shift held and on the numpad.

const CODE_NAMES = {
  Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-', BracketLeft: '[', BracketRight: ']',
  Comma: ',', Period: '.', Slash: '/', Backquote: '`', Space: 'Space', NumpadEnter: 'Enter',
};

// Used when a keyboard event has no physical key code (synthetic input, some remote-desktop and
// on-screen keyboards): fall back to the character it produced.
const KEY_NAMES = { '+': '=', _: '-', ' ': 'Space' };

export function comboFromEvent(e) {
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (e.code) key = CODE_NAMES[e.code] ?? e.key;
  else key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

// Arrows, Home and End move within an open menu, and within tabs reached from the keyboard; there
// they aren't page navigation. A tab just clicked with the mouse isn't :focus-visible and leaves them to the page.
const WIDGET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
function widgetKeeps(e, combo) {
  if (!WIDGET_KEYS.has(combo) || !(e.target instanceof Element)) return false;
  return e.target.closest('.menu') !== null || (e.target.matches('[role="tab"]') && e.target.matches(':focus-visible'));
}

export function installShortcuts(commands) {
  // Several commands may share a key (Delete: a selected annotation, or the selected pages);
  // the first one whose `when` applies wins.
  const byCombo = new Map();
  for (const command of Object.values(commands)) {
    for (const combo of command.keys ?? []) {
      if (!byCombo.has(combo)) byCombo.set(combo, []);
      byCombo.get(combo).push(command);
    }
  }

  window.addEventListener('keydown', (e) => {
    // A window with keys of its own (Compare) is open over the documents: they aren't the target.
    if (document.querySelector('[data-own-keys]')) return;
    const editing = isEditable(e.target);
    const combo = comboFromEvent(e);
    if (widgetKeeps(e, combo)) return;
    const command = byCombo.get(combo)
      ?.find((c) => (!editing || c.global) && (!c.when || c.when(e)));
    if (!command) return;
    e.preventDefault();
    e.stopPropagation();
    command.run(e);
  }, true);
}
