'use strict';
/**
 * config.js -- every environment-specific decision lives here, and nowhere else.
 *
 * We do not know what the target environment looks like, so nothing about it is
 * compiled in. Trigger, PDF source, publisher, Strapi version, field names,
 * auth scheme and extraction tuning are all values, each with a default that
 * works on a bare Linux box with no credentials.
 *
 * Precedence (later wins):
 *   built-in defaults  <  BOT_CONFIG_FILE (JSON)  <  --env-file  <  process.env  <  CLI flags
 *
 * Validation is done once, at boot, and reports EVERY problem at once with the
 * variable name and an example value. A bot that publishes investment
 * recommendations must never start half-configured and discover it at 09:00.
 */

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ env plumbing */

/** Minimal KEY=VALUE reader. Avoids a dotenv dependency for ~20 lines. */
function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readJsonFile(file, label, problems) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`${label}: could not read JSON from "${file}" (${err.message}).`);
    return null;
  }
}

/** A value that may be inline JSON or a path to a JSON file. */
function jsonOrFile(value, label, problems) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.parse(s); } catch (err) {
      problems.push(`${label}: not valid JSON (${err.message}). Give inline JSON or a path to a .json file.`);
      return null;
    }
  }
  return readJsonFile(s, label, problems);
}

/* ------------------------------------------------------------- defaults */

/**
 * Default Strapi field map, matching the table in README.md.
 *
 * Two deliberate departures, both explained in INTEGRATION.md:
 *   - `publishedAt` becomes `reportDate`. In Strapi, `publishedAt` is a
 *     RESERVED field owned by Draft & Publish; writing a report date into it
 *     would change whether the entry is live.
 *   - `contentHash` and `publishState` are added so re-runs can be a no-op and
 *     so shadow mode can write without the site showing the entry.
 *
 * Set any value to null to stop sending that field entirely.
 */
const DEFAULT_FIELD_MAP = {
  reportId: 'reportId',
  stockName: 'stockName',
  ticker: 'ticker',
  slug: 'slug',
  isin: null,
  reportDate: 'reportDate',
  reportType: 'reportType',
  period: 'period',
  template: null,
  rating: 'rating',
  cmp: 'cmp',
  fairValue: 'fairValue',
  currency: null,
  sourcePdf: 'sourcePdf',
  payload: 'payload',
  renderedHtml: 'renderedHtml',
  contentHash: 'contentHash',
  publishState: 'publishState'
};

const TRIGGER_MODES = ['once', 'poll', 'watch', 'webhook'];
const SOURCE_TYPES = ['http', 's3', 'file', 'dir'];
const PUBLISHER_TYPES = ['strapi', 'http', 'file', 'console'];
const RUN_MODES = ['dry-run', 'shadow', 'live'];
const API_VERSIONS = ['auto', 'v4', 'v5'];

/* ------------------------------------------------------------- helpers */

const truthy = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};

function num(env, key, dflt, problems, { min, max } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) { problems.push(`${key}: "${raw}" is not a number (example: ${dflt}).`); return dflt; }
  if (min !== undefined && n < min) { problems.push(`${key}: ${n} is below the minimum ${min}.`); return dflt; }
  if (max !== undefined && n > max) { problems.push(`${key}: ${n} is above the maximum ${max}.`); return dflt; }
  return n;
}

function oneOf(env, key, allowed, dflt, problems) {
  const raw = (env[key] || '').trim();
  if (!raw) return dflt;
  const v = raw.toLowerCase();
  if (!allowed.includes(v)) {
    problems.push(`${key}: "${raw}" is not supported. Use one of: ${allowed.join(', ')} (default: ${dflt}).`);
    return dflt;
  }
  return v;
}

function requireUrl(env, key, problems, { required, example }) {
  const raw = (env[key] || '').trim();
  if (!raw) {
    if (required) problems.push(`${key} is required. Example: ${example}`);
    return null;
  }
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) {
      problems.push(`${key}: "${raw}" must be http(s). Example: ${example}`);
      return null;
    }
    return raw.replace(/\/+$/, '');
  } catch (_) {
    problems.push(`${key}: "${raw}" is not a valid URL. Example: ${example}`);
    return null;
  }
}

