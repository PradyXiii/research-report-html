'use strict';
/**
 * Watch a directory that Jamun (or an sftp/rsync/aws-s3-sync job) drops PDFs
 * into. No inbound port, no outbound network, no credentials -- the mode with
 * the fewest environmental prerequisites, and therefore the one to fall back to
 * when nothing else can be agreed.
 *
 * fs.watch is used as a hint only; a slow sweep runs regardless, because
 * fs.watch is unreliable over NFS/CIFS and coalesces events under load. The
 * sweep is the correctness mechanism, the watcher is the latency mechanism.
 */

const fs = require('fs');
const { summarise } = require('./once');

function create(cfg, deps) {
  const { pipeline, source, logger } = deps;
  const dir = cfg.source.dir;
  let busy = false;

  async function sweep() {
    if (busy) return [];
    busy = true;
    try {
      const items = await source.list({ settleMs: 5000 });
      if (!items.length) return [];
      logger.info('watch: files ready', { count: items.length });
      const outcomes = [];
      for (const item of items.slice(0, cfg.trigger.maxPerCycle)) {
        const outcome = await pipeline.process(item);
        outcomes.push(outcome);
        // Archive only what will not be retried; a transient publish failure
        // must leave the file in place for the next sweep.
        if (outcome.status !== 'failed' && typeof source.commit === 'function') {
          try { await source.commit(item.path || item.filename); }
          catch (err) { logger.error(`could not archive ${item.filename}: ${err.message}`); }
        }
      }
      await pipeline.alert(outcomes);
      logger.info('watch sweep complete', summarise(outcomes));
      return outcomes;
    } finally {
      busy = false;
    }
  }

  return {
    kind: 'watch',
    describe: () => `watch ${dir} (sweep every ${Math.round(cfg.trigger.pollIntervalMs / 1000)}s)`,
    sweep,

    async run() {
      if (!fs.existsSync(dir)) throw new Error(`SOURCE_DIR "${dir}" does not exist.`);
      await sweep();

      let watcher = null;
      let debounce = null;
      try {
        watcher = fs.watch(dir, () => {
          clearTimeout(debounce);
          debounce = setTimeout(() => { sweep().catch((e) => logger.error(e.message)); }, 2000);
        });
      } catch (err) {
        logger.warn(`fs.watch is unavailable on this filesystem (${err.message}); relying on the periodic sweep only`);
      }

      const timer = setInterval(() => { sweep().catch((e) => logger.error(e.message)); }, cfg.trigger.pollIntervalMs);
      await new Promise((resolve) => {
        const stop = () => { clearInterval(timer); clearTimeout(debounce); watcher && watcher.close(); resolve(); };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      logger.info('watcher stopped');
      return [];
    }
  };
}

module.exports = { create };
