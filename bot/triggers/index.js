'use strict';
/**
 * Triggers -- "what starts a run". Every one of them ends up calling the same
 * Pipeline.process(ref), so choosing a trigger never changes what gets
 * published, only when.
 *
 *   once     process the refs given on the command line, exit.  DEFAULT.
 *            Needs nothing from the environment; cron, a systemd timer, Jenkins
 *            or a human can all drive it.
 *   webhook  a small node:http listener Jamun POSTs to. Lowest latency, but
 *            only possible if Jamun can be changed and a port can be opened.
 *   poll     re-list the source on an interval. Needs a source that can list
 *            (S3 with credentials, or a directory).
 *   watch    fs.watch a directory Jamun drops files into. No network at all.
 */

const once = require('./once');
const poll = require('./poll');
const watch = require('./watch');
const webhook = require('./webhook');

const REGISTRY = { once, poll, watch, webhook };

function createTrigger(cfg, deps) {
  const mode = cfg.trigger.mode;
  const factory = REGISTRY[mode];
  if (!factory) throw new Error(`Unknown TRIGGER_MODE "${mode}". Available: ${Object.keys(REGISTRY).join(', ')}.`);
  return factory.create(cfg, deps);
}

function registerTrigger(name, factory) {
  if (!factory || typeof factory.create !== 'function') {
    throw new Error(`registerTrigger("${name}"): factory must expose create(cfg, deps).`);
  }
  REGISTRY[name] = factory;
}

module.exports = { createTrigger, registerTrigger, REGISTRY };
