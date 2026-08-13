'use strict';
/**
 * Poll the source for new objects on an interval.
 *
 * The fallback for when Jamun cannot be changed. It needs a source that can
 * enumerate: S3 with s3:ListBucket, or a directory. Plain HTTPS cannot list, and
 * says so rather than silently finding nothing.
 *
 * A cursor (last seen mtime + the ids at that mtime) is persisted, so a restart
 * does not reprocess the world and does not miss anything published while the
 * bot was down. Ids are kept alongside the timestamp because S3 gives whole-
 * second precision and two objects can share it.
 */

const fs = require('fs');
const path = require('path');
const { summarise } = require('./once');

function create(cfg, deps) {
  const { pipeline, source, logger } = deps;
  const cursorFile = cfg.cursorFile;

  function readCursor() {
    try { return JSON.parse(fs.readFileSync(cursorFile, 'utf8')); }
    catch (_) { return { since: null, seen: [] }; }
  }
  function writeCursor(c) {
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    const tmp = cursorFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n');
    fs.renameSync(tmp, cursorFile);
  }

  async function cycle() {
    const cursor = readCursor();
    let items;
    try {
      // Ask for everything at or after the cursor and filter on ids, so an
      // object written in the same second as the last one is not lost.
      items = await source.list({ since: cursor.since ? shiftBack(cursor.since) : null });
    } catch (err) {
      logger.error(`listing the source failed: ${err.message}`);
      return [];
    }
    const seen = new Set(cursor.seen || []);
    const fresh = items.filter((i) => !seen.has(i.id)).slice(0, cfg.trigger.maxPerCycle);
    if (!fresh.length) {
      logger.debug('poll: nothing new', { listed: items.length, since: cursor.since });
      return [];
    }
    logger.info('poll: new reports found', { count: fresh.length });

    const outcomes = [];
    let high = cursor.since;
    const highIds = new Set(cursor.since ? (cursor.seen || []) : []);
    for (const item of fresh) {
      const outcome = await pipeline.process(item);
      outcomes.push(outcome);
      // Advance the cursor only for items we will not want to retry.
      if (outcome.status === 'failed') continue;
      if (!high || String(item.mtime) > String(high)) { high = item.mtime; highIds.clear(); }
      if (String(item.mtime) === String(high)) highIds.add(item.id);
    }
    if (high) writeCursor({ since: high, seen: Array.from(highIds).slice(-200) });
    await pipeline.alert(outcomes);
    logger.info('poll cycle complete', summarise(outcomes));
    return outcomes;
  }

  return {
    kind: 'poll',
    describe: () => `poll every ${Math.round(cfg.trigger.pollIntervalMs / 1000)}s (cursor: ${cursorFile})`,
    cycle,

    async run() {
      if (typeof source.list !== 'function') {
        throw new Error(`SOURCE_TYPE=${source.kind} cannot list. Use TRIGGER_MODE=once or TRIGGER_MODE=webhook.`);
      }
      await cycle();                     // run immediately, not after one interval
      let stopped = false;
      const stop = () => { stopped = true; };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      while (!stopped) {
        await sleep(cfg.trigger.pollIntervalMs, () => stopped);
        if (!stopped) await cycle();
      }
      logger.info('poll loop stopped');
      return [];
    }
  };
}

/** One second of slack, because S3 LastModified has whole-second precision. */
function shiftBack(iso) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? new Date(t - 1000).toISOString() : iso;
}

function sleep(ms, cancelled) {
  return new Promise((resolve) => {
    const step = Math.min(ms, 1000);
    let waited = 0;
    const timer = setInterval(() => {
      waited += step;
      if (waited >= ms || (cancelled && cancelled())) { clearInterval(timer); resolve(); }
    }, step);
    timer.unref && timer.unref();
  });
}

module.exports = { create };
