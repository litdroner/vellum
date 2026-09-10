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

export function installShortcuts(commands) {
  const byCombo = new Map();
  for (const command of Object.values(commands)) {
    for (const combo of command.keys ?? []) byCombo.set(combo, command);
  }

  window.addEventListener('keydown', (e) => {
    const command = byCombo.get(comboFromEvent(e));
    if (!command) return;
    if (isEditable(e.target) && !command.global) return;
    if (command.when && !command.when(e)) return;
    e.preventDefault();
    e.stopPropagation();
    command.run(e);
  }, true);
}
