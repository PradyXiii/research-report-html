'use strict';
/**
 * strapi.js -- Strapi REST client. No SDK; global fetch through lib/http.js.
 *
 * The two things this file exists to get right:
 *
 * 1. VERSION. Strapi v4 and v5 differ in ways that break a naive client:
 *
 *      v4  find    GET  /api/x?filters[reportId][$eq]=1  -> { data:[{ id, attributes:{...} }] }
 *          create  POST /api/x            { data:{...} } -> { data:{ id, attributes:{...} } }
 *          update  PUT  /api/x/:id        { data:{...} }
 *
 *      v5  find    (same query)                          -> { data:[{ id, documentId, ...fields }] }
 *          create  POST /api/x            { data:{...} } -> { data:{ id, documentId, ...fields } }
 *          update  PUT  /api/x/:documentId   { data:{...} }     <-- documentId, NOT id
 *
 *    We probe once at first use, cache the answer, and re-probe if a response
 *    turns up in the other shape. STRAPI_API_VERSION skips the probe.
 *
 * 2. IDEMPOTENCY. Re-running for the same reportId must update, never
 *    duplicate. We find by reportId, then create or update. Because two runs
 *    could race, `reportId` should be `unique: true` in the content type: the
 *    loser then gets a 400 on create, and we re-find and update instead of
 *    leaving a duplicate behind.
 *
 * Field names are never hard-coded: everything goes through cfg.fieldMap, and a
 * mapping of null drops the field entirely.
 */

const crypto = require('crypto');
const { request, HttpError } = require('./lib/http');

const RESERVED_STRAPI_FIELDS = new Set([
  'id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'locale', 'localizations'
]);

class StrapiClient {
  /**
   * @param {object} cfg  cfg.publisher.strapi
   * @param {object} deps { logger }
   */
  constructor(cfg, deps) {
    this.cfg = cfg;
    this.log = (deps && deps.logger) || null;
    this.version = cfg.apiVersion === 'auto' ? null : cfg.apiVersion;
    this.detectedFrom = cfg.apiVersion === 'auto' ? null : 'config';
    if (!cfg.url) throw new Error('STRAPI_URL is not set.');
  }

  get base() {
    return `${this.cfg.url}${this.cfg.apiPrefix}/${this.cfg.collection}`;
  }

  headers(extra) {
    const h = Object.assign({ accept: 'application/json' }, this.cfg.extraHeaders, extra || {});
    if (this.cfg.token) {
      // Scheme is configurable because we do not know what sits in front of
      // Strapi: a gateway may expect a different header or no scheme at all.
      h[this.cfg.authHeader] = this.cfg.authScheme
        ? `${this.cfg.authScheme} ${this.cfg.token}`
        : this.cfg.token;
    }
    return h;
  }

  async send(method, url, body, label) {
    const init = { method, headers: this.headers(body ? { 'content-type': 'application/json' } : {}) };
    if (body) init.body = JSON.stringify(body);
    return request(url, init, {
      retries: this.cfg.retries,
      timeoutMs: this.cfg.timeoutMs,
      logger: this.log,
      label: label || 'strapi'
    });
  }

  /* ------------------------------------------------------------ version */

