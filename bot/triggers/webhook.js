'use strict';
/**
 * A small node:http listener for Jamun to POST to. node:http only -- no Express,
 * no framework, nothing to keep patched.
 *
 * Contract (all fields optional except one reference):
 *   POST /jamun/report
 *   { "url": "https://.../131440_1_Lenskart...pdf" }
 *   or { "key": "jaamoon-pdf-files/131440_1_....pdf" }
 *   or { "filename": "131440_1_....pdf" }
 *
 * Responses:
 *   202 accepted, processing continues in the background
 *   200 done, with the outcome (?wait=1)
 *   400 the body was not usable
 *   401 the signature or token did not verify
 *   409 a run is already in progress for that reference
 *
 * Authentication is HMAC-SHA256 over the raw body by default, compared in
 * constant time. WEBHOOK_AUTH_MODE=token compares a shared secret instead, and
 * =none is only for the case where something in front already authenticates.
 *
 * Bind to 127.0.0.1 unless a reverse proxy terminates TLS in front: this
 * listener speaks plain HTTP by design, because certificate lifecycle belongs
 * to nginx/Apache, not to a 200-line bot.
 */

const http = require('http');
const crypto = require('crypto');

function create(cfg, deps) {
  const { pipeline, logger } = deps;
  const w = cfg.trigger.webhook;
  const inFlight = new Set();
  let server = null;

  function verify(rawBody, req) {
    if (w.authMode === 'none') return { ok: true };
    const provided = req.headers[w.signatureHeader];
    if (!provided) return { ok: false, why: `missing ${w.signatureHeader} header` };

    if (w.authMode === 'token') {
      return timingSafeEqual(String(provided), String(w.secret))
        ? { ok: true } : { ok: false, why: 'token mismatch' };
    }
    const expected = crypto.createHmac('sha256', w.secret).update(rawBody).digest('hex');
    const got = String(provided).replace(/^sha256=/i, '');
    return timingSafeEqual(got, expected) ? { ok: true } : { ok: false, why: 'HMAC mismatch' };
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === w.healthPath) {
      const health = await deps.health();
      return json(res, health.ok ? 200 : 503, health);
    }
    if (url.pathname !== w.pathname) return json(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });

    let raw;
    try { raw = await readBody(req, w.maxBodyBytes); }
    catch (err) { return json(res, 413, { error: err.message }); }

    const auth = verify(raw, req);
    if (!auth.ok) {
      logger.warn('webhook rejected', { why: auth.why, remote: req.socket.remoteAddress });
      return json(res, 401, { error: 'unauthorised' });
    }

    let body;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
    catch (err) { return json(res, 400, { error: `body is not JSON: ${err.message}` }); }

    const ref = body.url || body.key || body.path || body.filename || body.ref;
    if (!ref || typeof ref !== 'string') {
      return json(res, 400, { error: 'give one of: url, key, path, filename' });
    }
    if (inFlight.has(ref)) return json(res, 409, { error: 'already processing', ref });

    logger.info('webhook accepted', { ref, remote: req.socket.remoteAddress });
    inFlight.add(ref);

    const work = pipeline.process(ref)
      .then(async (outcome) => { await pipeline.alert([outcome]); return outcome; })
      .catch((err) => ({ status: 'failed', ref, failureMessage: err.message }))
      .finally(() => inFlight.delete(ref));

    if (url.searchParams.get('wait') === '1') {
      const outcome = await work;
      return json(res, outcome.status === 'published' || outcome.status === 'unchanged' || outcome.status === 'skipped' ? 200 : 500, outcome);
    }
    work.catch(() => {});
    return json(res, 202, { accepted: true, ref });
  }

  return {
    kind: 'webhook',
    describe: () => `webhook http://${w.host}:${w.port}${w.pathname} (auth: ${w.authMode})`,

    async run() {
      server = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          logger.error(`webhook handler crashed: ${err.message}`);
          if (!res.headersSent) json(res, 500, { error: 'internal error' });
        });
      });
      server.headersTimeout = 20000;
      server.requestTimeout = 60000;

      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(w.port, w.host, resolve);
      });
      logger.info('webhook listening', { host: w.host, port: w.port, path: w.pathname, health: w.healthPath, auth: w.authMode });
      if (w.host !== '127.0.0.1' && w.host !== 'localhost') {
        logger.warn('listener is bound to a non-loopback address and speaks plain HTTP; put a TLS-terminating reverse proxy in front', { host: w.host });
      }

      await new Promise((resolve) => {
        const stop = () => server.close(() => resolve());
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      logger.info('webhook stopped');
      return [];
    },

    close: () => new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error(`body larger than ${maxBytes} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still burn a comparison so length is not leaked by timing.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

module.exports = { create };
