'use strict';
/**
 * End-to-end tests: real PDF on disk -> extract -> render.js -> publisher.
 *
 * These exercise the actual renderer in ../../src/render.js, so a change to the
 * schema contract that the extractor does not satisfy fails here rather than in
 * production.
 *
 * The reference PDF is not committed (it is a 330 KB binary owned by the
 * research team). Point BOT_TEST_PDF at a copy to run the PDF-backed tests; the
 * line-level tests in extract.test.js cover the parser either way.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { load } = require('../config');
const { createLogger } = require('../lib/logger');
const { createSource } = require('../sources');
const { createPublisher } = require('../publishers');
const { Pipeline } = require('../pipeline');
const { extractFromLines } = require('../extract');

const quiet = createLogger({ level: 'silent' });
const FIXTURE = path.join(__dirname, 'fixtures', 'lenskart-page1.lines.json');
const FILENAME = '131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf';
const TEST_PDF = process.env.BOT_TEST_PDF || null;

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'krb-pipe-')); }

function renderer() {
  return require(path.join(__dirname, '..', '..', 'src', 'render.js'));
}

/* -------------------------------------- the extractor meets the renderer */

test('the extractor output satisfies render.js validate() and renders a block', () => {
  const r = extractFromLines(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), {
    filename: FILENAME, now: '2026-05-22T00:00:00Z', pageCount: 4,
    sourceUrl: 'https://example.test/' + FILENAME
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));

  const { validate, renderBlock, computeUpside } = renderer();
  assert.equal(validate(r.report), true);

  const html = renderBlock(r.report, { inlineCss: true });
  assert.match(html, /Lenskart Solutions/);
  assert.match(html, /LENSKART/);
  assert.match(html, /krb__verdict-value">ADD</);
  assert.match(html, /<style>/, 'inlineCss must embed the stylesheet');
  assert.equal(computeUpside(487, 560).toFixed(1), '15.0');
});

test('extracted text is escaped, so a hostile PDF cannot inject markup', () => {
  const lines = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const i = lines.findIndex((l) => l.text.includes('Balance sheet healthy'));
  lines[i] = Object.assign({}, lines[i], {
    text: '• <img src=x onerror=alert(1)> "quoted" & <script>bad()</script>'
  });
  const r = extractFromLines(lines, { filename: FILENAME, now: '2026-05-22T00:00:00Z', pageCount: 4 });
  assert.equal(r.ok, true, JSON.stringify(r.errors));

  const html = renderer().renderBlock(r.report, {});
  assert.ok(!html.includes('<img src=x'), 'raw markup must not reach the DOM');
  assert.ok(!html.includes('<script>bad()'), 'raw script must not reach the DOM');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

/* --------------------------------------------------- full pipeline runs */

test('file source + file publisher: creates, then reports unchanged', { skip: !TEST_PDF && 'set BOT_TEST_PDF to a copy of the reference PDF' }, async () => {
  const dir = tmpdir();
  const pdf = path.join(dir, FILENAME);
  fs.copyFileSync(TEST_PDF, pdf);

  const cfg = load({ mode: 'live', sourceType: 'file', publisherType: 'file', file: pdf }, {
    BOT_STATE_DIR: path.join(dir, 'state'),
    PUBLISH_DIR: path.join(dir, 'out'),
    BOT_MODE: 'live',
    SOURCE_PUBLIC_BASE_URL: 'https://example.test/reports',
    MAX_REPORT_AGE_DAYS: '100000'
  });
  const source = createSource(cfg, { logger: quiet });
  const publisher = createPublisher(cfg, { logger: quiet });
  const pipeline = new Pipeline(cfg, { logger: quiet, source, publisher });

  const first = await pipeline.process(pdf);
  assert.equal(first.status, 'published', JSON.stringify(first.errors));
  assert.equal(first.action, 'written');
  assert.equal(first.reportId, '131440_1');

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'out', '131440_1.json'), 'utf8'));
  assert.equal(written.recommendation.cmp, 487);
  assert.ok(fs.readFileSync(path.join(dir, 'out', '131440_1.html'), 'utf8').includes('Lenskart Solutions'));

  const second = await pipeline.process(pdf);
  assert.equal(second.status, 'unchanged', 'a re-run of the same report must not rewrite it');
});

test('a PDF that is not a PDF is rejected and dead-lettered', async () => {
  const dir = tmpdir();
  const bogus = path.join(dir, FILENAME);
  fs.writeFileSync(bogus, '<html><body>403 Forbidden</body></html>');

  const cfg = load({ mode: 'live', sourceType: 'file', publisherType: 'file', file: bogus }, {
    BOT_STATE_DIR: path.join(dir, 'state'), PUBLISH_DIR: path.join(dir, 'out'), BOT_MODE: 'live'
  });
  const pipeline = new Pipeline(cfg, {
    logger: quiet,
    source: createSource(cfg, { logger: quiet }),
    publisher: createPublisher(cfg, { logger: quiet })
  });

  const outcome = await pipeline.process(bogus);
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.failureCode, 'EXTRACTION_FAILED');
  assert.match(outcome.errors[0].message, /not a PDF/);
  assert.ok(fs.existsSync(outcome.deadLetter), 'a dead-letter record must exist for the human');
  const record = JSON.parse(fs.readFileSync(outcome.deadLetter, 'utf8'));
  assert.equal(record.status, 'rejected');
  assert.equal(fs.existsSync(path.join(dir, 'out')), false, 'nothing may be published');
});

