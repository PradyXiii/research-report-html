'use strict';
/**
 * Prints what WOULD be published and writes nothing. This is what --dry-run
 * uses, and it is the honest answer when no CMS is reachable yet.
 */

function create(cfg, deps) {
  const log = deps.logger;

  return {
    kind: 'console',
    describe: () => 'console (prints, writes nothing)',

    async publish({ report, html, hash, publishState }) {
      const rec = report.recommendation || {};
      const summary = {
        reportId: report.reportId,
        stock: `${report.stock.name} (${report.stock.ticker})`,
        rating: rec.rating,
        cmp: rec.cmp,
        fairValue: rec.fairValue,
        publishedAt: report.publishedAt,
        sections: (report.sections || []).map((s) => `${s.title}:${(s.bullets || []).length}`).join(' '),
        htmlBytes: html.length,
        hash: String(hash).slice(0, 12),
        publishState
      };
      log && log.info('DRY RUN -- nothing was written', summary);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return { action: 'printed', id: report.reportId, detail: summary };
    },

    async health() { return { ok: true, note: 'console publisher is always available' }; }
  };
}

module.exports = { create };
