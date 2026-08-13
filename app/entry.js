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
module.exports = { detectFormat, renderBlock, renderStandalone, validate, extract };

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

/* Wire the worker synchronously, before anything can call getDocument.
   esbuild bundles pdfjs into this file, so this is the very same module
   instance pdftext.js later awaits -- there is no second copy. */
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
if (globalThis.__KOTAK_WORKER_B64 && pdfjs.GlobalWorkerOptions) {
  // base64 rather than a JS string literal: the worker source contains
  // sequences (</script, U+2028) that cannot survive inline escaping.
  const bin = atob(globalThis.__KOTAK_WORKER_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  try {
    // The worker ships as an ES module, so it must be constructed as one.
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
  } catch (e) {
    pdfjs.GlobalWorkerOptions.workerSrc = url;
  }
}
module.exports.pdfjs = pdfjs;
