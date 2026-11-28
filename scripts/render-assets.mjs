/* global document */
// Renders the README images in .github/assets from their HTML sources:
//   node scripts/render-assets.mjs [report.json]
// The terminal image is drawn from a real SpecSync JSON report.
import { createRequire } from 'module';
import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { renderText } from '../dist/report/text.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const assets = resolve('.github/assets');
const browser = await chromium.launch();

async function shot(file, query, out, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  await page.goto(`${pathToFileURL(resolve(assets, 'src', file)).href}${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(assets, out), fullPage: true });
  await page.close();
  console.log(`wrote .github/assets/${out}`);
}

await shot('banner.html', '?theme=light', 'banner-light.png', { width: 1280, height: 400 });
await shot('banner.html', '?theme=dark', 'banner-dark.png', { width: 1280, height: 400 });

const reportPath = process.argv[2];
if (reportPath) {
  const report = JSON.parse(await readFile(reportPath, 'utf-8'));
  const ansi = renderText(report, undefined, { color: true, width: 104 });
  const colors = { 1: 'b', 2: 'dim', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 90: 'gray' };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let html = '';
  let open = [];
  for (const part of ansi.split(/(\x1b\[\d+m)/)) {
    const m = /\x1b\[(\d+)m/.exec(part);
    if (!m) html += esc(part);
    else if (m[1] === '0') { html += '</span>'.repeat(open.length); open = []; }
    else { html += `<span class="${colors[m[1]] ?? ''}">`; open.push(m[1]); }
  }
  const command = 'npx specsync run --spec docs/spec.md';
  const tpl = await readFile(resolve(assets, 'src/terminal.html'), 'utf-8');
  await writeFile(resolve(assets, 'src/terminal.out.html'), tpl.replace('{{COMMAND}}', esc(command)).replace('{{OUTPUT}}', html));
  await shot('terminal.out.html', '', 'terminal.png', { width: 1000, height: 400 });
}
await browser.close();
