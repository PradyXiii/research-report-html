'use strict';
/**
 * S3 (and any S3-compatible store) via plain REST + SigV4 from node:crypto.
 * No AWS SDK: two request shapes do not justify ~15 MB of transitive packages
 * inside a bank's review process. Point S3_ENDPOINT at MinIO/Ceph/Wasabi and
 * the same code works.
 *
 * MEASURED, 2026-08-13, against the reference bucket:
 *   GET  <object>                     -> 200, 337198 bytes  (anonymous)
 *   HEAD <object>                     -> 200                (anonymous)
 *   GET  /?list-type=2&prefix=...     -> 403 AccessDenied   (anonymous)
 * So anonymous reads work but anonymous *listing* does not. TRIGGER_MODE=poll
 * therefore requires credentials with s3:ListBucket; config.js refuses to start
 * in that combination without them rather than silently finding nothing.
 */

const { request, redact } = require('../lib/http');
const { sign, parseListObjects, uriEncode } = require('../lib/sigv4');
const { baseName } = require('../lib/filename');

function create(cfg, deps) {
  const log = deps.logger;
  const s = cfg.source;
  const c = s.s3;

  const creds = c.accessKeyId && c.secretAccessKey
    ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken }
    : null;

  const endpoint = c.endpoint || `https://s3.${c.region}.amazonaws.com`;
  const endpointUrl = new URL(endpoint);
  const pathStyle = c.forcePathStyle || !!c.endpoint;

  function target(key) {
    // virtual-host style: bucket.s3.<region>.amazonaws.com/<key>
    // path style:         <endpoint>/<bucket>/<key>
    const host = pathStyle ? endpointUrl.host : `${c.bucket}.${endpointUrl.host}`;
    const pathname = pathStyle ? `/${c.bucket}${key ? '/' + key : ''}` : `/${key || ''}`;
    return { host, pathname, origin: `${endpointUrl.protocol}//${host}` };
  }

  function keyFor(ref) {
    const raw = String(ref || '').trim();
    if (!raw) throw new Error('No S3 key given. Pass --key <object-key> or --url <https://...>.');
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      const p = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      return pathStyle && p.startsWith(c.bucket + '/') ? p.slice(c.bucket.length + 1) : p;
    }
    if (raw.startsWith(c.prefix) || !c.prefix) return raw.replace(/^\/+/, '');
    return c.prefix.replace(/\/+$/, '') + '/' + raw.replace(/^\/+/, '');
  }

  function resolve(ref) {
    const key = keyFor(ref);
    const t = target(key);
    return {
      id: key,
      key,
      filename: baseName(key) + '.pdf',
      url: s.publicBaseUrl
        ? s.publicBaseUrl + '/' + uriEncode(key.split('/').pop(), true)
        : `${t.origin}${uriEncode(t.pathname, false)}`,
      meta: {}
    };
  }

  async function send(method, key, query, label) {
    const t = target(key);
    const headers = sign({
      method, host: t.host, pathname: t.pathname, query: query || {},
      headers: {}, region: c.region, service: 's3'
    }, creds);
    const qs = Object.keys(query || {}).sort()
      .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`).join('&');
    const url = `${t.origin}${uriEncode(t.pathname, false)}${qs ? '?' + qs : ''}`;
    return request(url, { method, headers }, {
      retries: s.retries, timeoutMs: s.timeoutMs, logger: log, label,
      expectBuffer: label === 'source'
    });
  }

  return {
    kind: 's3',
    describe: () => `s3 ${c.bucket}/${c.prefix || ''} at ${redact(endpoint)} (${creds ? 'signed' : 'anonymous'})`,
    resolve,

    async fetch(ref) {
      const r = resolve(ref);
      const res = await send('GET', r.key, {}, 'source');
      if (res.buffer.length > s.maxBytes) {
        throw new Error(`Downloaded ${res.buffer.length} bytes, over SOURCE_MAX_BYTES=${s.maxBytes}.`);
      }
      return Object.assign({}, r, {
        buffer: res.buffer,
        meta: { etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null }
      });
    },

    /** ListObjectsV2, paginated. Requires s3:ListBucket -- see the header note. */
    async list(opts) {
      const o = opts || {};
      const out = [];
      let token = null;
      const since = o.since ? new Date(o.since).getTime() : null;

      do {
        const query = { 'list-type': '2', 'max-keys': String(o.maxKeys || 1000) };
        if (c.prefix) query.prefix = c.prefix;
        if (token) query['continuation-token'] = token;

        let res;
        try {
          res = await send('GET', '', query, 's3-list');
        } catch (err) {
          if (err.status === 403) {
            throw new Error(
              `S3 ListObjectsV2 on "${c.bucket}" returned 403 AccessDenied${creds ? '' : ' (request was anonymous)'}. ` +
              'Listing needs credentials with s3:ListBucket on the bucket and s3:GetObject on the prefix. ' +
              'If those cannot be issued, use TRIGGER_MODE=webhook or TRIGGER_MODE=watch instead of poll.'
            );
          }
          throw err;
        }

        const parsed = parseListObjects(res.text);
        if (parsed.errorCode) throw new Error(`S3 list failed: ${parsed.errorCode} ${parsed.errorMessage || ''}`.trim());
        for (const item of parsed.contents) {
          if (!/\.pdf$/i.test(item.key)) continue;
          if (since && new Date(item.lastModified).getTime() <= since) continue;
          out.push({ id: item.key, key: item.key, filename: item.key.split('/').pop(), mtime: item.lastModified, size: item.size, etag: item.etag });
        }
        token = parsed.isTruncated ? parsed.nextToken : null;
      } while (token);

      out.sort((a, b) => String(a.mtime).localeCompare(String(b.mtime)));
      return out;
    }
  };
}

module.exports = { create };
