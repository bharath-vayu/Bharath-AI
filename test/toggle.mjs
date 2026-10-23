// Live toggle: share audio on for sentence 1, off during sentences 2-3, back on for sentence 4.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const wav = fs.readFileSync('/home/claude/whispercpp/samples/jfk.wav');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage(); page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8099/transcriber/'); await page.waitForFunction(() => window.__transcriber && window.Vosk);
const r = await page.evaluate(async (b64) => {
  const T = window.__transcriber; T.S.running = true; T.S.t0 = performance.now(); await T.ensureWorker();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const s16 = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
  const play = new AudioContext({ sampleRate: 48000 }); await play.resume();
  const buf = play.createBuffer(1, s16.length * 3, 48000); const ch = buf.getChannelData(0);
  for (let i = 0; i < s16.length; i++) { const v = s16[i] / 32768; ch[i * 3] = v; ch[i * 3 + 1] = v; ch[i * 3 + 2] = v; }
  const dest = play.createMediaStreamDestination(); const src = play.createBufferSource(); src.buffer = buf; src.connect(dest);
  await T.attachAudio(dest.stream.getAudioTracks()[0], 'Others');
  const sw = document.getElementById('swSys'); src.start();
  setTimeout(() => sw.click(), 3200); setTimeout(() => sw.click(), 8600);   // off after sentence 1, on before sentence 4
  await new Promise(r => setTimeout(r, 11000 + 15000)); T.S.running = false;
  return { status: document.getElementById('status').textContent, segs: T.S.segs.map(s => `[${s.who} ${s.t0.toFixed(1)}-${s.t1.toFixed(1)}] ${s.text}`) };
}, wav.toString('base64'));
console.log(JSON.stringify(r, null, 1)); await browser.close();
