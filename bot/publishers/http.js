'use strict';
/**
 * Generic HTTP publisher: POST/PUT the whole envelope to any endpoint.
 *
 * For a CMS that is not Strapi, or an internal API that fronts one. It has no
 * find-then-update step of its own, so the receiving endpoint owns idempotency
 * -- reportId and contentHash are both in the body so it can.
 */

const { request } = require('../lib/http');

function create(cfg, deps) {
  const log = deps.logger;
  const p = cfg.publisher;

  return {
    kind: 'http',
    describe: () => `HTTP ${p.method} ${p.url}`,

    async publish({ report, html, hash, publishState }) {
      const body = {
        reportId: report.reportId,
        contentHash: hash,
        publishState,
        payload: report,
        renderedHtml: html
      };
      const res = await request(p.url, {
        method: p.method,
        headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, p.headers),
        body: JSON.stringify(body)
      }, { retries: cfg.publisher.strapi.retries, timeoutMs: cfg.publisher.strapi.timeoutMs, logger: log, label: 'publish-http' });

      const action = (res.json && res.json.action) || 'updated';
      return { action, id: (res.json && res.json.id) || report.reportId, detail: { status: res.status } };
    },

    async health() {
      return { ok: !!p.url, url: p.url, note: 'no health endpoint is assumed; reachability is proven by the first publish' };
    }
  };
}

module.exports = { create };
