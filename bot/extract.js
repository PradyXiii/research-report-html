'use strict';
/**
 * extract.js -- PDF (or pre-extracted lines) -> a document matching schema.json.
 *
 * Design rules, in priority order:
 *
 *  1. NEVER GUESS A NUMBER. Every figure is anchored on a printed label and
 *     confirmed geometrically. If a label is missing, ambiguous, or resolves to
 *     two different values, we return an error and publish nothing.
 *  2. LABELS, NOT POSITION. Page 1 of a Jamun one-pager puts the headline, CMP
 *     and Fair Value in text boxes that come out of the PDF *last*, not in
 *     visual order. Nothing here depends on a line's ordinal position. Geometry
 *     is used only to answer "which value belongs to which label" when two
 *     label/value pairs sit side by side.
 *  3. STRUCTURED RESULTS, NOT EXCEPTIONS. Everything comes back as
 *     { ok, report, errors[], warnings[], notes[], evidence } so the caller can
 *     log precisely what failed and hand a human something actionable.
 *  4. CROSS-CHECK. The filename, the headline and the numbers are three partly
 *     independent sources. Where they can be compared, they are -- a mismatch
 *     is the cheapest available detector of a misread.
 *
 * Zero dependencies in the parsing path: extractFromLines() is pure and is what
 * the test-suite exercises against a fixture captured from the real PDF.
 */

const path = require('path');
const { parseFilename } = require('./lib/filename');

/* ------------------------------------------------------------------ tables */

// Kept in step with src/render.js VALID_RATINGS and schema.json.
const RATINGS = ['BUY', 'ADD', 'REDUCE', 'SELL', 'NR', 'SUBSCRIBE', 'RS', 'NA', 'NM'];
// Ratings that imply a directional fair value.
const DIRECTIONAL = ['BUY', 'ADD', 'REDUCE', 'SELL'];
// Upside bands from page 2 of every report (mirrored in src/boilerplate.js).
const BANDS = [
  { code: 'SELL', test: (u) => u < -5 },
  { code: 'REDUCE', test: (u) => u >= -5 && u < 5 },
  { code: 'ADD', test: (u) => u >= 5 && u <= 15 },
  { code: 'BUY', test: (u) => u > 15 }
];

const DEFAULT_SECTIONS = [
  { match: '^rationale$', id: 'rationale', title: 'Rationale', tone: 'neutral', icon: 'rationale' },
  { match: '^positives?$', id: 'positives', title: 'Positives', tone: 'positive', icon: 'positive' },
  { match: '^negatives?$', id: 'negatives', title: 'Negatives', tone: 'negative', icon: 'negative' },
  { match: '^(?:risks?|key risks?)$', id: 'risks', title: 'Risks', tone: 'negative', icon: 'negative' },
  { match: '^(?:outlook|view|our view)$', id: 'outlook', title: 'Outlook', tone: 'neutral', icon: 'rationale' }
];

const DEFAULT_LABELS = {
  date: '^dated\\s*[:\\-]',
  holdingPeriod: '^holding\\s*period\\s*[:\\-]',
  cmp: '(?:current\\s*market\\s*price|\\(\\s*cmp\\s*\\)|^cmp\\b)',
  fairValue: '(?:fair\\s*value|\\(\\s*fv\\s*\\)|^fv\\b)'
};

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12
};

const CURRENCIES = [
  { re: /^(?:rs\.?|inr|₹)$/i, code: 'INR' },
  { re: /^(?:\$|usd|us\$)$/i, code: 'USD' },
  { re: /^(?:€|eur)$/i, code: 'EUR' },
  { re: /^(?:£|gbp)$/i, code: 'GBP' }
];

