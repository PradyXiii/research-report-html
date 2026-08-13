'use strict';
/**
 * Directory source: Jamun (or an rsync/SFTP drop, or `aws s3 sync`) leaves PDFs
 * in a folder and the bot consumes them.
 *
 * This is the mode that needs least from the environment: no outbound network,
 * no credentials, no webhook endpoint, no bucket policy. Where the trigger is
 * uncertain, this is the safe fallback -- anything that can put a file on disk
 * can drive it.
 *
 * A consumed file is moved to SOURCE_ARCHIVE_DIR (when set) so a re-run cannot
 * reprocess it; without an archive dir we fall back to a processed-set on disk.
 */

const fs = require('fs');
const path = require('path');
const { baseName } = require('../lib/filename');

function create(cfg, deps) {
  const log = deps.logger;
  const s = cfg.source;
  const pattern = new RegExp(s.filePattern, 'i');
  const seenFile = path.join(cfg.stateDir, 'seen-files.json');

  function readSeen() {
    try { return new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8'))); }
    catch (_) { return new Set(); }
  }
  function writeSeen(set) {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    // Keep the tail only; this file is a de-dup guard, not an audit log.
    fs.writeFileSync(seenFile, JSON.stringify(Array.from(set).slice(-5000)));
  }

  function resolve(ref) {
    const raw = String(ref || '').trim();
    if (!raw) throw new Error('No file reference given.');
    const abs = path.isAbsolute(raw) ? raw : path.join(s.dir, raw);
    // Refuse anything that escapes the configured directory.
    const rel = path.relative(s.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`"${raw}" resolves outside SOURCE_DIR (${s.dir}). Refusing.`);
    }
    return {
      id: path.basename(abs),
      filename: path.basename(abs),
      path: abs,
      url: s.publicBaseUrl ? s.publicBaseUrl + '/' + encodeURIComponent(path.basename(abs)) : null,
      meta: {}
    };
  }

  return {
    kind: 'dir',
    describe: () => `directory ${s.dir} (pattern ${s.filePattern})`,
    resolve,

    async fetch(ref) {
      const r = resolve(ref);
      const stat = fs.statSync(r.path);
      if (stat.size > s.maxBytes) throw new Error(`"${r.path}" is ${stat.size} bytes, over SOURCE_MAX_BYTES=${s.maxBytes}.`);
      return Object.assign({}, r, {
        buffer: fs.readFileSync(r.path),
        filename: baseName(r.path) + '.pdf',
        meta: { size: stat.size, mtime: stat.mtime.toISOString() }
      });
    },

    /**
     * Only files that have stopped growing are returned: a partially written
     * upload must never be parsed. `since` filters by mtime.
     */
    async list(opts) {
      const o = opts || {};
      let entries;
      try { entries = fs.readdirSync(s.dir, { withFileTypes: true }); }
      catch (err) { throw new Error(`Cannot read SOURCE_DIR "${s.dir}": ${err.message}`); }

      const seen = readSeen();
      const settleMs = o.settleMs === undefined ? 5000 : o.settleMs;
      const now = Date.now();
      const out = [];
      for (const e of entries) {
        if (!e.isFile() || !pattern.test(e.name)) continue;
        if (seen.has(e.name)) continue;
        const full = path.join(s.dir, e.name);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (now - st.mtimeMs < settleMs) {
          log && log.debug('skipping file still being written', { file: e.name });
          continue;
        }
        if (o.since && st.mtimeMs <= new Date(o.since).getTime()) continue;
        out.push({ id: e.name, filename: e.name, path: full, mtime: st.mtime.toISOString(), size: st.size });
      }
      out.sort((a, b) => a.mtime.localeCompare(b.mtime));
      return out;
    },

    /** Called only after a successful publish, so a failure is retried. */
    async commit(ref) {
      const r = resolve(ref);
      if (s.archiveDir) {
        fs.mkdirSync(s.archiveDir, { recursive: true });
        const dest = path.join(s.archiveDir, path.basename(r.path));
        try {
          fs.renameSync(r.path, dest);
          return;
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          fs.copyFileSync(r.path, dest);   // archive on another filesystem
          fs.unlinkSync(r.path);
          return;
        }
      }
      const seen = readSeen();
      seen.add(path.basename(r.path));
      writeSeen(seen);
    }
  };
}

module.exports = { create };
