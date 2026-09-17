import { h } from '../dom.js';
import { showDialog } from './dialogs.js';

// Fill & Sign: a signature made here — typed, drawn, or imported from a PNG or JPEG — becomes a picture
// on the page (editing/objects/inserted-image.js), so it is real page content: moved, resized, turned,
// deleted, undone and saved like any inserted picture. Nothing is flattened, and it is not a digital
// (certificate) signature.
//
// A typed or drawn signature is ink on a transparent canvas, trimmed to the ink and kept as a PNG at
// DENSITY times the canvas's size on screen, so it stays sharp when it is printed or zoomed.

/** Canvas pixels per CSS pixel of the pad. */
export const DENSITY = 3;

/** How big a pad pixel is on the page, in points: a signature written 300 pixels wide is 150 pt. */
export const POINTS_PER_PIXEL = 0.5 / DENSITY;

/** Transparent margin, in canvas pixels, kept around the ink. */
const MARGIN = 6;

/** Handwriting faces Windows ships; the first one this machine has is the default. */
export const SCRIPT_FONTS = ['Segoe Script', 'Ink Free', 'Lucida Handwriting', 'Gabriola'];

const INK = { black: '#111111', blue: '#1a3f9c' };
const PAD = { width: 480, height: 160 };

/**
 * The box around the ink in RGBA pixels `data` (`width` × `height`), widened by `margin` but kept
 * inside the image: { x, y, width, height }, or null when nothing is drawn.
 */
export function inkBounds(data, width, height, margin = MARGIN) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  const x = Math.max(0, left - margin);
  const y = Math.max(0, top - margin);
  return { x, y, width: Math.min(width, right + 1 + margin) - x, height: Math.min(height, bottom + 1 + margin) - y };
}

