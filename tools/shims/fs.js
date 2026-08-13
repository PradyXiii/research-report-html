// Browser stand-in for Node's `fs`, backed by files the build inlined into the
// page as `globalThis.__KRB_FILES__` (keyed by basename).
//
// Only readFileSync is implemented, and only for the one file src/render.js
// actually reads: krb.css. Unknown paths throw an ENOENT-shaped error so the
// failure looks exactly like Node's instead of yielding `undefined` and
// silently rendering a block with no stylesheet.
'use strict';

const { basename } = require('./path.js');

function files() {
  return (typeof globalThis !== 'undefined' && globalThis.__KRB_FILES__) || {};
}

function readFileSync(p, enc) {
  const key = basename(String(p));
  const table = files();
  if (!Object.prototype.hasOwnProperty.call(table, key)) {
    const err = new Error("ENOENT: no such file or directory, open '" + p + "'");
    err.code = 'ENOENT';
    err.path = String(p);
    throw err;
  }
  const value = table[key];
  if (enc === undefined || enc === null) {
    // Node would hand back a Buffer. Nothing in the bundled code takes this
    // branch today; make it loud rather than subtly wrong if that changes.
    throw new Error('fs shim: binary readFileSync("' + p + '") is not supported in the browser build');
  }
  if (enc !== 'utf8' && enc !== 'utf-8') {
    throw new Error('fs shim: unsupported encoding "' + enc + '"');
  }
  return value;
}

const existsSync = (p) => Object.prototype.hasOwnProperty.call(files(), basename(String(p)));

module.exports = { readFileSync, existsSync };
