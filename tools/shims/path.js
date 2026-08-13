// Browser stand-in for Node's `path`. src/render.js uses path.join and nothing
// else; bot/extract.js requires 'path' but never dereferences it.
'use strict';

function normalize(p) {
  const abs = p.charAt(0) === '/';
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(part);
  }
  return (abs ? '/' : '') + out.join('/');
}

function join(...parts) {
  const joined = parts.filter((p) => p !== '' && p !== null && p !== undefined).join('/');
  return joined ? normalize(joined) : '.';
}

const basename = (p) => normalize(String(p)).split('/').pop();
const dirname = (p) => {
  const n = normalize(String(p));
  const i = n.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '.') : n.slice(0, i);
};
const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
};

module.exports = { join, resolve: join, normalize, basename, dirname, extname, sep: '/' };
