// Setting a whole line of the page's own text — a run (editing/runs.js), or a pasted copy of one — in
// another face of its own font family that the SAME document already has: regular, bold, italic, bold
// italic. Never new text, which has its own fonts (objects/font-set.js), and never part of a line.
//
//   face   { font: 'doc:<object>-<generation>', bold, italic, glyphs: { character: [code, byteLength, width] } }
//          on a text or text-copy record whose encoding is 'original': the run is redrawn by the text writer
//          (objects/text-run.js) exactly as a moved run is — from its first glyph's placement, its own
//          size, spacing, colour and ExtGStates, the gaps between its glyphs, the record's transform —
//          only with the sibling font object in place of its own, and each glyph's character drawn with
//          the code and width pdf.js confirmed that font draws it with (the document's own fonts, font-set.js).
//          A space that font hasn't been seen to draw is [null, 0, width], as for new text in it: no glyph, a
//          gap as wide as its space (with the line's own character and word spacing, as the space had).
//
// A sibling is the face of the run's family the document's font set lists (font-set.js documentFontSet:
// the same family name, bold and italic from the font itself). The face must be an embedded font of the
// opened file, confirmed by pdf.js, with a confirmed glyph for EVERY character the line draws; one glyph
// that stands for several characters (a ligature) isn't matched to anything. Nothing is guessed, nothing
// is re-encoded, the font program is never read or changed. The writer checks the table against the font
// object again before drawing (font-set.js checkedDocumentFaces), and that every glyph of the run is in it.
//
// Another family works the same way (session formatText { family }): a face of a family of the SAME document's
// own fonts, in the style the line reads in now, with every character of the line confirmed in it. The
// document's families are the only ones offered; the standard and bundled fonts are never used for it.
//
// `bold` and `italic` are what the record says the line reads as, for the format bar; the writer doesn't
// rely on them. Back in the run's own style, the face goes: the run is drawn in its own font again.
//
// Another face has other widths, so the line gets longer or shorter from its baseline start (nothing else
// moves). The session refuses the change when the line would then newly cover something else on the page,
// or leave the page or the shape clipping it (faceQuadOf gives where it would be; objects/overlap.js
// judges it).

import { EditError } from '../edits.js';
import { REASONS } from '../runs.js';
import { multiply } from '../matrix.js';
import { documentFamilyOf } from './font-set.js';
import { documentKey } from './text-format.js';

const MESSAGES = {
  content: 'That font change couldn’t be used, so nothing was changed.',
  source: 'This text isn’t in the opened PDF itself, so it can only be set in its own font. Nothing was changed.',
  font: 'Text the PDF already draws can only be set in fonts this PDF has itself. Nothing was changed.',
  family: 'This PDF doesn’t have that font, so nothing was changed.',
  face: (style) => `This PDF doesn’t have a ${style} face of that font that Vellum has seen it draw, so nothing was changed.`,
  glyphs: (missing) => `The ${missing.style} face of this font in the PDF hasn’t been seen drawing ${missing.list}, so this line can’t be set in it. Nothing was changed.`,
  ligature: 'This line draws several letters as one glyph, which can’t be matched in another face, so nothing was changed.',
  retyped: 'This line has been retyped, so it can only be set in its own font. Nothing was changed.',
  retype: 'This line is set in another face of its font, so it can’t be retyped. Set it back first. Nothing was changed.',
  overlap: 'In that face the line would be wider and run into something else on the page, so nothing was changed.',
  bounds: 'In that face the line would be wider and go past the edge of the page or the area it is shown in, so nothing was changed.',
};

const styleName = ({ bold, italic }) => (bold && italic ? 'bold italic' : bold ? 'bold' : italic ? 'italic' : 'regular');
const listOf = (chars) => chars.map((ch) => (ch === ' ' ? 'a space' : `“${ch}”`)).join(', ');

