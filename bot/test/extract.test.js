'use strict';
/**
 * Extractor tests.
 *
 * The base fixture is the REAL page 1 of the reference PDF, captured with
 * pdftext.js (see test/fixtures/README). Working from a captured line list
 * rather than the PDF keeps these tests offline, fast and dependency-free, and
 * lets each failure mode be produced by mutating one line -- which is exactly
 * how a bad report will differ from a good one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { extractFromLines, parseMoney, compareNames, joinWrapped } = require('../extract');

const FIXTURE = path.join(__dirname, 'fixtures', 'lenskart-page1.lines.json');
const REFERENCE = path.join(__dirname, '..', '..', 'data', 'lenskart-2026-05-21.json');
const FILENAME = '131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf';
const SOURCE_URL = 'https://ks-oncloudpublic-reports.s3.ap-south-1.amazonaws.com/jaamoon-pdf-files/' + FILENAME;
// The reference report is dated 2026-05-21; pin "now" so staleness warnings are
// deterministic and the suite does not start failing with the calendar.
const NOW = '2026-05-22T09:00:00Z';

const baseLines = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function run(lines, opts) {
  return extractFromLines(lines || baseLines(), Object.assign({
    filename: FILENAME, sourceUrl: SOURCE_URL, now: NOW, pageCount: 4,
    tickerMap: { LENSKART: { slug: 'lenskart-solutions-share-price' } }
  }, opts || {}));
}

/** Replace the text of the line matching `needle`. */
function edit(lines, needle, replacement) {
  const i = lines.findIndex((l) => l.text.includes(needle));
  assert.ok(i >= 0, `fixture has no line containing "${needle}"`);
  if (replacement === null) lines.splice(i, 1);
  else lines[i] = Object.assign({}, lines[i], { text: replacement });
  return lines;
}

const codes = (list) => list.map((e) => e.code);

/* ------------------------------------------------------- the happy path */

test('reference PDF: extracts every mandatory field correctly', () => {
  const r = run();
  assert.equal(r.ok, true, 'errors: ' + JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);

  assert.equal(r.report.schemaVersion, '1.0');
  assert.equal(r.report.reportId, '131440_1');
  assert.equal(r.report.publishedAt, '2026-05-21');
  assert.equal(r.report.stock.name, 'Lenskart Solutions');
  assert.equal(r.report.stock.ticker, 'LENSKART');
  assert.equal(r.report.report.type, 'Result Update');
  assert.equal(r.report.report.period, 'Q4FY26');
  assert.equal(r.report.report.template, 'One Pager');
  assert.equal(r.report.recommendation.rating, 'ADD');
  assert.equal(r.report.recommendation.cmp, 487);
  assert.equal(r.report.recommendation.fairValue, 560);
  assert.equal(r.report.recommendation.currency, 'INR');
  assert.equal(r.report.recommendation.holdingPeriod, '12 months');
  assert.equal(r.report.sourcePdf, SOURCE_URL);
});

test('reference PDF: narrative matches the hand-transcribed reference byte for byte', () => {
  const r = run();
  const reference = JSON.parse(fs.readFileSync(REFERENCE, 'utf8'));
  assert.equal(r.report.sections.length, reference.sections.length);
  for (let i = 0; i < reference.sections.length; i++) {
    assert.equal(r.report.sections[i].id, reference.sections[i].id);
    assert.equal(r.report.sections[i].title, reference.sections[i].title);
    assert.equal(r.report.sections[i].tone, reference.sections[i].tone);
    assert.deepEqual(r.report.sections[i].bullets, reference.sections[i].bullets,
      `section "${reference.sections[i].title}" bullets differ`);
  }
});

test('reference PDF: wrapped lines rejoin, including the hyphenated break', () => {
  const r = run();
  const negatives = r.report.sections.find((s) => s.id === 'negatives');
  assert.match(negatives.bullets[0], /pressure on cross-currency rates/);
  assert.ok(!/cross- currency/.test(negatives.bullets[0]), 'hyphen break must not leave a space');
  assert.ok(r.notes.some((n) => /line-break hyphen/.test(n)), 'the join should be recorded for audit');
});

