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
      closing: (function () {
        if (!closeL) return null;
        let t = closeL.t;
        // The closing reads "Maintain ADD with" and stops: the fair value that
        // finishes the sentence is drawn inside the arrow graphic, so it never
        // reaches the text layer. Complete it from the fair value printed
        // elsewhere on the same page rather than publishing a dangling phrase.
        if (/\b(with|of|at|to)$/i.test(t) && fv) {
          // A space, not the hyphen the PDF's graphic uses: "Rs-2,220" reads
          // as a negative number.
          t += ' FV Rs ' + fv.toLocaleString('en-IN');
        }
        return t;
      })()
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

/** Numeric cells that make a row a table row rather than prose. */
const TABLE_MIN_NUMS = 3;
/** Gap between words, in points, that separates one column from the next. */
const COL_GAP = 5.5;

function isNumericCell(t) {
  return /^\(?-?[\d,]+(?:\.\d+)?\)?%?$/.test(String(t).trim());
}

/**
 * Find a page's column boundary, if it has one. The KIE cover page runs prose
 * on the left and a data panel on the right; both share baselines, so
 * clustering by y alone merges a sentence with an unrelated table row. Look for
 * a vertical band no word crosses, wide enough to be a gutter.
 */
function columnSplit(items) {
  if (!items || items.length < 60) return null;
  const xs = items.map((i) => i.x);
  const minX = Math.min.apply(null, xs);
  const maxX = Math.max.apply(null, items.map((i) => i.x + (i.w || 0)));
  const width = maxX - minX;
  if (width < 200) return null;

  // Coverage histogram: how many words overlap each 2pt slice. A gutter is a
  // band of near-zero coverage. A histogram survives the full-width footer that
  // defeats a simple gap scan.
  const SLICE = 2;
  const n = Math.ceil(width / SLICE);
  const cover = new Array(n).fill(0);
  for (const it of items) {
    const a = Math.max(0, Math.floor((it.x - minX) / SLICE));
    const b = Math.min(n - 1, Math.ceil((it.x + (it.w || 0) - minX) / SLICE));
    for (let k = a; k <= b; k++) cover[k]++;
  }
  const busy = cover.filter((c) => c > 0).length || 1;
  const floor = Math.max(1, Math.round(items.length / busy * 0.12));

  let best = null, run = 0;
  for (let k = 0; k < n; k++) {
    if (cover[k] <= floor) run++;
    else {
      if (run * SLICE > 18) {
        const at = minX + (k - run / 2) * SLICE;
        const frac = (at - minX) / width;
        if (frac > 0.3 && frac < 0.85 && (!best || run > best.run)) best = { at: at, run: run };
      }
      run = 0;
    }
  }
  if (!best) return null;
  const left = items.filter((i) => i.x < best.at).length;
  if (left < items.length * 0.25 || left > items.length * 0.85) return null;
  return best.at;
}

/** pdf.js items -> rows of cells, clustered by baseline then by x gap. */
function itemsToRows(items) {
  const byY = new Map();
  for (const it of items || []) {
    const key = Math.round(it.y / 2.2);
    if (!byY.has(key)) byY.set(key, []);
    byY.get(key).push(it);
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0])                      // PDF y grows upward
    .map(([, group]) => {
      const sorted = group.sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null, endX = null;
      for (const it of sorted) {
        if (cur !== null && it.x - endX < COL_GAP) cur.text += (it.x - endX > 0.6 ? ' ' : '') + it.s;
        else { cur = { text: it.s, x: it.x }; cells.push(cur); }
        endX = it.x + (it.w || 0);
      }
      return {
        cells: cells.map((c) => ({ text: c.text.replace(/\s+/g, ' ').trim(), x: c.x })).filter((c) => c.text),
        text: sorted.map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim(),
        height: Math.max.apply(null, sorted.map((i) => i.h || 0))
      };
    })
    .filter((r) => r.cells.length);
}

