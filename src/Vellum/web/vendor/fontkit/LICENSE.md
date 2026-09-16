# @pdf-lib/fontkit 1.1.1

`fontkit.es.min.js` is `dist/fontkit.es.min.js` from the npm package `@pdf-lib/fontkit` 1.1.1
(https://github.com/Hopding/fontkit, a fork of https://github.com/foliojs/fontkit), with one change:
its first statement, `import e from"pako";`, reads `import e from"../pako/pako.esm.mjs";`, so the page
and the Node tests load the vendored pako (`../pako`, 2.1.0) without a bundler or an import map.
Nothing else in the file differs from the published build.

Vellum uses it only through pdf-lib (`registerFontkit`, `embedFont` with `subset`) and to measure
bundled document fonts; it is loaded when such a font is first needed.

## Licence

fontkit and @pdf-lib/fontkit are released under the MIT License:

MIT License

Copyright (c) 2014 Devon Govett

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Code bundled into the build

- @pdf-lib/restructure, @pdf-lib/unicode-properties, unicode-trie, tiny-inflate, dfa, clone,
  deep-equal, buffer, base64-js — MIT
- base64-arraybuffer — MIT, Copyright (c) 2012 Niklas von Hertzen
- Node.js shims (string_decoder, events, util) — MIT, Copyright Joyent, Inc. and other Node contributors
- @pdf-lib/brotli — MIT; its WOFF2 (Brotli) decoder is Copyright 2013 Google Inc., licensed under the
  Apache License, Version 2.0 (full text in `LICENSE-APACHE-2.0`)
