'use strict';
/**
 * Jamun encodes report metadata in the PDF filename. It is the most reliable
 * metadata we have -- far more reliable than anything inside the page -- so we
 * treat it as the primary source and use page 1 only to corroborate.
 *
 *   131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf
 *   └─id──┘ └───── stock ─────┘  └template┘└period┘└─ type ──┘
 *
 * The default shape is a *default*, not an assumption baked into the code:
 * config.filenamePattern can replace it with any regex carrying the named
 * groups reportId / stock / template / period / type. Whatever the pattern
 * cannot supply comes back null with a warning, never a guess.
 */

const DEFAULT_PATTERN =
  '^(?<reportId>\\d+(?:_\\d+)*)_(?<stock>.+?)__(?<rest>.+)$';

// Q4FY26 · 4QFY26 · H1FY26 · 9MFY26 · FY26 · CY25 · FY2026
const PERIOD_RE = /^(?:(?:[1-4]Q|Q[1-4]|H[12]|\d{1,2}M)?FY\d{2,4}|CY\d{2,4})$/i;

function baseName(nameOrUrl) {
  let s = String(nameOrUrl || '');
  try {
    // Accept a full URL, a path, or a bare filename.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = new URL(s).pathname;
  } catch (_) { /* fall through, treat as a path */ }
  try { s = decodeURIComponent(s); } catch (_) { /* keep raw if not valid encoding */ }
  s = s.split(/[\\/]/).pop() || '';
  return s.replace(/\.pdf$/i, '');
}

function words(token) {
  return String(token).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} nameOrUrl
 * @param {object} [opts] { pattern }
 * @returns {{ ok, filename, reportId, stock, template, period, type, warnings }}
 */
function parseFilename(nameOrUrl, opts) {
  const o = opts || {};
  const filename = baseName(nameOrUrl);
  const out = {
    ok: false, filename,
    reportId: null, stock: null, template: null, period: null, type: null,
    warnings: []
  };
  if (!filename) {
    out.warnings.push('Empty filename: no metadata could be derived from the source name.');
    return out;
  }

  let re;
  const patternSrc = o.pattern || DEFAULT_PATTERN;
  try {
    re = new RegExp(patternSrc);
  } catch (err) {
    out.warnings.push(`FILENAME_PATTERN is not a valid regex (${err.message}); metadata not parsed.`);
    return out;
  }

  const m = re.exec(filename);
  if (!m || !m.groups) {
    out.warnings.push(
      `Filename "${filename}" does not match the expected pattern. ` +
      'Expected <reportId>_<Stock_Name>__<Template>_<Period>_<Report_Type>.pdf, ' +
      'or set FILENAME_PATTERN to a regex with named groups reportId/stock/template/period/type.'
    );
    return out;
  }

  const g = m.groups;
  out.reportId = g.reportId ? String(g.reportId).trim() : null;
  out.stock = g.stock ? words(g.stock) : null;

  // A custom pattern may supply template/period/type directly.
  if (g.template !== undefined || g.period !== undefined || g.type !== undefined) {
    out.template = g.template ? words(g.template) : null;
    out.period = g.period ? String(g.period).trim() : null;
    out.type = g.type ? words(g.type) : null;
  } else if (g.rest) {
    const tokens = String(g.rest).split('_').filter(Boolean);
    const idx = tokens.findIndex((t) => PERIOD_RE.test(t));
    if (idx === -1) {
      out.period = null;
      out.template = null;
      out.type = words(tokens.join(' ')) || null;
      out.warnings.push(
        `No reporting period (e.g. Q4FY26) found in "${filename}". ` +
        `report.template left null and report.type set to the whole tail ("${out.type}") -- please confirm.`
      );
    } else {
      out.period = tokens[idx];
      out.template = words(tokens.slice(0, idx).join(' ')) || null;
      out.type = words(tokens.slice(idx + 1).join(' ')) || null;
    }
  }

  if (!out.reportId) out.warnings.push('No report id found in the filename.');
  if (!out.stock) out.warnings.push('No stock name found in the filename.');
  if (!out.type) out.warnings.push('No report type found in the filename.');
  out.ok = !!(out.reportId && out.stock && out.type);
  return out;
}

module.exports = { parseFilename, baseName, DEFAULT_PATTERN, PERIOD_RE };
