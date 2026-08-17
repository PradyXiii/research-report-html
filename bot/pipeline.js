'use strict';

const { verify, summarise } = require('./verify');
/**
 * pipeline.js -- the one code path every trigger shares.
 *
 *   fetch PDF -> extract page 1 -> render.js validate() -> renderBlock() -> publish
 *
 * The only decision this file makes is WHETHER TO PUBLISH, and it errs towards
 * not publishing. A research recommendation that is half-parsed is worse than
 * one that is a day late: a wrong fair value on a live page is a
 * mis-communicated investment recommendation, whereas a missed run is a stale
 * page and a pager.
 *
 * Outcomes:
 *   published  everything checked out and the publisher wrote it
 *   unchanged  identical content is already published; nothing was written
 *   skipped    a dry run, or shadow mode with publishing withheld
 *   rejected   extraction or validation failed -- dead-lettered, alert raised
 *   failed     the publisher failed after retries -- dead-lettered, alert raised
 */

const fs = require('fs');
const path = require('path');

const { extractFromPdf } = require('./extract');
const { extractOptions } = require('./config');
const { contentHash } = require('./strapi');
const { request } = require('./lib/http');

// The renderer is owned by the other half of this repo. It is required lazily
// so that `--doctor` still reports a useful diagnosis if the path is wrong.
function loadRenderer(cfg) {
  const candidates = [
    process.env.RENDERER_PATH,
    path.join(__dirname, '..', 'src', 'render.js')
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(path.resolve(c)); } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
  }
  throw new Error(
    `Could not load the renderer. Looked in: ${candidates.join(', ')}. ` +
    'Set RENDERER_PATH if src/render.js lives somewhere else.'
  );
}

class Pipeline {
  constructor(cfg, deps) {
    this.cfg = cfg;
    this.log = deps.logger;
    this.source = deps.source;
    this.publisher = deps.publisher;
    this.renderer = deps.renderer || loadRenderer(cfg);
  }

  /**
   * Process one report.
   * @param {*} ref  whatever the trigger produced (URL, key, path, filename)
   * @returns {Promise<object>} outcome record
   */
  async process(ref) {
    const started = Date.now();
    const refId = typeof ref === 'string' ? ref : (ref && (ref.id || ref.key || ref.filename)) || String(ref);
    const log = this.log.child({ ref: refId });
    const outcome = { ref: refId, status: null, reportId: null, action: null, errors: [], warnings: [], notes: [], ms: 0 };

    /* 1. fetch ---------------------------------------------------------- */
    let fetched;
    try {
      fetched = await this.source.fetch(typeof ref === 'string' ? ref : (ref.key || ref.path || ref.filename || ref.id));
      log.info('fetched PDF', { bytes: fetched.buffer.length, filename: fetched.filename });
    } catch (err) {
      return this.fail(outcome, 'failed', 'FETCH_FAILED', err.message, log, started, null);
    }

    /* 2. extract -------------------------------------------------------- */
    const opts = extractOptions(this.cfg, {
      filename: fetched.filename,
      sourceUrl: fetched.url || null
    });
    const extracted = await extractFromPdf(fetched.buffer, opts);
    outcome.errors = extracted.errors;
    outcome.warnings = extracted.warnings;
    outcome.notes = extracted.notes;
    outcome.evidence = extracted.evidence;
    outcome.reportId = extracted.report && extracted.report.reportId ? extracted.report.reportId : null;

    for (const w of extracted.warnings) log.warn(`extraction: ${w.message}`, { code: w.code, field: w.field });
    for (const n of extracted.notes) log.debug(`extraction note: ${n}`);

    if (!extracted.ok) {
      for (const e of extracted.errors) log.error(`extraction: ${e.message}`, { code: e.code, field: e.field });
      return this.fail(outcome, 'rejected', 'EXTRACTION_FAILED',
        `${extracted.errors.length} extraction error(s)`, log, started, { fetched, extracted });
    }

    /* 3. validate against the renderer's own contract -------------------- */
    // validate() throws. A throw means "do not publish, alert a human".
    try {
      this.renderer.validate(extracted.report);
    } catch (err) {
      outcome.errors = outcome.errors.concat([{ code: 'RENDER_VALIDATION_FAILED', field: 'report', message: err.message }]);
      log.error(`render.validate() rejected the extracted report: ${err.message}`);
      return this.fail(outcome, 'rejected', 'RENDER_VALIDATION_FAILED', err.message, log, started, { fetched, extracted });
    }

    /* 3b. warnings gate -------------------------------------------------- */
    if (this.cfg.failOnWarning && extracted.warnings.length) {
      return this.fail(outcome, 'rejected', 'WARNINGS_NOT_ALLOWED',
        `BOT_FAIL_ON_WARNING is on and extraction raised ${extracted.warnings.length} warning(s)`,
        log, started, { fetched, extracted });
    }

    /* 4. render ---------------------------------------------------------- */
    let html;
    try {
      html = this.renderer.renderBlock(extracted.report, { inlineCss: true });
    } catch (err) {
      outcome.errors = outcome.errors.concat([{ code: 'RENDER_FAILED', field: 'report', message: err.message }]);
      return this.fail(outcome, 'rejected', 'RENDER_FAILED', err.message, log, started, { fetched, extracted });
    }
    /* 4b. VERIFY -- the gate. Nothing reaches a publisher that has not been
       reconciled back to the source document. This block sits unread for months;
       a wrong figure that looks right is the failure that costs jobs, so an
       unverifiable render is treated exactly like a failed one. */
    const verification = verify({
      data: extracted.report,
      html: html,
      sourceText: extracted.sourceText,
      page1Text: extracted.page1Text,
      filename: (fetched && fetched.filename) || (this.cfg && this.cfg.filename) || null
    });
    outcome.verification = {
      ok: verification.ok,
      checks: verification.passed.length,
      failures: verification.failures,
      warnings: verification.warnings
    };
    for (const w of verification.warnings) log.warn(`verify: ${w.detail}`, { code: w.code });
    if (!verification.ok) {
      for (const f of verification.failures) log.error(`verify: ${f.detail}`, { code: f.code });
      return this.fail(outcome, 'rejected', 'VERIFICATION_FAILED',
        summarise(verification), log, started, { fetched, extracted });
    }
    log.info(`verified: ${summarise(verification)}`);

    // publishState is part of the stored row, so it must be part of the hash --
    // otherwise flipping shadow -> live would be skipped as "unchanged" and the
    // entry would never go live.
    const publishState = this.cfg.mode === 'live' ? 'live' : 'shadow';
    const hash = contentHash(extracted.report, html, { publishState });
    outcome.hash = hash;
    outcome.publishState = publishState;
    outcome.htmlBytes = html.length;
    // Carried for --out and for the dead-letter record; run.js strips them
    // before printing the outcome, so logs stay readable.
    Object.defineProperty(outcome, 'report', { value: extracted.report, enumerable: false });
    Object.defineProperty(outcome, 'html', { value: html, enumerable: false });

    /* 5. publish --------------------------------------------------------- */
    if (this.cfg.mode === 'shadow' && this.publisher.kind === 'console') {
      log.info('shadow mode with the console publisher: nothing is written');
    }

    try {
      const res = await this.publisher.publish({ report: extracted.report, html, hash, publishState });
      outcome.action = res.action;
      outcome.status = res.action === 'printed' ? 'skipped' : (res.action === 'unchanged' ? 'unchanged' : 'published');
      outcome.publishedId = res.id;
      outcome.ms = Date.now() - started;
      log.info(`report ${outcome.status}`, {
        reportId: outcome.reportId, action: res.action, id: res.id,
        publishState, warnings: extracted.warnings.length, ms: outcome.ms
      });
      return outcome;
    } catch (err) {
      return this.fail(outcome, 'failed', 'PUBLISH_FAILED', err.message, log, started, { fetched, extracted, html });
    }
  }

