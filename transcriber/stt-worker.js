// Whisper in a Web Worker via transformers.js (xenova/transformers.js). Model files are downloaded once and cached by the browser.
import { pipeline, env, AutoProcessor, AutoModel } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
env.allowLocalModels = false;
env.useBrowserCache = true;
let asr = null, loading = null, spkProc = null, spkModel = null, spkLoading = null;

async function loadSpk() {
  if (!spkLoading) spkLoading = Promise.all([AutoProcessor.from_pretrained('Xenova/wavlm-base-plus-sv'), AutoModel.from_pretrained('Xenova/wavlm-base-plus-sv', { quantized: true, progress_callback: p => self.postMessage({ type: 'progress', p, spk: true }) })]);
  [spkProc, spkModel] = await spkLoading;
}

async function load(model) {
  if (!loading) loading = pipeline('automatic-speech-recognition', model, { quantized: true, progress_callback: p => self.postMessage({ type: 'progress', p }) });
  asr = await loading;
}

self.onmessage = async ev => {
  const m = ev.data;
  if (m.type === 'load') {
    try { await load(m.model || 'Xenova/whisper-base.en'); self.postMessage({ type: 'ready' }); }
    catch (e) { loading = null; self.postMessage({ type: 'error', error: String(e && e.message || e) }); }
  } else if (m.type === 'load-embed') {
    try { await loadSpk(); self.postMessage({ type: 'embed-ready' }); } catch (e) { spkLoading = null; self.postMessage({ type: 'embed-ready', error: String(e && e.message || e) }); }
  } else if (m.type === 'embed') {
    try {
      if (!spkModel) await loadSpk();
      let audio = m.audio; if (audio.length > 16000 * 8) audio = audio.slice(0, 16000 * 8);
      const inputs = await spkProc(audio); const out = await spkModel(inputs);
      self.postMessage({ type: 'embedding', id: m.id, embedding: Array.from(out.embeddings.data) });
    } catch (e) { self.postMessage({ type: 'embedding', id: m.id, embedding: null, error: String(e && e.message || e) }); }
  } else if (m.type === 'transcribe') {
    try {
      if (!asr) await load('Xenova/whisper-base.en');
      let audio = m.audio; if (audio.length < 16000) { const a = new Float32Array(16000); a.set(audio); audio = a; }
      const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
      self.postMessage({ type: 'result', id: m.id, text: out && out.text || '' });
    } catch (e) { self.postMessage({ type: 'result', id: m.id, text: '', error: String(e && e.message || e) }); }
  }
};
