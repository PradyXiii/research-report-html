'use strict';
/**
 * Publisher adapters -- "where does the output go".
 *
 * Interface, deliberately four methods wide so another CMS can be dropped in
 * without touching run.js:
 *
 *   describe()                      -> string
 *   publish({ report, html, hash, publishState }) -> { action, id, detail }
 *        action is one of created | updated | unchanged | written | printed
 *   health()                        -> { ok, ... }
 *
 * Strapi is the default. ConsolePublisher and FilePublisher exist so the whole
 * pipeline can be exercised end to end before a CMS is reachable -- that is the
 * dry-run and shadow story, and it is also the fallback if Strapi is down and
 * someone needs the HTML by hand.
 */

const strapiPublisher = require('./strapi');
const filePublisher = require('./file');
const consolePublisher = require('./console');
const httpPublisher = require('./http');

const REGISTRY = {
  strapi: strapiPublisher,
  file: filePublisher,
  console: consolePublisher,
  http: httpPublisher
};

function createPublisher(cfg, deps) {
  // A dry run never writes anywhere, whatever PUBLISHER_TYPE says.
  const type = cfg.dryRun ? 'console' : cfg.publisher.type;
  const factory = REGISTRY[type];
  if (!factory) {
    throw new Error(`Unknown PUBLISHER_TYPE "${type}". Available: ${Object.keys(REGISTRY).join(', ')}.`);
  }
  return factory.create(cfg, deps || {});
}

function registerPublisher(name, factory) {
  if (!factory || typeof factory.create !== 'function') {
    throw new Error(`registerPublisher("${name}"): factory must expose create(cfg, deps).`);
  }
  REGISTRY[name] = factory;
}

module.exports = { createPublisher, registerPublisher, REGISTRY };
