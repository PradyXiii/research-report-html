#!/usr/bin/env node
/**
 * tools/test.js -- contract + safety tests for the renderer.
 * No browser needed. Run: npm test
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderBlock, validate, computeUpside, esc, formatDate, formatNumber } = require('../src/render');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + e.message.split('\n')[0]); fail++; }
}

const valid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/lenskart-2026-05-21.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('\nhelpers');
t('esc neutralises angle brackets and quotes', () => {
  assert.strictEqual(esc('<a "b" \'c\' & d>'), '&lt;a &quot;b&quot; &#39;c&#39; &amp; d&gt;');
});
t('formatDate converts ISO to report style', () => {
  assert.strictEqual(formatDate('2026-05-21'), '21 May 2026');
});
t('formatDate passes through unparseable input', () => {
  assert.strictEqual(formatDate('21 May 2026'), '21 May 2026');
});
t('formatNumber uses Indian grouping', () => {
  assert.strictEqual(formatNumber(1234567), '12,34,567');
});
t('computeUpside matches the Lenskart figures', () => {
  assert.strictEqual(computeUpside(487, 560).toFixed(1), '15.0');
});
t('computeUpside handles a downside', () => {
  assert.ok(computeUpside(600, 500) < 0);
});
t('computeUpside returns null without a fair value', () => {
  assert.strictEqual(computeUpside(487, null), null);
});
t('computeUpside guards divide-by-zero', () => {
  assert.strictEqual(computeUpside(0, 100), null);
});

console.log('\nvalidation (bot must not publish on a throw)');
t('accepts the real Lenskart report', () => { assert.ok(validate(valid)); });
t('rejects an empty object', () => { assert.throws(() => validate({})); });
t('rejects a non-ISO publishedAt', () => {
  const d = clone(valid); d.publishedAt = '21 May 2026'; assert.throws(() => validate(d));
});
t('rejects a rating outside the PCG scale', () => {
  const d = clone(valid); d.recommendation.rating = 'STRONG BUY'; assert.throws(() => validate(d));
});
t('rejects a section with neither bullets nor paragraphs', () => {
  const d = clone(valid); d.sections.push({ title: 'Empty' }); assert.throws(() => validate(d));
});
t('rejects a missing ticker', () => {
  const d = clone(valid); delete d.stock.ticker; assert.throws(() => validate(d));
});
t('rejects a non-numeric CMP', () => {
  const d = clone(valid); d.recommendation.cmp = 'Rs.487'; assert.throws(() => validate(d));
});
t('allows a null fairValue (NR / RS reports)', () => {
  const d = clone(valid); d.recommendation.fairValue = null;
  d.recommendation.rating = 'NR';
  assert.ok(validate(d));
  const html = renderBlock(d);
  assert.ok(!/krb__stat--accent/.test(html), 'Fair Value tile should be omitted');
  assert.ok(!/Potential Upside/.test(html), 'Upside tile should be omitted');
  assert.strictEqual((html.match(/class="krb__stat"/g) || []).length, 1, 'only the CMP tile should remain');
});

console.log('\ninjection safety (PDF text is untrusted input)');
const attack = {
  schemaVersion: '1.0', publishedAt: '2026-05-21',
  stock: { name: '<script>alert(1)</script>', ticker: '"><img src=x onerror=alert(2)>' },
  report: { type: '</p><svg onload=alert(3)>', period: 'Q1' },
  recommendation: { rating: 'ADD', cmp: 100, fairValue: 120 },
  sections: [{ title: 'X</h3><script>alert(4)</script>', bullets: ['</li><script>alert(5)</script>'] }],
  abbreviations: '<b>x</b>', attribution: '<i>y</i>'
};
const evilHtml = renderBlock(attack);
t('no executable <script> survives', () => { assert.ok(!/<script>alert/.test(evilHtml)); });
t('no unexpected tag reaches the output', () => {
  // esc() escapes every '<' that comes from input, so any raw tag in the output
  // must have come from the template. Allowlisting tag names is therefore a
  // complete injection check -- an escaped payload cannot match this regex.
  const ALLOWED = new Set(['article', 'header', 'section', 'div', 'p', 'h2', 'h3', 'h4',
    'span', 'time', 'ul', 'li', 'dl', 'dt', 'dd', 'a', 'strong', 'details', 'summary',
    'svg', 'circle', 'path', 'script', 'style']);
  const tags = new Set();
  evilHtml.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g, (_, x) => tags.add(x.toLowerCase()));
  const bad = [...tags].filter((x) => !ALLOWED.has(x));
  assert.strictEqual(bad.length, 0, 'unexpected tags: ' + bad.join(', '));
});
t('attacker markup survives only in escaped form', () => {
  assert.ok(evilHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'payload should be escaped, not dropped');
  assert.ok(!/<svg onload/.test(evilHtml), 'no raw svg injection');
  assert.ok(!/<img src=x/.test(evilHtml), 'no raw img injection');
});
t('no raw markup from PDF text survives', () => {
  assert.ok(!/<b>x<\/b>/.test(evilHtml) && !/<i>y<\/i>/.test(evilHtml));
});
t('javascript: PDF url suppresses the button entirely', () => {
  const d = clone(valid); d.sourcePdf = 'javascript:alert(1)';
  const h = renderBlock(d);
  assert.ok(!/krb__btn/.test(h), 'button must not render');
  assert.ok(!/href=""/.test(h), 'must not emit an empty href');
});
t('data: PDF url is rejected too', () => {
  const d = clone(valid); d.sourcePdf = 'data:text/html,<script>';
  assert.ok(!/krb__btn/.test(renderBlock(d)));
});
t('valid https PDF url renders the button', () => {
  assert.ok(/krb__btn--primary/.test(renderBlock(valid)));
});
t('JSON-LD cannot break out of its script tag', () => {
  const d = clone(valid); d.stock.name = 'A</script><script>alert(1)</script>';
  const h = renderBlock(d);
  const ld = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'JSON-LD block present');
  assert.ok(!/<\/script>/i.test(ld[1]), 'no closing tag inside the JSON-LD payload');
});

console.log('\noutput shape');
const html = renderBlock(valid);
t('renders all three sections', () => {
  ['Rationale', 'Positives', 'Negatives'].forEach((s) => assert.ok(html.includes('>' + s + '<'), s));
});
t('renders all bullets from the source data', () => {
  const n = valid.sections.reduce((a, s) => a + (s.bullets || []).length, 0);
  assert.strictEqual((html.match(/<li>/g) || []).length, n);
});
t('CMP always carries an as-on date qualifier', () => {
  assert.ok(/as on 21 May 2026/.test(html));
});
t('rating is normalised to upper case', () => {
  const d = clone(valid); d.recommendation.rating = 'add';
  assert.ok(/krb__rating" aria-label="Rating: ADD">ADD</.test(renderBlock(d)));
});
t('exposes the three disclosure accordions', () => {
  assert.strictEqual((html.match(/class="krb__acc"/g) || []).length, 3);
});
t('every rating-scale code is present', () => {
  require('../src/boilerplate').ratingScale.forEach((r) =>
    assert.ok(html.includes('<dt>' + r.code + '</dt>'), r.code));
});
t('inline-css option embeds the stylesheet', () => {
  assert.ok(/<style>[\s\S]*\.krb \{/.test(renderBlock(valid, { inlineCss: true })));
});
t('--no-ld option drops the JSON-LD', () => {
  assert.ok(!/application\/ld\+json/.test(renderBlock(valid, { jsonLd: false })));
});
t('theme option pins the block theme', () => {
  assert.ok(/data-krb-theme="dark"/.test(renderBlock(valid, { theme: 'dark' })));
});
t('every class is namespaced (no site CSS collisions)', () => {
  const classes = new Set();
  html.replace(/class="([^"]+)"/g, (_, c) => c.split(/\s+/).forEach((x) => classes.add(x)));
  const bad = [...classes].filter((c) => c && !c.startsWith('krb'));
  assert.strictEqual(bad.length, 0, 'unnamespaced: ' + bad.join(', '));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