  /**
   * Decide v4 vs v5 from a real response. An entry with `documentId` is v5; an
   * entry with an `attributes` envelope is v4. An empty collection tells us
   * nothing, so we fall back to v5 (current) and say so loudly -- an operator
   * who knows better sets STRAPI_API_VERSION.
   */
  detectFromEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (typeof entry.documentId === 'string' && entry.documentId) return 'v5';
    if (entry.attributes && typeof entry.attributes === 'object') return 'v4';
    return null;
  }

  adopt(version, how) {
    if (!version || version === this.version) return;
    if (this.version && this.cfg.apiVersion === 'auto') {
      this.log && this.log.warn('Strapi API shape changed under us; re-adopting', { was: this.version, now: version, how });
    }
    this.version = version;
    this.detectedFrom = how;
    this.log && this.log.info('Strapi API version resolved', { version, how });
  }

  async ensureVersion() {
    if (this.version) return this.version;
    const url = `${this.base}?pagination[pageSize]=1&fields[0]=${encodeURIComponent(this.cfg.idField)}`;
    const res = await this.send('GET', url, null, 'strapi-probe');
    const data = res.json && res.json.data;
    const first = Array.isArray(data) ? data[0] : data;
    const detected = this.detectFromEntry(first);
    if (detected) {
      this.adopt(detected, 'probe');
    } else {
      this.adopt('v5', 'default-empty-collection');
      this.log && this.log.warn(
        'The collection is empty, so the Strapi major version could not be detected from a response. ' +
        'Assuming v5. If this Strapi is v4, set STRAPI_API_VERSION=v4 -- otherwise the first update will 404.',
        { collection: this.cfg.collection }
      );
    }
    return this.version;
  }

  /** Normalise an entry from either version into { id, key, fields }. */
  normalise(entry) {
    if (!entry) return null;
    const detected = this.detectFromEntry(entry);
    if (detected) this.adopt(detected, 'response');
    if (entry.attributes) {
      return { id: entry.id, key: entry.id, fields: entry.attributes, raw: entry };
    }
    const { id, documentId, ...rest } = entry;
    return { id, documentId, key: documentId || id, fields: rest, raw: entry };
  }

  /* -------------------------------------------------------------- CRUD */

  /** Find the single entry for a reportId. More than one is a data problem. */
  async findByReportId(reportId) {
    await this.ensureVersion();
    const q = new URLSearchParams();
    q.set(`filters[${this.cfg.idField}][$eq]`, reportId);
    q.set('pagination[pageSize]', '2');
    if (this.cfg.locale) q.set('locale', this.cfg.locale);
    if (this.cfg.draftAndPublish === 'on' && this.version === 'v5') q.set('status', 'draft');

    const res = await this.send('GET', `${this.base}?${q.toString()}`, null, 'strapi-find');
    const list = (res.json && Array.isArray(res.json.data)) ? res.json.data : [];
    if (list.length > 1) {
      throw new Error(
        `Strapi holds ${list.length} entries with ${this.cfg.idField}="${reportId}". ` +
        'Idempotency is broken: de-duplicate them and add `"unique": true` to that attribute in the content type.'
      );
    }
    return list.length ? this.normalise(list[0]) : null;
  }

  async create(fields) {
    await this.ensureVersion();
    const q = new URLSearchParams();
    if (this.cfg.locale) q.set('locale', this.cfg.locale);
    const url = `${this.base}${q.toString() ? '?' + q : ''}`;
    const res = await this.send('POST', url, { data: fields }, 'strapi-create');
    return this.normalise(res.json && res.json.data);
  }

  async update(key, fields) {
    await this.ensureVersion();
    const q = new URLSearchParams();
    if (this.cfg.locale) q.set('locale', this.cfg.locale);
    const url = `${this.base}/${encodeURIComponent(key)}${q.toString() ? '?' + q : ''}`;
    const res = await this.send('PUT', url, { data: fields }, 'strapi-update');
    return this.normalise(res.json && res.json.data);
  }

  /**
   * Create-or-update, keyed on reportId.
   *
   * @returns {{ action: 'created'|'updated'|'unchanged', entry, key }}
   */
  async upsert(reportId, fields, opts) {
    const o = opts || {};
    const existing = await this.findByReportId(reportId);

    if (existing) {
      const hashField = o.hashField;
      if (hashField && o.hash && existing.fields && existing.fields[hashField] === o.hash) {
        return { action: 'unchanged', entry: existing, key: existing.key };
      }
      const entry = await this.update(existing.key, fields);
      return { action: 'updated', entry: entry || existing, key: existing.key };
    }

    try {
      const entry = await this.create(fields);
      return { action: 'created', entry, key: entry && entry.key };
    } catch (err) {
      // Lost a race, or `unique: true` rejected the duplicate. Re-find and
      // update rather than leaving two entries for one report.
      if (err instanceof HttpError && (err.status === 400 || err.status === 409)) {
        const again = await this.findByReportId(reportId);
        if (again) {
          this.log && this.log.warn('create was rejected but the entry now exists; updating instead', { reportId, status: err.status });
          const entry = await this.update(again.key, fields);
          return { action: 'updated', entry: entry || again, key: again.key };
        }
      }
      throw err;
    }
  }

  /** Cheap reachability + auth check for --doctor and the health endpoint. */
  async health() {
    const started = Date.now();
    try {
      await this.ensureVersion();
      return { ok: true, version: this.version, detectedFrom: this.detectedFrom, ms: Date.now() - started };
    } catch (err) {
      return {
        ok: false, version: this.version, ms: Date.now() - started,
        status: err.status || null,
        error: err.message,
        hint: hintFor(err, this.cfg)
      };
    }
  }
}