/**
 * The full Kotak Institutional Equities note: prose interleaved with exhibit
 * tables over the content pages, then the standard disclaimers.
 *
 * Merged lines lose the x positions, and the exhibits have no ruled lines, so
 * this works from pdf.js's raw items: words are clustered onto baselines, then
 * split into columns wherever the gap between them exceeds normal word spacing.
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

  const TITLE_RE = /^(.+?)\s*\(([A-Z0-9&.-]{2,12})\)\s*(BUY|ADD|REDUCE|SELL|NR|SUBSCRIBE|RS|NA|NM)?\s*$/;
  const titleL = p1.find((l) => TITLE_RE.test(l.t) && !/^\d/.test(l.t));
  const cmp = grab(/CMP\s*\([₹R]s?\)?\s*:\s*([\d,]+)/i);
  const fv = grab(/Fair\s*Value\s*\([₹R]s?\)?\s*:\s*([\d,]+)/i);
  const titleM = titleL ? TITLE_RE.exec(titleL.t) : null;
  const ratingL = (titleM && titleM[3]) ? { t: titleM[3] } : p1.find((l) => RATINGS.includes(l.t.toUpperCase()));
  const dateHit = p1.map((l) => (/([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/.exec(l.t) || [])[1]).find(Boolean);
  const metaL = find(/CMP\s*\([₹R]/i);

  if (!titleL) errors.push({ code: 'TITLE_NOT_FOUND', field: 'stock',
    message: 'Could not find the "<Company> (<TICKER>)" headline on page 1.' });
  if (!ratingL) errors.push({ code: 'RATING_NOT_FOUND', field: 'recommendation.rating',
    message: 'No rating found on page 1.' });
  if (!cmp) errors.push({ code: 'CMP_NOT_FOUND', field: 'recommendation.cmp',
    message: 'Could not read CMP from page 1.' });
  if (errors.length) return { ok: false, report: null, errors, warnings };

  /* ---- body ---- */
  // The commonest line height is the body size; headings stand above it.
  const tally = {};
  for (const pg of all) for (const l of (pg.lines || [])) {
    const k = Math.round(l.height || 0); tally[k] = (tally[k] || 0) + 1;
  }
  const bodyH = Number(Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0]) || 9;

  const SKIP = /^(India Research|KOTAK INSTITUTIONAL EQUITIES|Refer to the disclosures|This report is not intended|Source:|Prices in this report|Full sector coverage|Related Research|\d{1,3}|RESULT)$/i;
  const seen = new Set([titleL.t, metaL && metaL.t].filter(Boolean));

  const contentPages = all.filter((pg) =>
    !/DISCLAIMERS, DISCLOSURES & LEGAL/i.test((pg.lines || []).map((l) => l.text).join(' ')));

  const content = [];
  for (const pg of contentPages) {
    let rows;
    if (pg.items) {
      const split = columnSplit(pg.items);
      rows = split === null
        ? itemsToRows(pg.items)
        // Read the whole left column, then the whole right one -- never
        // interleaved, which is what produced sentences spliced into tables.
        : itemsToRows(pg.items.filter((i) => i.x < split))
            .concat(itemsToRows(pg.items.filter((i) => i.x >= split)));
    } else {
      rows = (pg.lines || []).map((l) => ({ cells: [{ text: l.text }], text: l.text, height: l.height }));
    }
    let table = null, para = null;
    for (const row of rows) {
      const t = (row.text || '').trim();
      if (!t || SKIP.test(t) || seen.has(t)) continue;

      const nums = row.cells.filter((c) => isNumericCell(c.text)).length;
      if (nums >= TABLE_MIN_NUMS && row.cells.length >= nums) {
        para = null;
        if (!table) { table = { kind: 'table', rows: [] }; content.push(table); }
        table.rows.push(row.cells.map((c) => c.text));
        continue;
      }
      table = null;
      const isHead = row.cells.length === 1 && (row.height || 0) >= bodyH + 1 &&
                     t.length < 110 && !/[.;,:]$/.test(t);
      if (isHead) { para = null; content.push({ kind: 'head', text: t, page: pg.number }); continue; }
      if (para) para.text += ' ' + t;
      else { para = { kind: 'para', text: t, page: pg.number }; content.push(para); }
    }
  }
  if (!content.length) {
    errors.push({ code: 'NO_CONTENT', field: 'content', message: 'No body content could be read.' });
    return { ok: false, report: null, errors, warnings };
  }

  const headIdx = content.findIndex((c) => c.kind === 'head' && c.text.length > 25);
  const headline = headIdx >= 0 ? content[headIdx].text : null;
  const sumIdx = content.findIndex((c, i) => i > headIdx && c.kind === 'para' && c.text.length > 180);
  const summary = sumIdx >= 0 ? content[sumIdx].text : null;
  const body = content.filter((_, i) => i !== headIdx && i !== sumIdx)
                      .filter((c) => c.kind !== 'table' || c.rows.length > 1);

  const report = {
    schemaVersion: '1.0',
    format: 'kie-full-report',
    reportId: (meta && meta.reportId) || `kie-${titleM[2].toLowerCase()}-${toIso(dateHit) || 'undated'}`,
    publishedAt: toIso(dateHit),
    stock: { name: titleM[1].trim(), ticker: titleM[2].trim().toUpperCase(),
             sector: (p1.find((l) => /^[A-Z][a-z]+(?:\s[A-Z&][a-z]+)*$/.test(l.t) && l.t.length < 30 && l.t !== titleM[1].trim()) || {}).t || null },
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
  if (!headline) warnings.push({ code: 'NO_HEADLINE', field: 'headline', message: 'No headline identified.' });
  if (!report.publishedAt) warnings.push({ code: 'NO_DATE', field: 'publishedAt', message: 'No report date found.' });
  return { ok: true, report, errors, warnings };
}

