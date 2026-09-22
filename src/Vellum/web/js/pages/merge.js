// Merge Documents V1 — several PDFs chosen from disk into one new PDF.
//
// There is no merge engine here. The pages are laid out by a page plan (pages/plan.js) and written by
// the writer every other page operation already uses (annotations/persist.js composeDocument), which
// copies each page with its own size, rotation and resources and never rasterizes anything. The first
// document is the base, so its pages are reused as they are — links and bookmarks into them keep
// working — and every other document goes in as a source, page by page, in the order it was listed.
//
// Nothing is opened for writing but the copy composeDocument makes in memory: the chosen files are
// only read, so every source PDF is left byte for byte as it was. A protected (encrypted) or
// unreadable file is refused by name before any merging starts, in the words Vellum already uses.

import { newId } from '../annotations/model.js';
import { composeDocument, countPages } from '../annotations/persist.js';

/** A merge needs at least this many documents. */
export const MINIMUM_INPUTS = 2;

/** One input could not be read (protected, damaged); `name` is the file it came from. */
export class MergeInputError extends Error {
  constructor(name, message) {
    super(message);
    this.name = 'MergeInputError';
    this.fileName = name;
  }
}

const clampIndex = (i, length) => Math.min(length - 1, Math.max(0, i));

/** Moves the input `id` by `delta` places. Returns a new list (the same one when it can't move). */
export function moveInput(inputs, id, delta) {
  const from = inputs.findIndex((f) => f.id === id);
  if (from < 0 || !delta) return inputs;
  const to = clampIndex(from + delta, inputs.length);
  if (to === from) return inputs;
  const next = inputs.slice();
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Drops the input `id`. Returns a new list (the same one when the id isn't in it). */
export function removeInput(inputs, id) {
  return inputs.some((f) => f.id === id) ? inputs.filter((f) => f.id !== id) : inputs;
}

/** Drops inputs whose path is already listed, keeping the first of each. Files with no path are kept. */
export function withoutDuplicates(inputs) {
  const seen = new Set();
  return inputs.filter((f) => {
    const key = f.path?.toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The page plan for a merge, over inputs already counted: [{ id, pageCount }] in the order to merge.
 * The first input's pages are the plan's 'base' pages; every other input is a source of its own.
 */
export function mergePlan(counted) {
  const plan = [];
  counted.forEach(({ id, pageCount }, i) => {
    const src = i === 0 ? 'base' : id;
    for (let index = 0; index < pageCount; index++) plan.push({ id: newId(), src, index, rotate: 0 });
  });
  return plan;
}

/** How many pages each input contributes, refusing a file Vellum can't write by name. */
export async function countInputs(inputs) {
  const counted = [];
  for (const input of inputs) {
    try {
      counted.push({ ...input, pageCount: await countPages(input.bytes) });
    } catch (err) {
      throw new MergeInputError(input.name, `“${input.name}” can’t be merged. ${err.message}`);
    }
  }
  return counted;
}

/**
 * Merges `inputs` — [{ id, name, bytes }] in the order they should appear — into one PDF's bytes.
 * The inputs' own bytes are never written to; the same inputs in the same order give the same file.
 */
export async function mergeDocuments(inputs) {
  if (!Array.isArray(inputs) || inputs.length < MINIMUM_INPUTS) {
    throw new Error(`Choose at least ${MINIMUM_INPUTS} PDFs to merge.`);
  }
  const counted = await countInputs(inputs);
  const empty = counted.find((f) => f.pageCount < 1);
  if (empty) throw new MergeInputError(empty.name, `“${empty.name}” has no pages.`);

  const sources = new Map();
  for (const f of counted.slice(1)) sources.set(f.id, f.bytes);
  return composeDocument({ base: counted[0].bytes, plan: mergePlan(counted), sources });
}

/** Page count a merge of these counted inputs would produce. */
export const mergedPageCount = (counted) => counted.reduce((n, f) => n + (f.pageCount ?? 0), 0);

/** The name offered for the merged file: the first document's, marked as a merge. */
export function mergedFileName(firstName) {
  const base = String(firstName ?? 'Document').replace(/\.pdf$/i, '').trim();
  return `${base || 'Document'} (merged).pdf`;
}
