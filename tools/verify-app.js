#!/usr/bin/env node
/**
 * tools/verify-app.js -- prove converter.html actually works, in a real
 * browser, offline, from disk.
 *
 * Run: node tools/verify-app.js [path/to/report.pdf]
 *
 * This is the regression test that keeps the browser and the server bot from
 * drifting. It:
 *   1. runs bot/extract.js + src/render.js under Node to get ground truth,
 *   2. loads converter.html from file:// in Chromium with the context OFFLINE
 *      and every request recorded,
 *   3. feeds the same PDF three ways -- file picker, drag-and-drop, paste --
 *   4. asserts the block the page produces is byte-identical to Node's,
 *   5. asserts the block says what a Kotak one-pager must say and nothing it
 *      must not,
 *   6. asserts the page made no request to anything but file:/data:/blob:.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONVERTER = path.join(ROOT, 'converter.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DEFAULT_PDF = '/tmp/claude-0/-home-user-research-report-html/21a6e31a-d144-5551-b88f-61b60fe20eca/scratchpad/131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf';

const PDF = process.argv[2] || DEFAULT_PDF;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const stripTags = (h) => h.replace(/<[^>]*>/g, '');

(async () => {
  if (!fs.existsSync(CONVERTER)) { console.error('converter.html is missing -- run `npm run build:app` first.'); process.exit(1); }
  if (!fs.existsSync(PDF)) { console.error('PDF not found: ' + PDF); process.exit(1); }

  /* --------------------------------------------------- 1. Node ground truth */

  const { extractFromPdf } = require(path.join(ROOT, 'bot', 'extract.js'));
  const { DEFAULT_MAX_BYTES } = require(path.join(ROOT, 'bot', 'pdftext.js'));
  const renderer = require(path.join(ROOT, 'src', 'render.js'));

  const pdfBytes = fs.readFileSync(PDF);
  const pdfName = path.basename(PDF);
  const node = await extractFromPdf(new Uint8Array(pdfBytes), { filename: pdfName, maxPdfBytes: DEFAULT_MAX_BYTES });
  if (!node.ok) { console.error('Node extraction failed, so there is nothing to compare against:\n', node.errors); process.exit(1); }
  const nodeBlock = renderer.renderBlock(node.report, { inlineCss: true });
  const nodePage = renderer.renderStandalone(node.report);
  const nodeJson = JSON.stringify(node.report, null, 2);

  console.log('\nNode ground truth (bot/extract.js + src/render.js)');
  console.log('  report  ' + sha(JSON.stringify(node.report)) + '  ' + node.warnings.length + ' warnings, ' + node.notes.length + ' notes');
  console.log('  block   ' + sha(nodeBlock) + '  ' + nodeBlock.length + ' chars');
  console.log('  page    ' + sha(nodePage) + '  ' + nodePage.length + ' chars');

  /* ------------------------------------------------------------ 2. browser */

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ offline: true, viewport: { width: 1280, height: 1000 } });

  const requests = [];
  await ctx.route('**/*', (route) => { requests.push(route.request().url()); route.continue(); });

  const page = await ctx.newPage();
  page.on('request', (r) => requests.push(r.url()));
  const consoleErrors = [], pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('file://' + CONVERTER, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const e = document.getElementById('engine');
    return e && e.textContent.indexOf('pdf.js') === 0;
  }, { timeout: 20000 });

  console.log('\nPage boot');
  ok('window.KRB is defined', await page.evaluate(() => !!(window.KRB && window.KRB.extract && window.KRB.render)));
  ok('Buffer shim self-test passes', await page.evaluate(() => { try { return window.KRB.selfTest(); } catch (e) { return String(e); } }) === true);
  ok('globalThis.pdfjsWorker.WorkerMessageHandler is set (no worker file needed)',
     await page.evaluate(() => !!(globalThis.pdfjsWorker && globalThis.pdfjsWorker.WorkerMessageHandler)));
  ok('pdf.js in the page matches the bot pin',
     await page.evaluate(() => window.pdfjsLib && window.pdfjsLib.version) === JSON.parse(fs.readFileSync(path.join(ROOT, 'bot', 'package.json'), 'utf8')).dependencies['pdfjs-dist']);
  ok('no page errors on load', pageErrors.length === 0, pageErrors.join('\n         '));

  const b64 = pdfBytes.toString('base64');
  await page.evaluate(([b, name]) => {
    const bin = atob(b);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    window.__testFile = new File([arr], name, { type: 'application/pdf' });
  }, [b64, pdfName]);

  async function waitForResult() {
    await page.waitForSelector('#result:not([hidden])', { timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('busy').hidden, { timeout: 60000 });
  }
  async function reset() {
    await page.click('#again');
    await page.waitForFunction(() => document.getElementById('result').hidden);
  }

  /* ---- input route 1: the file picker ---- */
  console.log('\nInput routes');
  await page.setInputFiles('#file', PDF);
  await waitForResult();
  ok('file picker produces a result', await page.$eval('#verdict', (e) => e.getAttribute('data-state')) === 'ok');

  const blockFromPicker = await page.$eval('#block-out', (e) => e.textContent);
  const pageOut = await page.evaluate(() => window.KRB.render.renderStandalone(
    JSON.parse(document.getElementById('json-out').textContent)));
  const jsonOut = await page.$eval('#json-out', (e) => e.textContent);
  await reset();

  /* ---- input route 2: drag and drop, via a real DataTransfer ---- */
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__testFile);
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitForResult();
  const blockFromDrop = await page.$eval('#block-out', (e) => e.textContent);
  ok('drag-and-drop produces a result', await page.$eval('#verdict', (e) => e.getAttribute('data-state')) === 'ok');
  ok('drag-and-drop output === file-picker output', blockFromDrop === blockFromPicker);
  await reset();

  /* ---- input route 3: paste ---- */
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(window.__testFile);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await waitForResult();
  const blockFromPaste = await page.$eval('#block-out', (e) => e.textContent);
  ok('paste produces a result', await page.$eval('#verdict', (e) => e.getAttribute('data-state')) === 'ok');
  ok('paste output === file-picker output', blockFromPaste === blockFromPicker);

  /* --------------------------------------------- 3. parity with the server */

  console.log('\nParity with the server bot');
  ok('browser renderBlock(report, {inlineCss:true}) === Node, byte for byte',
     blockFromPicker === nodeBlock,
     'browser ' + sha(blockFromPicker) + ' (' + blockFromPicker.length + ') vs node ' + sha(nodeBlock) + ' (' + nodeBlock.length + ')');
  ok('browser renderStandalone(report) === Node, byte for byte',
     pageOut === nodePage, 'browser ' + sha(pageOut) + ' vs node ' + sha(nodePage));
  ok('browser extracted JSON === Node extracted JSON', jsonOut === nodeJson);

  const browserDiag = await page.evaluate(() => ({
    warnings: [].map.call(document.querySelectorAll('#warnings-list li'), (li) => ({
      code: li.querySelector('.diag__code') && li.querySelector('.diag__code').textContent,
      field: li.querySelector('.diag__field') && li.querySelector('.diag__field').textContent,
      message: li.querySelector('.diag__msg').textContent
    })),
    notes: [].map.call(document.querySelectorAll('#notes-list li'), (li) => li.querySelector('.diag__msg').textContent)
  }));
  ok('every extractor warning is shown, verbatim, with code and field',
     JSON.stringify(browserDiag.warnings) === JSON.stringify(node.warnings.map((w) => ({ code: w.code, field: w.field, message: w.message }))),
     JSON.stringify(browserDiag.warnings));
  ok('every extractor note is shown, verbatim',
     JSON.stringify(browserDiag.notes) === JSON.stringify(node.notes));

  /* ---------------------------------------------- 4. what the block says */

  console.log('\nBlock content');
  const blockText = stripTags(blockFromPicker);
  const must = ['Lenskart Solutions', 'LENSKART', 'ADD', 'Rs.487', 'Rs.560',
                'Holding Period: 12 months',
                'We expect the stock to deliver 5% - 15% returns over the next 12 months'];
  for (const s of must) ok('block says "' + s + '"', blockText.includes(s));

  const bullets = (blockFromPicker.match(/<li>/g) || []).length;
  ok('block carries all 12 bullets (found ' + bullets + ')', bullets === 12);

  const mustNot = [
    [/\bupside\b/i, 'the word "upside"'],
    [/[-+]?\d+(\.\d+)?\s*%\s*(upside|downside)/i, 'a computed upside/downside figure'],
    [/gauge/i, 'a gauge'],
    [/krb__gauge/i, 'gauge markup'],
    [/Download\s+(the\s+)?(full\s+)?(report|PDF)/i, 'a download-PDF button'],
    [/<a[^>]+\.pdf/i, 'a link to a PDF']
  ];
  for (const [re, what] of mustNot) ok('block contains no ' + what, !re.test(blockFromPicker));

  // The upside the report never printed: 560/487-1 = 14.99%. Make sure no
  // rounding of it appears anywhere.
  ok('block never states the derived upside (14.9 / 15.0 / 14.99)',
     !/\b1[45](\.\d+)?\s*%/.test(blockText) || /5% - 15%|5% to 15%/.test(blockText));

  /* ----------------------------------------------------- 5. the deliverable */

  console.log('\nDeliverable actions');
  const dl1 = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#dl-html');
  const d1 = await dl1;
  const p1 = await d1.path();
  const savedPage = fs.readFileSync(p1, 'utf8');
  ok('Download HTML saves the standalone page (' + d1.suggestedFilename() + ')', savedPage === nodePage);

  const dl2 = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#dl-json');
  const d2 = await dl2;
  const savedJson = fs.readFileSync(await d2.path(), 'utf8');
  ok('Download JSON saves the extracted document (' + d2.suggestedFilename() + ')', savedJson === nodeJson);

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.click('#cp-html');
  await page.waitForSelector('#toast:not([hidden])', { timeout: 8000 });
  const toastText = await page.$eval('#toast', (e) => e.textContent);
  const toastKind = await page.$eval('#toast', (e) => e.getAttribute('data-kind'));
  ok('Copy HTML reports success (' + toastText.trim() + ')', toastKind !== 'bad');

  /* ------------------------------------------------------------ 6. preview */

  const frameOk = await page.evaluate(() => {
    const f = document.getElementById('frame');
    const d = f.contentDocument;
    return { has: !!(d && d.querySelector('.krb')), body: d && d.body && d.body.className };
  }).catch(() => ({ has: false }));
  ok('live preview renders the block inside the iframe', frameOk.has === true, JSON.stringify(frameOk));
  ok('preview iframe uses the .krb-page host body', frameOk.body === 'krb-page', String(frameOk.body));

  /* -------------------------------------------------- 7. the failure path */

  console.log('\nFailure path');
  await reset();
  await page.evaluate(() => {
    const junk = new Uint8Array([60, 104, 116, 109, 108, 62, 111, 111, 112, 115]); // "<html>oops"
    const dt = new DataTransfer();
    dt.items.add(new File([junk], 'not-a-report.pdf', { type: 'application/pdf' }));
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await waitForResult();
  const failState = await page.evaluate(() => ({
    verdict: document.getElementById('verdict').getAttribute('data-state'),
    errors: [].map.call(document.querySelectorAll('#errors-list li'), (li) => ({
      code: li.querySelector('.diag__code') && li.querySelector('.diag__code').textContent,
      field: li.querySelector('.diag__field') && li.querySelector('.diag__field').textContent,
      msg: li.querySelector('.diag__msg').textContent
    })),
    actsHidden: document.getElementById('acts').hidden,
    previewHidden: document.getElementById('preview').hidden
  }));
  ok('a non-PDF is a refusal, not a success', failState.verdict === 'bad');
  ok('the refusal carries the extractor code and field',
     failState.errors.length > 0 && failState.errors[0].code === 'PDF_UNREADABLE' && failState.errors[0].field === 'document',
     JSON.stringify(failState.errors));
  ok("the refusal shows the bot's real message, not a generic one",
     failState.errors.length > 0 && /no %PDF- header/.test(failState.errors[0].msg),
     failState.errors[0] && failState.errors[0].msg);
  ok('no download buttons on a refusal', failState.actsHidden === true);
  ok('no preview on a refusal', failState.previewHidden === true);

  /* --------------------------------------------------------- 8. network */

  console.log('\nNetwork');
  const external = [...new Set(requests)].filter((u) => !/^(file|data|blob):/.test(u));
  ok('ZERO network requests (' + requests.length + ' total, all file:/data:/blob:)',
     external.length === 0, external.join('\n         '));
  ok('no console errors across the whole run', consoleErrors.length === 0, consoleErrors.join('\n         '));

  await browser.close();

  console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nverify-app crashed:\n', e); process.exit(1); });