/** The EditError for a refusal key of this module. */
export function runFaceError(reason, detail = {}) {
  const message = MESSAGES[reason] ?? MESSAGES.content;
  const text = typeof message === 'function' ? message(reason === 'glyphs' ? { style: detail.style, list: listOf(detail.missing) } : detail.style) : message;
  return new EditError('font', text, { reason, ...detail });
}

/** How a run reads now: { bold, italic } — its record's face, or its own font's. */
export function runStyleOf(run, record = null) {
  if (record?.face) return { bold: record.face.bold, italic: record.face.italic };
  return { bold: Boolean(run.font?.flags?.bold), italic: Boolean(run.font?.flags?.italic) };
}

/**
 * The id of the family of the document's own fonts (font-set.js documentFontSet) a run reads in now: its
 * record's face's family, as `fonts` lists it, or its own font's. null when it can't be told.
 */
export function runFamilyOf(run, record = null, fonts = null) {
  if (record?.face) return fonts?.families?.find((f) => f.faces?.includes(record.face.font))?.id ?? null;
  return run?.font?.name ? documentFamilyOf(run.font) : null;
}

/** Why `face` can't be on a record, or null: its shape only (the writer checks it against the file). */
export function runFaceRefusal(face) {
  if (face === undefined || face === null) return null;
  if (typeof face !== 'object' || Array.isArray(face) || !documentKey(face.font)) return 'content';
  if (typeof face.bold !== 'boolean' || typeof face.italic !== 'boolean') return 'content';
  const { glyphs } = face;
  if (!glyphs || typeof glyphs !== 'object' || Array.isArray(glyphs) || !Object.keys(glyphs).length) return 'content';
  for (const [ch, entry] of Object.entries(glyphs)) {
    if ([...ch].length !== 1 || !Array.isArray(entry) || entry.length !== 3) return 'content';
    const [code, length, width] = entry;
    if (code === null && ch === ' ' && length === 0 && width > 0 && width <= 2000) continue;
    if (!Number.isInteger(code) || !Number.isInteger(length) || length < 1 || length > 4 || !(width > 0)) return 'content';
  }
  return null;
}

/**
 * The table entry each glyph of `run` is drawn with in a face (`table`, as a face record holds it), in the
 * run's glyph order — or { missing } with the characters the table hasn't got, or { ligature: true } when
 * a glyph is more than one character.
 */
export function faceGlyphsOf(analysis, run, table) {
  const entries = [];
  const missing = new Set();
  for (const [si, gi] of run.glyphs) {
    const ch = analysis.shows[si]?.glyphs[gi]?.unicode;
    if (typeof ch !== 'string' || [...ch].length !== 1) return { ligature: true };
    const entry = Object.hasOwn(table, ch) ? table[ch] : null;
    const gap = ch === ' ' && Array.isArray(entry) && entry[0] === null && entry[2] > 0;
    if (!Array.isArray(entry) || !(Number.isInteger(entry[0]) || gap)) missing.add(ch);
    else entries.push(entry);
  }
  return missing.size ? { missing: [...missing] } : { entries };
}

/**
 * The face `changes` ({ bold?, italic?, family? }) asks for, for `run` as `record` (its text or text-copy record, or
 * null) has it: the record's new `face`, or null for the run's own font. `analysis` is the page the run is
 * read from; `fonts` the document's font set (font-set.js withDocumentFonts); `models` the opened PDF's own
 * FontModels (editing/source.js PdfSource.fonts), which the run's font must be one of. EditError when it
 * can't be done.
 */
