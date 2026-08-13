'use strict';
/**
 * Minimal AWS Signature V4 for S3 GET and ListObjectsV2, built on node:crypto.
 *
 * Why hand-rolled instead of @aws-sdk/client-s3: the SDK is ~15 MB and a few
 * hundred transitive packages, which is a real supply-chain and review burden
 * inside a bank for two request shapes. This is ~70 lines, has no dependencies,
 * and works against any S3-compatible endpoint (MinIO, Ceph, Wasabi) by
 * pointing S3_ENDPOINT at it.
 *
 * Anonymous access is also supported: when no credentials are configured the
 * request simply goes out unsigned, which is enough to GET a public object.
 */

const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_SHA256 = sha256('');

/** RFC 3986 encoding; S3 requires each path segment encoded but '/' preserved. */
function uriEncode(str, encodeSlash) {
  return String(str).replace(/[^A-Za-z0-9\-._~]/g, (c) => {
    if (c === '/' && !encodeSlash) return '/';
    return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

function amzDate(now) {
  const iso = (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, date: iso.slice(0, 8) };
}

/**
 * @param {object} req { method, host, pathname, query, headers, body, region, service }
 * @param {object} creds { accessKeyId, secretAccessKey, sessionToken }
 * @returns {object} headers to send (a copy; the input is not mutated)
 */
function sign(req, creds, now) {
  const headers = Object.assign({}, req.headers);
  if (!creds || !creds.accessKeyId || !creds.secretAccessKey) return headers; // anonymous

  const service = req.service || 's3';
  const region = req.region || 'us-east-1';
  const { amz, date } = amzDate(now);
  const payloadHash = req.body ? sha256(req.body) : EMPTY_SHA256;

  headers.host = req.host;
  headers['x-amz-date'] = amz;
  headers['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const signedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedKeys
    .map((k) => `${k}:${String(pick(headers, k)).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = signedKeys.join(';');

  const canonicalQuery = Object.keys(req.query || {}).sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(req.query[k], true)}`).join('&');

  const canonicalRequest = [
    req.method, uriEncode(req.pathname, false), canonicalQuery,
    canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonicalRequest)].join('\n');

  let key = hmac('AWS4' + creds.secretAccessKey, date);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function pick(obj, lowerKey) {
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lowerKey) return obj[k];
  return '';
}

/** Dependency-free reader for the handful of ListObjectsV2 fields we use. */
function parseListObjects(xml) {
  const text = String(xml);
  const contents = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(text))) {
    const chunk = m[1];
    contents.push({
      key: decodeXml(tag(chunk, 'Key')),
      lastModified: tag(chunk, 'LastModified'),
      size: Number(tag(chunk, 'Size') || 0),
      etag: (tag(chunk, 'ETag') || '').replace(/^"|"$/g, '')
    });
  }
  return {
    contents,
    isTruncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(text),
    nextToken: decodeXml(tag(text, 'NextContinuationToken')) || null,
    errorCode: tag(text, 'Code') || null,
    errorMessage: tag(text, 'Message') || null
  };
}

function tag(s, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s);
  return m ? m[1] : '';
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

module.exports = { sign, parseListObjects, uriEncode, sha256 };
