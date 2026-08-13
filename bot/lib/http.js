'use strict';
/**
 * The one HTTP helper. Wraps global fetch with timeout, bounded retries and
 * exponential backoff + full jitter.
 *
 * Runtime portability: global fetch is stable from Node 18. We check for it
 * once, here, and fail with an actionable message rather than an obscure
 * "fetch is not defined" 200 lines deeper in.
 *
 * Retry policy -- deliberately narrow, because this pipeline publishes
 * investment recommendations:
 *   RETRY     network/DNS/socket errors, timeouts, 408, 425, 429, 5xx
 *   NO RETRY  every other 4xx. A 400/401/403/404 means we are wrong, not
 *             early; retrying just delays the alert.
 * 429/503 `Retry-After` is honoured (seconds or HTTP-date), capped.
 */

const MIN_NODE = [18, 17, 0];

function assertRuntime() {
  const parts = process.versions.node.split('.').map(Number);
  const ok = parts[0] > MIN_NODE[0] || (parts[0] === MIN_NODE[0] && parts[1] >= MIN_NODE[1]);
  if (!ok) {
    throw new Error(
      `Node ${process.versions.node} is too old. This bot needs Node >= ${MIN_NODE.join('.')} ` +
      'for global fetch, AbortSignal.timeout and node:test. ' +
      'Install a newer Node (nodejs.org, nvm, or your distro\'s nodesource package) and retry.'
    );
  }
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      `global fetch is missing on Node ${process.versions.node}. ` +
      'If this is Node 18 started with --no-experimental-fetch, drop that flag; otherwise upgrade Node.'
    );
  }
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 509, 520, 521, 522, 523, 524]);

class HttpError extends Error {
  constructor(message, { status, url, method, body, retryable }) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.method = method;
    this.responseBody = body;
    this.retryable = !!retryable;
  }
}

function parseRetryAfter(value, capMs) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, capMs);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), capMs);
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Full-jitter exponential backoff: random in [0, base * 2^attempt], capped. */
function backoffMs(attempt, baseMs, capMs) {
  const ceiling = Math.min(capMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceiling);
}

/**
 * @param {string} url
 * @param {object} init      standard fetch init
 * @param {object} opts      { retries, timeoutMs, baseDelayMs, maxDelayMs, logger, label, expectBuffer }
 * @returns {Promise<{status, headers, text, json, buffer}>}
 */
async function request(url, init, opts) {
  assertRuntime();
  const o = Object.assign(
    { retries: 4, timeoutMs: 30000, baseDelayMs: 500, maxDelayMs: 20000, label: 'http' },
    opts || {}
  );
  const log = o.logger;
  const method = (init && init.method) || 'GET';
  let lastErr = null;

  for (let attempt = 0; attempt <= o.retries; attempt++) {
    let res;
    const started = Date.now();
    try {
      res = await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(o.timeoutMs) }));
    } catch (err) {
      // Network-layer failure: DNS, TLS, ECONNRESET, abort/timeout. Always retryable.
      lastErr = new HttpError(`${o.label}: ${method} ${redact(url)} failed: ${err.message}`, {
        url, method, retryable: true
      });
      lastErr.cause = err;
      if (attempt === o.retries) break;
      const wait = backoffMs(attempt, o.baseDelayMs, o.maxDelayMs);
      if (log) log.warn('request failed, retrying', { label: o.label, attempt: attempt + 1, waitMs: wait, err: err.message });
      await sleep(wait);
      continue;
    }

    if (res.ok) {
      const headers = Object.fromEntries(res.headers.entries());
      if (o.expectBuffer) {
        const buffer = Buffer.from(await res.arrayBuffer());
        return { status: res.status, headers, buffer, ms: Date.now() - started };
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON; caller decides */ }
      return { status: res.status, headers, text, json, ms: Date.now() - started };
    }

    const body = await safeText(res);
    const retryable = RETRY_STATUS.has(res.status);
    lastErr = new HttpError(
      `${o.label}: ${method} ${redact(url)} -> HTTP ${res.status}${body ? ' ' + truncate(body, 400) : ''}`,
      { status: res.status, url, method, body, retryable }
    );
    if (!retryable || attempt === o.retries) break;
    const hinted = parseRetryAfter(res.headers.get('retry-after'), o.maxDelayMs);
    const wait = hinted === null ? backoffMs(attempt, o.baseDelayMs, o.maxDelayMs) : hinted;
    if (log) log.warn('retryable status, retrying', { label: o.label, status: res.status, attempt: attempt + 1, waitMs: wait });
    await sleep(wait);
  }
  throw lastErr;
}

async function safeText(res) {
  try { return (await res.text()).trim(); } catch (_) { return ''; }
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }

/** Strip query strings and userinfo before a URL reaches a log line. */
function redact(url) {
  try {
    const u = new URL(url);
    u.username = ''; u.password = ''; u.search = u.search ? '?<redacted>' : '';
    return u.toString();
  } catch (_) { return String(url); }
}

module.exports = { request, HttpError, assertRuntime, redact, backoffMs, parseRetryAfter, sleep, RETRY_STATUS };
