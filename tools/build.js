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

/* ---- preview.html: reviewer tool with theme + viewport switches -------- */
const preview = `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Preview - Kotak research block</title>
<style>
${css}
  .pv-bar {
    position: sticky; top: 0; z-index: 10;
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    padding: 10px 14px; background: #00005a; color: #fff;
    font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .pv-bar strong { margin-right: 6px; letter-spacing: .05em; text-transform: uppercase; font-size: 11px; opacity: .75; }
  .pv-bar button {
    font: inherit; cursor: pointer; padding: 6px 12px; min-height: 32px;
    border: 1px solid rgba(255,255,255,.35); background: transparent; color: #fff; border-radius: 6px;
  }
  .pv-bar button[aria-pressed="true"] { background: #fa1432; border-color: #fa1432; }
  .pv-bar span.sep { width: 1px; height: 22px; background: rgba(255,255,255,.25); margin: 0 4px; }
  .pv-stage { padding: clamp(12px,3vw,32px); transition: max-width .2s ease; margin: 0 auto; }
</style>
</head>
<body class="krb-page" style="padding:0">
  <div class="pv-bar">
    <strong>Theme</strong>
    <button data-theme="system" aria-pressed="true">System</button>
    <button data-theme="light"  aria-pressed="false">Light</button>
    <button data-theme="dark"   aria-pressed="false">Dark</button>
    <span class="sep"></span>
    <strong>Width</strong>
    <button data-w="0"   aria-pressed="true">Full</button>
    <button data-w="1024" aria-pressed="false">Tablet 1024</button>
    <button data-w="768" aria-pressed="false">768</button>
    <button data-w="390" aria-pressed="false">Phone 390</button>
    <span class="sep"></span>
    <button id="pv-open">Expand all disclosures</button>
  </div>
  <div class="pv-stage" id="stage">
${renderBlock(sample)}
  </div>
<script>
  var body = document.body, stage = document.getElementById('stage'), block = stage.querySelector('.krb');
  function press(group, el) { group.forEach(function (b) { b.setAttribute('aria-pressed', String(b === el)); }); }
  var themeBtns = [].slice.call(document.querySelectorAll('[data-theme]'));
  themeBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.theme;
      if (t === 'system') { body.removeAttribute('data-krb-theme'); block.removeAttribute('data-krb-theme'); }
      else { body.setAttribute('data-krb-theme', t); block.setAttribute('data-krb-theme', t); }
      press(themeBtns, b);
    });
  });
  var wBtns = [].slice.call(document.querySelectorAll('[data-w]'));
  wBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var w = Number(b.dataset.w);
      stage.style.maxWidth = w ? w + 'px' : '';
      press(wBtns, b);
    });
  });
  document.getElementById('pv-open').addEventListener('click', function () {
    var d = [].slice.call(document.querySelectorAll('.krb__acc'));
    var open = d.every(function (x) { return x.open; });
    d.forEach(function (x) { x.open = !open; });
    this.textContent = open ? 'Expand all disclosures' : 'Collapse all disclosures';
  });
</script>
</body>
</html>
`;
write('preview.html', preview);
console.log('Done.');
