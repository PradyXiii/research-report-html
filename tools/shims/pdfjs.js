// Stands in for the bare specifier `pdfjs-dist/legacy/build/pdf.mjs` that
// bot/pdftext.js dynamically imports. In the browser the very same pdf.js
// build has already been evaluated from an inline <script>, which parks its
// module namespace on globalThis.pdfjsLib -- so hand that back.
//
// Resolved lazily (this module body runs on first require, i.e. inside
// loadPdfjs()), so script order inside converter.html is what guarantees the
// global exists by then.
'use strict';

if (!globalThis.pdfjsLib || typeof globalThis.pdfjsLib.getDocument !== 'function') {
  throw new Error(
    'pdf.js was not inlined into this page (globalThis.pdfjsLib is missing). ' +
    'converter.html is corrupt -- rebuild it with `npm run build:app`.'
  );
}

module.exports = globalThis.pdfjsLib;
