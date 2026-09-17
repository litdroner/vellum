import { newId } from '../annotations/model.js';
import { hasPageSettings } from './stamps.js';

// A page plan is the document's page list after editing. Each entry says where a page comes from:
//   { id, src: 'base', index, rotate }        page `index` (0-based) of the file that was opened
//   { id, src: '<sourceId>', index, rotate }  a page taken from another PDF inserted into this one
//   { id, src: 'blank', width, height, rotate }
// `rotate` is extra rotation (0/90/180/270) on top of the page's own. An entry may also carry `crop`,
// `pageNumber` and `watermark` (see pages/stamps.js). An entry keeps its id when it is moved, rotated
// or given settings, which is how annotations follow their page around.

export function identityPlan(pageCount) {
  return Array.from({ length: pageCount }, (_, index) => ({ id: newId(), src: 'base', index, rotate: 0 }));
}

/** True when the plan is just the opened file, untouched. */
export function isIdentity(plan, pageCount) {
  return !plan || (plan.length === pageCount && plan.every((e, i) => e.src === 'base' && e.index === i && !e.rotate && !hasPageSettings(e)));
}

/** Sets (or, with null, removes) one page setting — 'crop', 'pageNumber' or 'watermark' — on entries. value(entry) may vary per page. */
export function setPageSetting(plan, ids, key, value) {
  return plan.map((e) => {
    if (!ids.has(e.id)) return e;
    const next = { ...e };
    const v = typeof value === 'function' ? value(e) : value;
    if (v == null) delete next[key];
    else next[key] = v;
    return next;
  });
}

const turn = (angle) => ((angle % 360) + 360) % 360;

export function rotateEntries(plan, ids, delta) {
  return plan.map((e) => (ids.has(e.id) ? { ...e, rotate: turn(e.rotate + delta) } : e));
}

export function removeEntries(plan, ids) {
  return plan.filter((e) => !ids.has(e.id));
}

/** Moves the entries in `ids` (keeping their order) to insertion point `toIndex` of the current list. */
export function moveEntries(plan, ids, toIndex) {
  const moving = plan.filter((e) => ids.has(e.id));
  const rest = plan.filter((e) => !ids.has(e.id));
  const at = plan.slice(0, toIndex).filter((e) => !ids.has(e.id)).length;
  rest.splice(at, 0, ...moving);
  return rest;
}

export function insertEntries(plan, index, entries) {
  const next = plan.slice();
  next.splice(index, 0, ...entries);
  return next;
}

/** Puts a copy of each entry right after it. Returns the new plan and [originalId, copyId] pairs. */
export function duplicateEntries(plan, ids) {
  const copies = [];
  const next = [];
  for (const e of plan) {
    next.push(e);
    if (!ids.has(e.id)) continue;
    const copy = { ...e, id: newId() };
    copies.push([e.id, copy.id]);
    next.push(copy);
  }
  return { plan: next, copies };
}

/** Inserts a copy of each entry in `ids` (in plan order) at insertion point `index`. Same result shape as duplicateEntries. */
export function copyEntries(plan, ids, index) {
  const copies = [];
  const entries = plan.filter((e) => ids.has(e.id)).map((e) => {
    const copy = { ...e, id: newId() };
    copies.push([e.id, copy.id]);
    return copy;
  });
  return { plan: insertEntries(plan, index, entries), copies };
}

/**
 * Annotation changes that keep annotations on their pages when the plan changes: moved pages take
 * their annotations along, deleted pages take theirs away, duplicated pages get copies.
 */
export function followPages(annotations, oldPlan, newPlan, copies = []) {
  const position = new Map(newPlan.map((e, i) => [e.id, i + 1]));
  const changes = [];
  for (const a of annotations) {
    const entry = oldPlan[a.page - 1];
    const page = entry && position.get(entry.id);
    if (!page) changes.push({ before: a, after: null });
    else if (page !== a.page) changes.push({ before: a, after: { ...a, page } });
  }
  for (const [fromId, toId] of copies) {
    const from = oldPlan.findIndex((e) => e.id === fromId) + 1;
    const to = position.get(toId);
    if (!from || !to) continue;
    for (const a of annotations) {
      if (a.page === from) changes.push({ before: null, after: { ...a, id: newId(), page: to } });
    }
  }
  return changes;
}
