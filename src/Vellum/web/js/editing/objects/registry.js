// Which handler writes which kind of content edit (editing/edits.js). One kind today: text runs.
//
// A kind with no handler here is ignored by the page writer, exactly as it always has been. When
// object editing lands, an unwritable kind should become an explicit refusal instead: an edit a
// person made must never be dropped without a word.

import * as textRun from './text-run.js';

const HANDLERS = new Map([[textRun.kind, textRun]]);

/** The handler that writes this kind of edit, or null when nothing here can. */
export const handlerFor = (kind) => HANDLERS.get(kind) ?? null;

/** The kinds of edit that can be written today. */
export const writableKinds = () => [...HANDLERS.keys()];
