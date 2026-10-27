import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch(); const out = 'test/out'; fs.mkdirSync(out, { recursive: true });
const shot = fs.readFileSync('/home/claude/test.jpg').toString('base64');
for (const theme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 1180, height: 760 }, colorScheme: theme }); const p = await ctx.newPage();
  await p.goto('http://localhost:8099/transcriber/'); await p.waitForFunction(() => window.__transcriber && document.fonts.status === 'loaded'); await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}/idle-${theme}.png` });
  await p.evaluate(b64 => { const T = window.__transcriber; T.S.started = new Date('2026-10-27T09:21:00');
    T.final('Speaker 1', "If you remember, we modified that X file. Now, this is a machine 10105-1089. It has the Git directory on it. Right now, the credential manager is not the standard Git credential manager.", 2, 14);
    T.S.shots.push({ t: 30, file: 'shot_0001_00-00-30.jpg', data: 'data:image/jpeg;base64,' + b64 });
    T.final('Me', 'Oh yeah. This is set up so that the CL has to be in the path. If not, you have to open one of the Visual Studio DOS boxes so you get the compiler in the path.', 102, 110);
    T.final('Speaker 2', 'Right now I am going to move this over to 93 because I am actually building the code on 93. If we had RPC gen on 93 we would have been able to do the whole thing there.', 157, 168);
    T.S.live.Others = 'let me just go over here and'; T.finish(); }, shot);
  await p.waitForTimeout(300); await p.screenshot({ path: `${out}/stopped-${theme}.png` });
  await p.goto('http://localhost:8099/'); await p.waitForTimeout(800); await p.screenshot({ path: `${out}/hub-${theme}.png` });
  await ctx.close();
}
await b.close();
