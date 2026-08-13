# Kotak research report → HTML

Converts the Kotak PCG **research one-pager PDF** into an accessible, responsive
HTML block that is published to kotakneo.com through Strapi.

Reference input: [`Lenskart Solutions — One Pager Q4FY26 Result Update`](https://ks-oncloudpublic-reports.s3.ap-south-1.amazonaws.com/jaamoon-pdf-files/131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf)

---

## Quick start

```bash
npm run build     # regenerate every HTML artifact from src/ + data/
npm test          # 34 contract + injection-safety tests (no browser)
npm run audit     # WCAG AA contrast + structure audit in light AND dark
```

Then open **`sample-lenskart.html`** — plain output, no toolbar. Theme follows
your OS; sizing is whatever the container gives it.

Render a single report:

```bash
node src/render.js data/lenskart-2026-05-21.json                 # HTML fragment
node src/render.js data/lenskart-2026-05-21.json --inline-css    # self-contained fragment
node src/render.js data/lenskart-2026-05-21.json --standalone    # full HTML page
node src/render.js data/lenskart-2026-05-21.json --logo-url=https://cdn/logo.png
```

---

## Files

| Path | What it is |
|---|---|
| `schema.json` | **The contract.** JSON Schema the bot must emit and Strapi stores. |
| `src/render.js` | Deterministic JSON → HTML renderer. Zero dependencies, Node 16+. |
| `src/krb.css` | The scoped stylesheet. Every selector is under `.krb`. |
| `src/boilerplate.js` | Pages 2–4 of the PDF, verbatim and static. |
| `data/lenskart-2026-05-21.json` | The reference report, transcribed from the PDF. |
| `template.html` | The same markup rendered with `{{placeholders}}` — the template as a document. |
| `sample-lenskart.html` | Fully populated standalone page. Open it in a browser. |
| `block-inline-css.html` | Fragment with CSS inlined — what Strapi would store as the HTML blob. |
| `INTEGRATION.md` · `bot/` | The PDF → Strapi bot (see that doc). |
| `tools/build.js` · `tools/test.js` · `tools/audit.js` | Build, test, a11y gate. |
| `assets/kotak-neo-logo.png` | The logo, from page 1 of the PDF. Inlined by default. |

`render.js` is the single source of truth. `template.html` is **generated**, so it
can never drift from what actually ships.

---

## The flow

**Today**
```
Research team (evening)  →  Jamun  →  09:00 cron  →  page updated with PDF link + name + price
```

**Target**
```
Research team  →  Jamun signal  →  bot on the Kotak server
                                    │
                                    ├─ 1. fetch PDF from S3
                                    ├─ 2. extract PAGE 1 → JSON (validate against schema.json)
                                    ├─ 3. render.js → HTML fragment
                                    └─ 4. POST/PUT to Strapi (JSON fields + HTML blob)
                                                            │
                                                            └─ website renders the block
```

No n8n, no Make.com, no external connectors. `render.js` has zero dependencies
and makes no network calls, so it runs anywhere Strapi runs.

---

## Strapi content-type mapping

Suggested collection type `research-report`:

| Strapi field | Type | Source |
|---|---|---|
| `reportId` | UID / Text | `reportId` — from the PDF filename prefix (`131440_1`) |
| `stockName` | Text | `stock.name` |
| `ticker` | Text | `stock.ticker` |
| `slug` | UID | `stock.slug` — joins the block to its page |
| `publishedAt` | Date | `publishedAt` |
| `reportType` | Enumeration | `report.type` |
| `period` | Text | `report.period` |
| `rating` | Enumeration | `recommendation.rating` — BUY/ADD/REDUCE/SELL/NR/SUBSCRIBE/RS/NA/NM |
| `cmp` | Decimal | `recommendation.cmp` |
| `fairValue` | Decimal (nullable) | `recommendation.fairValue` |
| `sourcePdf` | Text | `sourcePdf` |
| `payload` | JSON | the whole validated JSON document |
| `renderedHtml` | Rich text (long) | output of `render.js --inline-css` |

The typed columns drive listings, filtering, sorting and schema markup.
`renderedHtml` is what the page injects, so the frontend needs no components.
Keeping `payload` means any future template change can re-render historical
reports without re-parsing PDFs.

---

## Embedding

The block is scoped, so it drops into the existing page with no isolation tricks:

```html
<link rel="stylesheet" href="/assets/krb.css">   <!-- once, site-wide -->
...
<div v-html="report.renderedHtml"></div>          <!-- or dangerouslySetInnerHTML -->
```

Or skip the stylesheet link entirely and store the `--inline-css` output —
the fragment then carries its own styles.

**Theme.** The block follows the host page automatically. It reads, in order:

1. `data-krb-theme="dark|light"` on the block itself (hard override)
2. `[data-theme="dark"]` or `.dark` on any ancestor (your site's toggle)
3. `prefers-color-scheme` (the OS setting)

If kotakneo.com already sets a theme attribute with a different name, change the
selector list at the top of `krb.css` — it is one place.

**Font** is `inherit`, so the block picks up the site's brand typeface with no
external font requests.

---

## Design decisions

### The block reproduces the PDF. It does not interpret it.

This is the rule the whole template is built around: **every visible string on
the block comes from page 1 of the PDF or is one of its constant printed
labels.** Nothing is computed, inferred, reworded or added.

That means the block deliberately does *not* show:

| Not shown | Why |
|---|---|
| Potential upside % | Derived from CMP and fair value. The PDF never states it. |
| A rating-scale gauge plotting that % | The report's CMP-to-fair-value gap and its rating band **need not agree** — a SELL or BUY can carry a gap outside the band. Drawing them together would imply a relationship the report does not claim. |
| "as on \<date\>" beside CMP | The PDF prints `Current Market Price (CMP)` and nothing more. |
| "DCF-based target", "12-month perspective" | Sub-labels that were invented, not printed. |
| "Kotak PCG rating" | "Private Client Group" appears only in the page-2 headings (`Rating Scale`, `Research Team`). Page 1 never labels the rating that way. |
| A PDF download button | Removed by request. `sourcePdf` is still carried in the JSON for the bot's own records. |
| A repeated ticker chip | `(LENSKART)` is already in the title line. |

The glossary and attribution are stored **byte-for-byte** as the PDF prints
them — including `EPS-` with no space, the en dash before *Free Cash Flow*, and
the missing space in `).Readers`. Those are the document's own typography, and
silently correcting a published disclaimer is not the renderer's job.
`npm test` asserts this.

Which rating applies is shown by flagging that rating's row inside the verbatim
page-2 rating scale — the PDF's own words, with no return figure attached to
this report.

### Structure — page 1, in order

```
┌──────────────────────────────────────────────┐
│  kotak neo logo                Dated: <date> │
├──────────────────────────────────────────────┤
│      <Stock> (<TICKER>) - <RATING>           │
├──────────────────────────────────────────────┤
│                <Report type>                 │
├──────────────────────────┬───────────────────┤
│ Current Market Price(CMP)│  Fair Value (FV)  │
│         Rs.487           │      Rs.560       │
├──────────────────────────┴───────────────────┤
│  Rationale:  Positives:  Negatives:          │
│  (glossary line)                             │
├──────────────────────────────────────────────┤
│  Attribution · Holding Period: <n> months    │
├──────────────────────────────────────────────┤
│  ▸ Rating Scale  ▸ Research Team             │
│  ▸ Disclosure / Disclaimer                   │
└──────────────────────────────────────────────┘
```

### The logo

`assets/kotak-neo-logo.png` — lifted from page 1 of the source PDF, white
background removed so it sits on any surface. **Inlined as a base64 data URI by
default**, so the fragment Strapi stores has no external image dependency and
cannot break when the page moves. Pass `--logo-url=<URL>` (or `logoUrl` in
code) to reference a hosted copy instead.

Committed in-repo, so it is stable for future use:

```
assets/kotak-neo-logo.png
https://raw.githubusercontent.com/PradyXiii/research-report-html/<branch>/assets/kotak-neo-logo.png
```

In dark mode the logo gets a white plate — its `neo` wordmark is navy and would
otherwise disappear.

### Brand colour, honestly applied

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--krb-red` | `#fa1432` | `#fa1432` | Top rule, title, section rules, bullets |
| `--krb-red-ink` | `#e00f2b` | `#ff4d63` | Red **text below 18.66px** |
| `--krb-navy` | `#00005a` | `#00005a` | Report-type band, links, positive markers |

`#fa1432` on white measures **4.03:1** — compliant for large text (needs 3:1),
not for small (needs 4.5:1). Exact brand red carries the title, rules and
accents; `#e00f2b` (**4.92:1**) carries the price figures, accordion headings
and other small red text. Dark mode lifts those to `#ff4d63` (**5.59:1**).

### Responsive without viewport breakpoints

The block sits in a column whose width we do not control, so viewport media
queries would measure the wrong thing. Layout is intrinsic — `clamp()` type,
`auto-fit` grids — and the conditional refinements use **container** queries so
the block measures itself, with an `@supports` viewport fallback for pre-2023
engines. No horizontal overflow at 390 / 560 / 820 / 1024 / 1280 px.

The disclosures are the densest part on a phone, so they get explicit
treatment: `overflow-wrap: anywhere` (the disclaimer contains bare URLs that
would otherwise force a sideways scroll), a 1.68 line-height, and a container
query that stacks each rating code above its definition instead of squeezing
two columns into 320 px.

### The audit is a real gate

`tools/audit.js` runs headless Chromium in both themes with every accordion
open and fails the build on:

- any text node under WCAG AA — **including text over gradients**, checked
  against every colour stop, stopping the ancestor walk at the first opaque
  layer so it never measures a hidden background;
- layout collisions and horizontal overflow at five widths;
- skipped heading levels, or pointer targets under 24 px.

It is verified against a negative control (a deliberately low-contrast build),
so a passing run means something.

## Accessibility

- WCAG 2.1 AA contrast on every text node, light and dark — machine-verified.
- Semantic `<article>/<section>/<h2>/<h3>`, no skipped heading levels.
- Disclosures are native `<details>` — they work with JS disabled and are in the
  DOM (and therefore indexable and findable with ⌘F) even while collapsed.
- Pointer targets ≥ 24 px (WCAG 2.2 SC 2.5.8); buttons ≥ 44 px.
- Visible focus rings, `prefers-reduced-motion` respected.
- Print stylesheet expands all disclosures and drops interactive chrome.

---

## Notes for the bot

**Only page 1 needs parsing.** Pages 2–4 are identical on every report and live in
`src/boilerplate.js`. This removes most of the fragility from extraction.

Page 1 of the reference PDF extracts cleanly with PyMuPDF, but note the title,
CMP and FV sit in text boxes that extract **last**, not in visual order. Anchor on
labels (`Current Market Price (CMP)`, `Fair Value (FV)`, `Rationale:`,
`Positives:`, `Negatives:`), not on position.

The filename carries reliable metadata:
```
131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf
└─id──┘ └─── stock ────┘  └template┘ └period┘ └─ report type ─┘
```

**Validate before publishing.** `render.js` throws on a missing ticker, a bad date,
an unknown rating, or an empty section. Treat a throw as *do not publish, alert a
human* — a half-parsed research recommendation is worse than a stale one.

**All extracted text is treated as untrusted** and HTML-escaped; `javascript:` and
`data:` PDF URLs suppress the download button rather than rendering a dead link.
`npm test` covers these.

> If Jamun can hand over the stock name, rating, CMP, FV and date as structured
> fields, take them from there and parse only the narrative bullets. That removes
> the highest-risk part of extraction — the numbers.

---

## Adding other report types later

`sections[]` is deliberately generic: `{ title, tone, bullets[] | paragraphs[] }`.
A report with different prose sections needs **no** schema or renderer change.

Templates carrying financial tables or charts will need a `blocks[]` array
alongside `sections[]` plus matching renderers. `report.template` already exists
to select between them. The CSS tokens, theming, accordions and disclosure
boilerplate are all reusable as-is.