  /* ------------------------------------------------------------ failure */

  fail(outcome, status, code, message, log, started, context) {
    outcome.status = status;
    outcome.failureCode = code;
    outcome.failureMessage = message;
    outcome.ms = Date.now() - started;
    log.error(`${status}: ${message}`, { code, ref: outcome.ref });
    try {
      outcome.deadLetter = this.deadLetter(outcome, context);
    } catch (err) {
      log.error(`could not write the dead-letter record: ${err.message}`);
    }
    return outcome;
  }

  /**
   * Everything needed to reproduce the failure, on disk, next to the log line.
   * Written even in dry-run: the whole point is that a human can pick it up.
   */
  deadLetter(outcome, context) {
    const dir = this.cfg.deadLetterDir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stem = `${stamp}__${String(outcome.reportId || outcome.ref || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}`;

    const record = {
      at: new Date().toISOString(),
      status: outcome.status,
      failureCode: outcome.failureCode,
      failureMessage: outcome.failureMessage,
      ref: outcome.ref,
      reportId: outcome.reportId,
      mode: this.cfg.mode,
      errors: outcome.errors,
      warnings: outcome.warnings,
      notes: outcome.notes,
      evidence: outcome.evidence || null,
      extractedReport: context && context.extracted ? context.extracted.report : null
    };
    const jsonPath = path.join(dir, `${stem}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2) + '\n');

    // Keep the PDF too: without it the failure cannot be reproduced once the
    // object has been replaced or the spool directory cleaned.
    if (context && context.fetched && context.fetched.buffer && this.cfg.mode !== 'dry-run') {
      const pdfPath = path.join(dir, `${stem}.pdf`);
      fs.writeFileSync(pdfPath, context.fetched.buffer);
      record.pdfPath = pdfPath;
    }
    return jsonPath;
  }

  /**
   * Alerting, without any external SaaS: the exit code (systemd OnFailure=),
   * the ERROR log line (journald / log shipper), the dead-letter file, and
   * optionally one POST to an internal endpoint.
   */
  async alert(outcomes) {
    const bad = outcomes.filter((o) => o.status === 'rejected' || o.status === 'failed');
    if (!bad.length || !this.cfg.alert.webhookUrl) return;
    const body = {
      source: 'kotak-research-report-bot',
      host: require('os').hostname(),
      at: new Date().toISOString(),
      mode: this.cfg.mode,
      failures: bad.map((o) => ({
        ref: o.ref, reportId: o.reportId, status: o.status,
        code: o.failureCode, message: o.failureMessage,
        errors: o.errors.map((e) => `${e.code}: ${e.message}`),
        deadLetter: o.deadLetter
      }))
    };
    try {
      await request(this.cfg.alert.webhookUrl, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, this.cfg.alert.headers),
        body: JSON.stringify(body)
      }, { retries: 2, timeoutMs: this.cfg.alert.timeoutMs, logger: this.log, label: 'alert' });
      this.log.info('alert delivered', { failures: bad.length });
    } catch (err) {
      // Never let a broken alert channel mask the original failure.
      this.log.error(`alert webhook failed: ${err.message}`);
    }
  }
}

module.exports = { Pipeline, loadRenderer };
