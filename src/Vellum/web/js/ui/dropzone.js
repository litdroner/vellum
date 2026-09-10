import { h } from '../dom.js';
import { icon } from '../icons.js';

// Drag files from Explorer onto the window. Shows an overlay while dragging and hands the dropped
// File objects to onFiles (the host turns them into real paths).
// Zones take over drops on part of the window (the page thumbnails insert pages instead of opening
// tabs): { accepts(e), over(e), leave(), drop(files, e) }.

export function installDropZone({ onFiles, zones = [] }) {
  const overlay = h('div', { class: 'drop-overlay ui', hidden: true, 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' },
      h('span', { html: icon('file-plus', 34) }),
      h('strong', { text: 'Drop to open' }),
      h('span', { text: 'Each PDF opens in its own tab' })));
  document.getElementById('overlay-root').append(overlay);

  let depth = 0;
  let activeZone = null;
  const carriesFiles = (e) => e.dataTransfer?.types?.includes('Files');
  const setZone = (zone) => {
    if (zone === activeZone) return;
    activeZone?.leave();
    activeZone = zone;
    overlay.classList.toggle('zoned', Boolean(zone));
  };
  const hide = () => {
    depth = 0;
    setZone(null);
    overlay.classList.remove('open');
    overlay.hidden = true;
  };

  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('open'));
  });
  window.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault(); // without this the browser would navigate to the file
    e.dataTransfer.dropEffect = 'copy';
    setZone(zones.find((z) => z.accepts(e)) ?? null);
    activeZone?.over(e);
  });
  window.addEventListener('dragleave', (e) => {
    if (!carriesFiles(e)) return;
    if (--depth <= 0) hide();
  });
  window.addEventListener('drop', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    const zone = zones.find((z) => z.accepts(e));
    const files = [...e.dataTransfer.files];
    hide();
    if (zone) zone.drop(files, e);
    else onFiles(files);
  });
}