test('reference PDF: the glossary is captured and the disclaimer is not swallowed', () => {
  const r = run();
  assert.match(r.report.abbreviations, /^EBITDA - Earnings Before Interest/);
  assert.match(r.report.abbreviations, /FCF/);
  assert.match(r.report.attribution, /^The content of this document has been derived from KIE research report/);
  assert.match(r.report.attribution, /take their own professional advice before investing\.$/);
  // The glossary must not have leaked into the last Negatives bullet.
  const negatives = r.report.sections.find((s) => s.id === 'negatives');
  assert.ok(!/EBITDA - Earnings/.test(negatives.bullets[0]));
});

/* --------------------------------------- the hidden ") - SELL" on page 1 */

test('the invisible leftover rating on page 1 is ignored, and flagged', () => {
  const r = run();
  assert.equal(r.report.recommendation.rating, 'ADD');
  assert.ok(codes(r.warnings).includes('STRAY_RATING_TEXT'),
    'the operator must be told that other rating-like text exists on the page');
  assert.deepEqual(r.evidence.ignoredLines, [') - SELL']);
});

test('two complete, conflicting headlines are a refusal, not a coin toss', () => {
  const lines = baseLines();
  lines.push({ index: lines.length, text: 'Lenskart Solutions (LENSKART) - SELL', x0: 145, x1: 452, y: 700, height: 20 });
  const r = run(lines);
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('AMBIGUOUS_TITLE'));
});

test('a headline for a different company loses to the one matching the filename', () => {
  const lines = baseLines();
  lines.push({ index: lines.length, text: 'Some Other Co (OTHER) - SELL', x0: 145, x1: 452, y: 700, height: 20 });
  const r = run(lines);
  assert.equal(r.ok, true);
  assert.equal(r.report.recommendation.rating, 'ADD');
  assert.equal(r.report.stock.ticker, 'LENSKART');
});

/* ------------------------------------------------- refusing to guess */

test('a missing CMP label is an error, never a nearby number', () => {
  const r = run(edit(baseLines(), 'Current Market Price (CMP)', null));
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('LABEL_NOT_FOUND'));
  assert.match(r.errors.find((e) => e.code === 'LABEL_NOT_FOUND').message, /Current Market Price/);
});

test('two CMP labels with different values is a refusal', () => {
  const lines = baseLines();
  lines.push({ index: lines.length, text: 'Current Market Price (CMP)', x0: 93, x1: 242, y: 600, height: 12 });
  lines.push({ index: lines.length + 1, text: 'Rs.999', x0: 150, x1: 185, y: 586, height: 12 });
  const r = run(lines);
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('AMBIGUOUS_VALUE'));
});

test('a non-numeric CMP is an error', () => {
  const r = run(edit(baseLines(), 'Rs.487', 'N.A.'));
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).some((c) => c === 'CMP_NOT_A_NUMBER' || c === 'LABEL_NOT_FOUND'));
});

test('an unparseable date is an error, never today', () => {
  const r = run(edit(baseLines(), 'Dated:', 'Dated: sometime last week'));
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('DATE_UNPARSEABLE'));
});

test('a rating outside the PCG scale is an error', () => {
  const r = run(edit(baseLines(), 'Lenskart Solutions (LENSKART) - ADD', 'Lenskart Solutions (LENSKART) - ACCUMULATE'));
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('UNKNOWN_RATING'));
});

test('a filename for a different company than the headline is an error', () => {
  const r = run(null, { filename: '131440_1_Titan_Company__One_Pager_Q4FY26_Result_Update.pdf' });
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('NAME_MISMATCH'));
});

test('a page with no text at all is an error, not an empty report', () => {
  const r = extractFromLines([], { filename: FILENAME, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('NO_TEXT'));
  assert.match(r.errors[0].message, /scan or image-only/);
});

test('a known heading is still recognised without its colon', () => {
  const lines = baseLines();
  edit(lines, 'Rationale:', 'Rationale');
  edit(lines, 'Positives:', 'Positives');
  edit(lines, 'Negatives:', 'Negatives');
  const r = run(lines);
  assert.equal(r.ok, true, 'errors: ' + JSON.stringify(r.errors));
  assert.deepEqual(r.report.sections.map((s) => s.id), ['rationale', 'positives', 'negatives']);
});

test('bullets under an unrecognisable heading are an error, not silently dropped', () => {
  // No colon and not in the known set: the heading cannot be detected, so its
  // bullets would vanish. Losing a bullet from a recommendation is not allowed.
  const r = run(edit(baseLines(), 'Rationale:', 'Investment view'));
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('ORPHAN_BULLETS'));
  assert.match(r.errors.find((e) => e.code === 'ORPHAN_BULLETS').message, /not inside any section/);
});

