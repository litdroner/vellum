// Which handler writes which kind of content edit (editing/edits.js). One kind today: text runs.
//
// A kind with no handler here is refused by the page writer — EditError('unsupported'), raised
// before any page is touched — rather than dropped: an edit a person made must never disappear
// without a word. Registering a handler here is what makes a kind writable.

import * as textRun from './text-run.js';

const HANDLERS = new Map([[textRun.kind, textRun]]);

/** The handler that writes this kind of edit, or null when nothing here can. */
export const handlerFor = (kind) => HANDLERS.get(kind) ?? null;

/** The kinds of edit that can be written today. */
export const writableKinds = () => [...HANDLERS.keys()];
