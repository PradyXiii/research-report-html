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

/* ------------------------------------------------------------------- icons */

const ICONS = {
  rationale: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 19V9m5 10V5m5 14v-7m5 7V8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  positive: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 13.5 9 18.5 20 6.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  negative: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 8v5m0 3.5v.2M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20.2h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function iconFor(section) {
  if (section.icon && ICONS[section.icon]) return ICONS[section.icon];
  const tone = String(section.tone || '').toLowerCase();
  if (tone === 'positive') return ICONS.positive;
  if (tone === 'negative') return ICONS.negative;
  return ICONS.rationale;
}

/* ------------------------------------------------------------- partials */

function renderCard(section, index) {
  const tone = String(section.tone || 'neutral').toLowerCase();
  const id = esc(section.id || ('section-' + (index + 1)));
  const count = (section.bullets || []).length;
  const items = (section.bullets || []).map((b) => `<li>${linkify(esc(b))}</li>`).join('\n              ');
  const paras = (section.paragraphs || []).map((p) => `<p>${linkify(esc(p))}</p>`).join('\n              ');
  const modifier = index === 0 ? ' krb__card--thesis' : '';

  return `          <section class="krb__card${modifier}" data-tone="${esc(tone)}" aria-labelledby="krb-${id}">
            <div class="krb__card-head">
              <span class="krb__icon">${iconFor(section)}</span>
              <h3 class="krb__card-title" id="krb-${id}">${esc(section.title)}</h3>
              ${count ? `<span class="krb__count">${count}</span>` : ''}
            </div>
${items ? `            <ul class="krb__list">\n              ${items}\n            </ul>` : ''}${paras ? `\n            <div class="krb__prose">\n              ${paras}\n            </div>` : ''}
          </section>`;
}

function renderHero(data) {
  const rec = data.recommendation;
  const rating = String(rec.rating).toUpperCase();
  const band = boilerplate.ratingScale.find((r) => r.code === rating);
  const chips = [
    { text: data.report.type, lead: true },
    { text: data.report.period },
    { text: formatDate(data.publishedAt) }
  ].filter((c) => c.text);

  return `        <header class="krb__hero">
          <div class="krb__hero-inner">
            <div class="krb__chips">
${chips.map((c) => `              <span class="krb__chip${c.lead ? ' krb__chip--lead' : ''}">${esc(c.text)}</span>`).join('\n')}
            </div>
            <div class="krb__headrow">
              <div class="krb__identity">
                <h2 class="krb__title" itemprop="headline">${esc(data.stock.name)}</h2>
                <span class="krb__ticker">${esc(data.stock.ticker)}</span>
              </div>
              <div class="krb__verdict">
                <span class="krb__verdict-label">Kotak PCG rating</span>
                <span class="krb__verdict-value">${esc(rating)}</span>
                <span class="krb__verdict-note">${esc(band && band.short ? band.short : (rec.holdingPeriod ? 'Holding period ' + rec.holdingPeriod : ''))}</span>
              </div>
            </div>
          </div>
        </header>`;
}

/** Split "Rs.487" so the currency mark can be set smaller than the figure. */
function money(value, currency) {
  const mark = currency === 'INR' || !currency ? 'Rs.' : String(currency) + ' ';
  return `<sup>${esc(mark)}</sup>${esc(formatNumber(value))}`;
}

function renderKpis(data) {
  const rec = data.recommendation;
  const upside = computeUpside(rec.cmp, rec.fairValue);
  const tiles = [
    `          <div class="krb__kpi">
            <span class="krb__kpi-label">Current market price</span>
            <span class="krb__kpi-value">${money(rec.cmp, rec.currency)}</span>
            <span class="krb__kpi-note">as on ${esc(formatDate(data.publishedAt))}</span>
          </div>`
  ];
  if (rec.fairValue !== null && rec.fairValue !== undefined) {
    tiles.push(`          <div class="krb__kpi krb__kpi--hero">
            <span class="krb__kpi-label">Fair value</span>
            <span class="krb__kpi-value">${money(rec.fairValue, rec.currency)}</span>
            <span class="krb__kpi-note">DCF-based target${rec.holdingPeriod ? ', ' + esc(rec.holdingPeriod) : ''}</span>
          </div>`);
  }
  if (upside !== null) {
    const sign = upside >= 0 ? '+' : '';
    tiles.push(`          <div class="krb__kpi">
            <span class="krb__kpi-label">Potential ${upside >= 0 ? 'upside' : 'downside'}</span>
            <span class="krb__kpi-value">${esc(sign + upside.toFixed(1))}%</span>
            <span class="krb__kpi-note">Fair value vs CMP</span>
          </div>`);
  }
  return `        <div class="krb__kpis">\n${tiles.join('\n')}\n        </div>`;
}

/**
 * Plots the computed upside on the PCG rating scale, so a reader can see WHY
 * the call is what it is. Omitted when there is no fair value (NR / RS), or
 * when the rating is non-directional and the scale would be meaningless.
 */
function renderGauge(data) {
  const rec = data.recommendation;
  const rating = String(rec.rating).toUpperCase();
  const upside = computeUpside(rec.cmp, rec.fairValue);
  const bands = boilerplate.gaugeBands;
  if (upside === null || !bands.some((b) => b.code === rating)) return '';

  const MIN = boilerplate.GAUGE_MIN;
  const MAX = boilerplate.GAUGE_MAX;
  const span = MAX - MIN;
  const raw = ((upside - MIN) / span) * 100;
  const pos = Math.max(0, Math.min(100, raw));
  const clamped = raw < 0 || raw > 100;

  const segments = bands.map((b) => {
    const width = ((b.to - b.from) / span) * 100;
    const active = b.code === rating;
    return `            <div class="krb__band" data-active="${active}" style="flex: 0 0 ${width.toFixed(4)}%" ${active ? `aria-current="true"` : ''}>${esc(b.code)}</div>`;
  }).join('\n');

  const sign = upside >= 0 ? '+' : '';
  const label = `${sign}${upside.toFixed(1)}%`;

  // Tick marks are the band edges themselves, so labels always line up with
  // the boundaries they describe.
  const ticks = [MIN].concat(bands.map((b) => b.to)).map((t, i, all) => {
    const pct = ((t - MIN) / span) * 100;
    const edge = i === 0 ? 'left: 0' : (i === all.length - 1 ? 'left: 100%' : `left: ${pct.toFixed(4)}%`);
    return `            <span style="${edge}">${t > 0 ? '+' : ''}${t}%</span>`;
  }).join('\n');

  return `        <section class="krb__gauge" aria-label="Expected return against the Kotak PCG rating scale">
          <div class="krb__gauge-head">
            <span class="krb__gauge-title">Where this call sits on the rating scale</span>
            <span class="krb__gauge-legend">${esc(label)} expected return over 12 months${clamped ? ' (beyond the scale shown)' : ''}</span>
          </div>
          <div class="krb__track" role="img" aria-label="${esc(label)} expected return falls in the ${esc(rating)} band">
${segments}
            <div class="krb__marker" style="left: ${pos.toFixed(4)}%">
              <span class="krb__marker-pill">${esc(label)}</span>
            </div>
          </div>
          <div class="krb__gauge-scale" aria-hidden="true">
${ticks}
          </div>
        </section>`;
}

function renderRatingScale() {
  const rows = boilerplate.ratingScale.map((r) =>
    `            <div><dt>${esc(r.code)}</dt><dd>${r.lead ? `<strong>${esc(r.lead)}</strong> ` : ''}${esc(r.text)}</dd></div>`
  ).join('\n');
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

function renderBlock(data, options) {
  const opts = options || {};
  validate(data);

  const rec = data.recommendation;
  const rating = String(rec.rating).toUpperCase();
  const themeAttr = opts.theme ? ` data-krb-theme="${esc(opts.theme)}"` : '';

  const css = opts.inlineCss
    ? `      <style>\n${fs.readFileSync(path.join(__dirname, 'krb.css'), 'utf8')}\n      </style>\n`
    : '';

  // First section is the thesis and gets the full-width hero card; the rest
  // pair up as a bull/bear split that collapses to one column when narrow.
  const cards = data.sections.map(renderCard);
  const thesis = cards.length ? cards[0] : '';
  const rest = cards.slice(1);

  // escUrl() returns '' for anything that is not http(s)/mailto/tel/relative,
  // so a javascript: or data: URL suppresses the button entirely rather than
  // rendering a dead <a href="">.
  const pdfUrl = escUrl(data.sourcePdf);

  return `${css}      <article class="krb"${themeAttr} data-krb-rating="${esc(rating)}" itemscope itemtype="https://schema.org/Report">
${renderHero(data)}

${renderKpis(data)}

${renderGauge(data)}

        <div class="krb__body">
${thesis}
${rest.length ? `          <div class="krb__split">\n${rest.join('\n')}\n          </div>` : ''}
${data.abbreviations ? `          <p class="krb__note">${esc(data.abbreviations)}</p>` : ''}
${pdfUrl ? `          <div class="krb__actions">
            <a class="krb__btn krb__btn--primary" href="${pdfUrl}" target="_blank" rel="noopener noreferrer">
              ${ICONS.download}<span>Download full report (PDF)</span>
            </a>
          </div>` : ''}
        </div>

${data.attribution ? `        <p class="krb__attribution">${linkify(esc(data.attribution))}</p>` : ''}

        <div class="krb__disclosures">
          <details class="krb__acc">
            <summary>Rating scale (Private Client Group)</summary>
            <div class="krb__acc-body">
${renderRatingScale()}
            </div>
          </details>

          <details class="krb__acc">
            <summary>Research team</summary>
            <div class="krb__acc-body">
${renderTeams()}
            </div>
          </details>

          <details class="krb__acc">
            <summary>Disclosures &amp; disclaimer</summary>
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
  const rec = data.recommendation;
  const title = `${data.stock.name} (${data.stock.ticker}) - ${String(rec.rating).toUpperCase()} | ${data.report.type}`;
  const desc = `Kotak Securities PCG ${data.report.type} on ${data.stock.name}. Rating ${String(rec.rating).toUpperCase()}, CMP Rs.${formatNumber(rec.cmp)}${rec.fairValue ? `, Fair Value Rs.${formatNumber(rec.fairValue)}` : ''}.`;
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
    console.error('Usage: node src/render.js <report.json> [--inline-css] [--standalone] [--theme=dark|light] [--no-ld]');
    process.exit(1);
  }
  const themeArg = args.find((a) => a.startsWith('--theme='));
  const opts = {
    inlineCss: args.includes('--inline-css'),
    theme: themeArg ? themeArg.split('=')[1] : null,
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
