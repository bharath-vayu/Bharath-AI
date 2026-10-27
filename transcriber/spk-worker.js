// Speaker fingerprints in their own Web Worker, so they never wait behind whisper.
// Model: 3D-Speaker CAM++ trained on VoxCeleb (7 M parameters, 30 MB, 512-d embeddings) via onnxruntime-web on the CPU.
// Features: Kaldi fbank (80 bins, 25 ms / 10 ms, Povey window, pre-emphasis, 20-7600 Hz) with per-clip mean removal,
// computed here in JS and matching sherpa-onnx's pipeline for this model. Downloaded once, kept in the browser cache.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.wasm.min.mjs';
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1)) : 1;

const MODEL_URL = 'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx';
const MODEL_BYTES = 29600000;
const SR = 16000, FL = 400, FS = 160, NFFT = 512, NBIN = NFFT / 2 + 1, NMEL = 80, LOW = 20, HIGH = SR / 2 - 400, PREEMPH = 0.97, EPS = 1.1920929e-7;

// ---- fbank tables
const mel = f => 1127 * Math.log(1 + f / 700);
const win = new Float32Array(FL); for (let i = 0; i < FL; i++) win[i] = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FL - 1)), 0.85);
const banks = []; {
  const mlo = mel(LOW), mhi = mel(HIGH), d = (mhi - mlo) / (NMEL + 1);
  for (let b = 0; b < NMEL; b++) {
    const l = mlo + b * d, c = l + d, r = c + d; let k0 = -1; const w = [];
    for (let k = 0; k < NBIN; k++) { const m = mel(k * SR / NFFT); if (m > l && m < r) { if (k0 < 0) k0 = k; w.push(m <= c ? (m - l) / (c - l) : (r - m) / (r - c)); } }
    banks.push({ k0: Math.max(0, k0), w: Float32Array.from(w) });
  }
}
// radix-2 FFT, size 512
const rev = new Uint16Array(NFFT); { let bits = Math.log2(NFFT); for (let i = 0; i < NFFT; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; } }
const cosT = new Float32Array(NFFT / 2), sinT = new Float32Array(NFFT / 2); for (let i = 0; i < NFFT / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / NFFT); sinT[i] = -Math.sin(2 * Math.PI * i / NFFT); }
const re = new Float32Array(NFFT), im = new Float32Array(NFFT), frame = new Float32Array(FL), power = new Float32Array(NBIN);
function fft() {
  for (let len = 2; len <= NFFT; len <<= 1) {
    const half = len >> 1, step = NFFT / len;
    for (let i = 0; i < NFFT; i += len) for (let j = 0; j < half; j++) {
      const k = j * step, a = i + j, b = a + half, tr = re[b] * cosT[k] - im[b] * sinT[k], ti = re[b] * sinT[k] + im[b] * cosT[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
// audio: Float32Array in [-1, 1] at 16 kHz -> Float32Array [T * 80]
function fbank(audio) {
  const n = audio.length, T = Math.floor((n + FS / 2) / FS), out = new Float32Array(T * NMEL);
  for (let t = 0; t < T; t++) {
    const start = t * FS + (FS - FL) / 2; let mean = 0;
    for (let i = 0; i < FL; i++) { let idx = start + i; while (idx < 0 || idx >= n) idx = idx < 0 ? -idx - 1 : 2 * n - 1 - idx; frame[i] = audio[idx]; mean += frame[i]; }
    mean /= FL; for (let i = 0; i < FL; i++) frame[i] -= mean;                       // remove DC offset
    for (let i = FL - 1; i > 0; i--) frame[i] -= PREEMPH * frame[i - 1]; frame[0] -= PREEMPH * frame[0];   // pre-emphasis
    re.fill(0); im.fill(0); for (let i = 0; i < FL; i++) re[rev[i]] = frame[i] * win[i]; fft();
    for (let k = 0; k < NBIN; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < NMEL; b++) { const { k0, w } = banks[b]; let e = 0; for (let i = 0; i < w.length; i++) e += power[k0 + i] * w[i]; out[t * NMEL + b] = Math.log(Math.max(e, EPS)); }
  }
  for (let b = 0; b < NMEL; b++) { let m = 0; for (let t = 0; t < T; t++) m += out[t * NMEL + b]; m /= T; for (let t = 0; t < T; t++) out[t * NMEL + b] -= m; }   // global mean removal per clip
  return { data: out, T };
}

// ---- model
let session = null, loading = null;
async function fetchCached(url) {
  let cache = null; try { cache = await caches.open('transcriber-models'); } catch (e) {}
  const hit = cache && await cache.match(url); if (hit) return await hit.arrayBuffer();
  const resp = await fetch(url, { mode: 'cors' }); if (!resp.ok) throw new Error('speaker model: HTTP ' + resp.status);
  const total = +resp.headers.get('content-length') || +resp.headers.get('x-linked-size') || MODEL_BYTES, reader = resp.body.getReader(), chunks = []; let got = 0, last = -1;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; const pct = Math.min(99, Math.round(got / total * 100)); if (pct !== last) { last = pct; self.postMessage({ type: 'progress', p: { status: 'progress', file: 'campp.onnx', progress: pct }, spk: true }); } }
  const blob = new Blob(chunks); if (cache) cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return await blob.arrayBuffer();
}
function load() {
  if (!loading) loading = (async () => {
    const buf = await fetchCached(MODEL_URL);
    self.postMessage({ type: 'progress', p: { status: 'done', file: 'campp.onnx' }, spk: true });
    session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch(e => { loading = null; throw e; });
  return loading;
}
async function embed(audio) {
  if (!session) await load();
  if (audio.length < SR * 0.5) { const a = new Float32Array(SR * 0.5); a.set(audio); audio = a; }   // very short clips: pad to 0.5 s
  const { data, T } = fbank(audio);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, T, NMEL]) });
  return Array.from(out[Object.keys(out)[0]].data);
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.type === 'load-embed') {
    try { await load(); self.postMessage({ type: 'embed-ready' }); } catch (e) { self.postMessage({ type: 'embed-ready', error: String(e && e.message || e) }); }
  } else if (m.type === 'embed') {
    try { let a = m.audio; if (a.length > SR * 10) a = a.subarray(0, SR * 10); const t0 = performance.now(); const embedding = await embed(a); self.postMessage({ type: 'embedding', id: m.id, embedding, ms: performance.now() - t0 }); }
    catch (e) { self.postMessage({ type: 'embedding', id: m.id, embedding: null, error: String(e && e.message || e) }); }
  } else if (m.type === 'embed-multi') {
    try { const t0 = performance.now(); const out = []; for (const w of m.windows) out.push(await embed(m.audio.subarray(w.s, w.e))); self.postMessage({ type: 'embeddings', id: m.id, embeddings: out, ms: performance.now() - t0 }); }
    catch (e) { self.postMessage({ type: 'embeddings', id: m.id, embeddings: null, error: String(e && e.message || e) }); }
  } else if (m.type === 'fbank') {   // test hook
    const { data, T } = fbank(m.audio); self.postMessage({ type: 'fbank', id: m.id, data, T });
  }
};
