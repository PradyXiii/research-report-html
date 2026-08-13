#!/usr/bin/env node
/**
 * tools/build.js -- regenerate every committed artifact from src/ + data/.
 * Run: npm run build
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { renderBlock, renderStandalone } = require('../src/render');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const write = (f, s) => { fs.writeFileSync(path.join(root, f), s); console.log(`  ${f}  (${(s.length / 1024).toFixed(1)} kB)`); };

const sample = read('data/lenskart-2026-05-21.json');
const placeholder = read('data/_placeholder.json');
const css = fs.readFileSync(path.join(root, 'src/krb.css'), 'utf8');

console.log('Building:');
write('sample-lenskart.html', renderStandalone(sample));
write('block-inline-css.html', renderBlock(sample, { inlineCss: true }));
write('template.html', renderStandalone(placeholder));

/* preview.html is deliberately NOT generated: the reviewer toolbar (theme and
   viewport switches) was scaffolding, and the user handles sizing and colour
   scheme themselves. sample-lenskart.html is the clean output. */
/* ---- the other three Kotak formats ------------------------------------- */
for (const [file, out] of [
  ['data/narayana-2026-08-07.json', 'sample-pick-of-the-week.html'],
  ['data/stock-recommendations-2026-08-11.json', 'sample-stock-recommendations.html'],
  ['data/kie-lenskart-2026-08-12.json', 'sample-kie-report.html']
]) {
  write(out, renderStandalone(read(file)));
}
console.log('Done.');
