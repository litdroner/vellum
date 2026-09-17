// Which handler writes which kind of content edit: text runs (editing/edits.js), images already on a
// page (objects/image.js), pictures put on a page from a file (objects/inserted-image.js), new text
// (objects/inserted-text.js), pasted copies of text and pictures (objects/copies.js) and the invisible
// text OCR reads (objects/ocr-text.js), and redactions (objects/redaction.js, which the page writer runs
// last on a page), each owning everything about turning its own kind of record
// into bytes.
//
// A kind with no handler here is refused by the page writer — EditError('unsupported'), raised
// before any page is touched — rather than dropped: an edit a person made must never disappear
// without a word. Registering a handler here is what makes a kind writable.

import * as textRun from './text-run.js';
import * as image from './image.js';
import * as insertedImage from './inserted-image.js';
import * as insertedText from './inserted-text.js';
import { textCopy, imageCopy } from './copies.js';
import * as ocrText from './ocr-text.js';
import * as redaction from './redaction.js';

const HANDLERS = new Map([
  [textRun.kind, textRun], [image.kind, image], [insertedImage.kind, insertedImage], [insertedText.kind, insertedText],
  [textCopy.kind, textCopy], [imageCopy.kind, imageCopy], [ocrText.kind, ocrText], [redaction.kind, redaction],
]);

/** The handler that writes this kind of edit, or null when nothing here can. */
export const handlerFor = (kind) => HANDLERS.get(kind) ?? null;

/** The kinds of edit that can be written today. */
export const writableKinds = () => [...HANDLERS.keys()];
