/**
 * Webinar registration endpoint.
 *
 * The browser posts {name, email, phone} here. This process registers the
 * person with Zoom and hands back the unique join_url Zoom mints for them.
 *
 * Why a server at all: the Zoom credentials are account-wide. Anything that
 * reaches the browser is public, so the client can never call Zoom directly.
 *
 * Runs on the same box as Strapi. No external automation service.
 *
 *   node webinar/server-example.js
 *
 * Environment (all required except PORT and ALLOW_ORIGIN):
 *   ZOOM_ACCOUNT_ID     server-to-server OAuth app, Account ID
 *   ZOOM_CLIENT_ID      server-to-server OAuth app, Client ID
 *   ZOOM_CLIENT_SECRET  server-to-server OAuth app, Client Secret
 *   ZOOM_WEBINAR_ID     numeric webinar id, e.g. 93315444846
 *   PORT                default 8787
 *   ALLOW_ORIGIN        default https://www.kotakneo.com
 *
 * Zoom app scopes needed: webinar:write:registrant:admin
 * (classic scope name: webinar:write:admin)
 *
 * If the event is a Zoom *Meeting* rather than a Webinar, change REG_PATH to
 * `/v2/meetings/${id}/registrants` and the scope to meeting:write:admin.
 * The response shape is the same.
 */

'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://www.kotakneo.com';
const WEBINAR_ID = process.env.ZOOM_WEBINAR_ID || '';
const REG_PATH = (id) => `/v2/webinars/${encodeURIComponent(id)}/registrants`;

/* ------------------------------------------------------------------ zoom auth */

let tokenCache = { value: '', expiresAt: 0 };

async function zoomToken() {
  // Zoom tokens last an hour. Re-minting on every registration burns rate
  // limit and adds a round trip to a form the user is waiting on.
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const id = need('ZOOM_ACCOUNT_ID');
  const basic = Buffer.from(need('ZOOM_CLIENT_ID') + ':' + need('ZOOM_CLIENT_SECRET')).toString('base64');

  const res = await fetch('https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(id), {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new HttpError(502, 'Zoom auth failed', { status: res.status, reason: body.reason || body.error });
  }

  // 60s of slack so a token cannot expire mid-request.
  tokenCache = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in || 3600) - 60) * 1000 };
  return tokenCache.value;
}

/* ---------------------------------------------------------------- validation */

// Mirrors the rules in registration-embed.html. The browser copy is for the
// user's benefit; this one is the one that counts -- anyone can post here
// directly, so nothing from the client is trusted.
function parseRegistration(raw) {
  const out = {};
  const name = String(raw.name || '').trim();
  if (name.length < 2 || name.length > 120) throw new HttpError(400, 'Enter your name.');
  out.name = name;

  const email = String(raw.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new HttpError(400, 'Check the email address.');
  }
  out.email = email;

  let digits = String(raw.phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) throw new HttpError(400, 'Enter a valid 10-digit mobile number.');
  out.phone = '+91' + digits;

  return out;
}

function splitName(full) {
  // Zoom requires first_name. It treats last_name as optional, so a single-word
  // name must not be rejected here -- plenty of people have one.
  const parts = full.split(/\s+/);
  return { first: parts[0].slice(0, 64), last: parts.slice(1).join(' ').slice(0, 64) };
}

/* -------------------------------------------------------------------- handler */

async function register(raw) {
  const reg = parseRegistration(raw);
  const id = WEBINAR_ID || need('ZOOM_WEBINAR_ID');
  const { first, last } = splitName(reg.name);

  const res = await fetch('https://api.zoom.us' + REG_PATH(id), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (await zoomToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: first,
      last_name: last || undefined,
      email: reg.email,
      phone: reg.phone,
      auto_approve: true
    })
  });

  const body = await res.json().catch(() => ({}));

  if (res.status === 429) throw new HttpError(503, 'Too many registrations right now. Try again in a minute.');
  if (!res.ok || !body.join_url) {
    // Zoom's message can name internal config ("registration is not enabled").
    // Log it, return something a registrant can act on.
    console.error('[zoom] register failed', res.status, JSON.stringify(body));
    if (res.status === 404) throw new HttpError(502, 'This session is not open for registration yet.');
    throw new HttpError(502, 'We could not complete your registration.');
  }

  // Zoom emails its own confirmation when the webinar has that setting on.
  // The join_url below is unique to this registrant -- do not cache or share it.
  return { join_url: body.join_url, registrant_id: body.registrant_id || null };
}

/* ---------------------------------------------------------------------- http */

class HttpError extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail; }
}

function need(key) {
  const v = process.env[key];
  // Fail loudly at the point of use. A missing secret that falls through as
  // undefined produces a confusing 401 from Zoom instead of naming the cause.
  if (!v) throw new HttpError(500, 'Server is not configured.', { missing: key });
  return v;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin === ALLOW_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readJson(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'Malformed request.')); }
    });
    req.on('error', reject);
  });
}

// Crude per-IP throttle so one script cannot enumerate the webinar. Swap for
// the reverse proxy's rate limiter if there is one -- this resets on restart
// and does not survive multiple processes.
const hits = new Map();
function throttle(ip, max = 5, windowMs = 60000) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  if (list.length > max) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}'); return; }

  if (path !== '/api/webinar/register' || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Not found"}');
    return;
  }

  try {
    throttle(req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
    const out = await register(await readJson(req));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[register]', err.message, err.detail || '');
    res.writeHead(status, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log('webinar registration listening on :' + PORT));
}

module.exports = { server, register, parseRegistration, splitName };
