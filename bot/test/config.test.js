'use strict';
/**
 * Config tests. The contract is: fail at boot, name the variable, say what it
 * should look like -- never start half-configured.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { load, ConfigError, parseEnvFile, redactConfig, DEFAULT_FIELD_MAP } = require('../config');
const { parseFilename } = require('../lib/filename');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krb-cfg-'));
const baseEnv = (extra) => Object.assign({ BOT_STATE_DIR: tmp }, extra || {});

/* ------------------------------------------------------------ defaults */

test('the defaults are the safe ones: dry-run, one-shot, publishes nothing', () => {
  const cfg = load({}, baseEnv({ SOURCE_URL: 'https://example.test/a.pdf' }));
  assert.equal(cfg.mode, 'dry-run');
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.trigger.mode, 'once');
  assert.equal(cfg.source.type, 'http');
  assert.equal(cfg.publisher.type, 'strapi');
  assert.equal(cfg.failOnWarning, false);
});

test('a dry run does not demand Strapi credentials', () => {
  assert.doesNotThrow(() => load({}, baseEnv({ SOURCE_URL: 'https://example.test/a.pdf' })));
});

test('going live without STRAPI_URL or a token fails at boot, naming both', () => {
  try {
    load({}, baseEnv({ BOT_MODE: 'live', SOURCE_URL: 'https://example.test/a.pdf' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.problems.length, 2);
    assert.match(err.message, /STRAPI_URL is required/);
    assert.match(err.message, /STRAPI_API_TOKEN is required/);
    assert.match(err.message, /find\/create\/update/);
  }
});

test('every problem is reported at once, not one per restart', () => {
  try {
    load({}, baseEnv({ BOT_MODE: 'live', SOURCE_TYPE: 's3', TRIGGER_MODE: 'poll', STRAPI_URL: 'not-a-url' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.problems.length >= 3, 'expected several problems, got ' + JSON.stringify(err.problems));
    assert.ok(err.problems.some((p) => /S3_BUCKET/.test(p)));
    assert.ok(err.problems.some((p) => /STRAPI_URL/.test(p)));
  }
});

test('an unsupported enum value names the alternatives', () => {
  try {
    load({}, baseEnv({ TRIGGER_MODE: 'kafka', SOURCE_URL: 'https://example.test/a.pdf' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /TRIGGER_MODE: "kafka" is not supported. Use one of: once, poll, watch, webhook/);
  }
});

/* ----------------------------------------- environment-shaped guardrails */

test('polling S3 without credentials is refused at boot, with the reason', () => {
  try {
    load({}, baseEnv({ SOURCE_TYPE: 's3', TRIGGER_MODE: 'poll', S3_BUCKET: 'b' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /s3:ListBucket/);
    assert.match(err.message, /TRIGGER_MODE=watch/);
  }
});

test('half-set S3 credentials are refused', () => {
  try {
    load({}, baseEnv({ SOURCE_TYPE: 's3', S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'AKIA' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /must both be present/);
  }
});

test('a webhook without a secret is refused', () => {
  try {
    load({}, baseEnv({ TRIGGER_MODE: 'webhook', SOURCE_URL: 'https://example.test/a.pdf' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /WEBHOOK_SECRET/);
  }
});

test('watch mode without SOURCE_DIR is refused', () => {
  try {
    load({}, baseEnv({ TRIGGER_MODE: 'watch', SOURCE_TYPE: 'dir' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /SOURCE_DIR is required/);
  }
});

test('a SLUG_TEMPLATE with no placeholder is refused', () => {
  try {
    load({}, baseEnv({ SOURCE_URL: 'https://x.test/a.pdf', SLUG_TEMPLATE: 'share-price' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /SLUG_TEMPLATE must contain \{name\} or \{ticker\}/);
  }
});

/* ------------------------------------------------------- overriding */

test('the field map merges over the defaults instead of replacing them', () => {
  const cfg = load({}, baseEnv({
    SOURCE_URL: 'https://x.test/a.pdf',
    STRAPI_FIELD_MAP: '{"stockName":"company","payload":null}'
  }));
  assert.equal(cfg.publisher.strapi.fieldMap.stockName, 'company');
  assert.equal(cfg.publisher.strapi.fieldMap.payload, null);
  assert.equal(cfg.publisher.strapi.fieldMap.reportId, DEFAULT_FIELD_MAP.reportId);
});

test('JSON-valued settings accept a file path as well as inline JSON', () => {
  const file = path.join(tmp, 'tickers.json');
  fs.writeFileSync(file, JSON.stringify({ LENSKART: { slug: 'lenskart-solutions-share-price' } }));
  const cfg = load({}, baseEnv({ SOURCE_URL: 'https://x.test/a.pdf', BOT_TICKER_MAP: file }));
  assert.equal(cfg.extract.tickerMap.LENSKART.slug, 'lenskart-solutions-share-price');
});

test('malformed JSON in a setting is a boot failure, not a silent empty map', () => {
  try {
    load({}, baseEnv({ SOURCE_URL: 'https://x.test/a.pdf', STRAPI_FIELD_MAP: '{oops' }));
    assert.fail('should have thrown');
  } catch (err) {
    assert.match(err.message, /STRAPI_FIELD_MAP: not valid JSON/);
  }
});

test('--env-file is read, and real environment variables still win', () => {
  const file = path.join(tmp, 'bot.env');
  fs.writeFileSync(file, '# comment\nSOURCE_URL="https://from-file.test/a.pdf"\nMAX_REPORT_AGE_DAYS=30\n');
  const cfg = load({ envFile: file }, baseEnv({ MAX_REPORT_AGE_DAYS: '3' }));
  assert.equal(cfg.source.url, 'https://from-file.test/a.pdf');
  assert.equal(cfg.extract.maxReportAgeDays, 3, 'process.env must beat the env file');
});

test('parseEnvFile handles quotes, export and blank lines', () => {
  const got = parseEnvFile('\n# c\nexport A=1\nB="two words"\nC=\'three\'\nnonsense\n');
  assert.deepEqual(got, { A: '1', B: 'two words', C: 'three' });
});

/* -------------------------------------------------------- redaction */

test('secrets never survive into a printable config', () => {
  const cfg = load({}, baseEnv({
    BOT_MODE: 'live', SOURCE_URL: 'https://x.test/a.pdf',
    STRAPI_URL: 'https://cms.test', STRAPI_API_TOKEN: 'super-secret-token-value',
    STRAPI_EXTRA_HEADERS: '{"x-api-key":"another-secret"}'
  }));
  const printed = JSON.stringify(redactConfig(cfg));
  assert.ok(!printed.includes('super-secret-token-value'));
  assert.ok(!printed.includes('another-secret'));
  assert.match(printed, /<set:\d+ chars>/);
});

/* --------------------------------------------------------- filename */

test('filename metadata', () => {
  const m = parseFilename('131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf');
  assert.deepEqual(
    { id: m.reportId, s: m.stock, t: m.template, p: m.period, y: m.type },
    { id: '131440_1', s: 'Lenskart Solutions', t: 'One Pager', p: 'Q4FY26', y: 'Result Update' }
  );
});

test('filename metadata survives a full URL and percent-encoding', () => {
  const m = parseFilename('https://host/a/b/131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf?x=1');
  assert.equal(m.reportId, '131440_1');
  assert.equal(parseFilename('99_1_Tata_Motors__One_Pager_Q1FY27_Company%20Update.pdf').type, 'Company Update');
});

test('other period shapes are recognised', () => {
  for (const p of ['Q1FY27', '4QFY26', 'H1FY26', 'FY26', 'FY2026', 'CY25', '9MFY26']) {
    const m = parseFilename(`1_1_Acme__One_Pager_${p}_Result_Update.pdf`);
    assert.equal(m.period, p, `period ${p}`);
    assert.equal(m.type, 'Result Update');
  }
});

test('an unrecognised filename yields nulls and a warning, never a guess', () => {
  const m = parseFilename('report-final-v2.pdf');
  assert.equal(m.ok, false);
  assert.equal(m.reportId, null);
  assert.match(m.warnings[0], /FILENAME_PATTERN/);
});

test('FILENAME_PATTERN can replace the convention entirely', () => {
  const m = parseFilename('LENSKART-2026-05-21-result.pdf', {
    pattern: '^(?<stock>[A-Z]+)-(?<reportId>\\d{4}-\\d{2}-\\d{2})-(?<type>\\w+)$'
  });
  assert.equal(m.reportId, '2026-05-21');
  assert.equal(m.stock, 'LENSKART');
  assert.equal(m.type, 'result');
});
