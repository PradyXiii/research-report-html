# `bot/` — Jamun PDF → schema.json → HTML block → CMS

Node-only. One runtime dependency (`pdfjs-dist`, pure JavaScript). No Python, no
native modules, no SDKs, no external automation service.

Deployment, trigger choice and the Strapi content type are in
[`../INTEGRATION.md`](../INTEGRATION.md). This file is how to run it on a laptop.

---

## Install

```bash
cd bot
npm ci --omit=optional      # --omit=optional skips @napi-rs/canvas, a NATIVE
                            # module pdf.js only needs for *rendering* pages
npm test                    # 81 tests (79 offline, 2 need a real PDF), ~1s
```

Node **18.17+** (global `fetch`, `AbortSignal.timeout`, `node:test`). Checked at
boot with an actionable message rather than a `fetch is not defined` stack.

---

## Run

The default is a **dry run**: it extracts, validates, renders and prints, and
writes nothing anywhere.

```bash
# a local PDF, no network at all
node run.js --dry-run --file ./131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf

# straight from S3 over https, no credentials needed
node run.js --dry-run --url https://ks-oncloudpublic-reports.s3.ap-south-1.amazonaws.com/jaamoon-pdf-files/131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf

# also drop the JSON and the rendered HTML somewhere to look at
node run.js --dry-run --file report.pdf --out ./tmp
```

Check the environment before trusting anything:

```bash
node run.js --doctor
node run.js --print-config     # resolved config, secrets masked
node run.js --help
```

Publish for real (needs `STRAPI_URL` and `STRAPI_API_TOKEN`):

```bash
node run.js --shadow --file report.pdf    # writes with publishState=shadow
node run.js --live   --file report.pdf    # writes with publishState=live
```

### Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | published, unchanged, or a clean dry run | nothing |
| 1 | unexpected internal error | read the stack; it is a bug |
| 2 | **refused to publish** — extraction or validation failed | a human reads the dead-letter record |
| 3 | publish failed after retries | retryable; check the CMS |
| 4 | configuration or environment unusable | fix the named variable |
| 5 | another instance holds the lock | usually benign |

**2 and 3 are different on purpose.** 2 means we do not trust the content — a
person must look at the PDF. 3 means the content was fine and the CMS was not —
running again is safe.

---

## Filenames matter

Almost all metadata comes from the filename, which is the most reliable source
available:

```
131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf
└─ id ─┘ └───── stock ─────┘  └template┘└period┘└── type ───┘
```

Renaming the file loses `reportId`, and without `reportId` the bot **refuses to
publish** — there would be no key to de-duplicate on, so a re-run would create a
second entry. This is why copying the PDF to `report.pdf` and running the bot
gives exit code 2. Override the convention with `FILENAME_PATTERN`.

---

## Layout

```
run.js         entry point: config -> source -> pipeline -> publisher, exit code
config.js      every environment-specific value, validated at boot
pipeline.js    the one code path: fetch -> extract -> validate -> render -> publish
extract.js     page 1 -> schema.json. Pure, dependency-free, label-anchored
pdftext.js     the ONLY file that touches pdfjs-dist. Buffer -> lines[]
strapi.js      Strapi REST client: v4/v5 adapter, upsert, retries
sources/       http · s3 · file · dir      "where the PDF comes from"
publishers/    strapi · http · file · console   "where the output goes"
triggers/      once · webhook · poll · watch    "what starts a run"
lib/           logger · http (retry/backoff) · sigv4 · filename
deploy/        systemd units, cron, logrotate, an optional Dockerfile
test/          node:test; fixtures captured from the real PDF
```

`sources`, `publishers` and `triggers` are registries. A store or CMS we have
not met is a new file plus one line, not a rewrite:

```js
require('./publishers').registerPublisher('mycms', { create: (cfg, deps) => ({ ... }) });
```

---

## How the extractor stays honest

Page 1 of a Jamun one-pager is adversarial in three specific ways, and each has
a countermeasure:

1. **The headline, CMP and Fair Value extract *last*.** They are in text boxes,
   so they come after the body in the content stream. Nothing here uses ordinal
   position; every field is anchored on its printed label.

2. **CMP and Fair Value sit side by side at the same height.** A "value on the
   next line" rule binds Fair Value to the CMP figure. Each label instead claims
   the value directly *beneath it* and horizontally centred on it, with the
   next-line rule kept only as a fallback when there is no geometry.

3. **The real PDF carries invisible leftover template text — `") - SELL"`.**
   PyMuPDF hides it; pdf.js does not. So a headline must match
   `Name (TICKER) - RATING` in full, and the name must agree with the filename.
   Anything rating-shaped that was ignored is reported as a warning.

On top of that the extractor **never guesses a number**. A missing label, two
labels, or one label with two candidate values is an error and nothing is
published. It also cross-checks the computed upside against the PCG rating
bands (`(FV−CMP)/CMP = +15.0%` must land in the ADD band), which is the cheapest
detector of a transposed or misread figure.

Diagnostics come back as data, never as an exception:

```js
{ ok, report, errors:[{code, field, message}], warnings:[...], notes:[...], evidence:{...} }
```

`ok:false` means **do not publish**. `evidence` records which line each field
came from, so a disputed number can be traced back to the PDF.

---

## Testing

```bash
npm test                                       # 81 tests; 79 run, 2 skipped
BOT_TEST_PDF=/path/to/reference.pdf npm test   # all 81, incl. real PDF -> publish
```

The fixture in `test/fixtures/lenskart-page1.lines.json` is the genuine line
list from the reference PDF, so the parser is tested against what a real report
actually produces. Failure modes are made by mutating one line — which is
exactly how a bad report will differ from a good one. See
`test/fixtures/README.md` before regenerating it.

`test/pipeline.test.js` runs the extractor through the real `../src/render.js`,
so a drift between the extractor and the schema contract fails here rather than
in production.

---

## Configuration

Everything is an environment variable with a working default. See
[`.env.example`](.env.example) — it is the complete list, annotated. Nothing
about the deployment target is compiled in:

| Unknown | Variable | Default |
|---|---|---|
| What starts a run | `TRIGGER_MODE` | `once` (any scheduler can drive it) |
| Where the PDF is | `SOURCE_TYPE` | `http` |
| Where output goes | `PUBLISHER_TYPE` | `strapi` |
| Strapi major version | `STRAPI_API_VERSION` | `auto` (probes the API) |
| Strapi field names | `STRAPI_FIELD_MAP` | matches `../README.md` |
| Auth scheme / headers | `STRAPI_AUTH_SCHEME`, `STRAPI_EXTRA_HEADERS` | `Bearer` |
| Filename convention | `FILENAME_PATTERN` | the Jamun convention |
| Section headings | `SECTION_MAP` | Rationale / Positives / Negatives |
| How live to be | `BOT_MODE` | `dry-run` |

Config is validated once, at boot, and reports **every** problem at once with
the variable name and an example value.

## Secrets

Never on the command line (`ps` shows it) and never in the repository. Put them
in an `EnvironmentFile` owned by root, mode `0640`, group-readable by the
service user. `--print-config` and every log line mask them; URLs are logged
with the query string stripped.
