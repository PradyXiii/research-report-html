'use strict';
/**
 * HTTPS source. The least demanding option: it needs a URL and nothing else --
 * no credentials, no SDK, no IAM role. It works against the public S3 URL the
 * research team already publishes, and against any CDN or reverse proxy in
 * front of it.
 *
 * It cannot enumerate -- there is nothing to list over plain HTTPS -- so
 * TRIGGER_MODE=poll needs SOURCE_TYPE=s3 (with credentials) or TRIGGER_MODE=watch.
 */

const { request, redact } = require('../lib/http');
const { baseName } = require('../lib/filename');

function create(cfg, deps) {
  const log = deps.logger;
  const s = cfg.source;

  function resolve(ref) {
    const raw = String(ref || s.url || '').trim();
    if (!raw) throw new Error('No PDF reference given. Pass --url <https://...> or set SOURCE_URL.');
    let url = raw;
    if (!/^https?:\/\//i.test(raw)) {
      if (!s.baseUrl) {
        throw new Error(`"${raw}" is not a URL and SOURCE_BASE_URL is not set, so it cannot be turned into one.`);
      }
      url = s.baseUrl + '/' + raw.replace(/^\/+/, '');
    }
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error(`"${url}" is not a valid URL.`); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing a non-http(s) source URL (${parsed.protocol}).`);
    }
    if (parsed.protocol === 'http:') {
      log && log.warn('source URL is plain http; report content will cross the network unencrypted', { url: redact(url) });
    }
    const filename = baseName(url) + '.pdf';
    return { id: filename, filename, url, meta: {} };
  }

  return {
    kind: 'http',
    describe: () => `https source (${s.url ? redact(s.url) : s.baseUrl ? redact(s.baseUrl) + '/<key>' : '<url given per run>'})`,
    resolve,

    async fetch(ref) {
      const r = resolve(ref);
      const res = await request(r.url, {
        method: 'GET',
        headers: Object.assign({ accept: 'application/pdf,*/*' }, s.headers),
        redirect: 'follow'
      }, {
        retries: s.retries, timeoutMs: s.timeoutMs, logger: log, label: 'source', expectBuffer: true
      });
      if (res.buffer.length > s.maxBytes) {
        throw new Error(`Downloaded ${res.buffer.length} bytes, over SOURCE_MAX_BYTES=${s.maxBytes}.`);
      }
      const ctype = res.headers['content-type'] || '';
      if (ctype && !/pdf|octet-stream|binary/i.test(ctype)) {
        // Not fatal on its own -- some gateways mislabel -- but pdftext.js will
        // reject a non-PDF body, and this makes the log say why.
        log && log.warn('unexpected content-type from source', { contentType: ctype, url: redact(r.url) });
      }
      return Object.assign({}, r, {
        buffer: res.buffer,
        meta: { contentType: ctype, etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null }
      });
    },

    async list() {
      throw new Error(
        'SOURCE_TYPE=http cannot enumerate reports -- plain HTTPS has nothing to list. ' +
        'Use TRIGGER_MODE=webhook (Jamun tells us), TRIGGER_MODE=watch with SOURCE_TYPE=dir ' +
        '(Jamun drops files on disk), or SOURCE_TYPE=s3 with credentials that allow s3:ListBucket.'
      );
    }
  };
}

module.exports = { create };