test('a filename the pattern does not fit still publishes, using a derived id', () => {
  // Files from kotakneo.com/uploads (and anything a human renamed) carry no id
  // or type. Page 1 states both, so refusing them was over-strict; what matters
  // is that the id is STABLE, so a re-run updates rather than duplicates.
  const res = run(baseLines(), { filename: 'some report.pdf' });
  assert.ok(res.ok, 'should publish');
  assert.ok(res.report.reportId, 'an id was derived');
  const again = run(baseLines(), { filename: 'renamed again.pdf' });
  assert.strictEqual(again.report.reportId, res.report.reportId,
    'the derived id must not change between runs, or re-runs would duplicate');
});

/* ----------------------------------------------------- cross-checks */

test('a fair value inconsistent with the rating raises a warning', () => {
  // Rs.900 against CMP 487 is +85%, which is the BUY band, not ADD.
  const r = run(edit(baseLines(), 'Rs.560', 'Rs.900'));
  assert.equal(r.ok, true, 'still publishable -- but the human must be told');
  assert.ok(codes(r.warnings).includes('RATING_BAND_MISMATCH'));
});

test('the reference report sits inside its own rating band, so no warning fires', () => {
  const r = run();
  assert.ok(!codes(r.warnings).includes('RATING_BAND_MISMATCH'));
});

test('a stale report date warns but does not block', () => {
  const r = run(null, { now: '2026-09-01T00:00:00Z' });
  assert.equal(r.ok, true);
  assert.ok(codes(r.warnings).includes('REPORT_STALE'));
});

test('a truncated bullet is flagged', () => {
  const lines = edit(baseLines(), 'currency rates. This has flowed through to the cost of imports.', null);
  const r = run(lines);
  assert.ok(codes(r.warnings).includes('BULLET_TRUNCATED'),
    'a bullet ending on "cross-" must be reported as possibly cut short');
});

test('CMP and fair value in different currencies is an error', () => {
  const r = run(edit(baseLines(), 'Rs.560', '$560'));
  assert.equal(r.ok, false);
  assert.ok(codes(r.errors).includes('CURRENCY_MISMATCH'));
});

/* ------------------------------------------------------ NR / RS reports */

test('a report with no fair value still publishes, with the tiles omitted', () => {
  const lines = baseLines();
  edit(lines, 'Fair Value (FV)', null);
  edit(lines, 'Rs.560', null);
  edit(lines, 'Lenskart Solutions (LENSKART) - ADD', 'Lenskart Solutions (LENSKART) - NR');
  const r = run(lines);
  assert.equal(r.ok, true, 'errors: ' + JSON.stringify(r.errors));
  assert.equal(r.report.recommendation.fairValue, null);
  assert.equal(r.report.recommendation.rating, 'NR');
  assert.ok(codes(r.warnings).includes('FV_NOT_FOUND'));
});

test('an explicit "NA" fair value becomes null, not zero', () => {
  const r = run(edit(baseLines(), 'Rs.560', 'NA'));
  assert.equal(r.ok, true, 'errors: ' + JSON.stringify(r.errors));
  assert.equal(r.report.recommendation.fairValue, null);
});

/* ------------------------------------------------------- side-by-side */

test('side-by-side labels bind to the value beneath each, not to the nearer one in reading order', () => {
  const r = run();
  // In the fixture, CMP's value (line 34) precedes the FV label (line 35): a
  // "next value-shaped line" rule would give FV = 487.
  assert.equal(r.report.recommendation.cmp, 487);
  assert.equal(r.report.recommendation.fairValue, 560);
  assert.equal(r.evidence.cmp.via, 'below');
  assert.equal(r.evidence.fairValue.via, 'below');
});

