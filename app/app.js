<script>
/* ==========================================================================
   Kotak Research Report Converter — UI driver.

   This file contains NO extraction and NO rendering logic. Everything that
   decides what a report says or what its HTML looks like lives in
   bot/extract.js and src/render.js, bundled into window.KRB by tools/
   build-app.js. The browser therefore runs the same code the server bot runs,
   which is the only reason the two can be trusted not to drift.

   The two calls that matter, and their exact server counterparts:
     KRB.extract.extractFromPdf(bytes, opts)        <- bot/pipeline.js
     KRB.render.renderBlock(report, {inlineCss:true}) <- bot/pipeline.js
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KRB = window.KRB;
  var BUILD = window.__KRB_BUILD__ || {};

  /* -------------------------------------------------------------- state */

  var current = null;   // { report, block, page, json, name }
  var busyNow = false;

  /* --------------------------------------------------------------- boot */

  function boot() {
    if (!KRB || !KRB.extract || !KRB.render) {
      return fatal(new Error(
        'converter.html is incomplete: window.KRB was never defined. ' +
        'The bundled extractor/renderer failed to evaluate.'
      ));
    }
    try {
      KRB.selfTest();
    } catch (err) {
      return fatal(err);
    }

    var pdfv = (window.pdfjsLib && window.pdfjsLib.version) || 'unknown';
    $('engine').textContent = 'pdf.js ' + pdfv + ' · offline · nothing is uploaded';
    $('foot-line').textContent =
      'converter.html · built ' + (BUILD.builtAt || '?') +
      ' · pdf.js ' + pdfv +
      ' · extractor + renderer bundled verbatim from bot/extract.js and src/render.js';

    wireTheme();
    wireInput();
    wireActions();
  }

  /* -------------------------------------------------------------- theme */

  function wireTheme() {
    var btns = [].slice.call(document.querySelectorAll('[data-theme-set]'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-theme-set');
        document.documentElement.setAttribute('data-app-theme', v);
        btns.forEach(function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        if (current) paintPreview();
      });
    });
  }

  function themeOpt() {
    var t = document.documentElement.getAttribute('data-app-theme');
    return (t === 'light' || t === 'dark') ? t : null;
  }

  /* -------------------------------------------------------------- input */

  function wireInput() {
    var drop = $('drop');
    var input = $('file');

    $('pick').addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) handle(input.files[0]);
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      window.addEventListener(ev, function (e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        drop.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      window.addEventListener(ev, function (e) {
        if (e.relatedTarget && ev === 'dragleave') return;
        drop.classList.remove('is-over');
      });
    });
    window.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      drop.classList.remove('is-over');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handle(f);
    });

    document.addEventListener('paste', function (e) {
      if (!e.clipboardData) return;
      var files = e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); handle(files[0]); return; }
      var items = e.clipboardData.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); handle(f); return; }
        }
      }
    });

    $('again').addEventListener('click', function () {
      $('result').hidden = true;
      $('fatal').hidden = true;
      current = null;
      $('drop').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types) for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }

  /* ------------------------------------------------------------ pipeline */

  // Let the browser paint before we hand the main thread to pdf.js, which
  // parses synchronously enough to freeze the tab otherwise.
  function paint() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { setTimeout(r, 0); });
    });
  }

  function stage(text) { $('busy-stage').textContent = text; return paint(); }

  async function handle(file) {
    if (busyNow) return;
    busyNow = true;
    current = null;
    $('result').hidden = true;
    $('fatal').hidden = true;
    $('busy').hidden = false;
    $('busy-file').textContent = file.name + ' · ' + bytes(file.size);
    $('busy-stage').textContent = 'Reading file…';

    try {
      await paint();
      var buf = await file.arrayBuffer();
      var data = new Uint8Array(buf);

      await stage('Parsing PDF and extracting fields…');
      // The exact option set bot/config.js hands the server bot: every other
      // value comes from extract.js's own DEFAULTS, which config.js mirrors.
      // maxPdfBytes MUST be passed -- extract.js has no default for it, and an
      // undefined limit disables the size guard entirely.
      var res = await KRB.extract.extractFromPdf(data, {
        filename: file.name,
        maxPdfBytes: KRB.DEFAULT_MAX_BYTES
      });

      if (!res.ok) {
        await stage('Collecting diagnostics…');
        var advice = await explain(data, res);
        showFailure(file, res, advice);
      } else {
        await stage('Rendering block…');
        showSuccess(file, res);
      }
    } catch (err) {
      fatal(err);
    } finally {
      $('busy').hidden = true;
      busyNow = false;
    }
  }

  /**
   * Failure path only. Re-reads page 1 purely to say WHICH Kotak format the
   * PDF looks like, so a refusal names the actual problem instead of leaving
   * the user guessing. Never runs on success, so it cannot influence output.
   */
  async function explain(data, res) {
    var unreadable = (res.errors || []).some(function (e) { return e.code === 'PDF_UNREADABLE'; });
    if (unreadable) return null;
    try {
      var doc = await KRB.pdftext.extractLines(data, { pages: [1], maxBytes: KRB.DEFAULT_MAX_BYTES });
      var page1 = (doc.pages[0] || { lines: [] }).lines.map(function (l) { return l.text; }).join('\n');
      return KRB.detect.detectFormat(page1, { pageCount: doc.pageCount });
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ outcomes */

  function showSuccess(file, res) {
    var report = res.report;

    // These two calls are the deliverable. They are byte-for-byte the calls
    // bot/pipeline.js makes, with no theme and no extra options, so what this
    // page hands you is what the bot would have published.
    var block = KRB.render.renderBlock(report, { inlineCss: true });
    var page = KRB.render.renderStandalone(report);
    var json = JSON.stringify(report, null, 2);

    current = { report: report, block: block, page: page, json: json, name: stem(report, file) };

    verdict('ok', '✓', 'Extracted and rendered',
      describe(report) + ' · ' + (res.warnings.length || 'no') +
      ' warning' + (res.warnings.length === 1 ? '' : 's') + ' to read before publishing.');

    diagnostics(res);
    $('errors').hidden = true;
    $('advice').hidden = true;
    $('acts').hidden = false;
    $('preview').hidden = false;
    $('fold-json').hidden = false;
    $('fold-ev').hidden = false;
    $('fold-block').hidden = false;

    $('acts-note').textContent =
      'Copy HTML gives the fragment the bot publishes to Strapi: renderBlock(report, { inlineCss: true }), ' +
      block.length.toLocaleString('en-IN') + ' characters, stylesheet included. ' +
      'Download HTML gives the standalone QA page. The preview theme control above does not affect either file.';

    $('json-meta').textContent = json.length.toLocaleString('en-IN') + ' chars · schema ' + (report.schemaVersion || '?');
    $('json-out').textContent = json;
    $('block-meta').textContent = block.length.toLocaleString('en-IN') + ' chars · inline CSS';
    $('block-out').textContent = block;
    evidence(res.evidence);

    paintPreview();
    reveal();
  }

  function showFailure(file, res, advice) {
    // Nothing renders, nothing downloads. A partial parse of a research
    // recommendation is a defect, not a draft.
    current = null;

    verdict('bad', '✕', 'Refused — nothing to publish',
      res.errors.length + ' error' + (res.errors.length === 1 ? '' : 's') +
      ' in ' + file.name + '. The extractor never guesses a number, so it stopped.');

    $('errors').hidden = false;
    $('errors-n').textContent = String(res.errors.length);
    fill($('errors-list'), res.errors, true);

    diagnostics(res);
    $('acts').hidden = true;
    $('preview').hidden = true;
    $('fold-block').hidden = true;
    $('fold-json').hidden = !res.report;
    if (res.report) {
      var j = JSON.stringify(res.report, null, 2);
      $('json-meta').textContent = 'partial — not publishable';
      $('json-out').textContent = j;
    }
    $('fold-ev').hidden = !res.evidence;
    evidence(res.evidence);

    if (advice) {
      $('advice').hidden = false;
      $('advice-body').innerHTML = '';
      var p = document.createElement('p');
      p.className = 'advice__t';
      if (advice.id === 'unknown') {
        p.appendChild(text(advice.reason || 'No known Kotak research format matched page 1.'));
      } else {
        p.appendChild(text('Page 1 matches '));
        p.appendChild(bold(advice.label));
        p.appendChild(text(' (confidence ' + advice.confidence + '). '));
        p.appendChild(text(advice.implemented
          ? 'That format is supported, so the errors above are about this particular file, not the template.'
          : (advice.reason || 'No renderer exists for that format yet.')));
      }
      $('advice-body').appendChild(p);
    } else {
      $('advice').hidden = true;
    }

    reveal();
  }

  function diagnostics(res) {
    var w = res.warnings || [], n = res.notes || [];
    $('warnings').hidden = !w.length;
    $('warnings-n').textContent = String(w.length);
    fill($('warnings-list'), w, true);
    $('notes').hidden = !n.length;
    $('notes-n').textContent = String(n.length);
    fill($('notes-list'), n.map(function (t) { return { message: t }; }), false);
  }

  function fill(ul, items, showCode) {
    ul.innerHTML = '';
    items.forEach(function (d) {
      var li = document.createElement('li');
      if (showCode && (d.code || d.field)) {
        var top = document.createElement('div');
        top.className = 'diag__top';
        if (d.code) {
          var c = document.createElement('span');
          c.className = 'diag__code';
          c.textContent = d.code;
          top.appendChild(c);
        }
        if (d.field) {
          var f = document.createElement('span');
          f.className = 'diag__field';
          f.textContent = d.field;
          top.appendChild(f);
        }
        li.appendChild(top);
      }
      var m = document.createElement('div');
      m.className = 'diag__msg';
      m.textContent = d.message;   // verbatim, textContent so it cannot inject
      li.appendChild(m);
      ul.appendChild(li);
    });
  }

  function evidence(ev) {
    var host = $('ev-out');
    host.innerHTML = '';
    if (!ev) { $('fold-ev').hidden = true; return; }
    var box = document.createElement('div');
    box.className = 'ev';
    var rows = [
      ['filename', ev.filename],
      ['title line', ev.title],
      ['date line', ev.dateLine],
      ['CMP', ev.cmp && (ev.cmp.raw + '  (matched ' + ev.cmp.via + ', line ' + ev.cmp.line + ')')],
      ['fair value', ev.fairValue && (ev.fairValue.raw + '  (matched ' + ev.fairValue.via + ', line ' + ev.fairValue.line + ')')],
      ['sections', ev.sections && ev.sections.map(function (s) { return s.id + ' ×' + s.bullets; }).join(', ')],
      ['lines by role', ev.roleCounts && Object.keys(ev.roleCounts).sort().map(function (k) { return k + ' ×' + ev.roleCounts[k]; }).join(', ')],
      ['ignored lines', ev.ignoredLines && ev.ignoredLines.length ? ev.ignoredLines.join('  |  ') : null]
    ];
    rows.forEach(function (r) {
      if (r[1] === null || r[1] === undefined || r[1] === '') return;
      var row = document.createElement('div');
      row.className = 'ev__row';
      var k = document.createElement('span'); k.className = 'ev__k'; k.textContent = r[0];
      var v = document.createElement('span'); v.className = 'ev__v'; v.textContent = String(r[1]);
      row.appendChild(k); row.appendChild(v);
      box.appendChild(row);
    });
    host.appendChild(box);
  }

  function verdict(state, badge, head, sub) {
    var v = $('verdict');
    v.setAttribute('data-state', state);
    $('verdict-badge').textContent = badge;
    $('verdict-h').textContent = head;
    $('verdict-p').textContent = sub;
  }

  function reveal() {
    $('result').hidden = false;
    $('verdict').focus();
    $('verdict').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ------------------------------------------------------------- preview */

  function paintPreview() {
    if (!current) return;
    var t = themeOpt();
    // Preview only. The downloadable files are always rendered without a
    // pinned theme so they follow whatever page finally hosts them.
    var html = t ? KRB.render.renderStandalone(current.report, { theme: t }) : current.page;
    var frame = $('frame');
    frame.srcdoc = html;
    frame.onload = function () {
      try {
        var d = frame.contentDocument;
        if (d && d.body) {
          var h = Math.max(d.body.scrollHeight, d.documentElement.scrollHeight);
          if (h > 200) frame.style.height = Math.min(h + 24, 20000) + 'px';
        }
      } catch (e) { /* opaque origin: keep the CSS fallback height */ }
    };
  }

  /* ------------------------------------------------------------- actions */

  function wireActions() {
    $('dl-html').addEventListener('click', function () {
      if (!current) return;
      save(current.page, current.name + '.html', 'text/html;charset=utf-8');
    });
    $('dl-json').addEventListener('click', function () {
      if (!current) return;
      save(current.json, current.name + '.json', 'application/json;charset=utf-8');
    });
    $('cp-html').addEventListener('click', function () {
      if (!current) return;
      copy(current.block);
    });
  }

  function save(textOut, filename, mime) {
    try {
      var url = URL.createObjectURL(new Blob([textOut], { type: mime }));
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Saved ' + filename);
    } catch (err) {
      toast('Download failed: ' + err.message, 'bad');
    }
  }

  function copy(textOut) {
    var done = function () { toast('Block HTML copied — ' + textOut.length.toLocaleString('en-IN') + ' characters'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textOut).then(done, function () { legacyCopy(textOut, done); });
    } else {
      legacyCopy(textOut, done);
    }
  }

  // navigator.clipboard is refused without transient focus in some contexts
  // (and was observed refusing at file://), so keep the old path alive.
  function legacyCopy(textOut, done) {
    var ta = document.createElement('textarea');
    ta.value = textOut;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) done();
    else toast('Could not copy. Open "Block HTML" below and copy it by hand.', 'bad');
  }

  /* --------------------------------------------------------------- utils */

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.setAttribute('data-kind', kind || 'ok');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4200);
  }

  function fatal(err) {
    $('busy').hidden = true;
    $('fatal').hidden = false;
    $('fatal-out').textContent = (err && (err.stack || err.message)) || String(err);
    $('fatal').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function describe(r) {
    var s = r.stock || {}, rec = r.recommendation || {};
    return [s.name, s.ticker && '(' + s.ticker + ')', rec.rating].filter(Boolean).join(' ');
  }

  function stem(report, file) {
    var s = (report && report.stock && report.stock.name)
      ? KRB.extract.slugify(report.stock.name)
      : KRB.filename.baseName(file.name);
    var d = (report && report.publishedAt) || '';
    return (s || 'research-report') + (d ? '-' + d : '');
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' kB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function text(s) { return document.createTextNode(s); }
  function bold(s) { var b = document.createElement('b'); b.textContent = s; return b; }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>