export function planRunFace({ run, record = null, analysis, changes, fonts, models }) {
  if (!run?.editable) throw new EditError('not-editable', REASONS.unsupported, { reason: 'unsupported' });
  if (changes.family !== undefined && !(typeof changes.family === 'string' && changes.family.startsWith('doc:'))) throw runFaceError('font');
  const now = runStyleOf(run, record);
  const want = { bold: changes.bold ?? now.bold, italic: changes.italic ?? now.italic };
  if (typeof want.bold !== 'boolean' || typeof want.italic !== 'boolean') throw runFaceError('content');
  const own = run.font;
  const ownFamily = runFamilyOf(run);
  const nowFamily = runFamilyOf(run, record, fonts) ?? ownFamily;
  const wantFamily = changes.family ?? nowFamily;
  if (want.bold === now.bold && want.italic === now.italic && wantFamily === nowFamily) return record?.face ?? null;
  if (record && record.encoding?.mode !== 'original') throw runFaceError('retyped');
  if (wantFamily === ownFamily && want.bold === Boolean(own?.flags?.bold) && want.italic === Boolean(own?.flags?.italic)) return null;
  if (!own?.key || !models || models.get(own.key) !== own) throw runFaceError('source');
  const family = fonts?.families?.find((f) => f.id === wantFamily && f.group === 'document');
  if (!family && changes.family !== undefined) throw runFaceError('family');
  const key = family?.faces?.[(want.bold ? 1 : 0) + (want.italic ? 2 : 0)] ?? null;
  const face = documentKey(key) ? fonts.face(key) : null;
  if (!face?.document) throw runFaceError('face', { style: styleName(want) });
  const chars = [];
  for (const [si, gi] of run.glyphs) chars.push(analysis.shows[si]?.glyphs[gi]?.unicode ?? '');
  const table = face.glyphs(chars.join(''));
  const found = faceGlyphsOf(analysis, run, table);
  if (found.ligature) throw runFaceError('ligature');
  if (found.missing) throw runFaceError('glyphs', { style: styleName(want), missing: found.missing });
  return { font: key, bold: want.bold, italic: want.italic, glyphs: table };
}

/** `record` with `face` on it — or without one, when `face` is null. */
export function withRunFace(record, face) {
  const next = { ...record };
  if (face) next.face = structuredClone(face);
  else delete next.face;
  return next;
}

/**
 * How much longer the run is drawn in `face` than in its own font, as a vector in the page's user space
 * along its baseline: each glyph's advance in the face, per the PDF text model (as the writer draws it,
 * with the first glyph's size and spacing), less the advance it has now. null when the face can't draw it.
 */
export function faceAdvanceOf(analysis, run, face) {
  const found = faceGlyphsOf(analysis, run, face.glyphs);
  if (!found.entries) return null;
  const [si0, gi0] = run.glyphs[0];
  const show = analysis.shows[si0];
  const { fontSize: fs, tc, tw, th } = show;
  let delta = 0;
  run.glyphs.forEach(([si, gi], i) => {
    const glyph = analysis.shows[si].glyphs[gi];
    const [code, length, width] = found.entries[i];
    const space = code === null ? glyph.byteLength === 1 && glyph.code === 32 : length === 1 && code === 32;
    delta += ((width / 1000) * fs + tc + (space ? tw : 0)) * th - glyph.advance;
  });
  const [a, b] = multiply(show.glyphs[gi0].tm, show.ctm);
  const vector = [delta * a, delta * b];
  return vector.every(Number.isFinite) ? vector : null;
}

/** The run's quad (editing/runs.js) as it is drawn in `face`, before any transform: its end moved by faceAdvanceOf. */
export function faceQuadOf(analysis, run, face) {
  const vector = analysis && face ? faceAdvanceOf(analysis, run, face) : null;
  if (!vector) return null;
  const q = run.quad;
  return [q[0], q[1], q[2] + vector[0], q[3] + vector[1], q[4] + vector[0], q[5] + vector[1], q[6], q[7]];
}

/**
 * Where `object` (of the object model) is drawn as `record` has it, before the record's transform: its own
 * quad, or — page text set in another face — faceQuadOf it, `analysis` being the page its run is read from.
 * null when the face can't draw it.
 */
export function drawnQuadOf(object, record, analysis) {
  const face = object.kind === 'text-run' && !object.ref?.newText ? record?.face : null;
  return face ? faceQuadOf(analysis, object.record, face) : object.geometry.quad;
}
