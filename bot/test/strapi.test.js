'use strict';
/**
 * Strapi client tests, against a fake Strapi that can speak either the v4 or
 * the v5 envelope. The point is that ONE code path handles both, and that a
 * re-run for the same reportId updates instead of duplicating.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { StrapiClient, buildFields, contentHash, canonicalJson } = require('../strapi');
const { createLogger } = require('../lib/logger');

const quiet = createLogger({ level: 'silent' });

/* ------------------------------------------------------- fake Strapi */

/**
 * @param {'v4'|'v5'} version
 * @returns {Promise<{url, close, entries, requests, fail}>}
 */
async function fakeStrapi(version, opts) {
  const o = opts || {};
  const entries = [];
  const requests = [];
  let nextId = 1;
  let failures = o.failFirst || 0;

  const wrap = (e) => (version === 'v4'
    ? { id: e.id, attributes: Object.assign({}, e.fields) }
    : Object.assign({ id: e.id, documentId: e.documentId }, e.fields));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization });

      if (failures > 0) { failures--; res.writeHead(503); return res.end('upstream busy'); }
      if (o.requireAuth && req.headers.authorization !== `Bearer ${o.requireAuth}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { status: 401, message: 'Missing or invalid credentials' } }));
      }

      const parts = url.pathname.split('/').filter(Boolean);   // ['api','research-reports', key?]
      if (parts[0] !== 'api' || parts[1] !== 'research-reports') { res.writeHead(404); return res.end('{}'); }
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET') {
        const want = url.searchParams.get('filters[reportId][$eq]');
        const found = want === null ? entries : entries.filter((e) => e.fields.reportId === want);
        return send(200, { data: found.map(wrap), meta: { pagination: { total: found.length } } });
      }
      if (req.method === 'POST') {
        const fields = JSON.parse(body).data;
        if (o.uniqueReportId && entries.some((e) => e.fields.reportId === fields.reportId)) {
          return send(400, { error: { status: 400, name: 'ValidationError', message: 'This attribute must be unique' } });
        }
        const e = { id: nextId, documentId: `doc${nextId}`, fields };
        nextId++;
        entries.push(e);
        return send(200, { data: wrap(e) });
      }
      if (req.method === 'PUT') {
        const key = decodeURIComponent(parts[2] || '');
        const e = entries.find((x) => (version === 'v4' ? String(x.id) : x.documentId) === key);
        if (!e) return send(404, { error: { status: 404, message: 'Not Found' } });
        Object.assign(e.fields, JSON.parse(body).data);
        return send(200, { data: wrap(e) });
      }
      send(405, {});
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    entries, requests,
    close: () => new Promise((r) => server.close(r))
  };
}

function clientFor(url, extra) {
  return new StrapiClient(Object.assign({
    url, apiPrefix: '/api', collection: 'research-reports',
    token: 'test-token', authScheme: 'Bearer', authHeader: 'Authorization',
    apiVersion: 'auto', extraHeaders: {}, fieldMap: {}, idField: 'reportId',
    locale: null, timeoutMs: 5000, retries: 2, draftAndPublish: 'off'
  }, extra || {}), { logger: quiet });
}

const FIELDS = (n) => ({ reportId: '131440_1', stockName: 'Lenskart Solutions', rating: 'ADD', cmp: 487, contentHash: n || 'h1' });

/* ------------------------------------------------------------ version */

for (const version of ['v4', 'v5']) {
  test(`${version}: the API shape is detected from a real response`, async () => {
    const s = await fakeStrapi(version);
    try {
      const c = clientFor(s.url);
      await c.create(FIELDS());
      const found = await c.findByReportId('131440_1');
      assert.equal(c.version, version);
      assert.equal(found.fields.rating, 'ADD');
      assert.equal(found.key, version === 'v4' ? 1 : 'doc1');
    } finally { await s.close(); }
  });

  test(`${version}: a second run for the same reportId updates, it does not duplicate`, async () => {
    const s = await fakeStrapi(version, { uniqueReportId: true });
    try {
      const c = clientFor(s.url);
      const first = await c.upsert('131440_1', FIELDS('h1'), { hash: 'h1', hashField: 'contentHash' });
      assert.equal(first.action, 'created');

      const second = await c.upsert('131440_1', FIELDS('h2'), { hash: 'h2', hashField: 'contentHash' });
      assert.equal(second.action, 'updated');
      assert.equal(s.entries.length, 1, 'exactly one entry must exist for one reportId');
      assert.equal(s.entries[0].fields.contentHash, 'h2');

      // v5 must have been addressed by documentId, v4 by id.
      const puts = s.requests.filter((r) => r.method === 'PUT');
      assert.equal(puts.length, 1);
      assert.equal(puts[0].path, `/api/research-reports/${version === 'v4' ? '1' : 'doc1'}`);
    } finally { await s.close(); }
  });

  test(`${version}: identical content is a no-op`, async () => {
    const s = await fakeStrapi(version);
    try {
      const c = clientFor(s.url);
      await c.upsert('131440_1', FIELDS('same'), { hash: 'same', hashField: 'contentHash' });
      const again = await c.upsert('131440_1', FIELDS('same'), { hash: 'same', hashField: 'contentHash' });
      assert.equal(again.action, 'unchanged');
      assert.equal(s.requests.filter((r) => r.method === 'PUT').length, 0, 'nothing should be written');
    } finally { await s.close(); }
  });
}

test('a create that loses the unique-constraint race becomes an update', async () => {
  const s = await fakeStrapi('v5', { uniqueReportId: true });
  try {
    // Another process got there first.
    await clientFor(s.url).create(FIELDS('other'));

    const c = clientFor(s.url);
    // Force the create path even though an entry exists, as a real race would.
    c.findByReportId = async function (id) {
      if (!this._called) { this._called = true; return null; }
      return StrapiClient.prototype.findByReportId.call(this, id);
    };
    const res = await c.upsert('131440_1', FIELDS('mine'), { hash: 'mine', hashField: 'contentHash' });
    assert.equal(res.action, 'updated');
    assert.equal(s.entries.length, 1, 'the race must not leave two entries behind');
  } finally { await s.close(); }
});

test('duplicates already in Strapi are reported, not silently picked from', async () => {
  const s = await fakeStrapi('v5');
  try {
    const c = clientFor(s.url);
    await c.create(FIELDS('a'));
    await c.create(FIELDS('b'));
    await assert.rejects(() => c.findByReportId('131440_1'), /2 entries with reportId/);
  } finally { await s.close(); }
});

/* ------------------------------------------------------ transport */

test('a 503 is retried and then succeeds', async () => {
  const s = await fakeStrapi('v5', { failFirst: 2 });
  try {
    const c = clientFor(s.url, { retries: 3 });
    const res = await c.upsert('131440_1', FIELDS(), {});
    assert.equal(res.action, 'created');
    assert.ok(s.requests.length >= 3);
  } finally { await s.close(); }
});

test('a 401 is not retried and produces an actionable hint', async () => {
  const s = await fakeStrapi('v5', { requireAuth: 'the-real-token' });
  try {
    const c = clientFor(s.url, { token: 'wrong', retries: 3 });
    const h = await c.health();
    assert.equal(h.ok, false);
    assert.equal(h.status, 401);
    assert.match(h.hint, /STRAPI_API_TOKEN was rejected/);
    assert.equal(s.requests.length, 1, '4xx must not be retried');
  } finally { await s.close(); }
});

test('a configurable auth scheme and extra headers are sent', async () => {
  const s = await fakeStrapi('v5');
  try {
    const c = clientFor(s.url, { authScheme: 'Token', extraHeaders: { 'x-gateway-key': 'abc' } });
    await c.create(FIELDS());
    assert.equal(s.requests[0].auth, 'Token test-token');
  } finally { await s.close(); }
});

/* ------------------------------------------------------ field mapping */

const REPORT = {
  schemaVersion: '1.0', reportId: '131440_1', sourcePdf: 'https://example/x.pdf', publishedAt: '2026-05-21',
  stock: { name: 'Lenskart Solutions', ticker: 'LENSKART', slug: 'lenskart-solutions-share-price' },
  report: { type: 'Result Update', period: 'Q4FY26', template: 'One Pager' },
  recommendation: { rating: 'ADD', cmp: 487, fairValue: 560, currency: 'INR', holdingPeriod: '12 months' },
  sections: [{ id: 'rationale', title: 'Rationale', bullets: ['a'] }]
};

test('the default map sends the report date as reportDate, never as publishedAt', () => {
  const { fields } = buildFields(REPORT, '<div/>', {
    fieldMap: require('../config').DEFAULT_FIELD_MAP
  }, { hash: 'h', publishState: 'live' });
  assert.equal(fields.reportDate, '2026-05-21');
  assert.ok(!('publishedAt' in fields), 'publishedAt is reserved by Strapi Draft & Publish');
  assert.equal(fields.stockName, 'Lenskart Solutions');
  assert.equal(fields.cmp, 487);
  assert.equal(fields.renderedHtml, '<div/>');
  assert.deepEqual(fields.payload, REPORT);
});

test('renaming a field is a config change', () => {
  const { fields } = buildFields(REPORT, '<div/>', {
    fieldMap: { reportId: 'jamun_id', stockName: 'company', rating: 'call', renderedHtml: 'body_html' }
  }, {});
  assert.deepEqual(Object.keys(fields).sort(), ['body_html', 'call', 'company', 'jamun_id']);
  assert.equal(fields.jamun_id, '131440_1');
});

test('mapping a field to null drops it', () => {
  const { fields } = buildFields(REPORT, '<div/>', {
    fieldMap: { reportId: 'reportId', payload: null, renderedHtml: null }
  }, {});
  assert.deepEqual(Object.keys(fields), ['reportId']);
});

test('mapping onto a Strapi-reserved name is refused with an explanation', () => {
  const { fields, warnings } = buildFields(REPORT, '<div/>', {
    fieldMap: { reportId: 'reportId', reportDate: 'publishedAt' }
  }, {});
  assert.ok(!('publishedAt' in fields));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /publishedAt.*changes whether the entry is live/s);
});

/* ---------------------------------------------------------- hashing */

test('the content hash ignores key order but not values', () => {
  const a = { x: 1, y: { b: 2, a: 1 } };
  const b = { y: { a: 1, b: 2 }, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(contentHash(a, 'h'), contentHash(b, 'h'));
  assert.notEqual(contentHash(a, 'h'), contentHash(a, 'h2'));
  assert.notEqual(contentHash({ x: 1 }, 'h'), contentHash({ x: 2 }, 'h'));
});

test('publishState is part of the hash, so shadow -> live is a real change', () => {
  const r = { x: 1 };
  assert.notEqual(
    contentHash(r, '<div/>', { publishState: 'shadow' }),
    contentHash(r, '<div/>', { publishState: 'live' })
  );
});
