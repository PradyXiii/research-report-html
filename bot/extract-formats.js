'use strict';
/**
 * Per-format extractors for the Kotak report types that are not the PCG
 * one-pager. Each takes the line list pdftext.js produces and returns the same
 * { ok, report, errors, warnings } shape as extract.js, so the caller does not
 * care which format it fed in.
 *
 * Every extractor anchors on printed labels, never on line position, and
 * refuses rather than guessing when a mandatory field is missing.
 */

const RATINGS = ['BUY', 'ADD', 'REDUCE', 'SELL', 'NR', 'SUBSCRIBE', 'RS', 'NA', 'NM'];

const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7,
                 august:8, september:9, october:10, november:11, december:12 };

function toIso(s) {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(String(s || ''));
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

function num(s) {
  const m = /-?[\d,]+(?:\.\d+)?/.exec(String(s || '').replace(/[₹\s]/g, ''));
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

/** Join wrapped lines into bullets: a line beginning "•" starts a new one. */
function bullets(lines, stopAt) {
  const out = [];
  for (const l of lines) {
    const t = (l.text || '').trim();
    if (!t) continue;
    if (stopAt && stopAt.test(t)) break;
    if (/^[••·-]\s*/.test(t)) out.push(t.replace(/^[••·-]\s*/, '').trim());
    else if (out.length) out[out.length - 1] += ' ' + t;
  }
  return out.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/* ------------------------------------------------------------ Pick of Week */

function extractPickOfWeek(lines, meta) {
  const errors = [], warnings = [];
  const L = lines.map((l) => Object.assign({}, l, { t: (l.text || '').trim() }));
  const find = (re) => L.find((l) => re.test(l.t));

  const title = find(/^(BUY|ADD|REDUCE|SELL|NR|SUBSCRIBE)\s*[–—-]\s*.+\(.+\)/i);
  const cmpL = find(/^CMP\s*:/i);
  const fvL = find(/Fair\s*Value\s*\(FV\)\s*:/i);
  const timeL = find(/Time\s*Period\s*:/i);
  const holdL = find(/Holding\s*Period\s*:/i);
  const closeL = find(/^(Maintain|Upgrade|Downgrade|Retain)\s+(BUY|ADD|REDUCE|SELL)/i);
  const glossL = L.find((l) => /^\(.+[–-]/.test(l.t) && /\|/.test(l.t));
  const attrL = L.find((l) => /content of this document has been derived/i.test(l.t));

  if (!title) errors.push({ code: 'TITLE_NOT_FOUND', field: 'stock',
    message: 'Could not find the "<RATING> – <Company> (<TICKER>)" headline on page 1.' });
  if (!cmpL) errors.push({ code: 'CMP_NOT_FOUND', field: 'recommendation.cmp',
    message: 'Could not find the "CMP:" line on page 1.' });
  if (errors.length) return { ok: false, report: null, errors, warnings };

  const tm = /^(\w+)\s*[–—-]\s*(.+?)\s*\(([^)]+)\)/.exec(title.t);
  const rating = tm[1].toUpperCase();
  if (!RATINGS.includes(rating)) {
    errors.push({ code: 'BAD_RATING', field: 'recommendation.rating',
      message: `"${rating}" is not a Kotak rating.` });
    return { ok: false, report: null, errors, warnings };
  }

  const cmp = num(cmpL.t);
  const asOn = toIso(cmpL.t);
  const fv = fvL ? num(fvL.t) : null;
  if (!fv) warnings.push({ code: 'NO_FAIR_VALUE', field: 'recommendation.fairValue',
    message: 'No Fair Value line found; the fair value tile will be omitted.' });

  // Bullets run from the first "•" to the glossary line.
  const firstBullet = L.findIndex((l) => /^[••]/.test(l.t));
  const bulletLines = firstBullet >= 0 ? L.slice(firstBullet) : [];
  const items = bullets(bulletLines, /^\(.+[–-].*\|/);
  if (!items.length) errors.push({ code: 'NO_BULLETS', field: 'sections',
    message: 'No bullet points found under "Why Invest?".' });
  if (errors.length) return { ok: false, report: null, errors, warnings };

  // Glossary can wrap over two lines.
  let gloss = null;
  if (glossL) {
    gloss = glossL.t;
    const next = L[L.indexOf(glossL) + 1];
    if (next && !/\)$/.test(gloss) && /\)$/.test(next.t)) gloss += ' ' + next.t;
  }
  let attribution = null;
  if (attrL) {
    const i = L.indexOf(attrL);
    attribution = [attrL.t, (L[i + 1] || {}).t, (L[i + 2] || {}).t]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  const report = {
    schemaVersion: '1.0',
    format: 'pick-of-the-week',
    reportId: (meta && meta.reportId) || `potw-${tm[3].toLowerCase()}-${asOn || 'undated'}`,
    publishedAt: asOn || (meta && meta.publishedAt) || null,
    stock: { name: tm[2].trim(), ticker: tm[3].trim().toUpperCase() },
    report: { type: 'Pick of the Week', template: 'Pick of the Week' },
    recommendation: {
      rating: rating,
      cmp: cmp,
      cmpAsOn: asOn,
      fairValue: fv,
      currency: 'INR',
      // Fair Value and Time Period share one printed line, so split on the
      // label rather than the first colon.
      timePeriod: timeL ? ((/Time\s*Period\s*:\s*([^|]+)/i.exec(timeL.t) || [])[1] || '').trim() : null,
      holdingPeriod: holdL ? ((/Holding\s*Period\s*:\s*([^|]+)/i.exec(holdL.t) || [])[1] || '').trim() : null,
      closing: closeL ? closeL.t : null
    },
    sections: [{ id: 'why-invest', title: 'Why Invest?', tone: 'neutral', bullets: items }],
    abbreviations: gloss,
    attribution: attribution
  };
  if (!report.publishedAt) {
    errors.push({ code: 'NO_DATE', field: 'publishedAt', message: 'No report date could be read.' });
    return { ok: false, report: null, errors, warnings };
  }
  return { ok: true, report, errors, warnings };
}

module.exports = { extractPickOfWeek, toIso, num, bullets, RATINGS };
