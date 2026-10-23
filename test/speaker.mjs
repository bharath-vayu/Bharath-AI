// Can the browser compute speaker embeddings fast enough, and do they separate voices?
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const wav = fs.readFileSync('/home/claude/whispercpp/samples/jfk.wav');
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8099/transcriber/');
const r = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const s16 = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
  const a = new Float32Array(s16.length); for (let i = 0; i < s16.length; i++) a[i] = s16[i] / 32768;
  const seg = (t0, t1) => a.slice(t0 * 16000 | 0, t1 * 16000 | 0);
  const shift = (x, r) => { const o = new Float32Array(Math.floor(x.length / r)); for (let i = 0; i < o.length; i++) o[i] = x[Math.floor(i * r)]; return o; };   // crude pitch/speed change = "another voice"
  const samples = { A1: seg(0, 2.7), A2: seg(5.1, 8.2), A3: seg(8.2, 10.9), B1: shift(seg(0, 2.7), 1.3), B2: shift(seg(5.1, 8.2), 1.3), C1: shift(seg(8.2, 10.9), 0.8) };
  const w = new Worker('stt-worker.js', { type: 'module' });
  const t0 = performance.now();
  return await new Promise(res => {
    const out = { times: {} }; let pending = 0; const emb = {};
    w.onmessage = ev => {
      const m = ev.data;
      if (m.type === 'embed-ready') { out.load = Math.round(performance.now() - t0); for (const k in samples) { pending++; const t = performance.now(); w.postMessage({ type: 'embed', id: k, audio: samples[k] }); out.times[k] = t; } }
      if (m.type === 'embedding') {
        out.times[m.id] = Math.round(performance.now() - out.times[m.id]); emb[m.id] = m.embedding; if (m.error) out.err = m.error;
        if (--pending === 0) {
          const cos = (x, y) => { let d = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; } return d / Math.sqrt(nx * ny); };
          out.dim = emb.A1?.length; out.sim = {};
          for (const p of [['A1', 'A2'], ['A1', 'A3'], ['A2', 'A3'], ['B1', 'B2'], ['A1', 'B1'], ['A2', 'B2'], ['A3', 'C1'], ['B1', 'C1']]) out.sim[p.join('-')] = +cos(emb[p[0]], emb[p[1]]).toFixed(3);
          res(out);
        }
      }
      if (m.type === 'error') res({ error: m.error });
    };
    w.postMessage({ type: 'load-embed' });
  });
}, wav.toString('base64'));
console.log(JSON.stringify(r, null, 1));
await browser.close();
