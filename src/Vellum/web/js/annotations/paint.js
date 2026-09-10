import { underlineSegments } from './geometry.js';

// Draws annotations onto a canvas (used when printing). Same geometry as the on-screen SVG layer.

function traceInk(ctx, p) {
  ctx.moveTo(p[0], p[1]);
  if (p.length === 2) { ctx.lineTo(p[0] + 0.01, p[1]); return; }
  if (p.length === 4) { ctx.lineTo(p[2], p[3]); return; }
  for (let i = 2; i < p.length - 2; i += 2) {
    ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
  }
  ctx.lineTo(p.at(-2), p.at(-1));
}

export function drawNoteIcon(ctx, color) {
  // Drawn in a y-down 20×20 box.
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(40, 30, 20, .6)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(1, 1, 18, 18, 3);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(40, 30, 20, .7)';
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(5, 7); ctx.lineTo(15, 7);
  ctx.moveTo(5, 10.5); ctx.lineTo(15, 10.5);
  ctx.moveTo(5, 14); ctx.lineTo(11.5, 14);
  ctx.stroke();
}

/** viewport: a pdf.js PageViewport for the canvas (maps PDF user space to canvas pixels). */
export function paintAnnotations(ctx, annotations, viewport) {
  if (!annotations.length) return;
  ctx.save();
  ctx.transform(...viewport.transform);
  for (const a of annotations) {
    ctx.save();
    switch (a.type) {
      case 'highlight':
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = a.color;
        ctx.beginPath();
        for (const q of a.quads) {
          ctx.moveTo(q[0], q[1]);
          ctx.lineTo(q[2], q[3]);
          ctx.lineTo(q[6], q[7]);
          ctx.lineTo(q[4], q[5]);
          ctx.closePath();
        }
        ctx.fill();
        break;
      case 'underline':
        ctx.strokeStyle = a.color;
        for (const s of underlineSegments(a.quads)) {
          ctx.lineWidth = s.width;
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        }
        break;
      case 'ink':
        ctx.strokeStyle = a.color;
        ctx.lineWidth = a.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (const p of a.paths) traceInk(ctx, p);
        ctx.stroke();
        break;
      case 'note':
        ctx.translate(a.point[0], a.point[1]);
        ctx.scale(1, -1);
        drawNoteIcon(ctx, a.color);
        break;
    }
    ctx.restore();
  }
  ctx.restore();
}
