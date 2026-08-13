'use strict';
/**
 * The ONLY file that touches a PDF library.
 *
 * Contract: Buffer -> { pageCount, pages: [ { number, lines: [Line] } ] }
 *   Line = { text, x0, x1, y, height, index }
 *          x/y are PDF user-space points, origin bottom-left.
 *
 * Everything downstream (extract.js and all its tests) works on that plain
 * structure, so the PDF engine is swappable and the parser is testable with a
 * JSON fixture and zero dependencies.
 *
 * Engine: pdfjs-dist (Mozilla). Chosen because it is pure JavaScript -- no
 * node-gyp, no system libraries, no Python -- so `npm ci` works on any Linux
 * box the bank hands us. Its one optional dependency (@napi-rs/canvas, a
 * native module used only for *rendering*) is deliberately not installed;
 * text extraction does not need it.
 *
 * Lines come from pdf.js's own end-of-line signal (item.hasEOL), which follows
 * the content stream's text-positioning operators. That keeps side-by-side
 * text boxes -- "Current Market Price (CMP)" and "Fair Value (FV)" sit at the
 * same y -- as separate lines instead of merging them, which a naive
 * group-by-y reconstruction would do.
 */

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

let pdfjsPromise = null;

/** Load the ESM build from CommonJS, muting pdf.js's canvas-polyfill chatter. */
function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    // pdf.js routes warn() through console.log at import time, complaining
    // that @napi-rs/canvas is absent. It is absent on purpose -- that module
    // is native and only rendering needs it -- so mute exactly those lines and
    // let every other message through.
    const NOISE = /^Warning: Cannot (load|polyfill)\b/;
    const originals = { log: console.log, warn: console.warn };
    const filter = (fn) => (...args) => { if (NOISE.test(String(args[0] || ''))) return; fn.apply(console, args); };
    console.log = filter(originals.log);
    console.warn = filter(originals.warn);
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (err) {
      throw new Error(
        'Could not load pdfjs-dist. Run `npm ci --omit=optional` inside bot/. ' +
        'Original error: ' + err.message
      );
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
    }
  })();
  return pdfjsPromise;
}

function isPdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  // %PDF- may be preceded by junk in tolerant readers; check the first 1 KB.
  return buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

/**
 * @param {Buffer|Uint8Array} buffer
 * @param {object} [opts] { pages: number[]|null, maxBytes, password }
 */
async function extractLines(buffer, opts) {
  const o = Object.assign({ pages: null, maxBytes: DEFAULT_MAX_BYTES }, opts || {});
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);

  if (!buf.length) throw new Error('PDF is empty (0 bytes).');
  if (buf.length > o.maxBytes) {
    throw new Error(`PDF is ${buf.length} bytes, over the ${o.maxBytes}-byte limit. Refusing to parse.`);
  }
  if (!isPdf(buf)) {
    throw new Error(
      'Source is not a PDF (no %PDF- header). This is usually an S3 error page, ' +
      'an HTML login redirect, or a truncated download.'
    );
  }

  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      // pdf.js takes ownership of the array, so hand it a copy.
      data: new Uint8Array(buf),
      password: o.password || undefined,
      isEvalSupported: false,     // never eval font programs
      disableFontFace: true,      // no DOM, no font loading
      useSystemFonts: false,      // no filesystem font probing
      useWorkerFetch: false,
      verbosity: 0                // errors only
    }).promise;
  } catch (err) {
    throw new Error(`PDF could not be opened (${err.name || 'error'}: ${err.message}). Treat as malformed.`);
  }

  try {
    const wanted = o.pages && o.pages.length
      ? o.pages.filter((n) => n >= 1 && n <= doc.numPages)
      : Array.from({ length: doc.numPages }, (_, i) => i + 1);

    const pages = [];
    for (const n of wanted) {
      const page = await doc.getPage(n);
      let content;
      try {
        content = await page.getTextContent();
      } finally {
        page.cleanup();
      }
      pages.push({ number: n, lines: toLines(content.items) });
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await doc.destroy().catch(() => {});
  }
}

/** pdf.js text items -> line records with geometry. */
function toLines(items) {
  const lines = [];
  let bucket = [];

  const flush = () => {
    const solid = bucket.filter((i) => i.str && i.str.trim());
    if (solid.length) {
      const first = solid[0];
      const last = solid[solid.length - 1];
      lines.push({
        index: lines.length,
        text: bucket.map((i) => i.str).join('').replace(/\s+/g, ' ').trim(),
        x0: round(first.transform[4]),
        x1: round(last.transform[4] + (last.width || 0)),
        y: round(first.transform[5]),
        height: round(first.height || 0)
      });
    }
    bucket = [];
  };

  for (const item of items) {
    if (typeof item.str !== 'string') continue; // marked-content spans
    bucket.push(item);
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

const round = (n) => Math.round(Number(n) * 10) / 10;

module.exports = { extractLines, isPdf, toLines, DEFAULT_MAX_BYTES };
