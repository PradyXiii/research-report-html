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

/** Handles both printed orders: "12 August 2026" and "August 12, 2026". */
function toIso(s) {
  const str = String(s || '');
  let d, mo, y;
  let m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(str);
  if (m) { d = Number(m[1]); mo = MONTHS[m[2].toLowerCase()]; y = m[3]; }
  else {
    m = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(str);
    if (!m) return null;
    mo = MONTHS[m[1].toLowerCase()]; d = Number(m[2]); y = m[3];
  }
  if (!mo || !d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
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

/* --------------------------------------------------------------- KIE report */

/** How many numeric cells make a line a table row rather than prose. */
const TABLE_MIN_NUMS = 4;

function numericTokens(t) {
  return (String(t).match(/(?:^|\s)\(?-?[\d,]+(?:\.\d+)?\)?%?(?=\s|$)/g) || []).length;
}

/**
 * The full Kotak Institutional Equities note. Content runs over the first pages
 * as prose interleaved with exhibit tables; the last pages are the standard
 * disclaimers and are dropped.
 *
 * pdftext merges text items that share a baseline, so a table ROW arrives as a
 * single line. That is what makes exhibits recoverable without ruled lines:
 * a line carrying several numeric cells is a row, and consecutive rows are one
 * table.
 */
function extractKieReport(pages, meta) {
  const errors = [], warnings = [];
  const all = pages || [];
  if (!all.length) {
    errors.push({ code: 'NO_PAGES', field: 'document', message: 'No pages could be read.' });
    return { ok: false, report: null, errors, warnings };
  }

  const p1 = (all[0].lines || []).map((l) => Object.assign({}, l, { t: (l.text || '').trim() }));
  const find = (re) => p1.find((l) => re.test(l.t));
  const grab = (re) => { const l = find(re); return l ? (re.exec(l.t) || [])[1] : null; };

  // The company, ticker and rating are printed on ONE line.
  const TITLE_RE = /^(.+?)\s*\(([A-Z0-9&.-]{2,12})\)\s*(BUY|ADD|REDUCE|SELL|NR|SUBSCRIBE|RS|NA|NM)?\s*$/;
  const titleL = p1.find((l) => TITLE_RE.test(l.t) && !/^\d/.test(l.t));
  const cmp = grab(/CMP\s*\(₹\)\s*:\s*([\d,]+)/i) || grab(/CMP\s*\(Rs\)\s*:\s*([\d,]+)/i);
  const fv = grab(/Fair\s*Value\s*\(₹\)\s*:\s*([\d,]+)/i) || grab(/Fair\s*Value\s*\(Rs\)\s*:\s*([\d,]+)/i);
  const titleM = titleL ? TITLE_RE.exec(titleL.t) : null;
  const ratingL = (titleM && titleM[3])
    ? { t: titleM[3] }
    : p1.find((l) => RATINGS.includes(l.t.toUpperCase()));
  // The date sits at the end of the shared meta line, not on its own.
  const dateHit = p1.map((l) => (/([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/.exec(l.t) || [])[1]).find(Boolean);
  const dateL = dateHit ? { t: dateHit } : null;

  if (!titleL) errors.push({ code: 'TITLE_NOT_FOUND', field: 'stock',
    message: 'Could not find the "<Company> (<TICKER>)" headline on page 1.' });
  if (!ratingL) errors.push({ code: 'RATING_NOT_FOUND', field: 'recommendation.rating',
    message: 'No rating found on page 1.' });
  if (!cmp) errors.push({ code: 'CMP_NOT_FOUND', field: 'recommendation.cmp',
    message: 'Could not read CMP from page 1.' });
  if (errors.length) return { ok: false, report: null, errors, warnings };

  const tm = titleM;
  const iso = dateL ? toIso(dateL.t.replace(',', '')) : null;

  /* ---- body: prose and exhibits, in document order ---- */
  const bodySize = p1.length ? p1.reduce((a, l) => a + (l.height || 0), 0) / p1.length : 12;
  const SKIP = /^(India Research|KOTAK INSTITUTIONAL EQUITIES|Refer to the disclosures|This report is not intended|\d{1,2}|RESULT)$/i;
  const content = [];
  const contentPages = all.filter((pg) => {
    const txt = (pg.lines || []).map((l) => l.text).join(' ');
    return !/DISCLAIMERS, DISCLOSURES & LEGAL/i.test(txt);
  });

  for (const pg of contentPages) {
    let table = null, para = null;
    for (const l of (pg.lines || [])) {
      const t = (l.text || '').trim();
      if (!t || SKIP.test(t)) continue;
      if (t === titleL.t || (dateL && t === dateL.t)) continue;

      if (numericTokens(t) >= TABLE_MIN_NUMS) {
        para = null;
        const cells = t.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
        const row = cells.length > 1 ? cells : t.split(/\s+/);
        if (!table) { table = { kind: 'table', rows: [] }; content.push(table); }
        table.rows.push(row);
        continue;
      }
      table = null;
      const isHead = (l.height || 0) > bodySize * 1.08 && t.length < 150 && !/[.]$/.test(t);
      if (isHead) { para = null; content.push({ kind: 'head', text: t, page: pg.number }); continue; }
      // Prose is laid out one visual line at a time; join it back into
      // paragraphs, breaking only at a heading or a table.
      if (para) para.text += ' ' + t;
      else { para = { kind: 'para', text: t, page: pg.number }; content.push(para); }
    }
  }
  if (!content.length) {
    errors.push({ code: 'NO_CONTENT', field: 'content', message: 'No body content could be read.' });
    return { ok: false, report: null, errors, warnings };
  }

  // The first long paragraph after the headline is the summary.
  const headIdx = content.findIndex((c) => c.kind === 'head' && c.text.length > 25);
  const headline = headIdx >= 0 ? content[headIdx].text : null;
  const sumIdx = content.findIndex((c, i) => i > headIdx && c.kind === 'para' && c.text.length > 180);
  const summary = sumIdx >= 0 ? content[sumIdx].text : null;
  const body = content.filter((_, i) => i !== headIdx && i !== sumIdx);

  if (!headline) warnings.push({ code: 'NO_HEADLINE', field: 'headline',
    message: 'No headline identified; the report renders without one.' });

  const report = {
    schemaVersion: '1.0',
    format: 'kie-full-report',
    reportId: (meta && meta.reportId) || `kie-${tm[2].toLowerCase()}-${iso || 'undated'}`,
    publishedAt: iso,
    stock: { name: tm[1].trim(), ticker: tm[2].trim().toUpperCase(),
             sector: (find(/^(Retailing|Automobiles|Banks|[A-Z][a-z]+(?: [A-Z&][a-z]+)*)$/) || {}).t || null },
    report: { type: 'Result', template: 'KIE Full Report' },
    recommendation: {
      rating: ratingL.t.toUpperCase(),
      cmp: num(cmp), fairValue: num(fv), currency: 'INR',
      sectorView: grab(/Sector\s*View\s*:\s*(\w+)/i),
      benchmark: (function () { const v = grab(/NIFTY-50\s*:\s*([\d,]+)/i); return v ? { name: 'NIFTY-50', value: v } : null; })()
    },
    restricted: p1.some((l) => /not intended for circulation to retail clients/i.test(l.t))
      ? 'This report is not intended for circulation to retail clients.' : null,
    headline: headline,
    summary: summary,
    content: body,
    panels: []
  };
  if (!report.publishedAt) {
    warnings.push({ code: 'NO_DATE', field: 'publishedAt', message: 'No report date found on page 1.' });
    report.publishedAt = (meta && meta.publishedAt) || null;
  }
  return { ok: true, report, errors, warnings };
}

module.exports.extractKieReport = extractKieReport;
