// Rasterises an SVG for eyeballing.  node tools/svg-to-png.mjs file.svg [...]
import { chromium } from 'playwright';
import fs from 'fs';
import { resolveChromium } from './chromium.mjs';
const [,, ...files] = process.argv;
const browser = await chromium.launch(resolveChromium());
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
for (const file of files) {
  const svg = fs.readFileSync(file, 'utf8');
  await page.setContent(`<body style="margin:0;background:#777;display:flex;align-items:center;justify-content:center;height:100vh">
    <div style="width:820px" id="w">${svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="820" height="820"')}</div></body>`);
  const el = await page.$('#w');
  await el.screenshot({ path: file.replace(/\.svg$/, '.png') });
  console.log('->', file.replace(/\.svg$/, '.png'));
}
await browser.close();
