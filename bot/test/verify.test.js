'use strict';
/**
 * The gate's own tests. A gate nobody has tried to break is decoration, so
 * roughly half of these are attempts to slip something past it.
 *
 * Fixtures are built from the real Lenskart one-pager lines committed under
 * fixtures/, so the "clean" case is a document that actually shipped.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { verify } = require('../verify');
const { extractFromLines } = require('../extract');
const { renderBlock } = require('../../src/render');

const LINES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lenskart-page1.lines.json'), 'utf8'));
const FILENAME = '131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf';
const SOURCE = LINES.map((l) => l.text).join('\n');

function clean() {
  const res = extractFromLines(LINES, {
    filename: FILENAME, now: new Date('2026-05-22T00:00:00Z'), pageCount: 4,
    sourceUrl: 'https://example.com/r.pdf',
    tickerMap: { LENSKART: { slug: 'lenskart-solutions-share-price' } }
  });
  assert.ok(res.ok, 'fixture must extract cleanly');
  return res.report;
}
function check(data, html) {
  return verify({
    data, html: html === undefined ? renderBlock(data, { inlineCss: false }) : html,
    sourceText: SOURCE, page1Text: SOURCE, filename: FILENAME
  });
}
const copy = (o) => JSON.parse(JSON.stringify(o));

test('a real report passes', () => {
  const v = check(clean());
  assert.ok(v.ok, 'should publish: ' + JSON.stringify(v.failures));
  assert.ok(v.passed.length >= 6, 'should run a meaningful number of checks');
});

test('refuses when there is no source to verify against', () => {
  const v = verify({ data: clean(), html: '<article>x</article>' });
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'NO_SOURCE_TEXT'));
});

test('a figure that is not in the PDF blocks publication', () => {
  const d = clean(); d.recommendation.cmp = 488;      // one digit off
  const v = check(d);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'FIGURE_NOT_IN_SOURCE'));
});

test('a doubled fair value blocks publication', () => {
  const d = clean(); d.recommendation.fairValue *= 2;
  assert.equal(check(d).ok, false);
});

test('a rating the cover does not print blocks publication', () => {
  const d = clean(); d.recommendation.rating = 'REDUCE';
  const v = check(d);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /TEXT_NOT_IN_SOURCE|RATING_NOT_IN_SOURCE/.test(f.code)));
});

test('reworded analyst wording blocks publication', () => {
  const d = clean();
  d.sections[0].bullets[0] = 'Lenskart will double from here.';
  const v = check(d);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'TEXT_NOT_IN_SOURCE'));
});

test('dropping most bullets blocks publication', () => {
  const d = clean();
  d.sections.forEach((s) => { s.bullets = s.bullets.slice(0, 1); });
  const v = check(d);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'BULLETS_LOST'));
});

test('the invisible leftover rating on the cover raises a warning', () => {
  // Page 1 of the real PDF carries a hidden ") - SELL" behind the type band.
  const v = check(clean());
  assert.ok(v.warnings.some((w) => w.code === 'MULTIPLE_RATINGS_IN_SOURCE'),
    'the second rating on the cover must be surfaced to a human');
});

test('a figure edited in the HTML after rendering blocks publication', () => {
  const d = clean();
  const html = renderBlock(d, { inlineCss: false }).replace('487', '987');
  const v = check(d, html);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'FIGURE_MISSING_FROM_HTML'));
});

test('an injected script blocks publication', () => {
  const d = clean();
  const html = renderBlock(d, { inlineCss: false }).replace('</article>', '<script>x()</script></article>');
  const v = check(d, html);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'SCRIPT_IN_OUTPUT'));
});

test('content dropped between extraction and rendering blocks publication', () => {
  const d = clean();
  const html = renderBlock(d, { inlineCss: false }).replace(/<section[\s\S]*?<\/section>/, '');
  const v = check(d, html);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => /TEXT_MISSING_FROM_HTML|UNBALANCED_TAGS/.test(f.code)));
});

test('an unfilled placeholder blocks publication', () => {
  const d = clean();
  const html = renderBlock(d, { inlineCss: false }).replace('Rs.', '{{currency}}');
  const v = check(d, html);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'PLACEHOLDER_IN_OUTPUT'));
});

test('unbalanced markup blocks publication', () => {
  const d = clean();
  const v = check(d, renderBlock(d, { inlineCss: false }).replace('</article>', ''));
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'UNBALANCED_TAGS'));
});

test('a date the reader cannot see blocks publication', () => {
  const d = clean();
  const html = renderBlock(d, { inlineCss: false }).replace(/21 May 2026/g, '');
  const v = check(d, html);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'DATE_NOT_SHOWN'));
});

test('a missing report id blocks publication', () => {
  const d = clean(); delete d.reportId;
  const v = check(d);
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'MISSING_IDENTITY'));
});

test('empty HTML blocks publication', () => {
  const v = check(clean(), '');
  assert.equal(v.ok, false);
  assert.ok(v.failures.some((f) => f.code === 'HTML_EMPTY'));
});
