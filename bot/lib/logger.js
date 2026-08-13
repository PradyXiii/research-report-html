'use strict';
/**
 * Structured logger. Two formats:
 *   text  -- human readable, for a terminal or `journalctl`
 *   json  -- one JSON object per line, for any log shipper
 *
 * No transport of its own: it writes to stdout/stderr and lets the process
 * manager (systemd, cron MAILTO, a file redirect, Docker) own the sink. That
 * is deliberate -- it works identically in every environment.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function createLogger(opts) {
  const o = opts || {};
  const min = LEVELS[o.level] === undefined ? LEVELS.info : LEVELS[o.level];
  const format = o.format === 'json' ? 'json' : 'text';
  const base = o.base || {};

  function emit(level, msg, fields) {
    if (LEVELS[level] < min) return;
    const rec = Object.assign({ ts: new Date().toISOString(), level, msg }, base, fields || {});
    const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    if (format === 'json') {
      stream.write(JSON.stringify(rec) + '\n');
      return;
    }
    const extras = Object.keys(rec)
      .filter((k) => k !== 'ts' && k !== 'level' && k !== 'msg')
      .map((k) => `${k}=${scalar(rec[k])}`)
      .join(' ');
    stream.write(`${rec.ts} ${level.toUpperCase().padEnd(5)} ${msg}${extras ? '  ' + extras : ''}\n`);
  }

  function scalar(v) {
    if (v === null || v === undefined) return '-';
    if (typeof v === 'object') return JSON.stringify(v);
    const s = String(v);
    return /\s/.test(s) ? JSON.stringify(s) : s;
  }

  const log = {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(Object.assign({}, o, { base: Object.assign({}, base, fields) }))
  };
  return log;
}

module.exports = { createLogger, LEVELS };
