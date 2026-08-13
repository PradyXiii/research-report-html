#!/usr/bin/env node
'use strict';
/**
 * run.js -- the entry point. Wires config -> source -> pipeline -> publisher,
 * picks a trigger, and turns the result into an exit code.
 *
 *   node run.js --file ./report.pdf --dry-run
 *   node run.js --url https://.../131440_1_Lenskart....pdf
 *   node run.js --key jaamoon-pdf-files/131440_1_....pdf     # SOURCE_TYPE=s3
 *   node run.js --trigger watch                              # long-running
 *   node run.js --doctor                                     # check the environment
 *
 * Exit codes -- the whole interface for cron, systemd and any scheduler:
 *   0  everything published, unchanged, or a clean dry run
 *   1  unexpected internal error
 *   2  extraction or validation refused to publish  -> a human must look
 *   3  publishing failed after retries              -> retryable, alert
 *   4  configuration or environment is unusable
 *   5  another instance holds the lock
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { load, extractOptions, redactConfig, ConfigError } = require('./config');
const { createLogger } = require('./lib/logger');
const { assertRuntime } = require('./lib/http');
const { createSource } = require('./sources');
const { createPublisher } = require('./publishers');
const { createTrigger } = require('./triggers');
const { Pipeline, loadRenderer } = require('./pipeline');

const EXIT = { OK: 0, INTERNAL: 1, REJECTED: 2, PUBLISH_FAILED: 3, CONFIG: 4, LOCKED: 5 };

/* --------------------------------------------------------------- CLI */

function parseArgs(argv) {
  const out = { refs: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '--dry-run': out.dryRun = true; out.mode = 'dry-run'; break;
      case '--shadow': out.mode = 'shadow'; break;
      case '--live': out.mode = 'live'; break;
      case '--strict': out.strict = true; break;
      case '--verbose': case '-v': out.verbose = true; break;
      case '--json': out.json = true; break;
      case '--doctor': out.doctor = true; break;
      case '--help': case '-h': out.help = true; break;
      case '--print-config': out.printConfig = true; break;
      case '--file': out.file = take(); out.sourceType = 'file'; break;
      case '--url': out.url = take(); out.sourceType = out.sourceType || 'http'; break;
      case '--key': out.key = take(); out.sourceType = out.sourceType || 's3'; break;
      case '--out': out.out = take(); break;
      case '--trigger': out.trigger = take(); break;
      case '--source': out.sourceType = take(); break;
      case '--publisher': out.publisherType = take(); break;
      case '--env-file': out.envFile = take(); break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag "${a}". Run with --help.`);
        out._.push(a);
    }
  }
  return out;
}

const HELP = `
Kotak research one-pager bot -- PDF -> schema.json -> HTML block -> CMS.

USAGE
  node run.js [reference] [flags]

REFERENCE (one of; also settable as SOURCE_URL)
  --file <path>      a local PDF; no network at all
  --url  <https>     a PDF URL
  --key  <s3-key>    an object key, with SOURCE_TYPE=s3

MODE
  --dry-run          extract, validate, render, print. Writes nothing. (default)
  --shadow           publish with publishState=shadow, so the site can ignore it
  --live             publish for real
  --strict           treat any extraction warning as a refusal to publish

OVERRIDES (all also available as environment variables)
  --trigger   once|poll|watch|webhook     (TRIGGER_MODE, default once)
  --source    http|s3|file|dir            (SOURCE_TYPE, default http)
  --publisher strapi|http|file|console    (PUBLISHER_TYPE, default strapi)
  --env-file  <path>                      load KEY=VALUE pairs before starting
  --out <dir>                             also write the JSON and HTML here

DIAGNOSTICS
  --doctor           check runtime, config, source and publisher, then exit
  --print-config     print the resolved config with secrets masked
  --json             machine-readable outcome on stdout
  --verbose          debug logging

EXIT CODES
  0 ok   1 internal   2 refused to publish   3 publish failed   4 config   5 locked

Every variable is documented in bot/.env.example; the deployment guide is
INTEGRATION.md at the repository root.
`;

/* ------------------------------------------------------------ locking */

/**
 * Single-instance lock. Two runs at once could both find "no entry" and both
 * create one; the publisher also guards this, but not starting is cheaper.
 * A stale lock (dead pid) is taken over rather than blocking forever.
 */
function acquireLock(file, logger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(file); } catch (_) {} };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      const alive = holder && holder.pid && holder.host === os.hostname() && isRunning(holder.pid);
      if (alive) return null;
      logger.warn('taking over a stale lock', { file, holder });
      try { fs.unlinkSync(file); } catch (_) {}
    }
  }
  return null;
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/* ------------------------------------------------------------- doctor */

async function doctor(cfg, deps, logger) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('node runtime', true, `${process.version} on ${process.platform}/${process.arch}`);
  add('global fetch', typeof globalThis.fetch === 'function', typeof globalThis.fetch);

  try { require.resolve('pdfjs-dist/legacy/build/pdf.mjs'); add('pdfjs-dist installed', true, require('pdfjs-dist/package.json').version); }
  catch (err) { add('pdfjs-dist installed', false, 'run `npm ci --omit=optional` in bot/'); }

  try { const r = loadRenderer(cfg); add('renderer (src/render.js)', typeof r.renderBlock === 'function', Object.keys(r).join(', ')); }
  catch (err) { add('renderer (src/render.js)', false, err.message); }

  for (const dir of [cfg.stateDir, cfg.deadLetterDir]) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); add(`writable: ${dir}`, true, ''); }
    catch (err) { add(`writable: ${dir}`, false, err.message); }
  }

  add('trigger', true, deps.trigger.describe());
  add('source', true, deps.source.describe());
  add('publisher', true, deps.publisher.describe());

  if (typeof deps.publisher.health === 'function') {
    const h = await deps.publisher.health();
    add('publisher reachable', !!h.ok, h.ok ? JSON.stringify(h) : `${h.error || ''} ${h.hint || ''}`.trim());
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.detail || ''}\n`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) logger.error(`${failed.length} check(s) failed`);
  else logger.info('all checks passed');
  return failed.length ? EXIT.CONFIG : EXIT.OK;
}

