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
  rationale: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/></svg>',
  positive: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 21h4V9H2v12zM23 10a2 2 0 0 0-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 0 0-.44-1.06L14.17 1 7.59 7.59A2 2 0 0 0 7 9v10a2 2 0 0 0 2 2h9a2 2 0 0 0 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>',
  negative: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M22 3h-4v12h4V3zM1 14a2 2 0 0 0 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59A2 2 0 0 0 17 15V5a2 2 0 0 0-2-2H6a2 2 0 0 0-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2z"/></svg>',
  download: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0 4-4m-4 4-4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>'
};

function iconFor(section) {
  if (section.icon && ICONS[section.icon]) return ICONS[section.icon];
  const tone = String(section.tone || '').toLowerCase();
  if (tone === 'positive') return ICONS.positive;
  if (tone === 'negative') return ICONS.negative;
  return ICONS.rationale;
}

/* ------------------------------------------------------------- partials */

function renderSection(section, index) {
  const tone = String(section.tone || 'neutral').toLowerCase();
  const id = esc(section.id || `section-${index + 1}`);
  const items = (section.bullets || []).map((b) => `<li>${linkify(esc(b))}</li>`).join('\n            ');
  const paras = (section.paragraphs || []).map((p) => `<p>${linkify(esc(p))}</p>`).join('\n            ');

  return `        <section class="krb__section" data-tone="${esc(tone)}" aria-labelledby="krb-${id}">
          <div class="krb__section-head">
            <span class="krb__icon" style="color: var(--krb-${tone === 'positive' ? 'blue' : 'red'})">${iconFor(section)}</span>
            <h3 class="krb__section-title" id="krb-${id}">${esc(section.title)}</h3>
          </div>
${items ? `          <ul class="krb__list">\n            ${items}\n          </ul>` : ''}${paras ? `\n          <div class="krb__prose">\n            ${paras}\n          </div>` : ''}
        </section>`;
}

function renderStats(data) {
  const rec = data.recommendation;
  const cur = esc(rec.currency === 'INR' || !rec.currency ? 'Rs.' : rec.currency + ' ');
  const upside = computeUpside(rec.cmp, rec.fairValue);
  const asOn = formatDate(data.publishedAt);

  const tiles = [
    `          <div class="krb__stat">
            <span class="krb__stat-label">Current Market Price</span>
            <span class="krb__stat-value">${cur}${esc(formatNumber(rec.cmp))}</span>
            <span class="krb__stat-note">as on ${esc(asOn)}</span>
          </div>`
  ];

  if (rec.fairValue !== null && rec.fairValue !== undefined) {
    tiles.push(`          <div class="krb__stat krb__stat--accent">
            <span class="krb__stat-label">Fair Value</span>
            <span class="krb__stat-value">${cur}${esc(formatNumber(rec.fairValue))}</span>
            <span class="krb__stat-note">DCF / target price</span>
          </div>`);
  }

  if (upside !== null) {
    const sign = upside >= 0 ? '+' : '';
    tiles.push(`          <div class="krb__stat">
            <span class="krb__stat-label">Potential Upside</span>
            <span class="krb__stat-value">${esc(sign + upside.toFixed(1))}%</span>
            <span class="krb__stat-note">Fair Value vs CMP</span>
          </div>`);
  }

  return `        <div class="krb__stats">\n${tiles.join('\n')}\n        </div>`;
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
  const eyebrow = [data.report.type, data.report.period].filter(Boolean).join(' \u00b7 ');

  const css = opts.inlineCss
    ? `      <style>\n${fs.readFileSync(path.join(__dirname, 'krb.css'), 'utf8')}\n      </style>\n`
    : '';

  const sections = data.sections.map(renderSection).join('\n\n');
  // escUrl() returns '' for anything that is not http(s)/mailto/tel/relative,
  // so a javascript: or data: URL suppresses the button entirely rather than
  // rendering a dead <a href="">.
  const pdfUrl = escUrl(data.sourcePdf);

  return `${css}      <article class="krb"${themeAttr} data-krb-rating="${esc(rating)}" itemscope itemtype="https://schema.org/Report">
        <header class="krb__head">
          <p class="krb__eyebrow">${esc(eyebrow)}</p>
          <h2 class="krb__title" itemprop="headline">${esc(data.stock.name)} <span class="krb__ticker">(${esc(data.stock.ticker)})</span></h2>
          <div class="krb__meta">
            <span class="krb__rating" aria-label="Rating: ${esc(rating)}">${esc(rating)}</span>
            <time datetime="${esc(data.publishedAt)}" itemprop="datePublished">${esc(formatDate(data.publishedAt))}</time>
            ${rec.holdingPeriod ? `<span>Holding period: ${esc(rec.holdingPeriod)}</span>` : ''}
          </div>
        </header>

        <p class="krb__band">${esc(data.report.type)}</p>

${renderStats(data)}

      <div class="krb__body">
${sections}

${data.abbreviations ? `        <p class="krb__note">${esc(data.abbreviations)}</p>` : ''}
      </div>

${pdfUrl ? `        <div class="krb__actions">
          <a class="krb__btn krb__btn--primary" href="${pdfUrl}" target="_blank" rel="noopener noreferrer">
            ${ICONS.download}<span>Download full report (PDF)</span>
          </a>
        </div>` : ''}

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