// Bullet glyphs seen across Word/InDesign exports, incl. the Symbol-font bullet
// (U+F0B7) that Word emits and that many extractors pass through verbatim.
const BULLET_RE = /^\s*(?:[\u2022\u25AA\u25AB\u25CF\u25CB\u25E6\u2043\u2219\u00B7\uF0B7\u2023\u25B8\u00BB*+]|[-\u2013\u2014](?=\s))\s*/;
const MONEY_RE = /^(?:(rs\.?|inr|₹|\$|usd|us\$|€|eur|£|gbp)\s*)?(\d[\d,]*(?:\.\d+)?)\s*(rs\.?|inr|₹)?$/i;
const NOT_APPLICABLE_RE = /^(?:n\.?\s?a\.?|not\s*rated|nr|not\s*applicable|[-\u2013\u2014\u2015]{1,3})$/i;
const ARTIFACT_RE = /^[\s`'"~^\u00B4\u2018\u2019\u201C\u201D\u00B7._=|\\/\u2013\u2014]*$/;
const TITLE_RE = /^(?<name>[^()]{2,80}?)\s*\(\s*(?<ticker>[A-Za-z0-9&.\-\s]{1,24}?)\s*\)\s*[-\u2013\u2014:|]\s*(?<rating>[A-Za-z]{2,10})\s*$/;
const TITLE_NO_RATING_RE = /^(?<name>[^()]{2,80}?)\s*\(\s*(?<ticker>[A-Za-z0-9&.\-\s]{1,24}?)\s*\)\s*$/;
// Both separators occur in the wild: "EBITDA - Earnings..." and "CAGR: Compounded...".
const GLOSSARY_HIT_RE = /\b[A-Z][A-Za-z0-9&/]{1,9}\s*[-\u2013\u2014:]\s*[A-Z]/g;

/* ------------------------------------------------------------------- utils */

const norm = (s) => String(s == null ? '' : s).replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
const foldKey = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const centre = (l) => (Number(l.x0 || 0) + Number(l.x1 || 0)) / 2;
const hasGeometry = (l) => Number.isFinite(l && l.y) && Number.isFinite(l && l.x0);

function slugify(s) {
  return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Collector that keeps errors/warnings uniform and machine-readable. */
function diagnostics() {
  const errors = [], warnings = [], notes = [];
  return {
    errors, warnings, notes,
    error: (code, field, message) => { errors.push({ code, field, message }); },
    warn: (code, field, message) => { warnings.push({ code, field, message }); },
    note: (message) => { notes.push(message); }
  };
}

/* -------------------------------------------------------- line classifier */

/**
 * Assign exactly one role to every line. Order is significant: the most
 * specific, label-anchored tests run first so that prose can never be mistaken
 * for a field.
 */
function classify(lines, cfg, filenameMeta) {
  const roles = new Array(lines.length).fill('text');
  const labelRe = {
    date: new RegExp(cfg.labels.date, 'i'),
    holdingPeriod: new RegExp(cfg.labels.holdingPeriod, 'i'),
    cmp: new RegExp(cfg.labels.cmp, 'i'),
    fairValue: new RegExp(cfg.labels.fairValue, 'i')
  };
  const sectionDefs = cfg.sections.map((s) => Object.assign({}, s, { re: new RegExp(s.match, 'i') }));
  const typeKey = filenameMeta && filenameMeta.type ? foldKey(filenameMeta.type) : null;
  const templateKey = filenameMeta && filenameMeta.template ? foldKey(filenameMeta.template) : null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].text;
    const t = norm(raw);
    if (!t || ARTIFACT_RE.test(t)) { roles[i] = 'artifact'; continue; }
    if (BULLET_RE.test(t)) { roles[i] = 'bullet'; continue; }
    if (labelRe.date.test(t)) { roles[i] = 'dateLabel'; continue; }
    if (labelRe.holdingPeriod.test(t)) { roles[i] = 'holdingPeriodLabel'; continue; }
    if (labelRe.cmp.test(t)) { roles[i] = 'cmpLabel'; continue; }
    if (labelRe.fairValue.test(t)) { roles[i] = 'fvLabel'; continue; }
    if (TITLE_RE.test(t)) { roles[i] = 'title'; continue; }
    if (MONEY_RE.test(t)) { roles[i] = 'money'; continue; }
    if (NOT_APPLICABLE_RE.test(t)) { roles[i] = 'na'; continue; }

    // Glossary parenthetical at the foot of page 1, plus its wrapped lines.
    if (t.startsWith('(') && (t.match(GLOSSARY_HIT_RE) || []).length >= 2) {
      roles[i] = 'abbreviations';
      let depth = countParens(t);
      for (let j = i + 1; j < lines.length && depth > 0 && j - i <= 5; j++) {
        roles[j] = 'abbreviations';
        depth += countParens(norm(lines[j].text));
        i = j;
      }
      continue;
    }

    const headingBody = t.replace(/\s*[:\uFF1A]\s*$/, '');
    const known = sectionDefs.find((d) => d.re.test(headingBody));
    if (known && headingBody !== t) { roles[i] = 'sectionHeading'; continue; }
    if (known && headingBody === t && isBullet(lines[i + 1])) { roles[i] = 'sectionHeading'; continue; }
    // Unknown heading: "Something:" with nothing after it, followed by a bullet.
    if (/[:\uFF1A]\s*$/.test(t) && isBullet(lines[i + 1])) { roles[i] = 'sectionHeading'; continue; }

    if (typeKey && foldKey(t) === typeKey) { roles[i] = 'reportTypeBand'; continue; }
    if (templateKey && foldKey(t) === templateKey) { roles[i] = 'templateBand'; continue; }
  }
  return { roles, sectionDefs };

  function isBullet(line) { return !!line && BULLET_RE.test(norm(line.text)); }
}

function countParens(s) {
  let d = 0;
  for (const ch of s) { if (ch === '(') d++; else if (ch === ')') d--; }
  return d;
}

/* --------------------------------------------------------- value resolvers */

function parseMoney(text) {
  const t = norm(text);
  const m = MONEY_RE.exec(t);
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const mark = m[1] || m[3] || null;
  const cur = mark ? (CURRENCIES.find((c) => c.re.test(mark.trim())) || {}).code || null : null;
  return { value, currency: cur, raw: t };
}

/**
 * Find the value printed against a label.
 *
 *   (a) on the same line, after the label       "CMP: Rs.487"
 *   (b) directly beneath the label, x-aligned   the Jamun one-pager layout
 *   (c) the next value-shaped line              fallback when no geometry
 *
 * Two labels of the same kind, or one label with two conflicting values, is an
 * error -- not a coin toss.
 */
function resolveLabelled(lines, roles, role, cfg, labelPattern) {
  const idxs = roles.map((r, i) => (r === role ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) return { found: false, candidates: [] };

  // Global, so "Current Market Price (CMP): Rs.512" loses both the phrase and
  // the parenthesised abbreviation and leaves just the figure.
  const labelRe = new RegExp(labelPattern, 'gi');
  const valueIdx = roles.map((r, i) => (r === 'money' || r === 'na' ? i : -1)).filter((i) => i >= 0);
  const candidates = [];

  for (const li of idxs) {
    const label = lines[li];
    const rest = norm(label.text)
      .replace(labelRe, ' ')
      .replace(/^[\s:()\-\u2013\u2014]+/, '')
      .replace(/[\s:()\-\u2013\u2014]+$/, '')
      .trim();

    if (rest) {
      const money = parseMoney(rest);
      if (money) { candidates.push({ via: 'inline', label: li, line: li, ...money, notApplicable: false }); continue; }
      if (NOT_APPLICABLE_RE.test(rest)) { candidates.push({ via: 'inline', label: li, line: li, value: null, currency: null, raw: rest, notApplicable: true }); continue; }
    }

    if (hasGeometry(label)) {
      let best = null;
      for (const vi of valueIdx) {
        const v = lines[vi];
        if (!hasGeometry(v)) continue;
        const dy = label.y - v.y;                       // PDF y grows upward
        if (dy <= 0 || dy > cfg.valueMaxDy) continue;
        const dx = Math.abs(centre(v) - centre(label));
        if (dx > cfg.valueMaxDx) continue;
        if (!best || dy < best.dy) best = { vi, dy, dx };
      }
      if (best) { candidates.push(makeCandidate('below', li, best.vi)); continue; }
    }

    const next = valueIdx.find((vi) => vi > li);
    if (next !== undefined) candidates.push(makeCandidate('sequential', li, next));
  }

  return { found: candidates.length > 0, candidates, labelIndexes: idxs };

  function makeCandidate(via, labelIdx, valueIdx2) {
    const line = lines[valueIdx2];
    if (roles[valueIdx2] === 'na') {
      return { via, label: labelIdx, line: valueIdx2, value: null, currency: null, raw: norm(line.text), notApplicable: true };
    }
    const money = parseMoney(line.text);
    return { via, label: labelIdx, line: valueIdx2, value: money ? money.value : null, currency: money ? money.currency : null, raw: norm(line.text), notApplicable: false };
  }
}

/** Collapse candidates to a single value, or report why we cannot. */
function pickSingle(res, field, dg, humanLabel) {
  if (!res.found) {
    dg.error('LABEL_NOT_FOUND', field, `Could not find "${humanLabel}" on page 1. Nothing was published.`);
    return null;
  }
  const distinct = [];
  for (const c of res.candidates) {
    const key = c.notApplicable ? 'NA' : String(c.value);
    if (!distinct.some((d) => d.key === key)) distinct.push({ key, c });
  }
  if (distinct.length > 1) {
    dg.error('AMBIGUOUS_VALUE', field,
      `"${humanLabel}" resolved to ${distinct.length} different values (${distinct.map((d) => d.key).join(', ')}). ` +
      'Refusing to choose. A human must check the PDF.');
    return null;
  }
  return distinct[0].c;
}

/* --------------------------------------------------------------- date */

function parseReportDate(text, dg, cfg) {
  const t = norm(text).replace(new RegExp(cfg.labels.date, 'i'), '').replace(/^[\s:\-]+/, '').trim();
  if (!t) { dg.error('DATE_MISSING', 'publishedAt', 'The "Dated:" line on page 1 has no date after it.'); return null; }

  let y = null, m = null, d = null, ambiguous = false;
  let mm;

  if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t))) {
    y = +mm[1]; m = +mm[2]; d = +mm[3];
  } else if ((mm = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{2,4})\b/.exec(t))) {
    d = +mm[1]; m = MONTHS[mm[2].toLowerCase()]; y = +mm[3];
  } else if ((mm = /^([A-Za-z]{3,9})\.?[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{2,4})\b/.exec(t))) {
    m = MONTHS[mm[1].toLowerCase()]; d = +mm[2]; y = +mm[3];
  } else if ((mm = /^(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{2,4})\b/.exec(t))) {
    // Numeric-only. Day-first (Indian convention) but flagged when it could
    // equally be month-first.
    d = +mm[1]; m = +mm[2]; y = +mm[3];
    ambiguous = d <= 12 && m <= 12;
  } else {
    dg.error('DATE_UNPARSEABLE', 'publishedAt',
      `Could not read a date from "Dated: ${t}". Supported: 21 May 2026, 21-May-2026, 2026-05-21, 21/05/2026.`);
    return null;
  }

  if (!m || m < 1 || m > 12 || !d || d < 1 || d > 31) {
    dg.error('DATE_UNPARSEABLE', 'publishedAt', `"${t}" is not a valid calendar date.`);
    return null;
  }
  if (y < 100) { y += 2000; dg.warn('DATE_TWO_DIGIT_YEAR', 'publishedAt', `Two-digit year in "${t}" read as ${y}.`); }

  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const asDate = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(asDate.getTime()) || asDate.getUTCDate() !== d) {
    dg.error('DATE_UNPARSEABLE', 'publishedAt', `"${t}" is not a real date (parsed as ${iso}).`);
    return null;
  }

  const now = cfg.now ? new Date(cfg.now) : new Date();
  const ageDays = Math.round((now.getTime() - asDate.getTime()) / 86400000);
  const thisYear = now.getUTCFullYear();
  if (y < 2000 || y > thisYear + 1) {
    dg.error('DATE_OUT_OF_RANGE', 'publishedAt', `Report date ${iso} is outside the plausible range 2000-${thisYear + 1}.`);
    return null;
  }
  if (ambiguous) {
    dg.warn('DATE_AMBIGUOUS', 'publishedAt',
      `"${t}" is numeric and could be day-first or month-first; read as ${iso} (day-first). Please confirm.`);
  }
  if (ageDays > cfg.maxReportAgeDays) {
    dg.warn('REPORT_STALE', 'publishedAt',
      `Report is dated ${iso}, ${ageDays} days ago (limit ${cfg.maxReportAgeDays}). Check this is not a re-run over an old file.`);
  }
  if (ageDays < -cfg.maxFutureDays) {
    dg.warn('REPORT_FUTURE_DATED', 'publishedAt', `Report is dated ${iso}, ${-ageDays} days in the future.`);
  }
  return iso;
}

/* ------------------------------------------------------------- sections */

/** Is `cur` the wrapped remainder of the line above it? */
function isContinuation(prev, cur, bulletLine, cfg) {
  if (!prev || !cur) return false;
  if (!hasGeometry(prev) || !hasGeometry(cur) || !hasGeometry(bulletLine)) {
    // No geometry (a different PDF engine, or a hand-written fixture): fall
    // back to "the previous line did not finish a sentence".
    return !/[.!?:;]["')\]]?$/.test(norm(prev.text));
  }
  const gap = prev.y - cur.y;
  const stride = Math.max(prev.height || 0, 8);
  if (gap <= 0 || gap > stride * cfg.lineGapFactor) return false;
  if (cur.x0 < bulletLine.x0 - 2 || cur.x0 > bulletLine.x0 + cfg.continuationIndent) return false;
  const hp = prev.height || 0, hc = cur.height || 0;
  if (hp > 0 && hc > 0) {
    const ratio = hc / hp;
    if (ratio < cfg.heightRatioMin || ratio > cfg.heightRatioMax) return false;
  }
  return true;
}

/** Join wrapped lines, keeping hyphenated words intact. */
function joinWrapped(lineTexts, dg) {
  let out = '';
  for (const piece of lineTexts) {
    const t = norm(piece);
    if (!out) { out = t; continue; }
    if (/[-\u2013]$/.test(out) && /^[a-z]/.test(t)) {
      // "cross-" + "currency" -> "cross-currency". A soft hyphen inserted by
      // the typesetter would be joined the same way, so record it.
      dg.note(`Joined a line-break hyphen: "...${out.slice(-14)}${t.slice(0, 14)}..."`);
      out += t;
    } else {
      out += ' ' + t;
    }
  }
  return norm(out);
}

function assembleSections(lines, roles, sectionDefs, cfg, dg) {
  const sections = [];
  const consumed = new Set();
  let current = null;
  let bullet = null;
  let prevIdx = -1;

  const closeBullet = () => {
    if (current && bullet && bullet.parts.length) {
      const text = joinWrapped(bullet.parts.map((i) => lines[i].text), dg).replace(BULLET_RE, '').trim();
      if (text) current.bullets.push({ text, lines: bullet.parts.slice() });
    }
    bullet = null;
  };
  const closeSection = () => { closeBullet(); current = null; };

  for (let i = 0; i < lines.length; i++) {
    const role = roles[i];

    if (role === 'sectionHeading') {
      closeSection();
      const body = norm(lines[i].text).replace(/\s*[:\uFF1A]\s*$/, '');
      const def = sectionDefs.find((d) => d.re.test(body));
      current = def
        ? { id: def.id, title: def.title || body, tone: def.tone || 'neutral', icon: def.icon, bullets: [], line: i }
        : { id: slugify(body) || `section-${sections.length + 1}`, title: body, tone: 'neutral', icon: 'rationale', bullets: [], line: i, unknown: true };
      if (current.unknown) {
        dg.warn('UNKNOWN_SECTION', 'sections',
          `Section "${body}" is not in the known set (${sectionDefs.map((d) => d.title).join(', ')}). ` +
          'Rendered as a neutral section -- confirm it belongs on the page.');
      }
      sections.push(current);
      prevIdx = i;
      continue;
    }

    if (!current) { prevIdx = i; continue; }

    if (role === 'bullet') {
      closeBullet();
      bullet = { start: i, parts: [i] };
      consumed.add(i);
      prevIdx = i;
      continue;
    }

    if (role === 'text' && bullet && isContinuation(lines[prevIdx], lines[i], lines[bullet.start], cfg)) {
      bullet.parts.push(i);
      consumed.add(i);
      prevIdx = i;
      continue;
    }

    // Anything else ends the section. We would rather drop a stray line than
    // absorb a disclaimer into a recommendation.
    closeSection();
    prevIdx = i;
  }
  closeSection();

  // Completeness gate: a bullet that landed outside every section means the
  // heading detection failed, and silently losing a bullet is unacceptable.
  const orphans = roles.map((r, i) => (r === 'bullet' && !consumed.has(i) ? i : -1)).filter((i) => i >= 0);
  if (orphans.length) {
    dg.error('ORPHAN_BULLETS', 'sections',
      `${orphans.length} bullet(s) are not inside any section heading, e.g. "${norm(lines[orphans[0]].text).slice(0, 70)}". ` +
      'Section headings on this PDF do not match the configured set.');
  }

  for (const s of sections) {
    if (!s.bullets.length) {
      dg.warn('EMPTY_SECTION', 'sections', `Section "${s.title}" has no bullets and was dropped.`);
      continue;
    }
    for (const b of s.bullets) {
      if (!/[.!?%)\]"'\u2019\u201D]$/.test(b.text)) {
        dg.warn('BULLET_TRUNCATED', 'sections',
          `A bullet in "${s.title}" does not end with sentence punctuation and may be cut short: "...${b.text.slice(-60)}".`);
      }
    }
  }
  return { sections: sections.filter((s) => s.bullets.length), consumed };
}

/* ----------------------------------------------------------- attribution */

/** The longest contiguous run of leftover prose is the KIE attribution note. */
function findAttribution(lines, roles, cfg) {
  let best = null, run = null;
  for (let i = 0; i <= lines.length; i++) {
    const isFree = i < lines.length && roles[i] === 'text';
    if (isFree) {
      if (!run) run = { from: i, idx: [] };
      run.idx.push(i);
    } else if (run) {
      const chars = run.idx.reduce((n, j) => n + norm(lines[j].text).length, 0);
      if (!best || chars > best.chars) best = { idx: run.idx, chars };
      run = null;
    }
  }
  if (!best || best.chars < cfg.minAttributionChars) return { text: null, idx: [] };
  const text = best.idx.map((i) => norm(lines[i].text)).join(' ').replace(/\s+/g, ' ').trim();
  return { text, idx: best.idx };
}

/* ------------------------------------------------------------ name check */

function compareNames(a, b) {
  const ka = foldKey(a), kb = foldKey(b);
  if (!ka || !kb) return 'unknown';
  if (ka === kb || ka.startsWith(kb) || kb.startsWith(ka)) return 'match';
  const ta = new Set(norm(a).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  const tb = norm(b).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return tb.some((w) => ta.has(w)) ? 'partial' : 'mismatch';
}

/* ------------------------------------------------------------- defaults */

const DEFAULTS = {
  labels: DEFAULT_LABELS,
  sections: DEFAULT_SECTIONS,
  ratings: RATINGS,
  defaultCurrency: 'INR',
  defaultHoldingPeriod: '12 months',
  tickerMap: {},
  slugTemplate: null,           // e.g. '{name}-share-price'; null => leave slug null
  maxReportAgeDays: 7,
  maxFutureDays: 2,
  expectedPageCount: 4,
  valueMaxDy: 45,               // pt: how far below a label its value may sit
  valueMaxDx: 90,               // pt: horizontal tolerance between label and value centres
  lineGapFactor: 2.2,
  continuationIndent: 60,       // pt
  heightRatioMin: 0.72,
  heightRatioMax: 1.35,
  minAttributionChars: 60,
  ratingBandTolerance: 0.5,     // percentage points
  now: null
};

function withDefaults(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  o.labels = Object.assign({}, DEFAULT_LABELS, (opts && opts.labels) || {});
  o.sections = (opts && opts.sections && opts.sections.length) ? opts.sections : DEFAULT_SECTIONS;
  o.ratings = (opts && opts.ratings && opts.ratings.length) ? opts.ratings : RATINGS;
  return o;
}

/* ------------------------------------------------------------------ main */

/**
 * @param {Array} lines  [{ text, x0, x1, y, height }] for PAGE 1 only
 * @param {object} opts  see DEFAULTS, plus { filename, sourceUrl, pageCount }
 */
function extractFromLines(lines, opts) {
  const cfg = withDefaults(opts);
  const dg = diagnostics();
  const src = Array.isArray(lines) ? lines.map((l, i) => Object.assign({ index: i }, l)) : [];

  if (!src.length) {
    dg.error('NO_TEXT', 'document',
      'Page 1 produced no text. The PDF is probably a scan or image-only; this pipeline does not OCR.');
    return result(false, null, dg, {});
  }

  const nameHint = cfg.filename || cfg.sourceUrl || '';
  const meta = parseFilename(nameHint, { pattern: cfg.filenamePattern });
  for (const w of meta.warnings) dg.warn('FILENAME', 'reportId', w);

  const { roles, sectionDefs } = classify(src, cfg, meta);

  if (cfg.pageCount && cfg.expectedPageCount && cfg.pageCount !== cfg.expectedPageCount) {
    dg.warn('PAGE_COUNT', 'document',
      `PDF has ${cfg.pageCount} pages, expected ${cfg.expectedPageCount}. ` +
      'Pages 2+ are assumed to be the standard boilerplate held in src/boilerplate.js -- confirm this is the same template.');
  }

  /* ---- headline: stock name, ticker, rating ---- */
  let name = null, ticker = null, rating = null, titleIdx = -1;
  const titleIdxs = roles.map((r, i) => (r === 'title' ? i : -1)).filter((i) => i >= 0);
  const titles = titleIdxs.map((i) => {
    const m = TITLE_RE.exec(norm(src[i].text));
    return { i, name: norm(m.groups.name), ticker: norm(m.groups.ticker).toUpperCase(), rating: m.groups.rating.toUpperCase() };
  });

  // When the filename tells us the stock, prefer the headline that agrees with
  // it. That is what disarms leftover template text on page 1.
  let chosen = titles;
  if (meta.stock && titles.length > 1) {
    const agreeing = titles.filter((t) => compareNames(meta.stock, t.name) !== 'mismatch');
    if (agreeing.length) chosen = agreeing;
  }
  const distinctTitles = [];
  for (const t of chosen) {
    if (!distinctTitles.some((d) => d.ticker === t.ticker && d.rating === t.rating)) distinctTitles.push(t);
  }

  if (distinctTitles.length === 1) {
    ({ name, ticker, rating } = distinctTitles[0]);
    titleIdx = distinctTitles[0].i;
  } else if (distinctTitles.length > 1) {
    dg.error('AMBIGUOUS_TITLE', 'stock',
      `Page 1 contains ${distinctTitles.length} conflicting headlines: ` +
      distinctTitles.map((t) => `"${t.name} (${t.ticker}) - ${t.rating}"`).join(' vs ') +
      '. Refusing to choose.');
  } else {
    // Fallback: "Name (TICKER)" with the rating printed on its own.
    const partial = src
      .map((l, i) => ({ i, m: roles[i] === 'text' ? TITLE_NO_RATING_RE.exec(norm(l.text)) : null }))
      .filter((x) => x.m && meta.stock && compareNames(meta.stock, x.m.groups.name) !== 'mismatch');
    const loose = src
      .map((l, i) => ({ i, t: norm(l.text).toUpperCase() }))
      .filter((x) => roles[x.i] === 'text' && cfg.ratings.includes(x.t));
    if (partial.length === 1 && loose.length === 1) {
      name = norm(partial[0].m.groups.name);
      ticker = norm(partial[0].m.groups.ticker).toUpperCase();
      rating = loose[0].t;
      titleIdx = partial[0].i;
      dg.warn('TITLE_SPLIT', 'stock',
        `The headline and the rating were found on separate lines ("${name} (${ticker})" and "${rating}"). Please confirm.`);
    } else {
      dg.error('TITLE_NOT_FOUND', 'stock',
        'Could not find the headline in the form "Stock Name (TICKER) - RATING" on page 1.');
    }
  }

  if (rating && !cfg.ratings.includes(rating)) {
    dg.error('UNKNOWN_RATING', 'recommendation.rating',
      `Rating "${rating}" is not on the PCG scale (${cfg.ratings.join(', ')}). Not publishing a rating we cannot map.`);
    rating = null;
  }

  if (name && meta.stock) {
    const verdict = compareNames(meta.stock, name);
    if (verdict === 'mismatch') {
      dg.error('NAME_MISMATCH', 'stock.name',
        `The filename says "${meta.stock}" but the headline says "${name}". These must agree.`);
    } else if (verdict === 'partial') {
      dg.warn('NAME_PARTIAL_MATCH', 'stock.name',
        `Filename stock "${meta.stock}" and headline "${name}" differ. Using the headline.`);
    }
  }

  /* ---- date ---- */
  const dateIdx = roles.indexOf('dateLabel');
  let publishedAt = null;
  if (dateIdx === -1) {
    dg.error('LABEL_NOT_FOUND', 'publishedAt', 'No "Dated:" line on page 1.');
  } else {
    publishedAt = parseReportDate(src[dateIdx].text, dg, cfg);
  }

  /* ---- CMP and fair value ---- */
  const cmpRes = resolveLabelled(src, roles, 'cmpLabel', cfg, cfg.labels.cmp);
  const fvRes = resolveLabelled(src, roles, 'fvLabel', cfg, cfg.labels.fairValue);
  const cmpPick = pickSingle(cmpRes, 'recommendation.cmp', dg, 'Current Market Price (CMP)');
  let fvPick = null;
  if (fvRes.found) {
    fvPick = pickSingle(fvRes, 'recommendation.fairValue', dg, 'Fair Value (FV)');
  } else {
    dg.warn('FV_NOT_FOUND', 'recommendation.fairValue',
      'No "Fair Value (FV)" label on page 1. Publishing without a fair value; the Fair Value and Upside tiles will be omitted.');
  }

  let cmp = null;
  if (cmpPick) {
    if (cmpPick.notApplicable || cmpPick.value === null) {
      dg.error('CMP_NOT_A_NUMBER', 'recommendation.cmp',
        `Current Market Price read as "${cmpPick.raw}", which is not a number. CMP is mandatory.`);
    } else if (!(cmpPick.value > 0)) {
      dg.error('CMP_NOT_POSITIVE', 'recommendation.cmp', `Current Market Price came out as ${cmpPick.value}.`);
    } else {
      cmp = cmpPick.value;
    }
  }
  const fairValue = fvPick && !fvPick.notApplicable ? fvPick.value : null;

  let currency = cfg.defaultCurrency;
  const marks = [cmpPick && cmpPick.currency, fvPick && fvPick.currency].filter(Boolean);
  if (marks.length && marks.some((m) => m !== marks[0])) {
    dg.error('CURRENCY_MISMATCH', 'recommendation.currency',
      `CMP and Fair Value are printed in different currencies (${marks.join(' vs ')}). Any upside figure would be nonsense.`);
  } else if (marks.length) {
    currency = marks[0];
  } else {
    dg.warn('CURRENCY_ASSUMED', 'recommendation.currency',
      `No currency mark next to the figures; assuming ${cfg.defaultCurrency}.`);
  }

  /* ---- holding period ---- */
  let holdingPeriod = cfg.defaultHoldingPeriod;
  const hpIdx = roles.indexOf('holdingPeriodLabel');
  if (hpIdx === -1) {
    dg.warn('HOLDING_PERIOD_DEFAULTED', 'recommendation.holdingPeriod',
      `No "Holding Period:" line; defaulting to "${cfg.defaultHoldingPeriod}".`);
  } else {
    const v = norm(src[hpIdx].text).replace(new RegExp(cfg.labels.holdingPeriod, 'i'), '').replace(/^[\s:\-]+/, '').trim();
    if (v) holdingPeriod = v;
    else dg.warn('HOLDING_PERIOD_DEFAULTED', 'recommendation.holdingPeriod', 'The "Holding Period:" line is empty; using the default.');
  }

  /* ---- narrative ---- */
  const { sections, consumed } = assembleSections(src, roles, sectionDefs, cfg, dg);
  if (!sections.length) {
    dg.error('NO_SECTIONS', 'sections',
      'No narrative sections were found. Expected headings such as "Rationale:", "Positives:", "Negatives:".');
  }

  // Leftover uppercase rating tokens elsewhere on the page usually mean stale
  // template text under a graphic. It bit us on the reference PDF (") - SELL").
  const ratingWord = new RegExp(`\\b(?:${cfg.ratings.join('|')})\\b`);
  const strays = src
    .map((l, i) => ({ i, t: norm(l.text) }))
    .filter((x) => x.i !== titleIdx && !consumed.has(x.i) && roles[x.i] !== 'bullet' &&
                   roles[x.i] !== 'abbreviations' && ratingWord.test(x.t));
  if (strays.length) {
    dg.warn('STRAY_RATING_TEXT', 'recommendation.rating',
      `Page 1 also contains rating-like text that was ignored: ${strays.map((s) => JSON.stringify(s.t.slice(0, 40))).join(', ')}. ` +
      'This is usually invisible leftover template text; confirm the published rating is correct.');
  }

  /* ---- glossary + attribution ---- */
  const abbrIdx = roles.map((r, i) => (r === 'abbreviations' ? i : -1)).filter((i) => i >= 0);
  const abbreviations = abbrIdx.length
    ? norm(abbrIdx.map((i) => norm(src[i].text)).join(' ')).replace(/^\(/, '').replace(/\)$/, '').trim()
    : null;
  if (!abbreviations) dg.warn('NO_ABBREVIATIONS', 'abbreviations', 'No glossary line found at the foot of page 1.');

  const attribution = findAttribution(src, roles, cfg);
  if (!attribution.text) {
    dg.warn('NO_ATTRIBUTION', 'attribution', 'No attribution / KIE-derivation note found at the foot of page 1.');
  }

  /* ---- report type cross-check ---- */
  let reportType = meta.type;
  const bandIdx = roles.indexOf('reportTypeBand');
  // Filenames differ by source: Jamun/S3 encode the type, but files served from
  // kotakneo.com/uploads (and anything a human renamed) do not. Fall back to the
  // type band printed on page 1 before giving up.
  if (!reportType) {
    const KNOWN = /^(Result Update|Company Update|Initiating Coverage|Event Update|Sector Update|IPO Note|Result|Company Report)$/i;
    const band = bandIdx >= 0 ? norm(src[bandIdx].text) : null;
    const printed = (band && KNOWN.test(band))
      ? band
      : (src.map((l) => norm(l.text)).find((t) => KNOWN.test(t)) || null);
    if (printed) {
      reportType = printed;
      dg.note('REPORT_TYPE_FROM_PAGE', 'report.type',
        `Report type "${printed}" read from page 1; the filename did not carry one.`);
    }
  }
  if (!reportType) {
    dg.error('REPORT_TYPE_MISSING', 'report.type',
      'No report type in the filename and none could be corroborated on page 1. report.type is mandatory.');
  } else if (bandIdx === -1 && meta.type) {
    // Only a filename-sourced type can be unconfirmed. One read off page 1 is
    // self-evidently on page 1.
    dg.warn('REPORT_TYPE_UNCONFIRMED', 'report.type',
      `Report type "${reportType}" comes from the filename but does not appear anywhere on page 1.`);
  }

  /* ---- ticker-derived fields ---- */
  const mapped = ticker ? (cfg.tickerMap[ticker] || cfg.tickerMap[String(ticker).toUpperCase()] || null) : null;
  let slug = mapped && mapped.slug ? mapped.slug : null;
  const isin = mapped && mapped.isin ? mapped.isin : null;
  if (!slug && cfg.slugTemplate && name) {
    slug = cfg.slugTemplate.replace('{name}', slugify(name)).replace('{ticker}', slugify(ticker || ''));
    dg.warn('SLUG_DERIVED', 'stock.slug',
      `stock.slug was derived as "${slug}" from SLUG_TEMPLATE, not looked up. ` +
      'If the recommendation page uses a different slug the block will not cross-link.');
  } else if (!slug) {
    dg.warn('SLUG_UNKNOWN', 'stock.slug',
      `No slug for ticker "${ticker}". Add it to the ticker map (BOT_TICKER_MAP) or set SLUG_TEMPLATE. ` +
      'The block still renders; only the cross-link to the recommendation page is missing.');
  }

  /* ---- rating vs computed upside ---- */
  if (rating && cmp && fairValue !== null && DIRECTIONAL.includes(rating)) {
    const upside = ((fairValue - cmp) / cmp) * 100;
    const band = BANDS.find((b) => b.test(upside));
    const near = BANDS.find((b) => b.test(upside + cfg.ratingBandTolerance) || b.test(upside - cfg.ratingBandTolerance));
    if (band && band.code !== rating && (!near || near.code !== rating)) {
      dg.warn('RATING_BAND_MISMATCH', 'recommendation',
        `Fair value ${fairValue} against CMP ${cmp} is ${upside.toFixed(1)}% upside, which is the ${band.code} band, ` +
        `but the report says ${rating}. One of the three figures may have been misread.`);
    }
  }
  if (rating && DIRECTIONAL.includes(rating) && fairValue === null) {
    dg.warn('NO_FAIR_VALUE_FOR_DIRECTIONAL_RATING', 'recommendation.fairValue',
      `Rating is ${rating} but no fair value was found. The Fair Value and Upside tiles will be missing from the block.`);
  }

  /* ---- source URL ---- */
  let sourcePdf = null;
  if (cfg.sourceUrl && /^https?:\/\//i.test(cfg.sourceUrl)) {
    sourcePdf = cfg.sourceUrl;
  } else if (cfg.publicBaseUrl && meta.filename) {
    sourcePdf = String(cfg.publicBaseUrl).replace(/\/+$/, '') + '/' + encodeURIComponent(meta.filename + '.pdf');
  } else {
    dg.warn('NO_SOURCE_URL', 'sourcePdf',
      'No public https URL for the PDF, so the "Download full report" button will be omitted. ' +
      'Set SOURCE_PUBLIC_BASE_URL when the bot reads from disk.');
  }

  const report = {
    schemaVersion: '1.0',
    reportId: meta.reportId || undefined,
    sourcePdf: sourcePdf || undefined,
    publishedAt: publishedAt || undefined,
    stock: { name: name || undefined, ticker: ticker || undefined, isin: isin, slug: slug },
    report: { type: reportType || undefined, period: meta.period || null, template: meta.template || null },
    recommendation: {
      rating: rating || undefined,
      cmp: cmp === null ? undefined : cmp,
      fairValue: fairValue,
      currency: currency,
      holdingPeriod: holdingPeriod
    },
    sections: sections.map((s) => ({
      id: s.id, title: s.title, tone: s.tone, icon: s.icon, bullets: s.bullets.map((b) => b.text)
    })),
    abbreviations: abbreviations,
    attribution: attribution.text
  };
  prune(report);

  // Same for the id. A stable id derived from the ticker and report date is
  // still de-duplicable across re-runs, which is all the publisher needs.
  if (!meta.reportId && report.stock && report.stock.ticker && report.publishedAt) {
    report.reportId = `${String(report.stock.ticker).toLowerCase()}-${report.publishedAt}`;
    dg.note('REPORT_ID_DERIVED', 'reportId',
      `No id in the filename; using "${report.reportId}", derived from ticker and report date.`);
  }
  if (!meta.reportId && !report.reportId) {
    dg.error('REPORT_ID_MISSING', 'reportId',
      'No report id could be derived from the filename. Without it the publisher cannot de-duplicate, ' +
      'so a re-run would create a second entry.');
  }

  const evidence = {
    filename: meta.filename,
    roleCounts: roles.reduce((a, r) => (a[r] = (a[r] || 0) + 1, a), {}),
    title: titleIdx >= 0 ? norm(src[titleIdx].text) : null,
    cmp: cmpPick ? { raw: cmpPick.raw, via: cmpPick.via, line: cmpPick.line } : null,
    fairValue: fvPick ? { raw: fvPick.raw, via: fvPick.via, line: fvPick.line } : null,
    dateLine: dateIdx >= 0 ? norm(src[dateIdx].text) : null,
    sections: report.sections ? report.sections.map((s) => ({ id: s.id, bullets: s.bullets.length })) : [],
    ignoredLines: roles
      .map((r, i) => (r === 'text' && !consumed.has(i) && !attribution.idx.includes(i) ? norm(src[i].text) : null))
      .filter(Boolean)
  };

  return result(dg.errors.length === 0, report, dg, evidence);
}

function result(ok, report, dg, evidence) {
  return { ok, report: ok ? report : report, errors: dg.errors, warnings: dg.warnings, notes: dg.notes, evidence };
}

/** Drop undefined keys so the object matches schema.json's additionalProperties:false. */
function prune(obj) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) delete obj[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) prune(v);
  }
  return obj;
}

/**
 * PDF buffer -> extraction result. Only page 1 is parsed; pages 2-4 are the
 * standard boilerplate and live in src/boilerplate.js.
 */
async function extractFromPdf(buffer, opts) {
  const cfg = withDefaults(opts);
  const { extractLines } = require('./pdftext');
  let doc;
  try {
    doc = await extractLines(buffer, { pages: [1], maxBytes: cfg.maxPdfBytes });
  } catch (err) {
    const dg = diagnostics();
    dg.error('PDF_UNREADABLE', 'document', err.message);
    return result(false, null, dg, { filename: cfg.filename || null });
  }
  const page1 = doc.pages[0] || { lines: [] };
  return extractFromLines(page1.lines, Object.assign({}, opts, { pageCount: doc.pageCount }));
}

module.exports = {
  extractFromPdf,
  extractFromLines,
  parseMoney,
  parseReportDate,
  compareNames,
  joinWrapped,
  slugify,
  DEFAULTS,
  RATINGS,
  DEFAULT_SECTIONS,
  DEFAULT_LABELS
};