/* --------------------------------------------------------------- main */

async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (err) { process.stderr.write(err.message + '\n'); return EXIT.CONFIG; }
  if (args.help) { process.stdout.write(HELP); return EXIT.OK; }

  try { assertRuntime(); }
  catch (err) { process.stderr.write(err.message + '\n'); return EXIT.CONFIG; }

  let cfg;
  try {
    cfg = load(args);
  } catch (err) {
    process.stderr.write((err instanceof ConfigError ? err.message : `Configuration failed: ${err.message}`) + '\n');
    return EXIT.CONFIG;
  }

  const logger = createLogger({ level: cfg.log.level, format: args.json ? 'json' : cfg.log.format });

  if (args.printConfig) {
    process.stdout.write(JSON.stringify(redactConfig(cfg), null, 2) + '\n');
    return EXIT.OK;
  }

  let source, publisher, pipeline, trigger;
  try {
    source = createSource(cfg, { logger });
    publisher = createPublisher(cfg, { logger });
    pipeline = new Pipeline(cfg, { logger, source, publisher });
    trigger = createTrigger(cfg, {
      cfg, logger, source, publisher, pipeline,
      health: async () => {
        const h = typeof publisher.health === 'function' ? await publisher.health() : { ok: true };
        return { ok: !!h.ok, mode: cfg.mode, trigger: cfg.trigger.mode, publisher: h, at: new Date().toISOString() };
      }
    });
  } catch (err) {
    logger.error(err.message);
    return EXIT.CONFIG;
  }

  if (args.doctor) return doctor(cfg, { source, publisher, trigger }, logger);

  logger.info('starting', {
    mode: cfg.mode, trigger: trigger.describe(), source: source.describe(), publisher: publisher.describe(),
    failOnWarning: cfg.failOnWarning, node: process.version
  });

  const release = acquireLock(cfg.lockFile, logger);
  if (!release) {
    logger.error('another instance is already running', { lockFile: cfg.lockFile });
    return EXIT.LOCKED;
  }

  let outcomes = [];
  try {
    const refs = [args.file, args.url, args.key, ...args._, cfg.source.url].filter(Boolean);
    outcomes = await trigger.run(refs.length ? [refs[0]] : []);
  } catch (err) {
    logger.error(err.message, { stack: cfg.log.level === 'debug' ? err.stack : undefined });
    return finish(EXIT.INTERNAL);
  } finally {
    release();
  }

  if (args.out) {
    try { writeArtifacts(args.out, outcomes, cfg, logger); }
    catch (err) { logger.error(`could not write --out artifacts: ${err.message}`); }
  }
  if (args.json) process.stdout.write(JSON.stringify({ mode: cfg.mode, outcomes }, null, 2) + '\n');

  return finish(exitCodeFor(outcomes));

  function finish(code) { return code; }
}

function exitCodeFor(outcomes) {
  if (!outcomes.length) return EXIT.OK;
  if (outcomes.some((o) => o.status === 'rejected')) return EXIT.REJECTED;
  if (outcomes.some((o) => o.status === 'failed')) return EXIT.PUBLISH_FAILED;
  return EXIT.OK;
}

/** --out: drop the JSON, the HTML and the outcome next to each other. */
function writeArtifacts(dir, outcomes, cfg, logger) {
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const o of outcomes) {
    const stem = String(o.reportId || o.ref || 'report').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
    fs.writeFileSync(path.join(dir, `${stem}.outcome.json`), JSON.stringify(o, null, 2) + '\n');
    if (o.report) fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(o.report, null, 2) + '\n');
    if (o.html) fs.writeFileSync(path.join(dir, `${stem}.html`), o.html);
    written++;
  }
  logger.info('artifacts written', { dir, count: written });
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`unhandled: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = EXIT.INTERNAL;
    });
}

module.exports = { main, parseArgs, acquireLock, exitCodeFor, EXIT };
