# Publishing process

This block is published without a human reader and stays up unread for months.
The failure that matters is not a broken page — someone notices those. It is a
**figure that is wrong but looks right**. Nobody notices until it matters, and
by then it has been quoted.

Everything below exists to make that specific failure impossible to ship.

## The rule

> **Nothing publishes that cannot be traced back to the source document.**

Not "nothing obviously wrong". Nothing *unverified*. A check that cannot be
evaluated is a failure, never a pass. Silence is not consent.

---

## The order

The stages run in this order and the order is enforced in `bot/pipeline.js`,
not left to whoever is running it. A later stage cannot execute until the
earlier one has passed.

```
1  IDENTIFY   which format is this?          bot/detect.js
2  EXTRACT    read the fields from the PDF   bot/extract.js, extract-formats.js
3  VALIDATE   does it fit the contract?      src/render.js validate()
4  RENDER     build the HTML                 src/render.js renderBlock()
5  VERIFY     reconcile HTML <-> PDF         bot/verify.js          <-- THE GATE
6  REVIEW     look at it                     tools/audit.js
7  PUBLISH    write to Strapi                bot/publishers/strapi.js
```

**Any stage failing stops the run.** The bot does not publish a partial result,
does not fall back to a previous version, and does not retry with looser rules.
It records why and raises an alert.

---

## 1. Identify

`detectFormat()` matches page 1 against the structural labels each format
prints. Four formats are known:

| Format | Recognised by | Parser |
|---|---|---|
| PCG one-pager | `Rationale:` + `Current Market Price (CMP)` | yes |
| Pick of the Week | `Why Invest?` + `Time Period:` | yes |
| Stock Recommendations | `Stock Recommendations` + `Name of the Company` | yes |
| KIE full report | `Sector View:` + `NIFTY-50:` | **no — refused** |

An unrecognised PDF returns `unknown` and is **refused**. A recognised format
with no parser is also **refused**. Both are correct: rendering a document with
another format's rules does not error, it produces confident nonsense.

> **Adding a format:** add its signals to `detect.js`, add a parser, add it to
> `EXTRACTABLE`, add a real PDF to the corpus, and add its round-trip test.
> All five. A format in `IMPLEMENTED` but not `EXTRACTABLE` is refused by
> design — that is the honest state while a parser is being written.

## 2. Extract

Parsers anchor on **printed labels**, never on line or page position. Wording
changes weekly; labels do not. Every parser returns the same shape, so nothing
downstream needs to know which format it was.

A parser **refuses rather than guesses**. If a mandatory field is unreadable it
returns an error. There is no default price, no assumed rating, no inferred date.

## 3. Validate

`validate()` throws on a missing ticker, a bad date, a rating outside the PCG
scale, or an empty section. **A throw means: do not publish, alert a human.**

## 4. Render

`renderBlock()` picks the template from `data.format`. All extracted text is
HTML-escaped: PDF text is untrusted input.

## 5. Verify — the gate

`bot/verify.js`. This is the stage that exists because of the opening
paragraph. It checks in **both directions**:

**A. Data ← PDF.** Everything we are about to publish must be findable in the
document.
- every figure appears in the PDF text
- every sentence appears in the PDF text
- the rating appears **on page 1** (pages 2+ list the whole scale, so searching
  the whole document would match anything)
- bullet count is consistent with the bullet glyphs on page 1

**B. HTML ← Data.** Everything extracted must survive into the output, and the
output must invent nothing.
- every extracted figure and sentence is present in the rendered HTML
- no unfilled placeholder, `undefined`, `NaN`, `null`
- no `<script>` and no inline event handler
- tags balance, so the block cannot swallow the host page
- the report date is legible to a reader

**Warnings are not failures, but they are surfaced.** The one that matters
most: `MULTIPLE_RATINGS_IN_SOURCE`. Page 1 of a real Lenskart PDF carries an
invisible `") - SELL"` at title size, hidden behind the type band — leftover
template text. A naive parser publishes **SELL for an ADD report**. The gate
cannot resolve that automatically, so it tells a human.

Exemptions from the source check are deliberate and narrow, each justified in
the code:
- **dates** are reformatted on purpose, so they are checked for legibility
  instead of literal match
- **`report.type`** is our classification, not a quotation; the detector's own
  tests prove it
- **the Pick of the Week verdict** is completed from the fair value, because the
  figure finishing the printed sentence is drawn inside a graphic. Both halves
  are verified separately
- **the filename** counts as source: Jamun encodes the period and type there

> Every new exemption needs a comment saying why, and a test. Exemptions are
> how a gate quietly becomes decoration.

## 6. Review

`npm run audit` — headless Chromium, both themes, all accordions open:
WCAG AA contrast on every text node (including text over gradients), layout
collisions, horizontal overflow at 390 / 560 / 820 / 1024 / 1280 px, heading
order, pointer target sizes.

The audit is checked against a **negative control** — a deliberately
low-contrast build — so a pass means something rather than the checker having
gone blind.

## 7. Publish

Strapi, keyed on `reportId`, idempotent: a re-run updates, never duplicates.
Version detection (v4/v5) happens at boot.

Roll out in order: `--dry-run` → `--shadow` → `--live`. Shadow writes the entry
with `publishState=shadow` so the site can ignore it while a human compares.

---

## If something goes wrong after publishing

1. **Do not hand-edit the published HTML.** The next run overwrites it and the
   error returns. Fix the parser or the template, then re-run.
2. **Reproduce first:** `node bot/run.js --file <pdf> --dry-run --out /tmp/x.html`.
3. **Write the failing test before the fix.** If the gate did not catch it, the
   gate has a hole — that hole is the bug, not just the symptom.
4. Re-run the whole corpus. A fix for one format must not break another.

## Before any change ships

```
npm test                 # 42 — renderer contract, escaping, all four templates
cd bot && npm test       # 95 — extraction, publishing, and the gate itself
npm run audit            # accessibility and layout, both themes
npm run build            # regenerate every sample
```

All four green, or it does not ship.

## What the gate does not cover

Stated plainly, because a checklist that overstates its coverage is worse than
none:

- **It cannot tell whether the analyst was right.** It checks fidelity to the
  document, not the quality of the call.
- **It cannot read a figure trapped in an image.** The Pick of the Week verdict
  needed a targeted rule for exactly this. If a future format puts a price in a
  chart, the gate will not see it — and it will not know it is missing.
- **It does not verify the boilerplate** on pages 2–4, which is injected from
  `src/boilerplate.js`. Re-check that against a fresh PDF whenever Compliance
  updates the disclaimer or the research team changes.
- **The KIE report is refused, not solved.** Its cover is two-column and pdf.js
  yields words rather than blocks, so baseline clustering splices a left-column
  sentence into a right-column table. It needs block-level geometry
  (PyMuPDF, server-side). The template renders correctly from good data.
