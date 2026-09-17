import { h, clamp } from '../dom.js';
import { icon } from '../icons.js';

// Popup menus (context menu, zoom menu). One open at a time.
// items: [{ label, icon?, swatch?, font?, weight?, italic?, shortcut?, checked?, disabled?, action }] or '-' for a
// separator. `font` is a CSS font stack the label is shown in, so a font menu previews its fonts; `weight`
// and `italic` pick the face of that font it is shown in.

let current = null;

export function openMenu(items, { x = 0, y = 0, anchor = null, align = 'start', className = '' } = {}) {
  closeMenu();
  const menu = h('div', { class: `menu ui ${className}`, role: 'menu', tabindex: '-1' });

  for (const item of items) {
    if (item === '-') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (item.heading) {
      // A section's name over the items that follow it: not an item, never focused or clicked.
      menu.append(h('div', { class: 'menu-heading', role: 'presentation', text: item.heading }));
      continue;
    }
    const button = h('button', {
      class: 'menu-item',
      role: item.checked != null ? 'menuitemradio' : 'menuitem',
      'aria-checked': item.checked != null ? String(Boolean(item.checked)) : null,
      disabled: item.disabled,
    },
    h('span', {
      class: 'menu-icon',
      html: item.swatch
        ? `<span class="menu-swatch" style="background:${item.swatch}"></span>`
        : item.icon ? icon(item.icon, 16) : item.checked ? icon('check', 16) : '',
    }),
    h('span', { class: 'menu-label', text: item.label, style: item.font ? { fontFamily: item.font, fontWeight: item.weight ?? '', fontStyle: item.italic ? 'italic' : '' } : null }),
    item.shortcut ? h('span', { class: 'menu-shortcut', text: item.shortcut }) : null);
    // Keep the PDF text selection alive while clicking (needed for Copy).
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      closeMenu();
      item.action?.();
    });
    menu.append(button);
  }

  document.getElementById('overlay-root').append(menu);

  const box = menu.getBoundingClientRect();
  let left;
  let top;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = align === 'end' ? a.right - box.width : align === 'center' ? a.left + a.width / 2 - box.width / 2 : a.left;
    top = a.bottom + 6;
    if (top + box.height > innerHeight - 8) top = a.top - box.height - 6;
  } else {
    left = x + box.width > innerWidth - 8 ? x - box.width : x;
    top = y + box.height > innerHeight - 8 ? y - box.height : y;
  }
  left = clamp(left, 8, innerWidth - box.width - 8);
  top = clamp(top, 8, innerHeight - box.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // Grow out of the pointer (or the anchor), not out of the menu's corner.
  menu.style.transformOrigin = anchor
    ? `${anchor.getBoundingClientRect().left + anchor.offsetWidth / 2 - left}px ${top > anchor.getBoundingClientRect().top ? 0 : box.height}px`
    : `${x - left}px ${y - top}px`;
  menu.focus({ preventScroll: true });

  const buttons = () => [...menu.querySelectorAll('.menu-item:not(:disabled)')];
  const onKey = (e) => {
    const list = buttons();
    const index = list.indexOf(document.activeElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown') list[(index + 1) % list.length]?.focus();
    else if (e.key === 'ArrowUp') list[(index - 1 + list.length) % list.length]?.focus();
    else if (e.key === 'Home') list[0]?.focus();
    else if (e.key === 'End') list.at(-1)?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onPointerDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  const onBlur = () => closeMenu();

  menu.addEventListener('keydown', onKey);
  // Deferred so the click that opened the menu doesn't immediately close it; not once it has closed, or
  // the listener would outlive it and close the next menu opened on the first press inside it.
  setTimeout(() => { if (current?.menu === menu) document.addEventListener('pointerdown', onPointerDown, true); });
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);

  current = {
    menu,
    cleanup() {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    },
  };
  requestAnimationFrame(() => menu.classList.add('open'));
  return menu;
}

export function closeMenu() {
  if (!current) return;
  current.cleanup();
  current.menu.remove();
  current = null;
}
