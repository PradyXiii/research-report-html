/* Converter UI. All work happens in this page -- nothing leaves the machine. */
(function () {
  'use strict';
  var B = window.KotakBot;
  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop'), file = $('file'), status = $('status'), meta = $('meta'),
      actions = $('actions'), out = $('out'), frame = $('frame'),
      jsonbox = $('jsonbox'), jsonEl = $('json');
  var last = null;

  function show(el, on) { el.classList.toggle('a-hide', !on); }
  function say(kind, html) { status.dataset.k = kind; status.innerHTML = html; show(status, true); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

  function reset() {
    [meta, actions, out, jsonbox].forEach(function (e) { show(e, false); });
    last = null;
  }

  function issues(list, heading) {
    if (!list || !list.length) return '';
    return '<b>' + esc(heading) + '</b><ul>' + list.map(function (d) {
      var code = d.code ? '[' + esc(d.code) + '] ' : '';
      var field = d.field ? ' <em>(' + esc(d.field) + ')</em>' : '';
      return '<li>' + code + esc(d.message || String(d)) + field + '</li>';
    }).join('') + '</ul>';
  }

  async function run(f) {
    reset();
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
      return say('err', '<b>Not a PDF.</b> ' + esc(f.name) + ' does not look like a PDF file.');
    }
    say('info', '<span class="a-spin"></span>Reading ' + esc(f.name) + '…');
    var t0 = performance.now();

    try {
      var buf = new Uint8Array(await f.arrayBuffer());
      // A hang is worse than an error: bound the parse so it can never spin.
      var pages = await Promise.race([
        B.extract.__lines(buf),
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('Timed out after 60s reading this PDF.')); }, 60000);
        })
      ]);           // page-1 lines + raw text
      var det = B.detectFormat(pages.page1Text, { pageCount: pages.pageCount, filename: f.name });

      meta.innerHTML =
        '<span class="a-chip" data-ok="y">' + esc(det.label || det.id) + '</span>' +
        (det.confidence ? '<span class="a-chip">confidence ' + det.confidence + '</span>' : '') +
        '<span class="a-chip">' + pages.pageCount + ' pages</span>' +
        (det.restricted ? '<span class="a-chip" data-ok="y">restricted</span>' : '');
      show(meta, true);

      if (!det.implemented || !det.extractable) {
        return say(det.implemented ? 'warn' : 'err',
          '<b>' + esc(det.label || 'Unrecognised') + '</b> — detected correctly.<br>' +
          esc(det.reason || 'No template for this format.'));
      }

      // Page 1 only: pages 2+ are the standard boilerplate, and feeding them in
      // makes the team contact block look like orphaned bullets.
      // Each format has its own parser -- the detected format picks it.
      var res;
      if (det.id === 'pick-of-the-week') res = B.formats.extractPickOfWeek(pages.page1Lines, { filename: f.name });
      else if (det.id === 'kie-full-report') res = B.formats.extractKieReport(pages.pages, { filename: f.name });
      else if (det.id === 'stock-recommendations') res = B.formats.extractStockRecos(pages.pages, { filename: f.name });
      else res = B.extract.extractFromLines(pages.page1Lines, { filename: f.name });
      var data = res.report;
      var errs = res.errors || [];
      // These concern the publishing pipeline, not the document: in a browser
      // there is no filename convention, no schedule and no source URL. Showing
      // them here trains people to ignore warnings that do matter.
      var PIPELINE_ONLY = ['FILENAME', 'REPORT_STALE', 'NO_SOURCE_URL', 'SLUG_UNKNOWN'];
      var warns = (res.warnings || []).filter(function (w) {
        return PIPELINE_ONLY.indexOf(w.code) === -1;
      });
      if (!res.ok) errs = errs.length ? errs : [{ message: 'Extraction did not complete.' }];

      if (errs.length) {
        jsonEl.textContent = JSON.stringify(data, null, 2); show(jsonbox, true);
        return say('err', issues(errs, 'Extraction failed — not published.') +
          (warns.length ? issues(warns, 'Also warned:') : ''));
      }

      if (det.id !== 'one-pager') data.format = det.id;
      var doc = B.renderStandalone(data);
      var frag = B.renderBlock(data, { inlineCss: true });
      last = { doc: doc, frag: frag, data: data, name: (data.reportId || 'report') };

      frame.srcdoc = doc;
      show(out, true); show(actions, true);
      jsonEl.textContent = JSON.stringify(data, null, 2); show(jsonbox, true);

      var ms = Math.round(performance.now() - t0);
      say(warns.length ? 'warn' : 'ok',
        '<b>' + esc(det.label) + '</b> converted in ' + ms + ' ms.' +
        (warns.length ? issues(warns, 'Warnings — check before publishing:') : ''));
    } catch (e) {
      say('err', '<b>Could not read that PDF.</b> ' + esc(e && e.message ? e.message : String(e)));
    }
  }

  function save(text, name, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  $('pick').addEventListener('click', function () { file.click(); });
  drop.addEventListener('click', function (e) { if (e.target === drop || e.target.tagName === 'H1' || e.target.tagName === 'P') file.click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', function () { run(file.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
  });
  drop.addEventListener('drop', function (e) { run(e.dataTransfer.files[0]); });
  window.addEventListener('paste', function (e) {
    var items = (e.clipboardData || {}).files;
    if (items && items.length) run(items[0]);
  });

  $('dl').addEventListener('click', function () { if (last) save(last.doc, last.name + '.html', 'text/html'); });
  $('dj').addEventListener('click', function () { if (last) save(JSON.stringify(last.data, null, 2), last.name + '.json', 'application/json'); });
  $('cp').addEventListener('click', function () {
    if (!last) return;
    navigator.clipboard.writeText(last.frag).then(function () {
      var b = $('cp'), t = b.textContent; b.textContent = 'Copied';
      setTimeout(function () { b.textContent = t; }, 1400);
    });
  });
})();