module.exports.extractKieReport = extractKieReport;

/* -------------------------------------------------- Stock Recommendations */

const RECO_COLUMNS = [
  'Price as on (Rs)', 'Price as on latest Report (Rs)', 'Latest Price target (Rs)',
  'Upside/(Downside) (%)', 'Latest Report Date', 'Mkt Cap (Rs Cr)',
  'EPS FY27E (Rs)', 'EPS FY28E (Rs)', 'EPS gth FY27E (%)', 'EPS gth FY28E (%)',
  'PE FY27E (x)', 'PE FY28E (x)', 'RoE FY27E (%)', 'RoE FY28E (%)',
  'EV/EBITDA FY27E (x)', 'EV/EBITDA FY28E (x)'
];

const RECO_ROW_RE = new RegExp('^(.+?)\\s+(' + RATINGS.join('|') + ')\\s+(.+)$');
const RECO_NOISE = /^(Kotak Neo|Stock Recommendations|Name of the Company|Reco|\d{1,2} Aug|\(Rs\)|For Private Circulation|Source|Note|UST |, \d{4}$)/i;

/**
 * The multi-stock recommendations table. Every row is one printed line -- the
 * company name, then the rating, then sixteen numeric cells -- so rows split
 * cleanly on the rating token. Sector names are the lines carrying no digits.
 */
function extractStockRecos(pages, meta) {
  const errors = [], warnings = [];
  const sectors = [];
  let current = null, dateIso = null;

  for (const pg of (pages || [])) {
    for (const l of (pg.lines || [])) {
      const t = (l.text || '').trim();
      if (!t) continue;

      if (!dateIso) {
        const d = toIso(t);
        if (d && /^[A-Z]{3,}/.test(t)) dateIso = d;
      }
      if (RECO_NOISE.test(t)) continue;

      const m = RECO_ROW_RE.exec(t);
      if (m) {
        const cells = m[3].trim().split(/\s+/);
        if (cells.length >= 8 && /^[\d(]/.test(cells[0])) {
          if (!current) { current = { name: 'Other', rows: [] }; sectors.push(current); }
          current.rows.push({
            name: m[1].trim(),
            reco: m[2].toUpperCase(),
            cells: cells.slice(0, RECO_COLUMNS.length)
          });
          continue;
        }
      }
      // A short line with no figures in it is a sector heading.
      if (!/\d/.test(t) && t.length > 2 && t.length < 46) {
        current = { name: t, rows: [] };
        sectors.push(current);
      }
    }
  }

  const withRows = sectors.filter((s) => s.rows.length);
  const total = withRows.reduce((n, s) => n + s.rows.length, 0);
  if (!total) {
    errors.push({ code: 'NO_ROWS', field: 'sectors',
      message: 'No recommendation rows could be read. Each row should be "<Company> <RATING> <figures>".' });
    return { ok: false, report: null, errors, warnings };
  }
  if (!dateIso) warnings.push({ code: 'NO_DATE', field: 'publishedAt',
    message: 'No report date found; using none.' });

  const report = {
    schemaVersion: '1.0',
    format: 'stock-recommendations',
    reportId: (meta && meta.reportId) || `stock-reco-${dateIso || 'undated'}`,
    publishedAt: dateIso,
    report: { type: 'Stock Recommendations', template: 'Stock Recommendations' },
    columns: RECO_COLUMNS,
    sectors: withRows,
    footnote: '^ Reco and price target are as of the latest report date shown for each stock.',
    circulation: 'For Private Circulation'
  };
  return { ok: true, report, errors, warnings };
}

module.exports.extractStockRecos = extractStockRecos;