test('a publisher failure is dead-lettered as "failed" (retryable), not "rejected"', { skip: !TEST_PDF && 'set BOT_TEST_PDF' }, async () => {
  const dir = tmpdir();
  const pdf = path.join(dir, FILENAME);
  fs.copyFileSync(TEST_PDF, pdf);

  const cfg = load({ mode: 'live', sourceType: 'file', publisherType: 'file', file: pdf }, {
    BOT_STATE_DIR: path.join(dir, 'state'), BOT_MODE: 'live',
    PUBLISHER_TYPE: 'file', PUBLISH_DIR: path.join(dir, 'out'), MAX_REPORT_AGE_DAYS: '100000'
  });
  let attempts = 0;
  const publisher = {
    kind: 'stub',
    describe: () => 'always fails',
    publish: async () => { attempts++; throw new Error('Strapi is down'); }
  };
  const pipeline = new Pipeline(cfg, { logger: quiet, source: createSource(cfg, { logger: quiet }), publisher });

  const outcome = await pipeline.process(pdf);
  assert.equal(outcome.status, 'failed', 'a transport failure is retryable, not a content problem');
  assert.equal(outcome.failureCode, 'PUBLISH_FAILED');
  assert.equal(attempts, 1);
  assert.ok(fs.existsSync(outcome.deadLetter));
  // The PDF is kept beside the record, so the failure can be replayed after
  // the object has been rotated out of the bucket.
  assert.ok(fs.existsSync(outcome.deadLetter.replace(/\.json$/, '.pdf')));
});

test('an alert is POSTed to the internal endpoint on failure', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = tmpdir();
  try {
    const cfg = load({ mode: 'live', sourceType: 'file', file: 'x' }, {
      BOT_STATE_DIR: path.join(dir, 'state'), BOT_MODE: 'live', PUBLISHER_TYPE: 'file',
      ALERT_WEBHOOK_URL: `http://127.0.0.1:${server.address().port}/alerts`
    });
    const pipeline = new Pipeline(cfg, {
      logger: quiet, source: createSource(cfg, { logger: quiet }), publisher: createPublisher(cfg, { logger: quiet })
    });
    await pipeline.alert([{ status: 'rejected', ref: 'x.pdf', reportId: '1_1', failureCode: 'EXTRACTION_FAILED', failureMessage: 'boom', errors: [] }]);
    assert.equal(received.length, 1);
    assert.equal(received[0].source, 'kotak-research-report-bot');
    assert.equal(received[0].failures[0].code, 'EXTRACTION_FAILED');
  } finally { await new Promise((r) => server.close(r)); }
});

/* -------------------------------------------------------- source units */

test('the directory source refuses a path that escapes SOURCE_DIR', () => {
  const dir = tmpdir();
  const cfg = load({}, { BOT_STATE_DIR: path.join(dir, 'state'), SOURCE_TYPE: 'dir', SOURCE_DIR: dir });
  const source = createSource(cfg, { logger: quiet });
  assert.throws(() => source.resolve('../../etc/passwd'), /resolves outside SOURCE_DIR/);
});

test('the directory source ignores files that are still being written', async () => {
  const dir = tmpdir();
  const cfg = load({}, { BOT_STATE_DIR: path.join(dir, 'state'), SOURCE_TYPE: 'dir', SOURCE_DIR: dir });
  const source = createSource(cfg, { logger: quiet });
  fs.writeFileSync(path.join(dir, 'fresh.pdf'), 'x');
  assert.deepEqual(await source.list({ settleMs: 60000 }), [], 'a file touched a moment ago is not ready');
  assert.equal((await source.list({ settleMs: 0 })).length, 1);
});

test('the http source explains why it cannot enumerate', async () => {
  const cfg = load({}, { BOT_STATE_DIR: tmpdir(), SOURCE_URL: 'https://example.test/a.pdf' });
  const source = createSource(cfg, { logger: quiet });
  await assert.rejects(() => source.list(), /cannot enumerate/);
});

test('a dry run always uses the console publisher, whatever PUBLISHER_TYPE says', () => {
  const cfg = load({}, { BOT_STATE_DIR: tmpdir(), SOURCE_URL: 'https://example.test/a.pdf', PUBLISHER_TYPE: 'strapi' });
  assert.equal(createPublisher(cfg, { logger: quiet }).kind, 'console');
});
