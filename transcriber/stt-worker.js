// Whisper in a Web Worker via transformers.js v3.
// On machines with a capable GPU (WebGPU in Chrome/Edge) whisper small.en runs on the GPU; otherwise whisper base.en
// runs on the CPU in WebAssembly. If the chosen model is slower than real time on this machine the page asks for a
// downgrade (small -> base -> tiny). Model files are downloaded once and cached by the browser.
// Speaker fingerprints live in spk-worker.js so they never wait behind a transcription.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2/dist/transformers.min.js';
env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null, loading = null, device = 'wasm', modelName = '', tier = '', memGB = 4;
const NEXT = { small: 'base', base: 'tiny' };

let gpuVendor = '';
async function pickDevice() {
  try {
    if (self.navigator && navigator.gpu) {
      const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (a) { try { const info = a.info || (a.requestAdapterInfo && await a.requestAdapterInfo()); gpuVendor = ((info && (info.vendor || info.description)) || '').toLowerCase(); } catch (e) {} return 'webgpu'; }
    }
  } catch (e) {}
  return 'wasm';
}
const discreteGpu = () => /nvidia|amd|radeon|apple/.test(gpuVendor);
async function load(wantTier) {
  if (!loading) loading = (async () => {
    if (!wantTier) device = await pickDevice();
    const progress_callback = p => self.postMessage({ type: 'progress', p });
    tier = wantTier || (device === 'webgpu' && memGB >= 8 && discreteGpu() ? 'small' : 'base');
    if (device === 'webgpu') {
      try {
        modelName = 'whisper ' + tier + '.en on GPU';
        return await pipeline('automatic-speech-recognition', 'onnx-community/whisper-' + tier + '.en', { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, progress_callback });
      } catch (e) { device = 'wasm'; self.postMessage({ type: 'note', text: 'GPU path failed (' + (e && e.message || e) + '); using CPU.' }); }
    }
    if (tier === 'small') tier = 'base';
    modelName = 'whisper ' + tier + '.en on CPU';
    return await pipeline('automatic-speech-recognition', 'Xenova/whisper-' + tier + '.en', { device: 'wasm', dtype: 'q8', progress_callback });
  })();
  asr = await loading;
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.type === 'load') {
    if (m.memGB) memGB = m.memGB;
    try { await load(); self.postMessage({ type: 'ready', device, modelName: modelName + (gpuVendor ? ' (' + gpuVendor.split(' ')[0] + ')' : ''), tier }); }
    catch (e) { loading = null; self.postMessage({ type: 'error', error: String(e && e.message || e) }); }
  } else if (m.type === 'downgrade') {   // too slow on this machine: step down one model size on the same device
    const next = NEXT[tier]; if (!next) return;
    try { const old = asr; asr = null; loading = null; await load(next); try { old && old.dispose && await old.dispose(); } catch (e) {} self.postMessage({ type: 'ready', device, modelName, tier, downgraded: true }); }
    catch (e) { self.postMessage({ type: 'note', text: 'Downgrade failed: ' + (e && e.message || e) }); }
  } else if (m.type === 'transcribe') {
    try {
      if (!asr) await load();
      let audio = m.audio; if (audio.length < 16000) { const a = new Float32Array(16000); a.set(audio); audio = a; }
      const t0 = performance.now();
      const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
      self.postMessage({ type: 'result', id: m.id, text: out && out.text || '', ms: performance.now() - t0, sec: m.audio.length / 16000, tier });
    } catch (e) { self.postMessage({ type: 'result', id: m.id, text: '', error: String(e && e.message || e) }); }
  }
};