function hintFor(err, cfg) {
  switch (err.status) {
    case 401: return 'STRAPI_API_TOKEN was rejected. Check the token has not expired and that STRAPI_AUTH_SCHEME matches what the server expects.';
    case 403: return `The token is valid but lacks permission. Grant find/create/update on "${cfg.collection}" to this API token.`;
    case 404: return `No collection at ${cfg.apiPrefix}/${cfg.collection}. Check STRAPI_COLLECTION is the *plural* API id, and STRAPI_API_PREFIX if Strapi is behind a path prefix.`;
    case 405: return 'The endpoint exists but rejects the method -- usually a reverse proxy or WAF in front of Strapi.';
    default: return err.status >= 500
      ? 'Strapi returned a server error. The bot has already retried with backoff; this needs the CMS team.'
      : 'Check STRAPI_URL is reachable from this host (proxy, firewall, TLS trust store).';
  }
}

/* ------------------------------------------------- payload construction */

/**
 * Build the Strapi body from a validated report + rendered HTML, through the
 * configurable field map. A mapping of null (or '') omits the field.
 */
function buildFields(report, html, cfg, extra) {
  const map = cfg.fieldMap || {};
  const rec = report.recommendation || {};
  const stock = report.stock || {};
  const meta = report.report || {};
  const e = extra || {};

  const source = {
    reportId: report.reportId,
    stockName: stock.name,
    ticker: stock.ticker,
    slug: stock.slug,
    isin: stock.isin,
    reportDate: report.publishedAt,
    reportType: meta.type,
    period: meta.period,
    template: meta.template,
    rating: rec.rating,
    cmp: rec.cmp,
    fairValue: rec.fairValue === undefined ? null : rec.fairValue,
    currency: rec.currency,
    sourcePdf: report.sourcePdf,
    payload: report,
    renderedHtml: html,
    contentHash: e.hash,
    publishState: e.publishState
  };

  const fields = {};
  const warnings = [];
  for (const [logical, target] of Object.entries(map)) {
    if (!target) continue;                       // explicitly not sent
    const value = source[logical];
    if (value === undefined) continue;
    if (RESERVED_STRAPI_FIELDS.has(target)) {
      warnings.push(
        `STRAPI_FIELD_MAP maps "${logical}" onto "${target}", which Strapi reserves. ` +
        (target === 'publishedAt'
          ? 'Writing the report date into publishedAt changes whether the entry is live. Use a field such as reportDate.'
          : 'Pick a different attribute name.')
      );
      continue;
    }
    fields[target] = value;
  }
  return { fields, warnings };
}

/**
 * Stable hash of everything that would be written, so an identical re-run is a
 * no-op. `extra` must carry anything that changes the stored row but not the
 * report -- publishState above all, or flipping shadow -> live would be
 * skipped as "unchanged" and the entry would never go live.
 */
function contentHash(report, html, extra) {
  const SEP = '\u241F';   // unambiguous separator between the three parts
  return crypto.createHash('sha256')
    .update(canonicalJson(report)).update(SEP)
    .update(String(html)).update(SEP)
    .update(canonicalJson(extra === undefined ? null : extra))
    .digest('hex');
}

/** JSON with object keys sorted, so key order can never change the hash. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    .join(',') + '}';
}

module.exports = { StrapiClient, buildFields, contentHash, canonicalJson, RESERVED_STRAPI_FIELDS };
