#!/usr/bin/env node
/**
 * render.js -- Kotak research one-pager: JSON -> HTML block.
 *
 * Deterministic and dependency-free so it can run anywhere on the Kotak
 * server that hosts Strapi (Node 16+, no npm install, no network).
 *
 * Usage
 *   node src/render.js data/lenskart-2026-05-21.json                  > block.html
 *   node src/render.js data/lenskart-2026-05-21.json --inline-css     > block.html
 *   node src/render.js data/lenskart-2026-05-21.json --standalone     > page.html
 *   node src/render.js data/lenskart-2026-05-21.json --theme=dark --standalone
 *
 * Flags
 *   --inline-css   embed krb.css in a <style> tag inside the block, so the
 *                  fragment is fully self-contained when injected by Strapi.
 *   --standalone   wrap in a full HTML document (for QA / preview / print).
 *   --theme=dark   force a theme instead of following the host page / OS.
 *   --no-ld        omit the JSON-LD structured-data script.
 *
 * Programmatic
 *   const { renderBlock } = require('./src/render');
 *   const html = renderBlock(reportJson, { inlineCss: true });
 */

'use strict';

const fs = require('fs');
const path = require('path');
const boilerplate = require('./boilerplate');

/* ------------------------------------------------------------------ utils */

/** Escape every value that reaches the DOM. Never interpolate raw input. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape for use inside an href/src attribute; blocks javascript: URLs. */
function escUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^(https?:|mailto:|tel:|\/|#)/i.test(raw)) return '';
  return esc(raw);
}

/** Turn bare http(s) URLs in already-escaped text into links. */
function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<)"]+[^\s<).,"'])/g, (m) =>
    `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`
  );
}

