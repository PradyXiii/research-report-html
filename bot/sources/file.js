'use strict';
/**
 * Local-file source: `run.js --file ./report.pdf`.
 *
 * This is the offline path -- no network at all -- and it is what makes the bot
 * testable on a laptop and on a locked-down server before any egress rules are
 * agreed. The public URL for the "Download full report" button then comes from
 * SOURCE_PUBLIC_BASE_URL.
 */

const fs = require('fs');
const path = require('path');
const { baseName } = require('../lib/filename');

function create(cfg) {
  const s = cfg.source;

  function resolve(ref) {
    const p = String(ref || '').trim();
    if (!p) throw new Error('No file given. Pass --file <path>.');
    const abs = path.resolve(p);
    return {
      id: path.basename(abs),
      filename: path.basename(abs),
      path: abs,
      url: s.publicBaseUrl ? s.publicBaseUrl + '/' + encodeURIComponent(path.basename(abs)) : null,
      meta: {}
    };
  }

  return {
    kind: 'file',
    describe: () => 'local file',
    resolve,

    async fetch(ref) {
      const r = resolve(ref);
      let stat;
      try { stat = fs.statSync(r.path); }
      catch (err) { throw new Error(`Cannot read "${r.path}": ${err.message}`); }
      if (!stat.isFile()) throw new Error(`"${r.path}" is not a file.`);
      if (stat.size > s.maxBytes) throw new Error(`"${r.path}" is ${stat.size} bytes, over SOURCE_MAX_BYTES=${s.maxBytes}.`);
      return Object.assign({}, r, {
        buffer: fs.readFileSync(r.path),
        filename: baseName(r.path) + '.pdf',
        meta: { size: stat.size, mtime: stat.mtime.toISOString() }
      });
    },

    async list() {
      throw new Error('SOURCE_TYPE=file handles one named file. Use SOURCE_TYPE=dir to enumerate a folder.');
    }
  };
}

module.exports = { create };
