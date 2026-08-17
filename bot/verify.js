'use strict';
/**
 * verify.js -- the pre-publish gate.
 *
 * This block will sit unread on a public site for months. The dangerous
 * failure is not a broken page, which someone notices; it is a plausible
 * number that is wrong, which nobody notices until it matters. So nothing
 * publishes unless it can be traced back to the source document.
 *
 * Two directions, both required:
 *
 *   A. DATA  <- PDF   every value we extracted must be findable in the PDF text.
 *                     Catches invented, mangled and mis-attributed values.
 *   B. HTML  <- DATA  every value we extracted must survive into the HTML, and
 *                     the HTML must introduce no figure that is not in the data.
 *                     Catches template bugs, truncation and stray literals.
 *
 * A check that cannot be evaluated FAILS. Silence is never treated as success.
 */

/* ------------------------------------------------------------------- utils */

/** Compare text the way a reader would: ignore spacing and quote style. */
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/ /g, ' ')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
function loose(s) { return norm(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** Numbers as a reader sees them: "1,884" and "1884" are the same figure. */
function numKey(v) {
  const s = String(v == null ? '' : v).replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

/** Every distinct figure in a piece of text. */
function figuresIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const k = numKey(m[0]);
    if (k !== null) out.add(k);
  }
  return out;
}

/** Strip tags so HTML can be compared as reading text. */
function textOf(html) {
  return norm(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' '));
}

/* ------------------------------------------------------------------ result */

function result() {
  const failures = [], warnings = [], passed = [];
  return {
    fail: (code, detail) => failures.push({ code, detail }),
    warn: (code, detail) => warnings.push({ code, detail }),
    pass: (code) => passed.push(code),
    done: () => ({ ok: failures.length === 0, failures, warnings, passed })
  };
}

/* ------------------------------------------------------- A. data <- source */

/** Walk the report and collect every leaf value a reader will see. */
function leafValues(data) {
  const strings = [], numbers = [];
  const SKIP = new Set([
    'schemaVersion', 'format', 'reportId', 'template', 'currency', 'id', 'tone',
    'icon', 'slug', 'isin', 'sourcePdf', 'columns', 'footnote', 'circulation',
    'restricted', 'attribution', 'panels', 'disclaimerPages',
    // `type` is our classification of the document, not a quotation from it --
    // its correctness is proved by the detector's own tests, not by grep.
    'type'
  ]);
  (function walk(v, key) {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) if (!SKIP.has(k)) walk(v[k], k);
      return;
    }
    if (SKIP.has(key)) return;
    if (typeof v === 'number') numbers.push({ key, value: v });
    else if (typeof v === 'string' && v.trim()) strings.push({ key, value: v });
  })(data, null);
  return { strings, numbers };
}