/** 487 -> "487", 1234.5 -> "1,234.5" (Indian grouping). */
function formatNumber(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** "2026-05-21" -> "21 May 2026". Passes through anything it can't parse. */
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/* -------------------------------------------------------------- validation */

const REQUIRED = [
  ['publishedAt', (d) => /^\d{4}-\d{2}-\d{2}$/.test(d.publishedAt || '')],
  ['stock.name', (d) => !!(d.stock && d.stock.name)],
  ['stock.ticker', (d) => !!(d.stock && d.stock.ticker)],
  ['report.type', (d) => !!(d.report && d.report.type)],
  ['recommendation.rating', (d) => !!(d.recommendation && d.recommendation.rating)],
  ['recommendation.cmp', (d) => Number.isFinite(Number(d.recommendation && d.recommendation.cmp))],
  ['recommendation.fairValue', (d) =>
    d.recommendation.fairValue === null ||
    Number.isFinite(Number(d.recommendation && d.recommendation.fairValue))],
  ['sections', (d) => Array.isArray(d.sections) && d.sections.length > 0]
];

const VALID_RATINGS = ['BUY', 'ADD', 'REDUCE', 'SELL', 'NR', 'SUBSCRIBE', 'RS', 'NA', 'NM'];

/**
 * Throws on anything that would render a broken or misleading block.
 * The bot should treat a throw as "do not publish, alert a human".
 */
function validate(data) {
  const errors = [];
  if (!data || typeof data !== 'object') throw new Error('Report data must be an object');

  for (const [field, ok] of REQUIRED) {
    if (!ok(data)) errors.push(`Missing or invalid: ${field}`);
  }

  const rating = data.recommendation && String(data.recommendation.rating || '').toUpperCase();
  if (rating && !VALID_RATINGS.includes(rating)) {
    errors.push(`Unknown rating "${rating}" -- expected one of ${VALID_RATINGS.join(', ')}`);
  }

  (data.sections || []).forEach((s, i) => {
    if (!s.title) errors.push(`sections[${i}].title is required`);
    const hasBullets = Array.isArray(s.bullets) && s.bullets.length > 0;
    const hasParas = Array.isArray(s.paragraphs) && s.paragraphs.length > 0;
    if (!hasBullets && !hasParas) errors.push(`sections[${i}] ("${s.title}") has no bullets or paragraphs`);
  });

  if (errors.length) throw new Error('Invalid report data:\n  - ' + errors.join('\n  - '));
  return true;
}

/** Upside to fair value, in %. Null when FV is absent (NR / RS reports). */
function computeUpside(cmp, fairValue) {
  // Guard the empty cases explicitly: Number(null) and Number('') are both 0,
  // which would silently render an NR/RS report as a -100% "upside".
  const blank = (v) => v === null || v === undefined || v === '';
  if (blank(cmp) || blank(fairValue)) return null;
  const c = Number(cmp);
  const f = Number(fairValue);
  if (!Number.isFinite(c) || !Number.isFinite(f) || c === 0) return null;
  return ((f - c) / c) * 100;
}

/* -------------------------------------------------------------------- logo */

/**
 * Typographic placeholder for the brand lockup. Set in CSS rather than shipped
 * as an image, so it stays crisp at any size and recolours per template.
 * Swap for the real asset when the brand file arrives: pass options.logoUrl.
 */
function renderWordmark(options, variant) {
  const url = options && options.logoUrl ? escUrl(options.logoUrl) : '';
  if (url) return `<img class="krb__logo" src="${url}" alt="Kotak Neo" width="360" height="80">`;
  const pcg = variant === 'pcg'
    ? '<span class="krb__wm-rule"></span><span class="krb__wm-pcg">Private<br>Client<br>Group</span>'
    : '';
  return `<span class="krb__wordmark" role="img" aria-label="Kotak Neo${variant === 'pcg' ? ' Private Client Group' : ''}">` +
         `<span class="krb__wm-mark" aria-hidden="true"></span>` +
         `<span class="krb__wm-name">kotak <b>neo</b></span>${pcg}</span>`;
}

/* ---------------------------------------------------------------- partials */

/**
 * Labels reproduced exactly as they appear on page 1. They are constant across
 * every report, so they live here rather than in the per-report JSON.
 */
const PAGE1 = {
  dated: 'Dated:',
  cmp: 'Current Market Price (CMP)',
  fv: 'Fair Value (FV)',
  holding: 'Holding Period:'
};

const ICONS = {
  rationale: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 19V9m5 10V5m5 14v-7m5 7V8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  positive: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 13.5 9 18.5 20 6.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  negative: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 8v5m0 3.5v.2M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function iconFor(section) {
  if (section.icon && ICONS[section.icon]) return ICONS[section.icon];
  const tone = String(section.tone || '').toLowerCase();
  if (tone === 'positive') return ICONS.positive;
  if (tone === 'negative') return ICONS.negative;
  return ICONS.rationale;
}

function renderSection(section, index) {
  const tone = String(section.tone || 'neutral').toLowerCase();
  const id = esc(section.id || ('section-' + (index + 1)));
  const count = (section.bullets || []).length;
  const items = (section.bullets || []).map((b) => `<li>${linkify(esc(b))}</li>`).join('\n              ');
  const paras = (section.paragraphs || []).map((p) => `<p>${linkify(esc(p))}</p>`).join('\n              ');
  const modifier = index === 0 ? ' krb__card--thesis' : '';
  const heading = /[:：]$/.test(section.title) ? section.title : section.title + ':';

  return `          <section class="krb__card${modifier}" data-tone="${esc(tone)}" aria-labelledby="krb-${id}">
            <div class="krb__card-head">
              <span class="krb__icon">${iconFor(section)}</span>
              <h3 class="krb__card-title" id="krb-${id}">${esc(heading)}</h3>
              ${count ? `<span class="krb__count">${count}</span>` : ''}
            </div>
${items ? `            <ul class="krb__list">\n              ${items}\n            </ul>` : ''}${paras ? `\n            <div class="krb__prose">\n              ${paras}\n            </div>` : ''}
          </section>`;
}

/**
 * The hero carries everything a reader needs before scrolling: what the report
 * is, the company, the rating AND what that rating means, and the holding
 * period. The rating definition is quoted verbatim from the scale on page 2 --
 * it is the report's own wording, not an interpretation of it.
 */
function renderHero(data, options) {
  const rec = data.recommendation;
  const rating = String(rec.rating).toUpperCase();
  const band = boilerplate.ratingScale.find((r) => r.code === rating);
  const definition = band ? ((band.lead ? band.lead + ' ' : '') + band.text) : '';
  const chips = [
    { text: data.report.type, lead: true },
    { text: data.report.period },
    { text: PAGE1.dated + ' ' + formatDate(data.publishedAt) }
  ].filter((c) => c.text);

  return `        <header class="krb__hero">
          <div class="krb__hero-inner">
            ${renderWordmark(options, 'neo')}
            <div class="krb__chips">
${chips.map((c) => `              <span class="krb__chip${c.lead ? ' krb__chip--lead' : ''}">${esc(c.text)}</span>`).join('\n')}
            </div>
            <div class="krb__headrow">
              <div class="krb__identity">
                <h2 class="krb__title" itemprop="headline">${esc(data.stock.name)} (${esc(data.stock.ticker)})</h2>
${rec.holdingPeriod ? `                <span class="krb__holding">${esc(PAGE1.holding)} ${esc(rec.holdingPeriod)}</span>` : ''}
              </div>
              <div class="krb__verdict">
                <span class="krb__verdict-label">Rating</span>
                <span class="krb__verdict-value">${esc(rating)}</span>
${definition ? `                <span class="krb__verdict-note">${esc(definition)}</span>` : ''}
              </div>
            </div>
          </div>
        </header>`;
}

function money(value, currency) {
  const mark = currency === 'INR' || !currency ? 'Rs.' : String(currency) + ' ';
  return `<sup>${esc(mark)}</sup>${esc(formatNumber(value))}`;
}

/** The two figures printed on page 1. Nothing derived from them. */
function renderPrices(data) {
  const rec = data.recommendation;
  const tiles = [
    `          <div class="krb__kpi">
            <span class="krb__kpi-label">${esc(PAGE1.cmp)}</span>
            <span class="krb__kpi-value">${money(rec.cmp, rec.currency)}</span>
          </div>`
  ];
  if (rec.fairValue !== null && rec.fairValue !== undefined) {
    tiles.push(`          <div class="krb__kpi krb__kpi--hero">
            <span class="krb__kpi-label">${esc(PAGE1.fv)}</span>
            <span class="krb__kpi-value">${money(rec.fairValue, rec.currency)}</span>
          </div>`);
  }
  return `        <div class="krb__kpis">\n${tiles.join('\n')}\n        </div>`;
}

function renderRatingScale(data) {
  // A multi-stock table has no single rating, so nothing is marked current.
  const current = data && data.recommendation ? String(data.recommendation.rating).toUpperCase() : null;
  const rows = boilerplate.ratingScale.map((r) => {
    const isCurrent = r.code === current;
    return `            <div${isCurrent ? ' data-current="true"' : ''}>` +
      `<dt>${esc(r.code)}${isCurrent ? '<span class="krb__scale-flag">This report</span>' : ''}</dt>` +
      `<dd>${r.lead ? `<strong>${esc(r.lead)}</strong> ` : ''}${esc(r.text)}</dd></div>`;
  }).join('\n');
  return `          <dl class="krb__scale">\n${rows}\n          </dl>`;
}

function renderTeams() {
  const groups = boilerplate.researchTeams.map((g) => {
    const people = g.members.map((m) => `                <div class="krb__person">
                  <strong>${esc(m.name)}</strong>
                  ${m.role ? `<span>${esc(m.role)}</span>` : ''}
                  <a href="mailto:${escUrl('mailto:' + m.email).replace(/^mailto:/, '')}">${esc(m.email)}</a>
                  <a href="tel:${esc(String(m.phone).replace(/[^\d+]/g, ''))}">${esc(m.phone)}</a>
                </div>`).join('\n');
    return `            <div class="krb__team-group">
              <h4>${esc(g.name)}</h4>
              <div class="krb__team-grid">
${people}
              </div>
            </div>`;
  }).join('\n');
  return `          <div class="krb__team">\n${groups}\n          </div>`;
}

function renderDisclosures() {
  const warnings = boilerplate.riskWarnings
    .map((w) => `          <p class="krb__risk">${esc(w)}</p>`).join('\n');
  const paras = boilerplate.disclosures
    .map((p) => `          <p>${linkify(esc(p))}</p>`).join('\n');
  return `${warnings}\n${paras}`;
}

function renderJsonLd(data) {
  const rec = data.recommendation;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Report',
    headline: `${data.stock.name} (${data.stock.ticker}) - ${rec.rating}`,
    datePublished: data.publishedAt,
    inLanguage: 'en-IN',
    about: { '@type': 'Corporation', name: data.stock.name, tickerSymbol: data.stock.ticker },
    publisher: { '@type': 'Organization', name: 'Kotak Securities Limited', url: 'https://www.kotakneo.com' },
    genre: data.report.type
  };
  const pdfUrl = escUrl(data.sourcePdf);
  if (pdfUrl) ld.encoding = { '@type': 'MediaObject', contentUrl: data.sourcePdf, encodingFormat: 'application/pdf' };
  // </script> can never appear: JSON.stringify escapes nothing, so guard it.
  return `      <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
}

/* ------------------------------------------------------------------ block */

/* ================================================================= variants */

function shell(inner, data, opts, extraClass) {
  const themeAttr = opts.theme ? ` data-krb-theme="${esc(opts.theme)}"` : '';
  const css = opts.inlineCss
    ? `      <style>\n${fs.readFileSync(path.join(__dirname, 'krb.css'), 'utf8')}\n      </style>\n`
    : '';
  const rating = data.recommendation ? esc(String(data.recommendation.rating).toUpperCase()) : '';
  return `${css}      <article class="krb${extraClass ? ' ' + extraClass : ''}"${themeAttr}${rating ? ` data-krb-rating="${rating}"` : ''} itemscope itemtype="https://schema.org/Report">
${inner}
${opts.jsonLd === false || !data.stock ? '' : renderJsonLd(data)}
      </article>`;
}

function disclosures(data) {
  return `        <div class="krb__disclosures">
          <details class="krb__acc">
            <summary>Rating Scale (Private Client Group)</summary>
            <div class="krb__acc-body"><p class="krb__acc-lead">Definitions of ratings</p>
${renderRatingScale(data)}</div>
          </details>
          <details class="krb__acc">
            <summary>Research Team (Private Client Group)</summary>
            <div class="krb__acc-body">${renderTeams()}</div>
          </details>
          <details class="krb__acc">
            <summary>Disclosure / Disclaimer</summary>
            <div class="krb__acc-body">${renderDisclosures()}</div>
          </details>
        </div>`;
}

/* ---- Pick of the Week ---------------------------------------------------- */
function renderPickOfWeek(data, opts) {
  const rec = data.recommendation;
  const rating = String(rec.rating).toUpperCase();
  const band = boilerplate.ratingScale.find((r) => r.code === rating);
  const cur = rec.currency === 'INR' || !rec.currency ? '\u20b9' : rec.currency + ' ';
  const asOn = rec.cmpAsOn ? ` as on ${formatDate(rec.cmpAsOn)}` : '';
  const inner = `        <header class="krb__hero krb__hero--potw">
          <div class="krb__hero-inner">
            ${renderWordmark(opts, 'neo')}
            <div class="krb__chips"><span class="krb__chip krb__chip--lead">${esc(data.report.type)}</span></div>
            <div class="krb__headrow">
              <div class="krb__identity">
                <h2 class="krb__title" itemprop="headline"><span class="krb__potw-rating">${esc(rating)}</span> &ndash; ${esc(data.stock.name)} (${esc(data.stock.ticker)})</h2>
${rec.timePeriod ? `                <span class="krb__holding">Time Period: ${esc(rec.timePeriod)}</span>` : ''}
              </div>
              <div class="krb__verdict">
                <span class="krb__verdict-label">Rating</span>
                <span class="krb__verdict-value">${esc(rating)}</span>
${band ? `                <span class="krb__verdict-note">${esc(band.text)}</span>` : ''}
              </div>
            </div>
          </div>
        </header>

        <div class="krb__kpis">
          <div class="krb__kpi"><span class="krb__kpi-label">CMP</span><span class="krb__kpi-value"><sup>${esc(cur)}</sup>${esc(formatNumber(rec.cmp))}</span>${asOn ? `<span class="krb__kpi-note">${esc(asOn.trim())}</span>` : ''}</div>
          <div class="krb__kpi krb__kpi--hero"><span class="krb__kpi-label">Fair Value (FV)</span><span class="krb__kpi-value"><sup>${esc(cur)}</sup>${esc(formatNumber(rec.fairValue))}</span></div>
        </div>

        <div class="krb__body">
${data.sections.map(renderSection).join('\n')}
${data.abbreviations ? `          <p class="krb__note">${esc(data.abbreviations)}</p>` : ''}
${rec.closing ? `          <p class="krb__closing">${esc(rec.closing)}</p>` : ''}
        </div>
${data.attribution ? `        <p class="krb__attribution">${linkify(esc(data.attribution))}</p>` : ''}
${rec.holdingPeriod ? `        <p class="krb__foot-holding">Holding Period: ${esc(rec.holdingPeriod)}</p>` : ''}
${disclosures(data)}`;
  return shell(inner, data, opts, 'krb--potw');
}

/* ---- Stock Recommendations table ---------------------------------------- */
function renderStockRecos(data, opts) {
  const cols = data.columns || [];
  const head = `              <tr><th scope="col" class="krb__t-name">Name of the Company</th><th scope="col">Reco</th>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr>`;
  const body = (data.sectors || []).map((sec) => {
    const rows = sec.rows.map((r) => {
      const cells = (r.cells || []).map((c) => `<td>${esc(c)}</td>`).join('');
      return `              <tr><th scope="row" class="krb__t-name">${esc(r.name)}</th><td><span class="krb__t-reco" data-reco="${esc(r.reco)}">${esc(r.reco)}</span></td>${cells}</tr>`;
    }).join('\n');
    return `              <tr class="krb__t-sector"><th scope="rowgroup" colspan="${cols.length + 2}">${esc(sec.name)}</th></tr>\n${rows}`;
  }).join('\n');
  const count = (data.sectors || []).reduce((n, s) => n + s.rows.length, 0);

  const inner = `        <header class="krb__hero krb__hero--table">
          <div class="krb__hero-inner">
            ${renderWordmark(opts, 'pcg')}
            <div class="krb__chips"><span class="krb__chip krb__chip--lead">${esc(data.report.type)}</span><span class="krb__chip">${esc(formatDate(data.publishedAt))}</span></div>
            <h2 class="krb__title" itemprop="headline">${esc(data.report.type)}</h2>
            <span class="krb__holding">${count} stocks &middot; ${(data.sectors || []).length} sectors</span>
          </div>
        </header>
        <div class="krb__tablewrap" tabindex="0" role="region" aria-label="Stock recommendations table">
          <table class="krb__table">
            <thead>
${head}
            </thead>
            <tbody>
${body}
            </tbody>
          </table>
        </div>
${data.footnote ? `        <p class="krb__note krb__note--table">${esc(data.footnote)}</p>` : ''}
${disclosures(data)}`;
  return shell(inner, data, opts, 'krb--table');
}

/* ---- KIE full research report -------------------------------------------- */
function renderKie(data, opts) {
  const rec = data.recommendation;
  const rating = String(rec.rating).toUpperCase();
  const cur = '\u20b9';
  const panel = (p) => {
    const cols = p.columns ? `<tr><td></td>${p.columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr>` : '';
    const rows = p.rows.map((r) => `<tr><th scope="row">${esc(r[0])}</th>${r.slice(1).map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
    return `            <section class="krb__panel"><h4>${esc(p.title)}</h4><table>${cols}${rows}</table></section>`;
  };
  const inner = `        <header class="krb__hero krb__hero--kie">
          <div class="krb__hero-inner">
            ${renderWordmark(opts, 'neo')}
            <div class="krb__headrow">
              <div class="krb__identity">
                <h2 class="krb__title" itemprop="headline">${esc(data.stock.name)} <span class="krb__kie-tic">(${esc(data.stock.ticker)})</span></h2>
${data.stock.sector ? `                <span class="krb__holding">${esc(data.stock.sector)}</span>` : ''}
              </div>
              <div class="krb__verdict"><span class="krb__verdict-label">Rating</span><span class="krb__verdict-value">${esc(rating)}</span></div>
            </div>
            <dl class="krb__kie-meta">
              <div><dt>CMP (${cur})</dt><dd>${esc(formatNumber(rec.cmp))}</dd></div>
              <div><dt>Fair Value (${cur})</dt><dd>${esc(formatNumber(rec.fairValue))}</dd></div>
${rec.sectorView ? `              <div><dt>Sector View</dt><dd>${esc(rec.sectorView)}</dd></div>` : ''}
${rec.benchmark ? `              <div><dt>${esc(rec.benchmark.name)}</dt><dd>${esc(rec.benchmark.value)}</dd></div>` : ''}
              <div><dt>Dated</dt><dd>${esc(formatDate(data.publishedAt))}</dd></div>
            </dl>
          </div>
        </header>
${data.restricted ? `        <p class="krb__restricted"><strong>Circulation restriction.</strong> ${esc(data.restricted)}</p>` : ''}
        <div class="krb__kie-grid">
          <div class="krb__kie-main">
            <h3 class="krb__kie-headline">${esc(data.headline)}</h3>
            <p class="krb__kie-summary">${esc(data.summary)}</p>
${(data.sections || []).map((sec) => `            <section class="krb__kie-sec"><h4>${esc(sec.title)}</h4>${(sec.paragraphs || []).map((t) => `<p>${esc(t)}</p>`).join('')}</section>`).join('\n')}
${data.analysts && data.analysts.length ? `            <p class="krb__kie-by">${esc(data.analysts.join(' \u00b7 '))}</p>` : ''}
          </div>
          <aside class="krb__kie-side">
${(data.panels || []).map(panel).join('\n')}
${data.source ? `            <p class="krb__kie-src">${esc(data.source)}</p>` : ''}
${data.priceNote ? `            <p class="krb__kie-src">${esc(data.priceNote)}</p>` : ''}
          </aside>
        </div>
${disclosures(data)}`;
  return shell(inner, data, opts, 'krb--kie');
}

const VARIANTS = {
  'pick-of-the-week': renderPickOfWeek,
  'stock-recommendations': renderStockRecos,
  'kie-full-report': renderKie
};

function renderBlock(data, options) {
  const opts = options || {};
  // Format decides the template. An unknown format must never be rendered with
  // whatever template happens to be first.
  const variant = VARIANTS[data && data.format];
  if (variant) return variant(data, opts);
  validate(data);

  const rating = String(data.recommendation.rating).toUpperCase();
  const themeAttr = opts.theme ? ` data-krb-theme="${esc(opts.theme)}"` : '';

  const css = opts.inlineCss
    ? `      <style>\n${fs.readFileSync(path.join(__dirname, 'krb.css'), 'utf8')}\n      </style>\n`
    : '';

  // First section is the thesis and gets the full-width card; the rest pair up
  // as a split that collapses to one column when the block is narrow.
  const cards = data.sections.map(renderSection);
  const thesis = cards.length ? cards[0] : '';
  const rest = cards.slice(1);

  return `${css}      <article class="krb"${themeAttr} data-krb-rating="${esc(rating)}" itemscope itemtype="https://schema.org/Report">
${renderHero(data, opts)}

${renderPrices(data)}

        <div class="krb__body">
${thesis}
${rest.length ? `          <div class="krb__split">\n${rest.join('\n')}\n          </div>` : ''}
${data.abbreviations ? `          <p class="krb__note">${esc(data.abbreviations)}</p>` : ''}
        </div>

${data.attribution ? `        <p class="krb__attribution">${linkify(esc(data.attribution))}</p>` : ''}

        <div class="krb__disclosures">
          <details class="krb__acc">
            <summary>Rating Scale (Private Client Group)</summary>
            <div class="krb__acc-body">
              <p class="krb__acc-lead">Definitions of ratings</p>
${renderRatingScale(data)}
            </div>
          </details>

          <details class="krb__acc">
            <summary>Research Team (Private Client Group)</summary>
            <div class="krb__acc-body">
${renderTeams()}
            </div>
          </details>

          <details class="krb__acc">
            <summary>Disclosure / Disclaimer</summary>
            <div class="krb__acc-body">
${renderDisclosures()}
            </div>
          </details>
        </div>
${opts.jsonLd === false ? '' : renderJsonLd(data)}
      </article>`;
}

/* ------------------------------------------------------------- standalone */

function renderStandalone(data, options) {
  const opts = options || {};
  // A multi-stock table has no single company or rating, so build the page
  // title from whatever the format actually carries.
  const rec = data.recommendation;
  const stock = data.stock;
  const rating = rec ? String(rec.rating).toUpperCase() : '';
  const title = stock
    ? `${stock.name} (${stock.ticker})${rating ? ' - ' + rating : ''} | ${data.report.type}`
    : `${data.report.type} | Kotak Securities`;
  const desc = stock
    ? `Kotak Securities ${data.report.type} on ${stock.name}.${rating ? ' Rating ' + rating + ',' : ''} CMP ${formatNumber(rec.cmp)}${rec.fairValue ? `, Fair Value ${formatNumber(rec.fairValue)}` : ''}.`
    : `Kotak Securities ${data.report.type}, ${formatDate(data.publishedAt)}.`;
  const block = renderBlock(data, Object.assign({}, opts, { inlineCss: false }));

  return `<!doctype html>
<html lang="en-IN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <style>
${fs.readFileSync(path.join(__dirname, 'krb.css'), 'utf8')}
  </style>
</head>
<body class="krb-page"${opts.theme ? ` data-krb-theme="${esc(opts.theme)}"` : ''}>
${block}
</body>
</html>
`;
}

/* --------------------------------------------------------------------- CLI */

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node src/render.js <report.json> [--inline-css] [--standalone] [--theme=dark|light] [--logo-url=URL] [--no-ld]');
    process.exit(1);
  }
  const themeArg = args.find((a) => a.startsWith('--theme='));
  const logoArg = args.find((a) => a.startsWith('--logo-url='));
  const opts = {
    inlineCss: args.includes('--inline-css'),
    theme: themeArg ? themeArg.split('=')[1] : null,
    logoUrl: logoArg ? logoArg.slice('--logo-url='.length) : null,
    jsonLd: !args.includes('--no-ld')
  };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(args.includes('--standalone')
      ? renderStandalone(data, opts)
      : renderBlock(data, opts));
  } catch (err) {
    console.error('render.js: ' + err.message);
    process.exit(1);
  }
}

module.exports = { renderBlock, renderStandalone, validate, computeUpside, esc, formatDate, formatNumber };
