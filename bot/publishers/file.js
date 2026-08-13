'use strict';
/**
 * Writes <reportId>.json and <reportId>.html into PUBLISH_DIR.
 *
 * Two real uses: shadow mode with no CMS in the loop at all, and a break-glass
 * path when Strapi is down but the site team needs the block by hand. Writes go
 * to a temp file and are renamed, so a reader never sees a half-written file.
 */

const fs = require('fs');
const path = require('path');

function create(cfg, deps) {
  const log = deps.logger;
  const dir = cfg.publisher.dir;

  return {
    kind: 'file',
    describe: () => `filesystem (${dir})`,

    async publish({ report, html, hash, publishState }) {
      fs.mkdirSync(dir, { recursive: true });
      const stem = String(report.reportId || report.stock.ticker || 'report').replace(/[^A-Za-z0-9._-]/g, '_');
      const jsonPath = path.join(dir, `${stem}.json`);
      const htmlPath = path.join(dir, `${stem}.html`);

      // Unchanged? Say so rather than churning mtimes and log lines.
      try {
        const prev = JSON.parse(fs.readFileSync(path.join(dir, `${stem}.meta.json`), 'utf8'));
        if (prev.hash === hash) {
          log && log.info('output already on disk and unchanged', { reportId: report.reportId });
          return { action: 'unchanged', id: stem, detail: { jsonPath, htmlPath } };
        }
      } catch (_) { /* first write */ }

      const existed = fs.existsSync(jsonPath);
      writeAtomic(jsonPath, JSON.stringify(report, null, 2) + '\n');
      writeAtomic(htmlPath, html);
      writeAtomic(path.join(dir, `${stem}.meta.json`),
        JSON.stringify({ hash, publishState, writtenAt: new Date().toISOString() }, null, 2) + '\n');

      return { action: existed ? 'updated' : 'written', id: stem, detail: { jsonPath, htmlPath } };
    },

    async health() {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.accessSync(dir, fs.constants.W_OK);
        return { ok: true, dir };
      } catch (err) {
        return { ok: false, dir, error: err.message, hint: `PUBLISH_DIR "${dir}" is not writable by this user.` };
      }
    }
  };
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

module.exports = { create };
