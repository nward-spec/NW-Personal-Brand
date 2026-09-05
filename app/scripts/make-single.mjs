// Bundles the built app (dist/) into one self-contained HTML fragment with the
// JS and CSS inlined, for hosts that serve a single page and no static assets.
// Usage: VITE_NO_SW=1 npx vite build && node scripts/make-single.mjs out.html
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const out = process.argv[2] ?? join(dist, 'single.html');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const js = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const local = (p) => readFileSync(join(dist, p.replace(/^\//, '')), 'utf8');

const page = [
  '<title>Weekly Journal</title>',
  `<style>${css.map(local).join('\n')}</style>`,
  '<div id="root"></div>',
  `<script type="module">${js.map(local).join('\n').replace(/<\/script/g, '<\\/script')}</script>`,
].join('\n');
writeFileSync(out, page);
console.log('wrote', out, `${(page.length / 1024).toFixed(0)} KB`);