class ConfigError extends Error {
  constructor(problems) {
    super('Configuration is not usable:\n  - ' + problems.join('\n  - ') +
      '\n\nSee bot/.env.example for every variable, or run `node run.js --doctor`.');
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/* ---------------------------------------------------------------- load */

/**
 * @param {object} [overrides]  usually CLI flags; highest precedence
 * @param {object} [rawEnv]     defaults to process.env (injectable for tests)
 */
function load(overrides, rawEnv) {
  const problems = [];
  const base = Object.assign({}, rawEnv || process.env);

  // --env-file, then BOT_CONFIG_FILE, both below real environment variables.
  const envFile = (overrides && overrides.envFile) || base.BOT_ENV_FILE;
  let fileEnv = {};
  if (envFile) {
    try { fileEnv = parseEnvFile(fs.readFileSync(envFile, 'utf8')); }
    catch (err) { problems.push(`--env-file/BOT_ENV_FILE: cannot read "${envFile}" (${err.message}).`); }
  }
  let jsonEnv = {};
  if (base.BOT_CONFIG_FILE) {
    const parsed = readJsonFile(base.BOT_CONFIG_FILE, 'BOT_CONFIG_FILE', problems);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) jsonEnv[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  const env = Object.assign({}, jsonEnv, fileEnv, base);
  const o = overrides || {};

  /* -- general -- */
  const stateDir = path.resolve(env.BOT_STATE_DIR || path.join(__dirname, 'state'));
  const mode = o.mode || oneOf(env, 'BOT_MODE', RUN_MODES, 'dry-run', problems);

  const cfg = {
    mode,                                   // dry-run | shadow | live
    dryRun: mode === 'dry-run' || !!o.dryRun,
    stateDir,
    deadLetterDir: env.BOT_DEAD_LETTER_DIR ? path.resolve(env.BOT_DEAD_LETTER_DIR) : path.join(stateDir, 'dead-letter'),
    lockFile: path.join(stateDir, 'bot.lock'),
    cursorFile: path.join(stateDir, 'cursor.json'),
    failOnWarning: truthy(env.BOT_FAIL_ON_WARNING, false) || !!o.strict,
    log: {
      level: oneOf(env, 'BOT_LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'], o.verbose ? 'debug' : 'info', problems),
      format: oneOf(env, 'BOT_LOG_FORMAT', ['text', 'json'], 'text', problems)
    },

    /* -- trigger -- */
    trigger: {
      mode: o.trigger || oneOf(env, 'TRIGGER_MODE', TRIGGER_MODES, 'once', problems),
      pollIntervalMs: num(env, 'TRIGGER_POLL_INTERVAL_MS', 300000, problems, { min: 5000 }),
      maxPerCycle: num(env, 'TRIGGER_MAX_PER_CYCLE', 20, problems, { min: 1, max: 500 }),
      webhook: {
        host: env.WEBHOOK_HOST || '127.0.0.1',
        port: num(env, 'WEBHOOK_PORT', 8787, problems, { min: 1, max: 65535 }),
        pathname: env.WEBHOOK_PATH || '/jamun/report',
        healthPath: env.WEBHOOK_HEALTH_PATH || '/healthz',
        secret: env.WEBHOOK_SECRET || null,
        signatureHeader: (env.WEBHOOK_SIGNATURE_HEADER || 'x-jamun-signature').toLowerCase(),
        // 'hmac-sha256' verifies a signature over the raw body; 'token' compares the header to the secret.
        authMode: oneOf(env, 'WEBHOOK_AUTH_MODE', ['hmac-sha256', 'token', 'none'], 'hmac-sha256', problems),
        maxBodyBytes: num(env, 'WEBHOOK_MAX_BODY_BYTES', 65536, problems, { min: 256 })
      }
    },

    /* -- source -- */
    source: {
      type: o.sourceType || oneOf(env, 'SOURCE_TYPE', SOURCE_TYPES, 'http', problems),
      url: (env.SOURCE_URL || '').trim() || null,
      baseUrl: (env.SOURCE_BASE_URL || '').trim().replace(/\/+$/, '') || null,
      publicBaseUrl: (env.SOURCE_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || null,
      dir: env.SOURCE_DIR ? path.resolve(env.SOURCE_DIR) : null,
      archiveDir: env.SOURCE_ARCHIVE_DIR ? path.resolve(env.SOURCE_ARCHIVE_DIR) : null,
      filePattern: env.SOURCE_FILE_PATTERN || '\\.pdf$',
      timeoutMs: num(env, 'SOURCE_TIMEOUT_MS', 60000, problems, { min: 1000 }),
      retries: num(env, 'SOURCE_RETRIES', 4, problems, { min: 0, max: 10 }),
      maxBytes: num(env, 'SOURCE_MAX_BYTES', 25 * 1024 * 1024, problems, { min: 1024 }),
      headers: jsonOrFile(env.SOURCE_HEADERS, 'SOURCE_HEADERS', problems) || {},
      s3: {
        endpoint: (env.S3_ENDPOINT || '').trim().replace(/\/+$/, '') || null,
        region: (env.S3_REGION || 'ap-south-1').trim(),
        bucket: (env.S3_BUCKET || '').trim() || null,
        prefix: (env.S3_PREFIX || '').replace(/^\/+/, ''),
        accessKeyId: env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || null,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || null,
        sessionToken: env.AWS_SESSION_TOKEN || null,
        forcePathStyle: truthy(env.S3_FORCE_PATH_STYLE, false)
      }
    },

    /* -- publisher -- */
    publisher: {
      type: o.publisherType || oneOf(env, 'PUBLISHER_TYPE', PUBLISHER_TYPES, 'strapi', problems),
      dir: env.PUBLISH_DIR ? path.resolve(env.PUBLISH_DIR) : path.join(stateDir, 'published'),
      url: (env.PUBLISH_URL || '').trim() || null,
      method: (env.PUBLISH_METHOD || 'POST').toUpperCase(),
      headers: jsonOrFile(env.PUBLISH_HEADERS, 'PUBLISH_HEADERS', problems) || {},
      strapi: {
        url: null,                        // filled in below when type === 'strapi'
        token: env.STRAPI_API_TOKEN || null,
        authScheme: env.STRAPI_AUTH_SCHEME || 'Bearer',
        authHeader: env.STRAPI_AUTH_HEADER || 'Authorization',
        collection: (env.STRAPI_COLLECTION || 'research-reports').replace(/^\/+|\/+$/g, ''),
        apiPrefix: (env.STRAPI_API_PREFIX || '/api').replace(/\/+$/, ''),
        apiVersion: oneOf(env, 'STRAPI_API_VERSION', API_VERSIONS, 'auto', problems),
        locale: env.STRAPI_LOCALE || null,
        timeoutMs: num(env, 'STRAPI_TIMEOUT_MS', 30000, problems, { min: 1000 }),
        retries: num(env, 'STRAPI_RETRIES', 4, problems, { min: 0, max: 10 }),
        extraHeaders: jsonOrFile(env.STRAPI_EXTRA_HEADERS, 'STRAPI_EXTRA_HEADERS', problems) || {},
        fieldMap: Object.assign({}, DEFAULT_FIELD_MAP, jsonOrFile(env.STRAPI_FIELD_MAP, 'STRAPI_FIELD_MAP', problems) || {}),
        idField: env.STRAPI_ID_FIELD || 'reportId',
        // Strapi Draft & Publish. 'auto' leaves it alone; see INTEGRATION.md.
        draftAndPublish: oneOf(env, 'STRAPI_DRAFT_AND_PUBLISH', ['off', 'on'], 'off', problems)
      }
    },

    /* -- extraction -- */
    extract: {
      filenamePattern: env.FILENAME_PATTERN || null,
      tickerMap: jsonOrFile(env.BOT_TICKER_MAP, 'BOT_TICKER_MAP', problems) || {},
      slugTemplate: (env.SLUG_TEMPLATE || '').trim() || null,
      sections: jsonOrFile(env.SECTION_MAP, 'SECTION_MAP', problems) || null,
      labels: jsonOrFile(env.LABEL_MAP, 'LABEL_MAP', problems) || null,
      defaultCurrency: env.DEFAULT_CURRENCY || 'INR',
      defaultHoldingPeriod: env.DEFAULT_HOLDING_PERIOD || '12 months',
      maxReportAgeDays: num(env, 'MAX_REPORT_AGE_DAYS', 7, problems, { min: 0 }),
      maxFutureDays: num(env, 'MAX_FUTURE_DAYS', 2, problems, { min: 0 }),
      expectedPageCount: num(env, 'EXPECTED_PAGE_COUNT', 4, problems, { min: 1 })
    },

    /* -- alerting -- */
    alert: {
      webhookUrl: (env.ALERT_WEBHOOK_URL || '').trim() || null,
      headers: jsonOrFile(env.ALERT_WEBHOOK_HEADERS, 'ALERT_WEBHOOK_HEADERS', problems) || {},
      timeoutMs: num(env, 'ALERT_TIMEOUT_MS', 10000, problems, { min: 500 })
    }
  };

  /* -- conditional requirements: only demand what the chosen mode needs -- */

  if (cfg.source.type === 'http' && !cfg.source.url && !cfg.source.baseUrl && !o.file && !o.url) {
    problems.push('SOURCE_TYPE=http needs SOURCE_URL (one report) or SOURCE_BASE_URL (a prefix that keys are appended to), ' +
      'or pass --url/--file on the command line. Example: SOURCE_BASE_URL=https://example.s3.ap-south-1.amazonaws.com/jaamoon-pdf-files');
  }
  if (cfg.source.type === 's3') {
    if (!cfg.source.s3.bucket) problems.push('SOURCE_TYPE=s3 needs S3_BUCKET. Example: S3_BUCKET=ks-oncloudpublic-reports');
    const hasKey = !!cfg.source.s3.accessKeyId, hasSecret = !!cfg.source.s3.secretAccessKey;
    if (hasKey !== hasSecret) {
      problems.push('S3 credentials are half-set: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must both be present, or both absent for anonymous access.');
    }
    if (cfg.trigger.mode === 'poll' && !hasKey) {
      problems.push('TRIGGER_MODE=poll with SOURCE_TYPE=s3 needs credentials: listing a bucket requires s3:ListBucket ' +
        '(the reference bucket refuses anonymous ListObjectsV2 with AccessDenied). Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, ' +
        'or use TRIGGER_MODE=watch over a directory Jamun writes to.');
    }
  }
  if ((cfg.source.type === 'dir' || cfg.trigger.mode === 'watch') && !cfg.source.dir) {
    problems.push('SOURCE_DIR is required for SOURCE_TYPE=dir / TRIGGER_MODE=watch. Example: SOURCE_DIR=/var/spool/jamun/incoming');
  }
  if (cfg.source.type === 'file' && !o.file) {
    problems.push('SOURCE_TYPE=file needs --file <path> on the command line.');
  }

  if (cfg.publisher.type === 'strapi' && !cfg.dryRun) {
    cfg.publisher.strapi.url = requireUrl(env, 'STRAPI_URL', problems, {
      required: true, example: 'STRAPI_URL=https://cms.internal.kotak.com'
    });
    if (!cfg.publisher.strapi.token) {
      problems.push('STRAPI_API_TOKEN is required to publish. Create a custom API token in Strapi with find/create/update ' +
        'on the research-report collection only. Never commit it; load it from the systemd unit\'s EnvironmentFile.');
    }
  } else if (cfg.publisher.type === 'strapi') {
    cfg.publisher.strapi.url = (env.STRAPI_URL || '').trim().replace(/\/+$/, '') || null;
  }
  if (cfg.publisher.type === 'http' && !cfg.dryRun) {
    cfg.publisher.url = requireUrl(env, 'PUBLISH_URL', problems, {
      required: true, example: 'PUBLISH_URL=https://cms.internal.kotak.com/hooks/research-report'
    });
  }
  if (cfg.trigger.mode === 'webhook' && cfg.trigger.webhook.authMode !== 'none' && !cfg.trigger.webhook.secret) {
    problems.push('TRIGGER_MODE=webhook needs WEBHOOK_SECRET (or WEBHOOK_AUTH_MODE=none, which is only acceptable ' +
      'when something in front of the bot already authenticates the caller).');
  }
  if (cfg.extract.slugTemplate && !/\{(name|ticker)\}/.test(cfg.extract.slugTemplate)) {
    problems.push('SLUG_TEMPLATE must contain {name} or {ticker}. Example: SLUG_TEMPLATE={name}-share-price');
  }

  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

/** Options object handed to extract.js, assembled from config. */
function extractOptions(cfg, extra) {
  const e = cfg.extract;
  return Object.assign({
    filenamePattern: e.filenamePattern,
    tickerMap: e.tickerMap,
    slugTemplate: e.slugTemplate,
    sections: e.sections,
    labels: e.labels,
    defaultCurrency: e.defaultCurrency,
    defaultHoldingPeriod: e.defaultHoldingPeriod,
    maxReportAgeDays: e.maxReportAgeDays,
    maxFutureDays: e.maxFutureDays,
    expectedPageCount: e.expectedPageCount,
    maxPdfBytes: cfg.source.maxBytes,
    publicBaseUrl: cfg.source.publicBaseUrl
  }, extra || {});
}

/** Config with every secret replaced, safe to log or print. */
function redactConfig(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg));
  const mask = (v) => (v ? `<set:${String(v).length} chars>` : null);
  if (clone.publisher && clone.publisher.strapi) clone.publisher.strapi.token = mask(cfg.publisher.strapi.token);
  if (clone.source && clone.source.s3) {
    clone.source.s3.secretAccessKey = mask(cfg.source.s3.secretAccessKey);
    clone.source.s3.sessionToken = mask(cfg.source.s3.sessionToken);
    if (cfg.source.s3.accessKeyId) clone.source.s3.accessKeyId = String(cfg.source.s3.accessKeyId).slice(0, 4) + '...';
  }
  if (clone.trigger && clone.trigger.webhook) clone.trigger.webhook.secret = mask(cfg.trigger.webhook.secret);
  for (const bag of [clone.publisher && clone.publisher.headers, clone.source && clone.source.headers,
    clone.publisher && clone.publisher.strapi && clone.publisher.strapi.extraHeaders, clone.alert && clone.alert.headers]) {
    if (!bag) continue;
    for (const k of Object.keys(bag)) if (/auth|token|key|secret|cookie/i.test(k)) bag[k] = '<redacted>';
  }
  return clone;
}

module.exports = {
  load, extractOptions, redactConfig, ConfigError,
  DEFAULT_FIELD_MAP, TRIGGER_MODES, SOURCE_TYPES, PUBLISHER_TYPES, RUN_MODES, API_VERSIONS,
  parseEnvFile
};
