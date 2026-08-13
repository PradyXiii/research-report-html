// Bundle entry for converter.html.
//
// This file is deliberately almost empty: it exists only to pull the REAL
// bot/browser modules into one IIFE and park them on window.KRB. There is no
// extraction or rendering logic here, and there must never be any -- the whole
// point of the browser converter is that it runs the same code the server bot
// runs, so the two cannot drift.
'use strict';

const extract = require('../bot/extract.js');
const render = require('../src/render.js');
const pdftext = require('../bot/pdftext.js');
const filename = require('../bot/lib/filename.js');
const detect = require('../bot/detect.js');

/**
 * Prove the Buffer shim still behaves like Node's Buffer for the one
 * non-obvious thing bot/pdftext.js:61 depends on: a byte-SEQUENCE
 * `includes()` on a `subarray()` view. If this ever regresses, every PDF
 * would be rejected with the misleading "Source is not a PDF" message, so
 * fail loudly and early instead.
 */
function selfTest() {
  const probe = Buffer.from('junk%PDF-1.7 rest');
  if (!Buffer.isBuffer(probe)) throw new Error('Buffer shim: isBuffer() failed');
  if (!probe.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('Buffer shim: subarray().includes(<byte sequence>) failed');
  }
  if (Buffer.from('nothing here').subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('Buffer shim: includes() matched a sequence that is absent');
  }
  if (!pdftext.isPdf(Buffer.from('%PDF-1.4\n'))) throw new Error('pdftext.isPdf() rejected a valid header');
  if (pdftext.isPdf(Buffer.from('<html>oops</html>'))) throw new Error('pdftext.isPdf() accepted an HTML page');
  return true;
}

module.exports = {
  extract,
  render,
  pdftext,
  filename,
  detect,
  selfTest,
  DEFAULT_MAX_BYTES: pdftext.DEFAULT_MAX_BYTES
};
