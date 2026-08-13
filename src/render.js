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

let LOGO_CACHE = null;

/**
 * The Kotak Neo logo, lifted from page 1 of the source PDF and committed at
 * assets/kotak-neo-logo.png. Inlined as a data URI by default so the fragment
 * stays self-contained wherever Strapi injects it -- pass options.logoUrl to
 * reference a hosted copy instead.
 */
function logoSrc(options) {
  if (options && options.logoUrl) return escUrl(options.logoUrl);
  if (LOGO_CACHE === null) {
    try {
      const file = path.join(__dirname, '..', 'assets', 'kotak-neo-logo.png');
      LOGO_CACHE = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
    } catch (err) {
      LOGO_CACHE = '';
    }
  }
  return LOGO_CACHE;
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

function renderSection(section, index) {
  const tone = String(section.tone || 'neutral').toLowerCase();
  const id = esc(section.id || ('section-' + (index + 1)));
  const items = (section.bullets || []).map((b) => `<li>${linkify(esc(b))}</li>`).join('\n              ');
  const paras = (section.paragraphs || []).map((p) => `<p>${linkify(esc(p))}</p>`).join('\n              ');

  // The PDF prints its section headings with a trailing colon.
  const heading = /[:：]$/.test(section.title) ? section.title : section.title + ':';

  return `          <section class="krb__section" data-tone="${esc(tone)}" aria-labelledby="krb-${id}">
            <h3 class="krb__section-title" id="krb-${id}">${esc(heading)}</h3>
${items ? `            <ul class="krb__list">\n              ${items}\n            </ul>` : ''}${paras ? `\n            <div class="krb__prose">\n              ${paras}\n            </div>` : ''}
          </section>`;
}

function renderHead(data, options) {
  const src = logoSrc(options);
  return `        <header class="krb__head">
${src ? `          <img class="krb__logo" src="${src}" alt="Kotak Neo" width="360" height="80">` : ''}
          <p class="krb__dated">${esc(PAGE1.dated)} <time datetime="${esc(data.publishedAt)}" itemprop="datePublished">${esc(formatDate(data.publishedAt))}</time></p>
        </header>`;
}

/** "Lenskart Solutions (LENSKART) - ADD" -- the title line exactly as printed. */
function renderTitle(data) {
  const rating = String(data.recommendation.rating).toUpperCase();
  return `        <h2 class="krb__title" itemprop="headline">${esc(data.stock.name)} (${esc(data.stock.ticker)}) - <span class="krb__title-rating">${esc(rating)}</span></h2>`;
}

function money(value, currency) {
  const mark = currency === 'INR' || !currency ? 'Rs.' : String(currency) + ' ';
  return esc(mark + formatNumber(value));
}

/** The two-cell price table from page 1. No derived figures. */
function renderPrices(data) {
  const rec = data.recommendation;
  const cells = [
    `          <div class="krb__price">
            <span class="krb__price-label">${esc(PAGE1.cmp)}</span>
            <span class="krb__price-value">${money(rec.cmp, rec.currency)}</span>
          </div>`
  ];
  if (rec.fairValue !== null && rec.fairValue !== undefined) {
    cells.push(`          <div class="krb__price">
            <span class="krb__price-label">${esc(PAGE1.fv)}</span>
            <span class="krb__price-value">${money(rec.fairValue, rec.currency)}</span>
          </div>`);
  }
  return `        <div class="krb__prices">\n${cells.join('\n')}\n        </div>`;
}

/**
 * The rating scale, verbatim from page 2, with this report's own rating marked.
 * Deliberately NOT plotted against the CMP-to-fair-value gap: the two do not
 * have to agree, and showing them together would imply a relationship the
 * report does not claim.
 */
function renderRatingScale(data) {
  const current = data ? String(data.recommendation.rating).toUpperCase() : null;
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

function renderBlock(data, options) {
  const opts = options || {};
  validate(data);

  const rating = String(data.recommendation.rating).toUpperCase();
  const themeAttr = opts.theme ? ` data-krb-theme="${esc(opts.theme)}"` : '';
  const rec = data.recommendation;

  const css = opts.inlineCss
    ? `      <style>\n${fs.readFileSync(path.join(__dirname, 'krb.css'), 'utf8')}\n      </style>\n`
    : '';

  const sections = data.sections.map(renderSection).join('\n');

  return `${css}      <article class="krb"${themeAttr} data-krb-rating="${esc(rating)}" itemscope itemtype="https://schema.org/Report">
${renderHead(data, opts)}

${renderTitle(data)}

        <p class="krb__band">${esc(data.report.type)}</p>

${renderPrices(data)}

        <div class="krb__body">
${sections}
${data.abbreviations ? `          <p class="krb__abbr">${esc(data.abbreviations)}</p>` : ''}
        </div>

        <div class="krb__foot">
${data.attribution ? `          <p class="krb__attribution">${linkify(esc(data.attribution))}</p>` : ''}
${rec.holdingPeriod ? `          <p class="krb__holding">${esc(PAGE1.holding)} ${esc(rec.holdingPeriod)}</p>` : ''}
        </div>

        <div class="krb__disclosures">
          <details class="krb__acc">
            <summary>Rating Scale (Private Client Group)<span class="krb__acc-icon" aria-hidden="true"></span></summary>
            <div class="krb__acc-body">
              <p class="krb__acc-lead">Definitions of ratings</p>
${renderRatingScale(data)}
            </div>
          </details>

          <details class="krb__acc">
            <summary>Research Team (Private Client Group)<span class="krb__acc-icon" aria-hidden="true"></span></summary>
            <div class="krb__acc-body">
${renderTeams()}
            </div>
          </details>

          <details class="krb__acc">
            <summary>Disclosure / Disclaimer<span class="krb__acc-icon" aria-hidden="true"></span></summary>
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
