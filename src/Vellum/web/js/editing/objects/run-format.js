// Formatting text the page already draws: one text run (editing/runs.js), or a pasted copy of one — never
// new text, which has its own format (objects/text-format.js), and never a paragraph as such.
//
// A run is already redrawn after the page's content by the text writer (objects/text-run.js drawText):
// its glyphs are neutralised where they were, and drawn again from a clean graphics state that repeats the
// original's font, size, spacing, colour, colour space and ExtGStates. Formatting changes only that redraw,
// so everything the writer already guarantees still holds — the same font object, the same glyph codes
// (or the retyped text's own encoding), the same widths and spacing, nothing rasterized, nothing embedded,
// the font program never read or changed:
//
//   size       a uniform scale about the run's first glyph origin, composed into the record's `transform`
//              (edits.js): the existing placement, so the baseline start stays put, the glyphs, spacing,
//              rise and adjustments all scale together, and geometry, copies, undo and save already follow
//              it. Nothing new is stored for it.
//   format     { color?, opacity?, underline? } on the record, each field only when it changes something:
//     color      '#rrggbb', written as a DeviceRGB fill (`rg`) in place of the original's fill colour
//     opacity    0.05–1, an ExtGState of its own (/ca and /CA) set after the original's own ExtGStates, so
//                blend mode and the rest of them are kept and only the opacity is replaced
//     underline  true: a filled rule under the drawn text, in its fill colour and opacity, as wide as the
//                glyphs drawn (measured from the same widths the writer draws with), a tenth of an em below
//                the baseline and a twentieth of an em thick, in the text's own text space
//
// Refused, with nothing stored (the reason is said, never guessed around):
//   - a font, bold or italic: another face would re-encode the text in a font the run isn't drawn in
//   - alignment or a wrapping width: a run is one line of the page, not a box
//   - colour or underline of text drawn as an outline (render modes 1 and 2): one fill colour can't say it
//   - colour or opacity in a PDF/A document: device RGB and transparency aren't checked against the standard
//   - anything the run itself refuses (runs.js reasons), and values out of range

import { EditError } from '../edits.js';
import { REASONS } from '../runs.js';
import { multiply, translate } from '../matrix.js';
import { LIMITS } from './text-format.js';
import { similarityScaleOf } from './transform.js';

/** The fields a record's `format` may hold. */
export const RUN_FORMAT_FIELDS = Object.freeze(['color', 'opacity', 'underline']);

/** Where an underline sits and how thick it is, per em (the same rule Vellum draws for a document font). */
export const RUN_UNDERLINE = Object.freeze({ position: -0.1, thickness: 0.05 });

const round = (v, digits) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k || 0;
};

const hex = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/**
 * The fill colour a run's first show sets, as '#rrggbb' — only for DeviceGray and DeviceRGB, which say
 * exactly one colour; black when nothing was set; null for any other colour space (CMYK, calibrated,
 * separations, patterns), which is shown as unknown rather than converted.
 */
export function fillHexOf(show) {
  const { space, color } = show.fill ?? {};
  if (!space && !color) return '#000000';
  if (space || !color) return null;
  const args = color.args.map(Number);
  if (!args.every(Number.isFinite)) return null;
  if (color.op === 'g' && args.length === 1) return `#${hex(args[0]).repeat(3)}`;
  if (color.op === 'rg' && args.length === 3) return `#${args.map(hex).join('')}`;
  return null;
}

/** A run's size as the page draws it now: its size in user space, times the uniform scale of `transform`. */
export const runSizeOf = (run, transform = null) => run.frame.size * (transform ? similarityScaleOf(transform) ?? 1 : 1);

/**
 * How a run reads now, for a format bar: { size, color, opacity, underline, outlined }, `record` its edit
 * record (a text or text-copy record) if it has one. `color` is null where the page's colour isn't a plain
 * device grey or RGB; `opacity` null where fill and stroke differ on outlined text.
 */
export function runFormatOf(run, record = null) {
  const show = run.first;
  const own = record?.format ?? {};
  const tr = show.tr;
  const opacity = tr === 1 ? show.CA : tr === 2 && show.ca !== show.CA ? null : show.ca;
  return Object.freeze({
    size: round(runSizeOf(run, record?.transform ?? null), 1),
    color: own.color ?? fillHexOf(show),
    opacity: own.opacity ?? (typeof opacity === 'number' ? round(opacity, 2) : null),
    underline: own.underline === true,
    outlined: tr === 1 || tr === 2,
  });
}

/**
 * Why `format` can't be written for `run`, or null when it can: the one check the planner and the writer
 * both make. `pdfa` says the document claims PDF/A.
 */
