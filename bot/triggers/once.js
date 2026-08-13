'use strict';
/**
 * One-shot: process the references handed in, then exit.
 *
 * This is the default because it assumes the least. Any scheduler that exists
 * anywhere -- systemd timer, cron, Autosys, Control-M, a person on a laptop --
 * can run it, and the exit code is the whole interface.
 */

function create(cfg, deps) {
  const { pipeline, logger } = deps;

  return {
    kind: 'once',
    describe: () => 'one-shot (process the given references and exit)',

    async run(refs) {
      const list = (refs || []).filter(Boolean);
      if (!list.length) {
        throw new Error(
          'Nothing to process. Give a reference: --url <https://...>, --file <path>, --key <s3-key>, ' +
          'or set SOURCE_URL. For a directory sweep use TRIGGER_MODE=watch or TRIGGER_MODE=poll.'
        );
      }
      const outcomes = [];
      for (const ref of list) {
        outcomes.push(await pipeline.process(ref));
      }
      await pipeline.alert(outcomes);
      logger.info('run complete', summarise(outcomes));
      return outcomes;
    }
  };
}

function summarise(outcomes) {
  const by = {};
  for (const o of outcomes) by[o.status] = (by[o.status] || 0) + 1;
  return Object.assign({ total: outcomes.length }, by);
}

module.exports = { create, summarise };
