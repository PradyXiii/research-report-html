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

Then open **`preview.html`** — it has light/dark/system switches and
desktop/tablet/phone width presets, for sign-off without a device lab.

Render a single report:

```bash
node src/render.js data/lenskart-2026-05-21.json                 # HTML fragment
node src/render.js data/lenskart-2026-05-21.json --inline-css    # self-contained fragment
node src/render.js data/lenskart-2026-05-21.json --standalone    # full HTML page
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
| `preview.html` | Reviewer tool with theme + viewport switches. |
| `INTEGRATION.md` · `bot/` | The PDF → Strapi bot (see that doc). |
| `tools/build.js` · `tools/test.js` · `tools/audit.js` | Build, test, a11y gate. |

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

### Layout

```
┌─────────────────────────────────────────────┐
│  HERO   red → navy gradient, dark in BOTH   │  chips · company · ticker
│         themes. Rating medallion, right.    │  rating + what it means
├─────────────────────────────────────────────┤
│  KPI    CMP  │  FAIR VALUE  │  UPSIDE       │  oversized figures
├─────────────────────────────────────────────┤
│  GAUGE  SELL │ REDUCE │ ADD │ BUY  ▲+15.0%  │  why it's an ADD
├─────────────────────────────────────────────┤
│  THESIS  Rationale (full width)             │
│  ┌────────────────┬────────────────┐        │
│  │  Positives     │  Negatives     │        │  bull / bear pair
│  └────────────────┴────────────────┘        │
├─────────────────────────────────────────────┤
│  Abbreviations · PDF · attribution          │
│  ▸ Rating scale  ▸ Team  ▸ Disclosures      │  native <details>
└─────────────────────────────────────────────┘
```

**The gauge is the point.** It plots the computed upside on the PCG rating scale
from page 2, so a reader sees *why* the call is an ADD rather than taking it on
faith. It is omitted when there is no fair value (NR/RS) or the rating is
non-directional (SUBSCRIBE/NA/NM), clamps an off-scale upside to the track end,
and says so rather than hiding it.

### Brand colour, honestly applied

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--krb-red` | `#fa1432` | `#fa1432` | Hero, active gauge band, bullets, accents |
| `--krb-red-ink` | `#e00f2b` | `#ff4d63` | Red **text below 18.66px** |
| `--krb-red-deep` | `#e00f2b` | `#e00f2b` | White-on-red: rating value, PDF button |
| `--krb-navy` | `#00005a` | `#00005a` | Hero ramp end, links, positive markers |
| `--krb-text-faint` | `#6b7280` | `#949bab` | KPI labels, tick marks |

**Why red has three shades.** `#fa1432` on white measures **4.03:1** — compliant
for large text (needs 3:1), not for small (needs 4.5:1). Exact brand red carries
the hero, the active band and the accents; a one-shade-deeper `#e00f2b`
(**4.92:1**) carries small red text and white-on-red. Dark mode lifts small red
text to `#ff4d63` (**5.59:1**). Indistinguishable side by side; the compliance
difference is not.

The hero is **dark in both themes** — it reads as brand, not as chrome, and it
means the most striking part of the block looks identical to every user.

### Responsive without viewport breakpoints

The block sits in a column whose width we do not control, so viewport media
queries would measure the wrong thing. Layout is intrinsic — `clamp()` type,
`auto-fit` grids — and the three refinements that *are* conditional use
**container** queries, so the block measures itself. Verified with no horizontal
overflow and no layout collisions at 390 / 560 / 820 / 1024 / 1280 px.

### The audit is a real gate

`tools/audit.js` runs headless Chromium in both themes with every accordion open
and fails the build on:

- any text node under WCAG AA — **including text over gradients**, which it
  checks against every colour stop rather than an average, stopping the ancestor
  walk at the first opaque layer so it never measures a hidden background;
- the floating gauge marker colliding with the legend or title, at five widths;
- horizontal overflow, skipped heading levels, or pointer targets under 24 px.

It is verified against a negative control (a deliberately low-contrast build) so
a passing run means something.

### Report CMP vs the live ticker

The report's CMP is a snapshot from the report date and will disagree with the
live price on the page. It is always rendered as **"Rs.487 · as on 21 May 2026"**
so the two can never look like a contradiction.

### Potential upside

Computed, never parsed: `(fairValue − cmp) / cmp`. For Lenskart that is **+15.0%**,
consistent with the ADD band (5–15%) on page 2. The tile disappears when there is
no fair value (NR / RS reports).

---

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
