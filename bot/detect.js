'use strict';
/**
 * detect.js -- identify WHICH Kotak research format a PDF is, before parsing it.
 *
 * Every format has a different page-1 layout, so the wrong parser produces
 * confident nonsense rather than an error. Detection runs first and picks the
 * template; an unrecognised PDF is refused, never guessed at.
 *
 * Signals are drawn from strings that are structural to each format (printed
 * labels and headings), not from wording that changes report to report.
 */

const FORMATS = [
  {
    id: 'stock-recommendations',
    label: 'Stock Recommendations (multi-stock table)',
    template: 'Stock Recommendations',
    section: 'Fundamental research: stock recommendation',
    // A table of many stocks, not a report on one.
    all: [/Stock\s+Recommendations/i, /Name\s+of\s+the\s+Company/i],
    any: [/Latest\s*\n?\s*Report\s*\n?\s*Date/i, /EV\/EBITDA/i, /Upside\/?\s*\n?\s*\(?Down-?\s*\n?\s*side\)?/i],
    single: false
  },
  {
    id: 'kie-full-report',
    label: 'Kotak Institutional Equities full research report',
    template: 'KIE Full Report',
    section: 'Long term stocks / stock research recommendation',
    // KIE house style: sector view + index level on the masthead line.
    all: [/Sector\s+View:/i],
    any: [
      /not\s+intended\s+for\s+circulation\s+to\s+retail\s+clients/i,
      /NIFTY-50:/i,
      /Company\s+data\s+and\s+valuation\s+summary/i
    ],
    single: true,
    restricted: 'Page 1 states: "This report is not intended for circulation to retail clients."'
  },
  {
    id: 'pick-of-the-week',
    label: 'Pick of the Week',
    template: 'Pick of the Week',
    section: 'Weekly picks',
    all: [/Why\s*Invest\s*\?/i],
    any: [/Pick\s+of\s+the\s+Week/i, /Time\s*Period:/i],
    single: true
  },
  {
    id: 'one-pager',
    label: 'PCG one-pager',
    template: 'One Pager',
    section: 'Top monthly picks / stock research recommendation',
    all: [/Rationale\s*:/i, /Current\s+Market\s+Price\s*\(CMP\)/i],
    any: [/Positives\s*:/i, /Negatives\s*:/i, /Fair\s+Value\s*\(FV\)/i],
    single: true
  }
];

/** Which formats currently have a renderer. Update as templates land. */
const IMPLEMENTED = new Set(['one-pager']);

/**
 * @param {string} page1Text  text of page 1 (detection never needs more)
 * @param {object} [meta]     optional { filename, pageCount }
 * @returns {{id, label, template, section, confidence, matched, implemented, restricted?}}
 *          or { id: 'unknown' } when nothing matches with confidence.
 */
function detectFormat(page1Text, meta) {
  const text = String(page1Text || '');
  const info = meta || {};
  const scored = [];

  for (const f of FORMATS) {
    const allHits = f.all.filter((re) => re.test(text));
    if (allHits.length !== f.all.length) continue;          // required signals
    const anyHits = (f.any || []).filter((re) => re.test(text));
    if (f.any && f.any.length && anyHits.length === 0) continue;
    scored.push({
      format: f,
      matched: allHits.length + anyHits.length,
      possible: f.all.length + (f.any || []).length
    });
  }

  if (!scored.length) {
    return {
      id: 'unknown',
      label: 'Unrecognised format',
      implemented: false,
      confidence: 0,
      matched: [],
      reason: 'No known Kotak research format matched page 1. Refusing to parse: ' +
              'the wrong parser would produce a confident but wrong result.'
    };
  }

  // Most specific match wins; ties break toward the more distinctive format,
  // which is the earlier entry (the table and KIE report are unmistakable).
  scored.sort((a, b) => (b.matched / b.possible) - (a.matched / a.possible) ||
                        FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format));

  const best = scored[0];
  const f = best.format;
  const out = {
    id: f.id,
    label: f.label,
    template: f.template,
    section: f.section,
    confidence: Number((best.matched / best.possible).toFixed(2)),
    matched: best.matched,
    implemented: IMPLEMENTED.has(f.id),
    singleStock: f.single
  };
  if (f.restricted) out.restricted = f.restricted;
  if (!out.implemented) {
    out.reason = `Recognised as "${f.label}", but no renderer exists for it yet. ` +
                 'Refusing rather than rendering it with the wrong template.';
  }
  if (info.pageCount && f.id === 'one-pager' && info.pageCount > 6) {
    out.warning = `Detected a one-pager but the PDF has ${info.pageCount} pages; confirm the template.`;
  }
  return out;
}

module.exports = { detectFormat, FORMATS, IMPLEMENTED };
