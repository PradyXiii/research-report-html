/* Browser entry: the same extractor, detector and renderer the server bot uses.
   Only the Node-only edges are shimmed -- the logic itself is untouched. */

/* pdftext.js uses Buffer for the %PDF- magic check and to normalise input.
   These two members are all it needs. */
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = {
    isBuffer: (b) => b instanceof Uint8Array,
    from: (v) => (typeof v === 'string'
      ? new TextEncoder().encode(v)
      : new Uint8Array(v || []))
  };
}
/* Uint8Array has no .includes(subarray); pdftext relies on it for the header. */
if (!Uint8Array.prototype.__kotakIncludes) {
  const orig = Uint8Array.prototype.includes;
  Uint8Array.prototype.__kotakIncludes = true;
  Uint8Array.prototype.includes = function (needle, from) {
    if (needle instanceof Uint8Array) {
      outer: for (let i = 0; i <= this.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    }
    return orig.call(this, needle, from);
  };
}
/* Browser entry: the same extractor, detector and renderer the server bot uses. */
const { detectFormat } = require('../bot/detect.js');
const { renderBlock, renderStandalone, validate } = require('../src/render.js');
const extract = require('../bot/extract.js');
const formats = require('../bot/extract-formats.js');
module.exports = { detectFormat, renderBlock, renderStandalone, validate, extract, formats };

/* Browser-side helper: pdf.js -> the same line shape pdftext.js produces, so
   extractFromLines runs unmodified. */
const pdftext = require('../bot/pdftext.js');
extract.__lines = async function (bytes) {
  // pdftext contract: Buffer -> { pageCount, pages: [ { number, lines: [Line] } ] }
  const doc = await pdftext.extractLines(bytes, {});
  const pages = doc.pages || [];
  const lines = pages.reduce((acc, pg) => acc.concat(
    (pg.lines || []).map((l) => Object.assign({}, l, { page: pg.number }))), []);
  const first = pages.find((pg) => pg.number === 1) || pages[0] || { lines: [] };
  return {
    lines: lines,
    page1Lines: (first.lines || []),
    pages: pages,
    pageCount: doc.pageCount || pages.length,
    page1Text: (first.lines || []).map((l) => l.text).join('\n')
  };
};

/* pdf.js normally parses in a Web Worker. A Blob worker is blocked on file://,
   where it hangs forever with no error, so instead we hand pdf.js the worker
   MODULE directly: when globalThis.pdfjsWorker is present it uses it on the
   main thread and never constructs a Worker at all. Works from disk and over
   http, with no blob URL and no second copy of the code. */
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjsWorker = require('pdfjs-dist/legacy/build/pdf.worker.mjs');
globalThis.pdfjsWorker = pdfjsWorker;
if (pdfjs.GlobalWorkerOptions) {
  pdfjs.GlobalWorkerOptions.workerPort = null;
  pdfjs.GlobalWorkerOptions.workerSrc = '';
}
module.exports.pdfjs = pdfjs;
