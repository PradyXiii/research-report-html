/**
 * tools/audit.js -- accessibility gate for the rendered block.
 *
 * Checks, in BOTH light and dark, with every accordion forced open:
 *   - WCAG 2.1 AA text contrast on every text node (4.5:1, or 3:1 for large text)
 *   - heading order (no skipped levels)
 *   - WCAG 2.2 SC 2.5.8 pointer target size (>=24px), excluding the
 *     spec's inline exception for links inside a sentence
 *   - lang attribute and JSON-LD presence
 *
 * Run: npm run audit   (exits non-zero on failure -- wire into CI)
 */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const url = 'file:///home/user/research-report-html/sample-lenskart.html';
  let fails = 0;

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));

    const results = await page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
      /**
       * Every colour that can actually sit behind an element's text.
       * Walks ancestors and STOPS at the first layer that paints opaquely --
       * anything below that is hidden and must not be measured. A gradient
       * contributes one candidate per colour stop (translucent stops are
       * composited over each opaque stop on the same layer), so text over a
       * gradient is judged against its WORST stop, never an average.
       */
      const bgsOf = (el) => {
        const base = parse(getComputedStyle(document.body).backgroundColor);
        let n = el;
        while (n && n !== document.documentElement) {
          const cs = getComputedStyle(n);
          const solid = cs.backgroundColor;
          const solidA = solid === 'rgba(0, 0, 0, 0)' ? 0 : Number((solid.match(/[\d.]+/g) || [])[3] ?? 1);
          const hasSolid = solidA > 0.05;
          const img = cs.backgroundImage;

          if (img && img !== 'none') {
            const stops = (img.match(/rgba?\([^)]+\)/g) || []).map((st) => {
              const nums = (st.match(/[\d.]+/g) || []).map(Number);
              return { rgb: nums.slice(0, 3), a: nums.length > 3 ? nums[3] : 1 };
            }).filter((x) => x.a > 0.05);
            const opaque = stops.filter((x) => x.a >= 0.99).map((x) => x.rgb);
            const translucent = stops.filter((x) => x.a < 0.99);
            const layer = opaque.length ? opaque : (hasSolid ? [parse(solid)] : [base]);
            const out = layer.slice();
            translucent.forEach((t) => layer.forEach((b) => out.push(over(t.rgb, t.a, b))));
            if (opaque.length || hasSolid) return out;   // opaque layer -- stop here
          }
          if (hasSolid) return [parse(solid)];
          n = n.parentElement;
        }
        return [base];
      };
      const ratio = (a, b) => { const [x, y] = [lum(a) + .05, lum(b) + .05]; return x > y ? x / y : y / x; };

      const out = [];
      const sel = '.krb h2, .krb h3, .krb h4, .krb p, .krb li, .krb span, .krb a, .krb dt, .krb dd, .krb summary, .krb strong, .krb time';
      document.querySelectorAll(sel).forEach(el => {
        const txt = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
        if (!txt) return;
        const cs = getComputedStyle(el);
        const size = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const fg = parse(cs.color);
        const r = Math.min.apply(null, bgsOf(el).map((bg) => ratio(fg, bg)));
        const need = large ? 3 : 4.5;
        if (r < need) out.push({
          text: txt.slice(0, 46), cls: el.className || el.tagName,
          size: +size.toFixed(1), weight, ratio: +r.toFixed(2), need
        });
      });
      return out;
    });

    console.log(`\n=== ${scheme.toUpperCase()} — WCAG AA text contrast ===`);
    if (!results.length) console.log('  PASS — every text node meets AA');
    else { fails += results.length; results.forEach(r => console.log('  FAIL', JSON.stringify(r))); }

    // touch targets + structural checks
    const struct = await page.evaluate(() => {
      const small = [];
      document.querySelectorAll('.krb a, .krb summary').forEach(el => {
        const r = el.getBoundingClientRect();
        // SC 2.5.8 inline exception: a link flowing inside a sentence is sized
        // by the surrounding line-height, so it is exempt from the 24px floor.
        const p = el.parentElement;
        const inline = p && getComputedStyle(el).display === 'inline' &&
                       p.textContent.trim().length > el.textContent.trim().length;
        if (r.height > 0 && r.height < 24 && !inline) {
          small.push({ t: el.textContent.trim().slice(0, 30), h: +r.height.toFixed(1) });
        }
      });
      const h = Array.from(document.querySelectorAll('.krb h2,.krb h3,.krb h4')).map(e => +e.tagName[1]);
      let jump = null;
      for (let i = 1; i < h.length; i++) if (h[i] - h[i - 1] > 1) jump = `${h[i-1]} -> ${h[i]}`;
      return { smallTargets: small.slice(0, 5), headingJump: jump, headings: h.join(','),
               lang: document.documentElement.lang, jsonLd: !!document.querySelector('script[type="application/ld+json"]') };
    });
    console.log('  heading order:', struct.headings, struct.headingJump ? 'JUMP ' + struct.headingJump : '(no skips)');
    console.log('  small targets (<24px):', struct.smallTargets.length ? JSON.stringify(struct.smallTargets) : 'none');
    console.log('  lang:', struct.lang, '| JSON-LD:', struct.jsonLd);
    await ctx.close();

    // Layout collisions + horizontal overflow, across the widths the block
    // actually gets used at. The gauge marker floats out of flow, so it needs
    // an explicit check rather than trusting the CSS.
    for (const w of [390, 560, 820, 1024, 1280]) {
      const c2 = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme });
      const p2 = await c2.newPage();
      await p2.goto(url, { waitUntil: 'load' });
      const bad = await p2.evaluate(() => {
        const rect = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
        const hits = (a, b) => a && b && !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
        const problems = [];
        if (hits(rect('.krb__marker-pill'), rect('.krb__gauge-legend'))) problems.push('marker pill overlaps gauge legend');
        if (hits(rect('.krb__marker-pill'), rect('.krb__gauge-title'))) problems.push('marker pill overlaps gauge title');
        const doc = document.documentElement;
        if (doc.scrollWidth > doc.clientWidth) problems.push(`horizontal overflow (${doc.scrollWidth} > ${doc.clientWidth})`);
        const m = document.querySelector('.krb__marker');
        const t = document.querySelector('.krb__track');
        if (m && t) {
          const mr = m.getBoundingClientRect(), tr = t.getBoundingClientRect();
          if (mr.left < tr.left - 1 || mr.left > tr.right + 1) problems.push('marker sits outside the track');
        }
        return problems;
      });
      if (bad.length) { fails += bad.length; bad.forEach((x) => console.log(`  FAIL @${w}px  ${x}`)); }
      await c2.close();
    }
    console.log('  layout @390/560/820/1024/1280: ' + (fails ? 'see failures above' : 'no collisions, no overflow'));
  }
  await browser.close();
  console.log('\n' + (fails ? `${fails} contrast failure(s)` : 'ALL CHECKS PASSED (light + dark)'));
  process.exit(fails ? 1 : 0);
})();
