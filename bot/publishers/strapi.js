'use strict';
/** Strapi REST publisher: the default. All the interesting logic is in ../strapi.js. */

const { StrapiClient, buildFields, RESERVED_STRAPI_FIELDS } = require('../strapi');

function create(cfg, deps) {
  const log = deps.logger;
  const sc = cfg.publisher.strapi;
  const client = new StrapiClient(sc, deps);

  return {
    kind: 'strapi',
    client,
    describe: () => `Strapi ${sc.apiVersion === 'auto' ? '(version auto-detected)' : sc.apiVersion} at ${sc.url}${sc.apiPrefix}/${sc.collection}`,

    async publish({ report, html, hash, publishState }) {
      if (!report.reportId) {
        throw new Error('Cannot publish without reportId -- there would be no key to de-duplicate on.');
      }
      const { fields, warnings } = buildFields(report, html, sc, { hash, publishState });
      for (const w of warnings) log && log.warn(w, { where: 'STRAPI_FIELD_MAP' });

      const hashField = sc.fieldMap.contentHash || null;
      const res = await client.upsert(report.reportId, fields, { hash, hashField });
      return {
        action: res.action,
        id: res.key,
        detail: {
          apiVersion: client.version,
          fields: Object.keys(fields),
          collection: sc.collection
        }
      };
    },

    health: () => client.health()
  };
}

module.exports = { create, RESERVED_STRAPI_FIELDS };