export function runFormatRefusal(run, format, { pdfa = false } = {}) {
  if (format === undefined || format === null) return null;
  if (typeof format !== 'object' || Array.isArray(format)) return 'content';
  for (const key of Object.keys(format)) if (!RUN_FORMAT_FIELDS.includes(key)) return 'content';
  const { color, opacity, underline } = format;
  if (color !== undefined && !(typeof color === 'string' && /^#[0-9a-f]{6}$/.test(color))) return 'content';
  if (opacity !== undefined && !(Number.isFinite(opacity) && opacity >= LIMITS.opacity[0] && opacity <= LIMITS.opacity[1])) return 'content';
  if (underline !== undefined && underline !== true) return 'content';
  if ((color !== undefined || underline) && run.first.tr !== 0) return 'outlined';
  if (pdfa && (color !== undefined || opacity !== undefined)) return 'pdfa';
  return null;
}

const MESSAGES = {
  content: 'That formatting couldn’t be used, so nothing was changed.',
  outlined: 'This text is drawn as an outline, so its colour and underline can’t be changed as one fill, and nothing was changed.',
  pdfa: 'This PDF follows the PDF/A archiving standard. Vellum doesn’t check a new colour or transparency against it, so nothing was changed.',
  font: 'The font of text the PDF already draws can’t be changed yet: Vellum would have to write it in a font it isn’t drawn in. Nothing was changed.',
  box: 'Text the PDF already draws is a line of the page, not a text box, so it can’t be aligned or wrapped. Nothing was changed.',
  size: 'That text size couldn’t be used, so nothing was changed.',
  range: 'Part of a line of the page’s own text can’t be formatted on its own yet, so nothing was changed.',
};

/** The EditError for a refusal key of this module. */
export const runFormatError = (reason, detail = {}) => new EditError(reason === 'pdfa' ? 'pdfa' : 'format', MESSAGES[reason] ?? MESSAGES.content, { reason, ...detail });

/**
 * `changes` — any of size (points, as the page shows it), color, opacity and underline — applied to the
 * run `record` draws (a text or text-copy record, or null for a run with none): { format, transform }, the
 * record's new `format` (null: none) and its new absolute `transform` (unchanged unless the size changed),
 * or EditError. The caller writes them through the record's own planner (session.js), which quantizes and
 * checks the transform as for any move, and drops a text record that no longer says anything.
 */
export function planRunFormat({ run, record = null, changes, pdfa = false }) {
  if (!run?.editable) throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported' });
  if (!changes || typeof changes !== 'object') throw runFormatError('content');
  if (['family', 'bold', 'italic', 'font'].some((k) => changes[k] !== undefined)) throw runFormatError('font');
  if (['align', 'width'].some((k) => changes[k] !== undefined)) throw runFormatError('box');
  const now = runFormatOf(run, record);
  const format = { ...(record?.format ?? {}) };
  const show = run.first;
  if (changes.color !== undefined) {
    const color = typeof changes.color === 'string' ? changes.color.toLowerCase() : changes.color;
    if (color === fillHexOf(show)) delete format.color;
    else format.color = color;
  }
  if (changes.opacity !== undefined) {
    const opacity = Number.isFinite(changes.opacity) ? round(changes.opacity, 2) : changes.opacity;
    const own = show.tr === 0 ? show.ca : show.ca === show.CA ? show.ca : null;
    if (opacity === own) delete format.opacity;
    else format.opacity = opacity;
  }
  if (changes.underline !== undefined) {
    if (typeof changes.underline !== 'boolean') throw runFormatError('content');
    if (changes.underline) format.underline = true;
    else delete format.underline;
  }
  const reason = runFormatRefusal(run, format, { pdfa });
  if (reason) throw runFormatError(reason);

  let transform = record?.transform ?? null;
  if (changes.size !== undefined) {
    const size = Number.isFinite(changes.size) ? round(changes.size, 2) : NaN;
    if (!(size >= LIMITS.size[0] && size <= LIMITS.size[1]) || !(now.size > 0)) throw runFormatError('size');
    const factor = size / runSizeOf(run, transform);
    if (Math.abs(factor - 1) > 1e-6) {
      const [ox, oy] = run.origin;
      const scale = multiply(multiply(translate(-ox, -oy), [factor, 0, 0, factor, 0, 0]), translate(ox, oy));
      transform = multiply(scale, transform ?? [1, 0, 0, 1, 0, 0]);
    }
  }
  return { format: Object.keys(format).length ? format : null, transform };
}

/** `record` with `format` in it — or without one, when `format` is null. */
export function withRunFormat(record, format) {
  const next = { ...record };
  if (format) next.format = { ...format };
  else delete next.format;
  return next;
}
