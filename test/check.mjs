// Layout + export smoke test: loads the page in headless Chromium, injects a fake session, triggers every export.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const srv = { kill() {} };
await new Promise(r => setTimeout(r, 1500));
const out = path.join(root, 'test', 'out'); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:8099/transcriber/');
await page.waitForFunction(() => window.__transcriber && window.jspdf && window.docx, null, { timeout: 20000 });
await page.screenshot({ path: path.join(out, 'idle.png') });

// fake session
const shot = fs.readFileSync('/home/claude/test.jpg').toString('base64');
await page.evaluate(b64 => {
  const T = window.__transcriber; T.S.started = new Date('2026-10-22T16:21:00');
  T.final('Speaker 1', "If you remember, we modified that X file. Now, this is a machine 10105-1089. It has the Git directory on it. Right now, the credential manager is not the standard Git credential manager.", 2, 14);
  T.final('Speaker 1', "I'm not sure. It's using a different credential manager. And so if you ever have trouble, in fact, I think every time you do a fetch, it's going to ask me for a password.", 14.5, 24);
  T.S.shots.push({ t: 30, file: 'shot_0001_00-00-30.jpg', data: 'data:image/jpeg;base64,' + b64 });
  T.final('Me', 'Oh yeah. This is set up so that the CL has to be in the path. If not, you have to open one of the Visual Studio DOS boxes so you get the compiler in the path.', 102, 110);
  T.final('Speaker 2', 'Right now I am going to move this over to 93 because I am actually building the code on 93. If we had RPC gen on 93 we would have been able to do the whole thing there.', 157, 168);
  T.finish();
}, shot);
await page.screenshot({ path: path.join(out, 'stopped.png') });
await page.setViewportSize({ width: 420, height: 800 }); await page.screenshot({ path: path.join(out, 'phone.png') }); await page.setViewportSize({ width: 1180, height: 760 });

for (const fmt of ['txt', 'html', 'pdf', 'docx']) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(`.exportbar button[data-fmt="${fmt}"]`)]);
  const p = path.join(out, dl.suggestedFilename()); await dl.saveAs(p);
  console.log(fmt, dl.suggestedFilename(), fs.statSync(p).size, 'bytes');
}
await page.goto('http://localhost:8099/'); await page.screenshot({ path: path.join(out, 'hub.png') });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close(); srv.kill();
