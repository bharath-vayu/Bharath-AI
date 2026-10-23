import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const browser = await chromium.launch(); const ctx = await browser.newContext(); const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
const seen = [];
await page.goto('http://localhost:8099/transcriber/');
const t0 = Date.now();
for (let i = 0; i < 300; i++) { const st = await page.evaluate(() => document.getElementById('status').textContent); if (seen[seen.length - 1] !== st) seen.push(st); if (/Ready\. Models are loaded|failed|unavailable/.test(st)) break; await page.waitForTimeout(500); }
console.log('first visit', Math.round((Date.now() - t0) / 1000) + 's'); console.log(seen.filter((x, i) => i < 3 || i > seen.length - 4).join('\n'));
// second visit in the same profile: should be served from cache
await page.goto('http://localhost:8099/transcriber/'); const t1 = Date.now(); const seen2 = [];
for (let i = 0; i < 200; i++) { const st = await page.evaluate(() => document.getElementById('status').textContent); if (seen2[seen2.length - 1] !== st) seen2.push(st); if (/Ready\. Models are loaded|failed/.test(st)) break; await page.waitForTimeout(300); }
console.log('second visit', Math.round((Date.now() - t1) / 1000) + 's', JSON.stringify(seen2));
await browser.close();
