// Regenerates docs/screenshot.png from the running app.
//   node tools/screenshot.mjs [outfile]

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { resolveChromium } from './chromium.mjs';

const out = process.argv[2] || 'docs/screenshot.png';
const port = 5198;
const server = spawn(process.execPath, ['server.js', String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch(resolveChromium());
const page = await browser.newPage({ viewport: { width: 1480, height: 940 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#preview svg');
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#preview svg');

await page.getByRole('button', { name: 'Use demo city' }).click();
await page.waitForFunction(() => /demo data/.test(document.querySelector('.stats')?.textContent || ''));
// Open the sections the screenshot needs to reach into.
await page.evaluate(() => {
  for (const details of document.querySelectorAll('details.section')) {
    const title = details.querySelector('.section-title')?.textContent || '';
    if (/labels|pin/i.test(title)) details.open = true;
  }
});
await page.getByText('Show labels', { exact: true }).click();
await page.locator('input[placeholder="Home"]').fill('Family');
await page.waitForTimeout(600);
// Leave the panel scrolled to the top for the shot.
await page.evaluate(() => {
  for (const details of document.querySelectorAll('details.section')) {
    const title = details.querySelector('.section-title')?.textContent || '';
    details.open = /location|layers|caption/i.test(title);
  }
  document.querySelector('.sidebar').scrollTop = 0;
});
await page.waitForTimeout(500);
await page.evaluate(() => { document.querySelector('#status').className = 'status'; });

await page.screenshot({ path: out });
console.log('->', out);
await browser.close();
server.kill();
