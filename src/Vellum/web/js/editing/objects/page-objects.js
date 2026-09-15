// One read-only view of everything drawn on a page: text runs, images, painted paths and the form
// XObjects that draw them. Derived from an analysis (editing/runs.js) — it adds no parsing of its
// own and never changes what it reads.
//
//   { kind, ref: { kind, key, stream, opIndex, runKey? }, order, geometry, capabilities, record }
//
// Built on demand, never inside analyzePage() and never while a document is being composed: the
// writer works from edit records and the analysis, and has no use for this. It exists so that
// selection and hit-testing (later phases) can name one object on a page and find it again.
//
// What may be done to an object is answered verb by verb in `capabilities` (objects/capabilities.js),
// in the reason keys of runs.js and no other vocabulary. A text run also carries the editability the
// engine already worked out (`editable`, `reasons`) exactly as it always has; the other kinds still
// make no such claim, rather than an invented one.

import { capabilitiesFor } from './capabilities.js';
import { keyOf as insertedKey } from './inserted-image.js';

/**
 * Identity. Two draws of one image share a resource key ("4 0 R"), and an inline image has none, so
 * a resource key can never name an object. Where an object is drawn can: its stream and the
 * operator index in that stream. Text is the exception — one TJ operator can hold several columns,
 * which read as separate runs from the same operator — so a run keeps the key it already has (the
 * index of its first glyph), which is also what an edit record's `target.key` refers to.
 */
const refFor = {
  'text-run': (r) => ({ key: `run:${r.key}`, stream: r.first.form?.key ?? 'page', opIndex: r.first.opIndex, runKey: r.key }),
  image: (r) => ({ key: `image:${r.stream}#${r.opIndex}`, stream: r.stream, opIndex: r.opIndex }),
  path: (r) => ({ key: `path:${r.stream}#${r.opIndex}`, stream: r.stream, opIndex: r.opIndex }),
  form: (r) => ({ key: `form:${r.stream}#${r.opIndex}`, stream: r.stream, opIndex: r.opIndex }),
};

const geometryFor = {
  'text-run': (r) => ({ quad: r.quad, box: r.box, frame: r.frame }),
  image: (r) => ({ quad: r.quad, box: r.box, frame: null }),
  // A painted path has bounds but no quad; a shading with nothing clipping it has no bounds at all.
  path: (r) => ({ quad: null, box: r.box ?? null, frame: null }),
  form: (r) => ({ quad: null, box: r.box ?? null, frame: null }),
};

/**
 * Where an object sits in the drawing order, as the path of operator indexes from the page down
 * through every form that encloses it: [57] is the 58th operator of the page, [57, 2] the 3rd
 * operator inside the form that operator draws. A single number can't say this — inside a form an
 * object's index counts from the form's own stream, which says nothing about where the form is
 * drawn — so a nested object would sort as though it were at the front of the page.
 */
function orderPath(analysis, stream, opIndex) {
  const path = [opIndex];
  const seen = new Set();
  let at = stream;
  while (at !== 'page') {
    if (seen.has(at)) break; // a form drawing itself: the interpreter stops, and so do we
    seen.add(at);
    const form = analysis.forms.find((f) => f.key === at);
    if (!form) break; // drawn by a form this page doesn't draw itself: nothing more can be said
    path.unshift(form.opIndex);
    at = form.stream;
  }
  return path;
}

/** Drawing order: earlier in the page's content comes first; a form comes before what it draws. */
export function compareOrder(a, b) {
  const x = a.order ?? a;
  const y = b.order ?? b;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

function makeObject(analysis, kind, record) {
  const ref = { kind, ...refFor[kind](record) };
  const object = {
    kind,
    ref: Object.freeze(ref),
    order: Object.freeze(orderPath(analysis, ref.stream, ref.opIndex)),
    geometry: Object.freeze(geometryFor[kind](record)),
    capabilities: capabilitiesFor(analysis, kind, record, ref),
    record,
  };
  // A text run brings the editability the engine already decided, unchanged and in its own words.
  if (kind === 'text-run') {
    object.text = record.text;
    object.editable = record.editable;
    object.reasons = Object.freeze([...record.reasons].sort());
  }
  return Object.freeze(object);
}

/**
 * Every object on an analyzed page, in drawing order. Pure: call it as often as you like, or use
 * objectsOf() to have the result kept.
 */
export function pageObjects(analysis) {
  const objects = [
    ...analysis.runs.map((r) => makeObject(analysis, 'text-run', r)),
    ...analysis.images.map((r) => makeObject(analysis, 'image', r)),
    ...analysis.paths.map((r) => makeObject(analysis, 'path', r)),
    ...analysis.forms.map((r) => makeObject(analysis, 'form', r)),
  ];
  objects.sort(compareOrder);
  return Object.freeze(objects);
}

/** An image's own space: the unit square every image is drawn into. */
const UNIT_QUAD = Object.freeze([0, 0, 1, 0, 1, 1, 0, 1]);
const UNIT_BOX = Object.freeze([0, 0, 1, 1]);

/**
 * A picture put on the page from a file (objects/inserted-image.js), as an object: a picture whose own
 * outline is the unit square, so its record's transform is where it is, and whose identity is its
 * record's. Drawn after everything the page has, in the order the pictures were put there. `analysis`
 * is the page's (null for a blank page), for the page-wide refusals only.
 */
export function insertedObject(analysis, record, index = 0) {
  const ref = Object.freeze({ kind: 'image', key: insertedKey(record), stream: 'page', opIndex: null, inserted: true });
  const image = Object.freeze({
    stream: 'page', opIndex: null, inserted: true, name: null, inline: false, oc: null, softMask: null, clip: null,
    ctm: Object.freeze([1, 0, 0, 1, 0, 0]), quad: UNIT_QUAD, box: UNIT_BOX,
    info: Object.freeze({ width: record.picture.width, height: record.picture.height }),
  });
  return Object.freeze({
    kind: 'image',
    ref,
    order: Object.freeze([Number.MAX_SAFE_INTEGER, index]),
    geometry: Object.freeze({ quad: UNIT_QUAD, box: UNIT_BOX, frame: null }),
    capabilities: capabilitiesFor(analysis ?? { tainted: false, unbalanced: false }, 'image', image, ref),
    record: image,
  });
}

const cache = new WeakMap();

/** The page's objects, worked out the first time they're asked for and kept for that analysis. */
export function objectsOf(analysis) {
  let objects = cache.get(analysis);
  if (!objects) {
    objects = pageObjects(analysis);
    cache.set(analysis, objects);
  }
  return objects;
}

/** One object by its ref key, or null. */
export function objectByKey(analysis, key) {
  return objectsOf(analysis).find((o) => o.ref.key === key) ?? null;
}

/** The objects of one kind, in drawing order. */
export function objectsOfKind(analysis, kind) {
  return objectsOf(analysis).filter((o) => o.kind === kind);
}
