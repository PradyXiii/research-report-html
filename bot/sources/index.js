'use strict';
/**
 * Source adapters -- "where does the PDF come from".
 *
 * Every source implements the same tiny interface, so swapping S3 for a
 * watched directory is a config change (SOURCE_TYPE) and nothing else:
 *
 *   describe()          -> string, for logs
 *   resolve(ref)        -> { id, filename, url|null, meta }   (no I/O)
 *   fetch(ref)          -> { buffer, filename, url|null, meta }
 *   list({ since })     -> [ref]           optional; only needed by TRIGGER_MODE=poll/watch
 *   commit(ref)         -> void            optional; e.g. move a consumed file to an archive
 *
 * A `ref` is whatever the trigger produced: a URL, an object key, a filename or
 * a path. Each adapter decides how to interpret it, and none of them are
 * allowed to invent one.
 */

const httpSource = require('./http');
const s3Source = require('./s3');
const fileSource = require('./file');
const dirSource = require('./dir');

const REGISTRY = {
  http: httpSource,
  s3: s3Source,
  file: fileSource,
  dir: dirSource
};

/**
 * @param {object} cfg     full config object
 * @param {object} deps    { logger }
 */
function createSource(cfg, deps) {
  const type = cfg.source.type;
  const factory = REGISTRY[type];
  if (!factory) {
    throw new Error(`Unknown SOURCE_TYPE "${type}". Available: ${Object.keys(REGISTRY).join(', ')}.`);
  }
  return factory.create(cfg, deps || {});
}

/** Register a source implementation at runtime (for a store we have not met). */
function registerSource(name, factory) {
  if (!factory || typeof factory.create !== 'function') {
    throw new Error(`registerSource("${name}"): factory must expose create(cfg, deps).`);
  }
  REGISTRY[name] = factory;
}

module.exports = { createSource, registerSource, REGISTRY };
