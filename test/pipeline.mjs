// End-to-end: a 16 kHz clip is played through a 48 kHz MediaStream (like a shared tab), captured by attachAudio,
// gated by the chunker, transcribed by the worker, and must show up as "Others" entries.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const wav = fs.readFileSync('/home/claude/whispercpp/samples/jfk.wav');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8099/transcriber/');
await page.waitForFunction(() => window.__transcriber); await page.waitForTimeout(3000); await page.waitForFunction(() => window.__transcriber && window.Vosk);
const r = await page.evaluate(async (b64) => {
  const T = window.__transcriber; T.S.running = true; T.S.t0 = performance.now();
  if (!await T.ensureWorker()) return { error: 'worker failed' };
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const s16 = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
  const play = new AudioContext({ sampleRate: 48000 }); await play.resume();
  const L = s16.length * 3, M = Math.floor(s16.length / 1.3) * 3, buf = play.createBuffer(1, L + 48000 + M, 48000); const ch = buf.getChannelData(0);
  for (let i = 0; i < s16.length; i++) { const v = s16[i] / 32768; ch[i * 3] = v; ch[i * 3 + 1] = v; ch[i * 3 + 2] = v; }
  for (let i = 0; i < M / 3; i++) { const v = s16[Math.floor(i * 1.3)] / 32768; const o = L + 48000 + i * 3; ch[o] = v; ch[o + 1] = v; ch[o + 2] = v; }   // same clip again, pitch-shifted = second voice
  const dest = play.createMediaStreamDestination(); const src = play.createBufferSource(); src.buffer = buf; src.connect(dest);
  await T.attachAudio(dest.stream.getAudioTracks()[0], 'Others');
  src.start(); const lives = []; const lt = setInterval(() => { const l = T.S.live.Others; if (l && lives[lives.length - 1] !== l) lives.push(l); }, 300);
  await new Promise(r => setTimeout(r, 11000 + 9500 + 25000)); T.S.running = false; await new Promise(r => setTimeout(r, 100));   // clip length + time for whisper
  T.S.running = false;
  clearInterval(lt); return { lives, coi: self.crossOriginIsolated, status: document.getElementById('status').textContent, segs: T.S.segs.map(s => `[${s.who} ${s.t0.toFixed(1)}-${s.t1.toFixed(1)}${s.refined ? ' whisper' : ' vosk'}] ${s.text}`) };
}, wav.toString('base64'));
console.log(JSON.stringify(r, null, 1));
await browser.close();
