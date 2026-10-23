// Does the whisper worker load from the CDN and transcribe a real clip inside Chromium?
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
const wav = fs.readFileSync('/home/claude/whispercpp/samples/jfk.wav');
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', m => console.log('[page]', m.text()));
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8099/transcriber/');
const r = await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const s16 = new Int16Array(bytes.buffer, 44, (bytes.length - 44) >> 1);
  const audio = new Float32Array(s16.length); for (let i = 0; i < s16.length; i++) audio[i] = s16[i] / 32768;
  const w = new Worker('stt-worker.js', { type: 'module' });
  const t0 = performance.now(); const log = [];
  return await new Promise(res => {
    const timer = setTimeout(() => res({ error: 'timeout', log }), 240000);
    w.onerror = e => { clearTimeout(timer); res({ error: 'worker error: ' + e.message, log }); };
    w.onmessage = ev => {
      const m = ev.data;
      if (m.type === 'progress' && m.p?.status === 'progress' && m.p.file?.endsWith('.onnx')) log.push(`${m.p.file} ${Math.round(m.p.progress)}%`);
      if (m.type === 'error') { clearTimeout(timer); res({ error: m.error, log }); }
      if (m.type === 'ready') { log.push('ready after ' + Math.round(performance.now() - t0) + ' ms'); w.postMessage({ type: 'transcribe', id: 1, audio }, [audio.buffer]); }
      if (m.type === 'result') { clearTimeout(timer); res({ text: m.text, err: m.error, ms: Math.round(performance.now() - t0), log: log.slice(-3) }); }
    };
    w.postMessage({ type: 'load' });
  });
}, wav.toString('base64'));
console.log(JSON.stringify(r, null, 1));
await browser.close();