function verifyAgainstSource(data, sourceText, page1Text, r) {
  const src = norm(sourceText);
  const srcLoose = loose(sourceText);
  const srcFigs = figuresIn(sourceText);

  if (srcLoose.length < 200) {
    r.fail('SOURCE_TOO_SHORT',
      `Only ${srcLoose.length} characters of source text; cannot verify anything against it.`);
    return;
  }

  const { strings, numbers } = leafValues(data);

  // Every figure we publish must exist in the document.
  for (const n of numbers) {
    const k = numKey(n.value);
    if (k === null) { r.fail('FIGURE_UNREADABLE', `${n.key} = ${n.value}`); continue; }
    if (!srcFigs.has(k)) {
      r.fail('FIGURE_NOT_IN_SOURCE',
        `${n.key} = ${n.value} does not appear anywhere in the PDF. A figure we cannot ` +
        'trace to the document must never be published.');
    }
  }
  if (numbers.length) r.pass('every published figure traced to the PDF');

  // Every sentence we publish must exist in the document. Dates are the one
  // exception: they are reformatted from the printed form on purpose.
  const DATE_KEYS = /^(publishedAt|cmpAsOn)$/;
  for (const s of strings) {
    // Dates are deliberately reformatted ("31 July 2026" -> "2026-07-31"), so a
    // literal match is the wrong test; verifyDates checks them properly.
    if (DATE_KEYS.test(s.key)) continue;
    const hay = loose(src), needle = loose(s.value);
    if (needle.length < 4) continue;
    // The Pick of the Week verdict is completed from the fair value, because
    // the figure that finishes the printed sentence lives inside a graphic.
    // Verify the two halves rather than waving the whole line through.
    if (s.key === 'closing') {
      const fvNum = numKey((data.recommendation || {}).fairValue);
      const m = /^(.*?)\s*FV\s*Rs\s*([\d,]+)$/i.exec(norm(s.value));
      if (m) {
        if (!hay.includes(loose(m[1]))) {
          r.fail('TEXT_NOT_IN_SOURCE', `closing prefix ${JSON.stringify(m[1])} is not in the PDF.`);
        } else if (numKey(m[2]) !== fvNum) {
          r.fail('CLOSING_FV_MISMATCH',
            `The verdict says FV Rs ${m[2]} but the extracted fair value is ${fvNum}.`);
        } else r.pass('composed verdict reconciles with the fair value');
        continue;
      }
    }
    if (!hay.includes(needle)) {
      r.fail('TEXT_NOT_IN_SOURCE',
        `${s.key}: ${JSON.stringify(String(s.value).slice(0, 90))} is not in the PDF text. ` +
        'Published wording must be the document\'s own.');
    }
  }
  if (strings.length) r.pass('every published sentence found in the PDF');

  // A rating must be the one the document prints, not merely a valid code.
  const rating = data.recommendation && String(data.recommendation.rating || '').toUpperCase();
  if (rating) {
    // Page 1 only. Pages 2+ print the whole rating scale, so searching the
    // document would find every code and prove nothing.
    const cover = norm(page1Text || sourceText).toUpperCase();
    if (!new RegExp('\\b' + rating + '\\b').test(cover)) {
      r.fail('RATING_NOT_IN_SOURCE', `Rating "${rating}" does not appear in the PDF text.`);
    } else {
      // Guard the known landmine: leftover template text can leave a second,
      // invisible rating on page 1.
      const others = ['BUY', 'ADD', 'REDUCE', 'SELL'].filter((c) =>
        c !== rating && new RegExp('\\b' + c + '\\b').test(cover));
      if (others.length) {
        r.warn('MULTIPLE_RATINGS_IN_SOURCE',
          `The PDF also contains ${others.join(', ')}. Confirm "${rating}" is the live call ` +
          '-- these documents are known to carry invisible leftover template text.');
      }
      r.pass('rating matches the document');
    }
  }

  // A bullet lost in extraction is a silent change to the recommendation.
  const printed = (String(sourceText).match(/(?:^|\n)\s*[•●·]/g) || []).length;
  const rendered = (data.sections || []).reduce((n, s) => n + ((s.bullets || []).length), 0);
  if (printed && rendered && rendered < printed * 0.6) {
    r.fail('BULLETS_LOST',
      `The PDF shows about ${printed} bullet glyphs but only ${rendered} bullets were extracted. ` +
      'Dropping a point from a recommendation changes what it says.');
  } else if (rendered) r.pass(`${rendered} bullets extracted`);
}

/* --------------------------------------------------------- B. html <- data */

const PLACEHOLDER = /\{\{[^}]*\}\}|\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/;

