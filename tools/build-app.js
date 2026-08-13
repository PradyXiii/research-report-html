#!/usr/bin/env node
/**
 * Builds converter.html -- ONE self-contained file that turns a Kotak research
 * PDF into the finished HTML block, entirely in the browser.
 *
 * The bot lives inside the page: the same detect.js, extract.js and render.js
 * the server uses are bundled in, so the browser output cannot drift from the
 * server output. Node-only bits (fs reads of the stylesheets, the pdfjs
 * dynamic import) are shimmed at BUILD time -- the logic itself is untouched.
 *
 * No network at runtime. pdf.js and its worker are inlined.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const krbCss = R('src/krb.css');
const kieCss = fs.existsSync(path.join(root, 'src/kie.css')) ? R('src/kie.css') : '';
const workerSrc = R('bot/node_modules/pdfjs-dist/build/pdf.worker.min.mjs');

/* fs/path shims: render.js reads the stylesheets off disk. Serve them from
   memory instead so the module is used unmodified. */
const shim = `
export const readFileSync = (p) => {
  const k = String(p).replace(/\\\\/g, '/');
  if (k.endsWith('krb.css')) return ${JSON.stringify(krbCss)};
  if (k.endsWith('kie.css')) return ${JSON.stringify(kieCss)};
  throw new Error('No bundled file for ' + p);
};
export const existsSync = () => true;
export default { readFileSync, existsSync };
`;
const pathShim = `
export const join = (...a) => a.filter(Boolean).join('/').replace(/\\/+/g, '/');
export const basename = (p) => String(p).split('/').pop();
export const dirname = (p) => String(p).split('/').slice(0, -1).join('/') || '.';
export const resolve = join;
export default { join, basename, dirname, resolve };
`;

const memPlugin = {
  name: 'kotak-shims',
  setup(b) {
    b.onResolve({ filter: /^(fs|node:fs)$/ }, () => ({ path: 'shim-fs', namespace: 'k' }));
    b.onResolve({ filter: /^(path|node:path)$/ }, () => ({ path: 'shim-path', namespace: 'k' }));
    // pdf.js is bundled by esbuild from the real package: it ships as ESM and
    // will not parse inside a classic <script> tag.
    b.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf\.mjs$/ }, () => ({
      path: path.join(root, 'bot/node_modules/pdfjs-dist/build/pdf.mjs')
    }));
    b.onLoad({ filter: /.*/, namespace: 'k' }, (a) => {
      if (a.path === 'shim-fs') return { contents: shim, loader: 'js' };
      return { contents: pathShim, loader: 'js' };
    });
  }
};

(async () => {
  const bundle = await esbuild.build({
    entryPoints: [path.join(root, 'app/entry.js')],
    bundle: true, write: false, format: 'iife', globalName: 'KotakBot',
    platform: 'browser', target: ['es2020'], plugins: [memPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'var process={env:{},cwd:function(){return "/"}},__dirname="/";' }
  });
  const botJs = bundle.outputFiles[0].text;

  const appJs = R('app/app.js');
  const appCss = R('app/app.css');
  const html = R('app/index.html')
    .replace('/*__APP_CSS__*/', appCss)
    .replace('/*__KRB_CSS__*/', krbCss)
    .replace('/*__KIE_CSS__*/', kieCss)
    .replace('/*__WORKER__*/', JSON.stringify(Buffer.from(workerSrc, 'utf8').toString('base64')))
    .replace('/*__BOT__*/', botJs)
    .replace('/*__APP__*/', appJs);

  fs.writeFileSync(path.join(root, 'converter.html'), html);
  console.log(`converter.html  ${(html.length / 1024 / 1024).toFixed(2)} MB  (bundle ${(botJs.length / 1024).toFixed(0)} kB, worker ${(workerSrc.length / 1024).toFixed(0)} kB)`);
})().catch((e) => { console.error(e); process.exit(1); });
