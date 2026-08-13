# Test fixtures

`lenskart-page1.lines.json` is the **real** output of `pdftext.js` for page 1 of

```
131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf
```

captured on 2026-08-13 from
`https://ks-oncloudpublic-reports.s3.ap-south-1.amazonaws.com/jaamoon-pdf-files/`.

The PDF itself is not committed: it is a 330 KB binary owned by the research
team, and the line list is what the parser actually consumes. Working from the
line list keeps the suite offline, fast and free of `pdfjs-dist`, and lets each
failure mode be produced by mutating a single line.

Two details in this fixture are load-bearing and must not be "tidied up":

- **Line 38 is `") - SELL"`** — invisible leftover template text sitting under a
  graphic on page 1 of the real report. PyMuPDF drops it; pdf.js does not. It is
  the reason the extractor requires a full `Name (TICKER) - RATING` headline and
  cross-checks the name against the filename.
- **The headline, CMP and Fair Value are lines 33–37, i.e. last.** They are in
  text boxes, so they extract after the body. Any parser that trusts reading
  order gets this report wrong.

## Regenerating

```bash
node -e "
  const {extractLines} = require('./pdftext');
  const fs = require('fs');
  extractLines(fs.readFileSync(process.argv[1]), {pages:[1]}).then(r =>
    fs.writeFileSync('test/fixtures/lenskart-page1.lines.json',
      JSON.stringify(r.pages[0].lines, null, 2) + '\n'));
" /path/to/131440_1_Lenskart_Solutions__One_Pager_Q4FY26_Result_Update.pdf
```

Regenerate only when the PDF template changes, and read the diff: a change here
is a change in what the research team is publishing.