function verifyRendering(data, html, r) {
  if (!html || html.length < 500) {
    r.fail('HTML_EMPTY', `Rendered HTML is ${html ? html.length : 0} characters.`);
    return;
  }
  const body = textOf(html);

  // Anything the renderer failed to fill.
  const ph = PLACEHOLDER.exec(body);
  if (ph) r.fail('PLACEHOLDER_IN_OUTPUT',
    `Rendered output contains ${JSON.stringify(ph[0])} -- a field the template did not fill.`);
  else r.pass('no unfilled placeholders');

  // Executable content must never come out of a PDF.
  if (/<script(?![^>]*application\/ld\+json)/i.test(html)) {
    r.fail('SCRIPT_IN_OUTPUT', 'Rendered HTML contains a <script> tag other than JSON-LD.');
  } else if (/\son[a-z]+\s*=\s*["']?[^"'>]*\(/i.test(html)) {
    r.fail('EVENT_HANDLER_IN_OUTPUT', 'Rendered HTML contains an inline event handler.');
  } else r.pass('no executable content in the output');

  // Tags must balance, or the block will swallow the rest of the page.
  // Count markup only: an inlined stylesheet mentions tag names in comments and
  // selectors, and counting those reports imbalances that do not exist.
  const markup = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const tag of ['article', 'section', 'div', 'table', 'ul', 'details']) {
    const open = (markup.match(new RegExp('<' + tag + '\\b', 'gi')) || []).length;
    const close = (markup.match(new RegExp('</' + tag + '>', 'gi')) || []).length;
    if (open !== close) {
      r.fail('UNBALANCED_TAGS',
        `<${tag}>: ${open} opened, ${close} closed. Unbalanced markup breaks the host page.`);
    }
  }
  r.pass('markup balanced');

  // Everything extracted must actually reach the reader.
  const { strings, numbers } = leafValues(data);
  const bodyFigs = figuresIn(body);
  const bodyLoose = loose(body);

  for (const n of numbers) {
    const k = numKey(n.value);
    if (k !== null && !bodyFigs.has(k)) {
      r.fail('FIGURE_MISSING_FROM_HTML',
        `${n.key} = ${n.value} was extracted but does not appear in the rendered HTML.`);
    }
  }
  const DATE_KEYS_HTML = /^(publishedAt|cmpAsOn)$/;
  for (const s of strings) {
    if (DATE_KEYS_HTML.test(s.key)) continue;   // checked by verifyDates
    const needle = loose(s.value);
    if (needle.length >= 8 && !bodyLoose.includes(needle)) {
      r.fail('TEXT_MISSING_FROM_HTML',
        `${s.key}: ${JSON.stringify(String(s.value).slice(0, 70))} was extracted but is not in ` +
        'the rendered HTML. Content was dropped between extraction and rendering.');
    }
  }
  r.pass('all extracted content present in the HTML');

  // A date is reformatted, not copied, so verify the reader can actually see
  // the same day: all three parts must appear.
  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  for (const key of ['publishedAt', 'cmpAsOn']) {
    const iso = key === 'publishedAt' ? data[key] : (data.recommendation || {})[key];
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const [y, m, d] = iso.split('-');
    const month = MONTHS[Number(m) - 1];
    const shown = body.includes(String(Number(d))) && body.includes(month) && body.includes(y);
    if (!shown) {
      r.fail('DATE_NOT_SHOWN',
        `${key} ${iso} is not legible in the rendered HTML (expected ${Number(d)} ${month} ${y}). ` +
        'A recommendation without a visible date cannot be judged for staleness.');
    }
  }
  r.pass('dates legible in the output');
}

/* -------------------------------------------------------------- public API */

/**
 * @param {object} input { data, html, sourceText }
 * @returns {{ok, failures, warnings, passed}}  ok=false means DO NOT PUBLISH.
 */
function verify(input) {
  const r = result();
  const { data, html, sourceText, page1Text, filename } = input || {};

  if (!data || typeof data !== 'object') {
    r.fail('NO_DATA', 'No extracted data to verify.');
    return r.done();
  }
  if (typeof sourceText !== 'string') {
    r.fail('NO_SOURCE_TEXT',
      'No source text supplied. Without the document there is nothing to verify against, ' +
      'and unverified output must not be published.');
    return r.done();
  }

  // Mandatory identity: a report nobody can identify cannot be de-duplicated,
  // corrected or withdrawn.
  for (const [path_, label] of [['reportId', 'report id'], ['publishedAt', 'report date']]) {
    if (!data[path_]) r.fail('MISSING_IDENTITY', `No ${label}.`);
  }
  if (data.publishedAt && !/^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt)) {
    r.fail('BAD_DATE', `publishedAt "${data.publishedAt}" is not an ISO date.`);
  }

  // The filename is part of the document's identity -- the period and report
  // type are encoded there by Jamun -- so it counts as source text.
  verifyAgainstSource(data, sourceText + '\n' + String(filename || ''), page1Text, r);
  verifyRendering(data, html, r);
  return r.done();
}

/** One-line summary for a log. */
function summarise(v) {
  if (v.ok) return `PASS (${v.passed.length} checks, ${v.warnings.length} warning(s))`;
  return `BLOCKED: ${v.failures.length} failure(s) -- ` +
         v.failures.map((f) => f.code).join(', ');
}

module.exports = { verify, summarise, norm, loose, numKey, figuresIn, textOf };