/** The canvas's ink, trimmed, as PNG bytes; null when it is blank. */
async function trimmedPng(canvas) {
  const box = inkBounds(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  if (!box) return null;
  const out = h('canvas', { width: box.width, height: box.height });
  out.getContext('2d').drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

function padCanvas() {
  const canvas = h('canvas', { class: 'signature-pad', width: PAD.width * DENSITY, height: PAD.height * DENSITY });
  canvas.style.width = `${PAD.width}px`;
  canvas.style.height = `${PAD.height}px`;
  return canvas;
}

const available = () => SCRIPT_FONTS.filter((f) => document.fonts.check(`32px "${f}"`));

/**
 * Asks for a signature. Resolves with { name, bytes, pointsPerPixel } — a PNG made here, or the
 * imported file's own bytes at the size an inserted picture gets — or null when cancelled or empty.
 */
export async function askForSignature() {
  const fonts = available();
  let place = null;
  const state = { mode: 'type', ink: 'black', font: fonts[0] ?? 'cursive', strokes: 0 };

  const nameInput = h('input', { class: 'field', type: 'text', maxlength: '60', spellcheck: 'false', autocomplete: 'off', placeholder: 'Your name', 'aria-label': 'Signature text' });
  const typeCanvas = padCanvas();
  typeCanvas.setAttribute('aria-hidden', 'true');
  const fontSelect = h('select', { class: 'field signature-font', 'aria-label': 'Handwriting style' },
    ...(fonts.length ? fonts : ['cursive']).map((f) => h('option', { value: f, text: f === 'cursive' ? 'Handwriting' : f })));
  const drawCanvas = padCanvas();
  drawCanvas.setAttribute('aria-label', 'Draw your signature');
  const clearBtn = h('button', { class: 'btn', type: 'button', text: 'Clear' });
  const inkBtns = Object.keys(INK).map((ink) => h('button', {
    class: 'seg-btn', type: 'button', 'data-ink': ink, 'aria-pressed': String(ink === state.ink), text: ink[0].toUpperCase() + ink.slice(1),
  }));
  const inkSeg = h('div', { class: 'seg signature-ink', role: 'group', 'aria-label': 'Ink colour' }, ...inkBtns);
  const note = h('p', { class: 'dialog-note', text: '' });

  const modes = [['type', 'Type'], ['draw', 'Draw'], ['import', 'Import']];
  const tabs = modes.map(([id, label]) => h('button', { class: 'seg-btn', type: 'button', role: 'tab', 'data-mode': id, 'aria-selected': String(id === state.mode), text: label }));
  const tabSeg = h('div', { class: 'seg signature-modes', role: 'tablist', 'aria-label': 'How to sign' }, ...tabs);
  tabSeg.style.setProperty('--seg-count', String(modes.length));

  const typePanel = h('div', { class: 'signature-panel', 'data-panel': 'type' }, nameInput, fontSelect, typeCanvas);
  const drawPanel = h('div', { class: 'signature-panel', 'data-panel': 'draw' }, drawCanvas, h('div', { class: 'signature-row' }, clearBtn));
  const importPanel = h('div', { class: 'signature-panel', 'data-panel': 'import' },
    h('p', { class: 'dialog-message', text: 'Choose a PNG or JPEG of your signature. A PNG with a transparent background looks best.' }));

  const renderTyped = () => {
    const ctx = typeCanvas.getContext('2d');
    ctx.clearRect(0, 0, typeCanvas.width, typeCanvas.height);
    const text = nameInput.value.trim();
    if (!text) return;
    let size = 56 * DENSITY;
    const face = state.font === 'cursive' ? 'cursive' : `"${state.font}"`;
    ctx.font = `${size}px ${face}`;
    const room = typeCanvas.width - 24 * DENSITY;
    const measured = ctx.measureText(text).width;
    if (measured > room) size = Math.floor(size * room / measured);
    ctx.font = `${size}px ${face}`;
    ctx.fillStyle = INK[state.ink];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, typeCanvas.width / 2, typeCanvas.height / 2);
  };

  const recolourDrawing = () => {
    const ctx = drawCanvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = INK[state.ink];
    ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);
    ctx.restore();
  };

  const show = (mode) => {
    state.mode = mode;
    tabs.forEach((t, i) => t.setAttribute('aria-selected', String(modes[i][0] === mode)));
    tabSeg.style.setProperty('--seg-index', String(modes.findIndex(([id]) => id === mode)));
    for (const panel of [typePanel, drawPanel, importPanel]) panel.hidden = panel.dataset.panel !== mode;
    inkSeg.hidden = mode === 'import';
    note.textContent = '';
    if (place) place.textContent = mode === 'import' ? 'Choose picture…' : 'Place signature';
  };

  // Drawing: pointer strokes, smoothed with quadratic curves through the midpoints.
  let last = null;
  const at = (e) => {
    const r = drawCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (drawCanvas.width / r.width), (e.clientY - r.top) * (drawCanvas.height / r.height)];
  };
  const pen = () => {
    const ctx = drawCanvas.getContext('2d');
    ctx.lineWidth = 2.4 * DENSITY;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK[state.ink];
    ctx.fillStyle = INK[state.ink];
    return ctx;
  };
  drawCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drawCanvas.setPointerCapture(e.pointerId);
    last = { point: at(e), mid: at(e) };
    const ctx = pen();
    ctx.beginPath();
    ctx.arc(last.point[0], last.point[1], ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    state.strokes++;
    note.textContent = '';
  });
  drawCanvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const point = at(e);
    const mid = [(last.point[0] + point[0]) / 2, (last.point[1] + point[1]) / 2];
    const ctx = pen();
    ctx.beginPath();
    ctx.moveTo(...last.mid);
    ctx.quadraticCurveTo(...last.point, ...mid);
    ctx.stroke();
    last = { point, mid };
  });
  const lift = () => { last = null; };
  drawCanvas.addEventListener('pointerup', lift);
  drawCanvas.addEventListener('pointercancel', lift);
  clearBtn.addEventListener('click', () => {
    drawCanvas.getContext('2d').clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    state.strokes = 0;
  });

  nameInput.addEventListener('input', renderTyped);
  fontSelect.addEventListener('change', () => { state.font = fontSelect.value; renderTyped(); });
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.mode)));
  inkBtns.forEach((b) => b.addEventListener('click', () => {
    state.ink = b.dataset.ink;
    inkBtns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    inkSeg.style.setProperty('--seg-index', String(inkBtns.indexOf(b)));
    renderTyped();
    recolourDrawing();
  }));
  show(state.mode);

  let result = null;
  await showDialog({
    title: 'Add a signature',
    message: 'The signature is placed on the page as a picture you can move, resize and turn. It isn’t a certificate-based digital signature.',
    iconName: 'pen-line',
    className: 'signature-dialog',
    content: [tabSeg, typePanel, drawPanel, importPanel, inkSeg, note],
    buttons: [],
    onOpen: () => nameInput,
    bind: ({ finish, dialog }) => {
      place = h('button', { class: 'btn primary', type: 'button', text: 'Place signature' });
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel', onClick: () => finish(null) });
      const footer = dialog.querySelector('.dialog-actions');
      footer.hidden = false;
      footer.append(cancel, place);
      show(state.mode);
      // Enter in the name field places it, as a primary button would.
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); place.click(); } });
      place.addEventListener('click', async () => {
        if (place.disabled) return;
        place.disabled = true;
        try {
          result = await signatureOf(state, { typeCanvas, drawCanvas });
          if (result) finish('place');
          else if (state.mode !== 'import') note.textContent = state.mode === 'type' ? 'Type your name first.' : 'Draw your signature first.';
        } catch (err) {
          note.textContent = `That signature couldn’t be used: ${err.message}`;
        } finally {
          place.disabled = false;
        }
      });
    },
  });
  return result;
}

async function signatureOf(state, { typeCanvas, drawCanvas }) {
  if (state.mode === 'import') {
    // Loaded here, not at the top, so inkBounds() can be tested outside the app.
    const { bridge } = await import('../bridge.js');
    const { file } = await bridge.request('pictureDialog', { purpose: 'signature' });
    if (!file) return null;
    return { name: file.name, bytes: base64Bytes(file.data), pointsPerPixel: undefined };
  }
  const bytes = await trimmedPng(state.mode === 'type' ? typeCanvas : drawCanvas);
  return bytes ? { name: 'Signature', bytes, pointsPerPixel: POINTS_PER_PIXEL } : null;
}

function base64Bytes(data) {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