test('an inline "CMP: Rs.512" is read without geometry', () => {
  const r = extractFromLines([
    { text: 'Dated: 21 May 2026' },
    { text: 'Acme Industries (ACME) - BUY' },
    { text: 'Current Market Price (CMP): Rs.512' },
    { text: 'Fair Value (FV): Rs.640' },
    { text: 'Holding Period: 12 months' },
    { text: 'Rationale:' },
    { text: '• A single complete bullet for the test.' }
  ], {
    filename: '900_1_Acme_Industries__One_Pager_Q1FY27_Result_Update.pdf',
    now: '2026-05-22T00:00:00Z', pageCount: 4
  });
  assert.equal(r.ok, true, 'errors: ' + JSON.stringify(r.errors));
  assert.equal(r.report.recommendation.cmp, 512);
  assert.equal(r.report.recommendation.fairValue, 640);
  assert.equal(r.evidence.cmp.via, 'inline');
});

/* ------------------------------------------------------ configurability */

test('unrecognised section headings still publish, with a warning', () => {
  const r = run(edit(baseLines(), 'Positives:', 'Key strengths:'));
  assert.equal(r.ok, true, 'errors: ' + JSON.stringify(r.errors));
  assert.ok(codes(r.warnings).includes('UNKNOWN_SECTION'));
  assert.ok(r.report.sections.some((s) => s.title === 'Key strengths'));
});

test('SECTION_MAP can name and tone a new heading without touching code', () => {
  const r = run(edit(baseLines(), 'Positives:', 'Key strengths:'), {
    sections: [
      { match: '^rationale$', id: 'rationale', title: 'Rationale', tone: 'neutral', icon: 'rationale' },
      { match: '^key strengths$', id: 'positives', title: 'Positives', tone: 'positive', icon: 'positive' },
      { match: '^negatives?$', id: 'negatives', title: 'Negatives', tone: 'negative', icon: 'negative' }
    ]
  });
  assert.equal(r.ok, true);
  assert.ok(!codes(r.warnings).includes('UNKNOWN_SECTION'));
  const s = r.report.sections.find((x) => x.id === 'positives');
  assert.equal(s.title, 'Positives');
  assert.equal(s.tone, 'positive');
});

test('SLUG_TEMPLATE derives a slug and says so', () => {
  const r = run(null, { tickerMap: {}, slugTemplate: '{name}-share-price' });
  assert.equal(r.report.stock.slug, 'lenskart-solutions-share-price');
  assert.ok(codes(r.warnings).includes('SLUG_DERIVED'));
});

test('with no ticker map and no template the slug is null, with a warning, and the block still renders', () => {
  const r = run(null, { tickerMap: {} });
  assert.equal(r.ok, true);
  assert.equal(r.report.stock.slug, null);
  assert.ok(codes(r.warnings).includes('SLUG_UNKNOWN'));
});

/* -------------------------------------------------------------- units */

test('parseMoney', () => {
  assert.deepEqual(parseMoney('Rs.487'), { value: 487, currency: 'INR', raw: 'Rs.487' });
  assert.equal(parseMoney('1,234.50').value, 1234.5);
  assert.equal(parseMoney('₹ 560').currency, 'INR');
  assert.equal(parseMoney('$99').currency, 'USD');
  assert.equal(parseMoney('Retain ADD.'), null);
  assert.equal(parseMoney('487 shares'), null);
});

test('compareNames', () => {
  assert.equal(compareNames('Lenskart Solutions', 'Lenskart Solutions'), 'match');
  assert.equal(compareNames('Lenskart Solutions', 'Lenskart Solutions Ltd'), 'match');
  assert.equal(compareNames('Bajaj Finserv', 'Bajaj Finance'), 'partial');
  assert.equal(compareNames('Lenskart Solutions', 'Titan Company'), 'mismatch');
});

test('joinWrapped', () => {
  const notes = [];
  const dg = { note: (m) => notes.push(m) };
  assert.equal(joinWrapped(['pressure on cross-', 'currency rates.'], dg), 'pressure on cross-currency rates.');
  assert.equal(notes.length, 1);
  assert.equal(joinWrapped(['growth in the', 'India business.'], dg), 'growth in the India business.');
});
