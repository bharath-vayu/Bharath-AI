/* Transcriber (browser edition)
   Microphone and shared screen/tab audio -> Vosk (live words, sentence boundaries) -> whisper rewrite (transformers.js worker)
   Shared audio sentences -> WavLM speaker embedding -> Speaker 1, Speaker 2, ...   Microphone -> "Me"
   Shared video -> screenshots every N seconds, unchanged frames skipped
   Export: Text / HTML / PDF / Word, optional Save to Google Drive                                    */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tv = $('tv'), status = $('status'), pill = $('pill'), pillText = $('pillText'), btnStart = $('btnStart');
  const swSys = $('swSys'), swMic = $('swMic'), swShot = $('swShot'), swInclude = $('swInclude'), intervalEl = $('interval');
  const exportbar = $('exportbar');
  const SR = 16000;

  const MOBILE = !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);   // phones and tablets: microphone only
  const S = { running: false, active: { Others: true, Me: true }, started: null, t0: 0, segs: [], shots: [], live: { Me: '', Others: '' }, lastWho: '', lastT1: -100, pendingOthers: 0, spkLog: [], names: {} };
  let display = null, mic = null, worker = null, workerReady = false, shotTimer = null, clockTimer = null, video = null, lastShotHash = 0, jobs = new Map(), jobSeq = 0;

  const now = () => (performance.now() - S.t0) / 1000;
  const pad = n => String(n).padStart(2, '0');
  const hms = t => { const s = Math.max(0, t | 0); return `${pad(s / 3600 | 0)}:${pad(s / 60 % 60 | 0)}:${pad(s % 60)}`; };
  const ms = t => { const s = Math.max(0, t | 0); return s >= 3600 ? hms(t) : `${s / 60 | 0}:${pad(s % 60)}`; };
  const setStatus = s => status.textContent = s;
  const on = sw => sw.getAttribute('aria-checked') === 'true';
  const setOn = (sw, v) => sw.setAttribute('aria-checked', v ? 'true' : 'false');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SPK_HEX = ['#2b5fd9', '#c24a12', '#7a3fd1', '#0c7a8a', '#b11f3a', '#4f7a12', '#9a6a08', '#b3236f'];
  const whoColor = w => w === 'Me' || w === 'Mic' ? 'var(--me)' : w.startsWith('Speaker ') ? `var(--s${(parseInt(w.slice(8)) - 1) % 8 + 1})` : 'var(--ink-soft)';
  const whoHex = w => w === 'Me' || w === 'Mic' ? '#157a5b' : w.startsWith('Speaker ') ? SPK_HEX[(parseInt(w.slice(8)) - 1) % 8] : '#6f655d';
  // Speakers can be renamed (S.names maps a voice id such as "Speaker 2" to the name shown); two voices given the
  // same name share that name's color and read as one person.
  const disp = w => S.names[w] || w;
  const num = w => w.startsWith('Speaker ') ? parseInt(w.slice(8)) : 99;
  const colorKey = w => { const n = disp(w); let k = w; for (const id in S.names) if (S.names[id] === n && num(id) < num(k)) k = id; return k; };
  document.querySelectorAll('.switch').forEach(sw => sw.addEventListener('click', () => { if (sw.disabled) return; setOn(sw, !on(sw)); if (sw === swInclude) rebuildView(); else if (S.running) liveToggle(sw).catch(e => setStatus('Could not change that: ' + e.message)); }));
  // Switches work while recording: pausing a source keeps its stream and just stops feeding it; enabling a source
  // that was never started acquires it (the browser will prompt for the share or the microphone).
  async function liveToggle(sw) {
    const want = on(sw);
    if (sw === swShot) {
      if (want && !display) { sw.disabled = true; try { await startDisplay(false, true); } finally { sw.disabled = false; } }
      else if (want && !video) await attachVideo();
      restartShotTimer(); if (want) setTimeout(snap, 300);
    } else {
      const label = sw === swSys ? 'Others' : 'Me';
      if (label === 'Me') { S.active.Me = want; if (want && !rec) startMic(); if (!want) { S.live.Me = ''; renderLive(); } return; }
      const ctx = contexts.find(c => c._label === label);
      if (!want) { S.active[label] = false; ctx?._pause(); return; }
      if (ctx) { S.active[label] = true; return; }
      sw.disabled = true;
      try {
        {
          const at = display?.getAudioTracks()[0];
          if (at) { S.active.Others = true; if (await ensureWorker()) await attachAudio(at, 'Others'); }
          else { const old = display; display = null; S.active.Others = true; await startDisplay(true, on(swShot)); old?.getTracks().forEach(t => t.stop()); }
        }
      } finally { sw.disabled = false; }
    }
  }

  // ---------------------------------------------------------------- transcript view
  function entryNode(e) {
    const d = document.createElement('div');
    if (e.kind === 'shot') {
      d.className = 'e shot';
      d.dataset.file = e.file; d.innerHTML = `<div><div class="who">Screenshot</div><div class="t">${ms(e.t)}</div></div><div><img alt="Screenshot at ${ms(e.t)}"><div class="cap">${esc(e.file)}</div></div>`;
      d.querySelector('img').src = e.data;
    } else {
      d.className = 'e' + (e.kind === 'err' ? ' err' : '');
      d.innerHTML = `<div><div class="who" style="color:${e.kind === 'err' ? 'var(--accent)' : whoColor(colorKey(e.id || e.who))}">${esc(e.who)}</div><div class="t">${ms(e.t)}</div></div><div class="x"></div>`;
      d.querySelector('.x').textContent = e.text;
    }
    return d;
  }
  let liveBox = null;
  function addEntry(e, merge, seg) {
    $('empty')?.remove();
    const last = [...tv.children].reverse().find(el => el.classList.contains('e') && !el.classList.contains('live'));
    let node;
    if (merge && last && !last.classList.contains('shot') && last.dataset.who === e.who) { node = last; node._segs.push(seg || { text: e.text }); }
    else { node = entryNode(e); node.dataset.who = e.who || ''; node._segs = [seg || { text: e.text }]; if (liveBox) tv.insertBefore(node, liveBox); else tv.appendChild(node); }
    if (seg) { seg.node = node; refreshNode(node); }
    else if (e.segs) { node._segs = e.segs; for (const sg of e.segs) sg.node = node; }   // rebuilt rows stay linked to their sentences for later rewrites
    tv.scrollTop = tv.scrollHeight;
  }
  function refreshNode(node) { const x = node.querySelector('.x'); if (x && node._segs) x.textContent = node._segs.map(s => s.text).join(' '); }
  function renderLive() {
    if (!liveBox) { liveBox = document.createElement('div'); tv.appendChild(liveBox); }
    liveBox.innerHTML = '';
    for (const who of ['Others', 'Me']) {
      const t = S.live[who]; if (!t) continue;
      const d = document.createElement('div'); d.className = 'e live';
      d.innerHTML = `<div><div class="who">${who === 'Me' && MOBILE ? 'Mic' : who}</div></div><div class="x"></div>`; d.querySelector('.x').textContent = t; liveBox.appendChild(d);
    }
    if (liveBox.children.length) tv.scrollTop = tv.scrollHeight;
  }
  function merged(withShots) {
    const v = []; let lw = '', lt = -100;
    for (const s of [...S.segs].sort((a, b) => a.t0 - b.t0)) {
      const name = disp(s.who);
      if (v.length && v[v.length - 1].kind === 'text' && name === lw && s.who !== 'Others' && s.t0 - lt < 15 && !(withShots && S.shots.some(sh => sh.t >= lt && sh.t <= s.t0))) { v[v.length - 1].text += ' ' + s.text; v[v.length - 1].segs.push(s); }
      else v.push({ kind: 'text', who: name, id: s.who, text: s.text, t: s.t0, segs: [s] });
      lw = name; lt = s.t1;
    }
    if (withShots) for (const sh of S.shots) v.push({ kind: 'shot', file: sh.file, data: sh.data, t: sh.t });
    return v.sort((a, b) => a.t - b.t);
  }
  function rebuildView() { tv.innerHTML = ''; liveBox = null; $('search').value = ''; for (const e of merged(on(swInclude))) addEntry(e, false); tv.scrollTop = 0; renderSpeakers(); renderShots(); }
  // ---- right rail: speakers (renamable) and screenshot thumbnails
  let spkTimer = 0;
  function renderSpeakers() {
    const list = $('spkList'); if (!list) return;
    const rows = [], byName = {};   // one row per shown name; voices renamed to the same name are one row
    for (const s of S.segs) { const n = disp(s.who); if (!byName[n]) { byName[n] = { ids: [], t: 0 }; rows.push(n); } const r = byName[n]; if (!r.ids.includes(s.who)) r.ids.push(s.who); r.t += Math.max(0, s.t1 - s.t0); }
    list.innerHTML = ''; if (!rows.length) { list.innerHTML = '<div class="none">No one yet.</div>'; return; }
    for (const name of rows) {
      const r = byName[name], d = document.createElement('div'); d.className = 'spk';
      d.innerHTML = `<span class="dot"></span><span class="nm" title="Click to rename"></span><span class="ct"></span>`;
      d.querySelector('.dot').style.background = whoColor(colorKey(r.ids[0])); d.querySelector('.nm').textContent = name; d.querySelector('.ct').textContent = ms(r.t);
      d.querySelector('.nm').addEventListener('click', () => {
        const inp = document.createElement('input'); inp.value = name; inp.maxLength = 40; d.replaceChild(inp, d.querySelector('.nm')); inp.focus(); inp.select();
        let done = false; const commit = () => { if (done) return; done = true; const v = inp.value.trim(); for (const id of r.ids) { if (v && v !== id) S.names[id] = v; else delete S.names[id]; } rebuildView(); autosave(); };
        inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') { done = true; renderSpeakers(); } }); inp.addEventListener('blur', commit);
      });
      list.appendChild(d);
    }
  }
  function renderShots() {
    const list = $('shotList'); if (!list) return; list.innerHTML = ''; $('shotCount').textContent = S.shots.length ? String(S.shots.length) : '';
    if (!S.shots.length) { list.innerHTML = '<div class="none">None yet.</div>'; return; }
    for (const sh of S.shots) {
      const d = document.createElement('div'); d.innerHTML = `<img alt="Screenshot at ${ms(sh.t)}"><div class="tt">${ms(sh.t)}</div>`; d.querySelector('img').src = sh.data;
      d.querySelector('img').addEventListener('click', () => { const n = tv.querySelector(`.e.shot[data-file="${sh.file}"]`); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      list.appendChild(d);
    }
  }

  // ---------------------------------------------------------------- autosave (IndexedDB)
  const idb = { db: null,
    open() { return new Promise(r => { const q = indexedDB.open('transcriber', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => { this.db = q.result; r(true); }; q.onerror = () => r(false); }); },
    put(v) { try { this.db.transaction('s', 'readwrite').objectStore('s').put(v, 'current'); } catch (e) {} },
    get() { return new Promise(r => { try { const q = this.db.transaction('s').objectStore('s').get('current'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); } catch (e) { r(null); } }); },
    del() { try { this.db.transaction('s', 'readwrite').objectStore('s').delete('current'); } catch (e) {} } };
  let saveTimer = 0;
  const autosave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => idb.put({ started: S.started, segs: S.segs, shots: S.shots, names: S.names }), 400); };

  // ---------------------------------------------------------------- voice-gated chunker (same logic as the desktop app)
  class Chunker {
    constructor(onFinal) { this.onFinal = onFinal; this.noise = 0.002; this.inSpeech = false; this.tNow = 0; this.tStart = 0; this.silent = 0; this.speech = 0; this.buf = []; this.pre = []; this.preN = 0; }
    push(pcm) {
      const FR = 320;
      for (let off = 0; off < pcm.length; off += FR) {
        const m = Math.min(FR, pcm.length - off); let e = 0; for (let i = 0; i < m; i++) e += pcm[off + i] * pcm[off + i];
        const rms = Math.sqrt(e / m), dt = m / SR, fr = pcm.subarray(off, off + m);
        this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.999 + rms * 0.001; this.noise = Math.max(this.noise, 0.0005);
        const sp = rms > Math.max(this.noise * 3.5, 0.0035);
        if (!this.inSpeech) {
          this.pre.push(fr); this.preN += m; while (this.preN > 0.3 * SR && this.pre.length > 1) this.preN -= this.pre.shift().length;
          if (sp) { this.inSpeech = true; this.tStart = this.tNow - this.preN / SR; this.buf = this.pre; this.pre = []; this.preN = 0; this.silent = 0; this.speech = 0; }
        } else {
          this.buf.push(fr);
          if (sp) { this.silent = 0; this.speech += dt; } else this.silent += dt;
          const len = this.buf.reduce((a, b) => a + b.length, 0) / SR;
          if (this.silent >= 0.6 || len >= 20) this.finish();
        }
        this.tNow += dt;
      }
    }
    finish() {
      this.inSpeech = false; const n = this.buf.reduce((a, b) => a + b.length, 0);
      if (this.speech >= 0.4 && n) { const out = new Float32Array(n); let o = 0; for (const b of this.buf) { out.set(b, o); o += b.length; } this.onFinal(out, this.tStart, this.tStart + n / SR); }
      this.buf = [];
    }
    flush() { if (this.inSpeech) this.finish(); }
  }
  const normalize = a => { let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); if (p > 0.01 && p < 0.9) { const g = 0.9 / p; for (let i = 0; i < a.length; i++) a[i] *= g; } return a; };

  // ---------------------------------------------------------------- whisper worker
  function ensureWorker() {
    return new Promise(resolve => {
      if (workerReady) return resolve(true);
      if (!worker) {
        try { worker = new Worker('stt-worker.js', { type: 'module' }); } catch (e) { return resolve(false); }
        worker.onmessage = ev => {
          const m = ev.data;
          if (m.type === 'progress' && !m.spk) { if (m.p && m.p.status === 'progress' && m.p.file && m.p.file.endsWith('.onnx')) setStatus(`Downloading speech model (first time only): ${Math.round(m.p.progress || 0)}%`); }
          else if (m.type === 'ready') { workerReady = true; S.engine = m.modelName || ''; S.tier = m.tier; S.speed = []; if (m.downgraded) setStatus('Switched to the faster whisper model for this machine.'); else if (S.running) setStatus('Recording.'); worker._res?.(true); }
          else if (m.type === 'note') { console.warn(m.text); }
          else if (m.type === 'error') { setStatus('Speech model failed to load: ' + m.error); worker._res?.(false); }
          else if (m.type === 'result') {
            const j = jobs.get(m.id); jobs.delete(m.id); S.pendingOthers = Math.max(0, S.pendingOthers - 1);
            if (m.ms && m.sec > 1 && m.tier !== 'tiny') {   // slower than real time on this machine? step down a size (small -> base -> tiny)
              S.speed.push(m.ms / 1000 / m.sec); if (S.speed.length >= 3) { const avg = S.speed.slice(-3).reduce((x, y) => x + y, 0) / 3; if (avg > 1.0) { worker.postMessage({ type: 'downgrade' }); S.speed = []; } }
            }
            const text = (m.text || '').trim().replace(/\s+/g, ' ');
            if (j && text && !/^[\[\(\*].*[\]\)\*]$/.test(text) && /[a-z0-9]/i.test(text)) { j.seg.pending = text; if (S.segs[S.segs.length - 1] !== j.seg) applyPending(); }
          }
        };
        worker.onerror = e => { setStatus('Speech worker error: ' + (e.message || e)); worker._res?.(false); };
      }
      worker._res = resolve; worker.postMessage({ type: 'load', memGB: navigator.deviceMemory || 4 });
    });
  }
  // Whisper rewrites a segment in the background. Jobs queue up (the model steps down a size if it falls behind);
  // only when the queue is very deep is a segment left with its live text, so text is never missing.
  function refine(seg, audio) {
    if (!worker || !workerReady || S.pendingOthers >= 6 || audio.length < SR * 0.6) return;
    const id = ++jobSeq; jobs.set(id, { seg }); S.pendingOthers++;
    worker.postMessage({ type: 'transcribe', id, audio: normalize(audio) }, [audio.buffer]);
  }
  function applyPending() {   // whisper's cleaner text is only swapped in for rows that are no longer the newest one
    const last = S.segs[S.segs.length - 1]; let changed = false;
    for (const sg of S.segs) if (sg.pending && (sg !== last || !S.running)) { sg.text = sg.pending; sg.refined = true; delete sg.pending; if (sg.node) refreshNode(sg.node); changed = true; }
    if (changed) autosave();
  }
  function final(who, text, t0, t1) {
    const s = { who, text, t0, t1 }; S.segs.push(s); applyPending();
    // consecutive rows join into a paragraph only when the same identified voice continues; unlabelled rows stay separate
    const name = disp(who);
    addEntry({ kind: 'text', who: name, id: who, text, t: t0 }, name === S.lastWho && who !== 'Others' && t0 - S.lastT1 < 15, s); S.lastWho = name; S.lastT1 = t1; autosave();
    clearTimeout(spkTimer); spkTimer = setTimeout(renderSpeakers, 500);
    return s;
  }

  // ---------------------------------------------------------------- speech pipeline (shared by mic and screen audio)
  // Vosk prints words as they are spoken and decides where a sentence ends. Each finished sentence then gets
  // (a) a speaker label from a voice embedding (screen audio only) and (b) a cleaner rewrite from whisper.
  let meterTimer = null; const meter = { Others: 0, Me: 0 }, frames = { Others: 0, Me: 0 }; const contexts = [];
  let voskModel = null, voskLoading = null; const voskRecs = [];
  const VOSK_MODEL = 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';
  // Download with a progress readout, stored in the browser cache so the next visit is instant.
  async function fetchCached(url, label) {
    let cache = null; try { cache = await caches.open('transcriber-models'); } catch (e) {}
    const hit = cache && await cache.match(url); if (hit) return await hit.blob();
    const resp = await fetch(url, { mode: 'cors' }); if (!resp.ok) throw new Error(`${label}: HTTP ${resp.status}`);
    const total = +resp.headers.get('content-length') || 0, reader = resp.body.getReader(), chunks = []; let got = 0, lastPct = -1;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length;
      const pct = total ? Math.round(got / total * 100) : -1;
      if (pct !== lastPct) { lastPct = pct; setStatus(`${label} (first time only): ${total ? pct + '%' : (got / 1048576).toFixed(0) + ' MB'}`); }
    }
    const blob = new Blob(chunks);
    if (cache) cache.put(url, new Response(blob, { headers: { 'Content-Type': resp.headers.get('content-type') || 'application/octet-stream' } })).catch(() => {});
    return blob;
  }
  function ensureVosk() {
    if (voskModel) return Promise.resolve(true);
    if (!window.Vosk) return Promise.resolve(false);
    if (!voskLoading) voskLoading = (async () => {
      try {
        const blob = await fetchCached(VOSK_MODEL, 'Downloading live speech model, 40 MB');
        setStatus('Starting live speech model…');
        const url = URL.createObjectURL(blob);
        voskModel = await Promise.race([Vosk.createModel(url, 0), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 120000))]);
        return true;
      } catch (e) { setStatus('Live speech model failed: ' + (e.message || e) + '. Reload the page to retry.'); voskLoading = null; return false; }
    })();
    return voskLoading;
  }
  // speaker labels
  // The voice-fingerprint model (CAM++, 29 MB) runs in its own worker so it never queues behind whisper.
  let spkWorker = null, spkReady = false, spkLoading = null; const spk = []; const embJobs = new Map(); let embSeq = 0;
  function ensureSpeaker() {
    if (spkReady) return Promise.resolve(true);
    if (!spkLoading) spkLoading = new Promise(resolve => {
      try { spkWorker = new Worker('spk-worker.js', { type: 'module' }); } catch (e) { spkLoading = null; return resolve(false); }
      setStatus('Loading speaker model (first time only, 30 MB)…');
      const timer = setTimeout(() => { setStatus('Speaker labels unavailable: the speaker model took too long to start.'); spkLoading = null; resolve(false); }, 180000);
      const done = ok => { clearTimeout(timer); spkReady = ok; if (!ok) spkLoading = null; resolve(ok); };
      spkWorker.onmessage = ev => {
        const m = ev.data;
        if (m.type === 'embed-ready') { setStatus(m.error ? 'Speaker labels unavailable: ' + m.error : S.running ? 'Recording.' : 'Ready. Models are loaded.'); done(!m.error); }
        else if (m.type === 'embedding') onEmbedding(m);
        else if (m.type === 'embeddings') onEmbeddings(m);
        else if (m.type === 'progress') { if (m.p.status === 'progress') setStatus(`Downloading speaker model (first time only): ${m.p.progress}%`); else if (m.p.status === 'done') setStatus('Starting speaker model…'); }
      };
      spkWorker.onerror = e => { setStatus('Speaker labels unavailable: ' + (e.message || e)); done(false); };
      spkWorker.postMessage({ type: 'load-embed' });
    });
    return spkLoading;
  }
  const cosine = (x, y) => { let d = 0, nx = 0, ny = 0; for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; } return nx && ny ? d / Math.sqrt(nx * ny) : 0; };
  // 3D-Speaker CAM++ cosine: a 2 s window scores ~0.75 against its own speaker's centroid and under ~0.45 against
  // another speaker's; consecutive windows of one voice score ~0.6, a change of voice ~0.1
  const SAME_VOICE = 0.55, RUN_BREAK = 0.38;
  // A piece joins the closest known voice when it is at least a fair match (SAME_VOICE), and also when it is short or
  // the match is middling but not clearly foreign (NEW_VOICE): a brand-new speaker needs a clearly different voice
  // heard for a few seconds. Up to 8 voices.
  const NEW_VOICE = 0.42;
  function assignSpeaker(emb, seconds) {
    let best = -1, bestSim = -1;
    spk.forEach((k, i) => { if (k.into) return; const c = cosine(emb, k.c); if (c > bestSim) { bestSim = c; best = i; } });
    const clearlyNew = bestSim < NEW_VOICE && seconds >= 2.5 || bestSim < SAME_VOICE && seconds >= 4;
    S.spkLog.push([+bestSim.toFixed(2), +seconds.toFixed(1), clearlyNew ? 'new' : best + 1]); if (S.spkLog.length > 300) S.spkLog.shift();
    if (best >= 0 && (!clearlyNew || spk.length >= 8)) {
      const k = spk[best];   // only a confident match refines the voice's fingerprint, so a doubtful piece cannot drag it towards another voice
      if (bestSim >= SAME_VOICE) { const w = 1 / (k.n + 1); for (let i = 0; i < emb.length; i++) k.c[i] = k.c[i] * (1 - w) + emb[i] * w; k.n = Math.min(20, k.n + 1); mergeLookalikes(); }
      return k.into || best + 1;
    }
    spk.push({ c: emb.slice(), n: 1 }); return spk.length;
  }
  // Two voices that have each been heard several times and whose fingerprints have become near-identical are the
  // same person; the later number folds into the earlier one and its rows are relabeled.
  function mergeLookalikes() {
    for (let i = 0; i < spk.length; i++) for (let j = i + 1; j < spk.length; j++) {
      const a = spk[i], b = spk[j]; if (a.into || b.into || a.n < 3 || b.n < 3 || cosine(a.c, b.c) < 0.72) continue;
      const wa = a.n / (a.n + b.n); for (let x = 0; x < a.c.length; x++) a.c[x] = a.c[x] * wa + b.c[x] * (1 - wa); a.n = Math.min(20, a.n + b.n); b.into = a.into || i + 1;
      const from = 'Speaker ' + (j + 1), to = 'Speaker ' + b.into; let changed = false;
      for (const sg of S.segs) if (sg.who === from) { sg.who = to; changed = true; }
      if (changed) { rebuildView(); S.lastWho = ''; autosave(); }
      return;
    }
  }
  const liveUpdaters = {};
  function onEmbedding(m) {
    const j = embJobs.get(m.id); if (!j) return; embJobs.delete(m.id); liveUpdaters[j.label]?.();
    const words = j.text.split(/\s+/).length;   // one- or two-word fragments never open a new speaker
    const who = m.embedding ? 'Speaker ' + assignSpeaker(m.embedding, words >= 3 ? j.audio.length / SR : 0) : 'Others';
    refine(final(who, j.text, j.t0, j.t1), j.audio);
  }
  const meanVec = vs => { const o = new Array(vs[0].length).fill(0); for (const v of vs) for (let i = 0; i < v.length; i++) o[i] += v[i] / vs.length; return o; };
  function onEmbeddings(m) {
    const j = embJobs.get(m.id); if (!j) return; embJobs.delete(m.id); liveUpdaters[j.label]?.();
    const E = m.embeddings, W = j.windows;
    if (!E || !j.words || !j.words.length) { refine(final(E ? 'Speaker ' + assignSpeaker(meanVec(E), j.audio.length / SR) : 'Others', j.text, j.t0, j.t1), j.audio); return; }
    // group consecutive windows into runs of one voice; a run breaks where a window no longer resembles the run so far
    const runs = [{ embs: [E[0]], sWin: 0, eWin: 0 }];
    for (let i = 1; i < E.length; i++) { const r = runs[runs.length - 1]; if (cosine(E[i], meanVec(r.embs)) >= RUN_BREAK) { r.embs.push(E[i]); r.eWin = i; } else runs.push({ embs: [E[i]], sWin: i, eWin: i }); }
    // run boundaries in statement seconds: the middle of the first window of the new run
    // ... then snapped to the word gap nearest that point (the longest silence between words within 0.7 s)
    const gaps = j.words.slice(1).map((w, i) => ({ at: w.s - j.s0, len: w.s - j.words[i].e }));
    const bounds = runs.slice(1).map(r => {
      const b = (W[r.sWin].s + (W[r.sWin].e - W[r.sWin].s) / 2) / SR;
      const near = gaps.filter(g => Math.abs(g.at - b) <= 0.7).sort((x, y) => y.len - x.len || Math.abs(x.at - b) - Math.abs(y.at - b));
      return near.length ? near[0].at - 0.001 : b;
    });
    const pieces = runs.map((r, i) => ({ from: i ? bounds[i - 1] : 0, to: i < bounds.length ? bounds[i] : j.audio.length / SR, emb: meanVec(r.embs), words: [] }));
    for (const w of j.words) { const mid = (w.s + w.e) / 2 - j.s0; const p = pieces.find(p => mid >= p.from && mid < p.to) || pieces[pieces.length - 1]; p.words.push(w); }
    const out = [];
    for (const p of pieces) {
      if (!p.words.length) continue;
      const who = 'Speaker ' + assignSpeaker(p.emb, p.words.length >= 3 ? p.to - p.from : 0);
      const text = p.words.map(w => w.w).join(' '), ws = Math.max(0, Math.round((p.words[0].s - j.s0) * SR)), we = Math.min(j.audio.length, Math.round((p.words[p.words.length - 1].e - j.s0) * SR));
      const last = out[out.length - 1];
      if (last && last.who === who) { last.text += ' ' + text; last.we = we; } else out.push({ who, text, ws, we });
    }
    const span = j.t1 - j.t0, dur = j.audio.length / SR;
    for (const o of out) { const t0 = j.t0 + span * (o.ws / SR) / dur, t1 = j.t0 + span * (o.we / SR) / dur; refine(final(o.who, o.text, t0, t1), j.audio.slice(o.ws, Math.max(o.we, o.ws + 1))); }
  }
  let rec = null;
  function startMic() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) { addEntry({ kind: 'err', who: 'Error', text: 'This browser has no speech recognition for the microphone. Use Chrome or Edge.', t: now() }, false); return; }
    rec = new Rec(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'; let segStart = 0;
    rec.onresult = ev => {
      if (!S.active.Me) return;
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i], t = r[0].transcript.trim(); if (!t) continue;
        if (r.isFinal) { const t1 = now(); final(MOBILE ? 'Mic' : 'Me', t, segStart || t1 - 2, t1); segStart = 0; }
        else { if (!segStart) segStart = now(); interim += t + ' '; }
      }
      S.live.Me = interim.trim(); renderLive();
    };
    rec.onstart = () => { if (MOBILE) setStatus('Listening.'); };
    rec.onerror = ev => { if (ev.error === 'not-allowed') addEntry({ kind: 'err', who: 'Error', text: 'Microphone blocked. Allow it in the address bar and press Start again.', t: now() }, false); };
    rec.onend = () => { S.live.Me = ''; renderLive(); if (S.running && rec) { try { rec.start(); } catch (e) { setTimeout(() => { try { S.running && rec && rec.start(); } catch (e2) {} }, 300); } } };
    rec.start(); frames.Me = 1;
  }
  function stopMic() { if (rec) { const r = rec; rec = null; r.onend = null; try { r.stop(); } catch (e) {} } S.live.Me = ''; renderLive(); }
  async function attachAudio(track, label) {
    const ac = new AudioContext(); contexts.push(ac);
    try { await ac.resume(); } catch (e) {}
    const src = ac.createMediaStreamSource(new MediaStream([track])), proc = ac.createScriptProcessor(4096, 1, 1), mute = ac.createGain(); mute.gain.value = 0;
    const haveVosk = await ensureVosk();
    if (label === 'Others') ensureSpeaker();   // runs in the background; sentences get labels once it is ready
    let pend = [], pendN = 0, segStart = now(), rec = null, fed = 0;   // fed = samples given to Vosk (its clock)
    const chk = haveVosk ? null : new Chunker((audio, t0, t1) => refine(final(label, '…', t0, t1), audio));
    if (chk) chk.tNow = now();
    if (haveVosk) {
      rec = new voskModel.KaldiRecognizer(SR); rec.setWords(true); voskRecs.push(rec);
      rec.on('partialresult', m => {
        const p = (m.result.partial || '').trim(); if (p && !pendN) segStart = now();
        if (p && !partialTxt && asm && now() - asm.t1 >= 1.0) emit();   // speech resumed after a real pause: previous statement is done
        if (p !== partialTxt) { partialTxt = p; updateLive(); }
      });
      let asm = null, asmTimer = null, partialTxt = '';
      const updateLive = () => { const held = [...embJobs.values()].filter(j => j.label === label).map(j => j.text); S.live[label] = [...held, asm ? asm.text : '', partialTxt].filter(Boolean).join(' '); renderLive(); };
      liveUpdaters[label] = updateLive;
      const emit = () => { if (!asm) return; const a = asm; asm = null; clearTimeout(asmTimer); asmTimer = null;
        const audio = new Float32Array(a.n); let o = 0; for (const b of a.bufs) { audio.set(b, o); o += b.length; }
        const t = a.text, t0 = a.t0, t1 = a.t1, n = a.n;
        if (label === 'Others' && spkReady && n >= SR * 0.8) {
          const id = ++embSeq, WIN = SR * 2, HOP = SR;
          if (n >= SR * 3 && embJobs.size < 4) {   // look for speaker changes inside the statement
            const windows = []; for (let st = 0; st + WIN <= n; st += HOP) windows.push({ s: st, e: st + WIN }); if (windows[windows.length - 1].e < n - SR * 0.5) windows.push({ s: n - WIN, e: n });
            embJobs.set(id, { label, text: t, t0, t1, audio, words: a.words, s0: a.s0, windows }); spkWorker.postMessage({ type: 'embed-multi', id, audio: audio.slice(), windows });
          } else { embJobs.set(id, { label, text: t, t0, t1, audio }); spkWorker.postMessage({ type: 'embed', id, audio: audio.slice() }); }
        }
        else refine(final(label === 'Others' && spk.length ? 'Speaker 1' : label, t, t0, t1), audio);
        updateLive();
      };
      rec.on('result', m => {
        const t = (m.result.text || '').trim(); const n = pendN; const bufs = pend; pend = []; pendN = 0; partialTxt = '';
        if (!t) { emit(); updateLive(); return; }
        const t1 = now(), t0 = Math.max(segStart, t1 - n / SR); segStart = t1;
        const words = (m.result.result || []).map(w => ({ w: w.word, s: w.start, e: w.end })), s0 = (fed - n) / SR;
        if (asm && asm.n + n <= SR * 12) { asm.text += ' ' + t; asm.bufs.push(...bufs); asm.n += n; asm.t1 = t1; asm.words.push(...words); }
        else { emit(); asm = { text: t, bufs, n, t0, t1, words, s0 }; }
        updateLive(); clearTimeout(asmTimer); asmTimer = setTimeout(emit, 2000);
      });
      ac._emit = emit;
    }
    ac._flush = () => { if (chk) chk.flush(); else if (rec) { try { rec.retrieveFinalResult(); } catch (e) {} setTimeout(() => ac._emit?.(), 250); } };
    const ratio = ac.sampleRate / SR; let frac = 0, prev = 0, have = false;
    ac._label = label; ac._pause = () => { ac._flush(); partialTxt = ''; updateLive(); setTimeout(() => { pend = []; pendN = 0; }, 400); };
    proc.onaudioprocess = e => {
      if (!S.running || !S.active[label]) return;
      const inp = e.inputBuffer.getChannelData(0), out = new Float32Array(Math.ceil(inp.length / ratio) + 2); let n = 0, peak = 0;
      for (let i = 0; i < inp.length; i++) {
        const cur = inp[i]; peak = Math.max(peak, Math.abs(cur));
        if (!have) { prev = cur; have = true; continue; }
        while (frac < 1) { out[n++] = prev + (cur - prev) * frac; frac += ratio; }
        frac -= 1; prev = cur;
      }
      meter[label] = Math.max(meter[label] * 0.8, peak); frames[label]++;
      if (!n) return;
      const pcm = out.slice(0, n);
      if (chk) chk.push(pcm);
      else { pend.push(pcm); pendN += n; if (pendN > SR * 30) { pend.shift(); pendN = pend.reduce((a, b) => a + b.length, 0); } let g = 1, pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(pcm[i])); if (pk > 0.01 && pk < 0.5) g = 0.5 / pk; rec.acceptWaveformFloat(g === 1 ? pcm : pcm.map(v => v * g), SR); fed += n; }
    };
    src.connect(proc); proc.connect(mute); mute.connect(ac.destination);
    if (!meterTimer) meterTimer = setInterval(() => {
      if (!S.running) return;
      const bars = '▁▂▃▄▅▆▇█', lv = x => bars[Math.min(7, Math.round(Math.log10(1 + x * 9) * 7))];
      const parts = [];
      for (const c of contexts) if (c.state !== 'running') parts.push('audio paused (click the page)');
      if (frames.Others) parts.push(S.active.Others ? 'share ' + lv(meter.Others) + (meter.Others < 0.004 ? ' silent' : '') : 'share off');
      if (frames.Me) parts.push(S.active.Me && rec ? 'mic on' : 'mic off');
      parts.push(on(swShot) && video ? 'screenshots every ' + intervalEl.value + ' s' : 'screenshots off');
      if (S.pendingOthers) parts.push('polishing'); if (embJobs.size) parts.push('identifying speaker');
      const st = status.textContent; if (!/^(Downloading|Loading|Building)/.test(st)) setStatus('Recording  ·  ' + parts.join('  ·  '));
    }, 500);
  }
  async function startDisplay(wantAudio, wantVideo) {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false, systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false });
    display.getVideoTracks()[0].onended = () => { if (S.running && !document.hidden) stop(); };
    if (video) { video.srcObject = null; video = null; if (shotTimer) { clearInterval(shotTimer); shotTimer = null; } }
    if (wantAudio) {
      const at = display.getAudioTracks()[0];
      if (!at) addEntry({ kind: 'err', who: 'Error', text: 'The share has no audio. Stop, press Start again and tick "Share system audio" (entire screen) or "Share tab audio" (tab). Window shares carry no audio on Windows.', t: now() }, false);
      else { setStatus('Loading speech model…'); const ok = await ensureWorker(); if (ok) await attachAudio(at, 'Others'); }
    }
    if (wantVideo) await attachVideo();
  }
  async function attachVideo() {
    if (!display || video) return;
    video = document.createElement('video'); video.muted = true; video.srcObject = new MediaStream(display.getVideoTracks()); await video.play();
    setTimeout(snap, 800); restartShotTimer();
  }
  function restartShotTimer() {
    if (shotTimer) { clearInterval(shotTimer); shotTimer = null; }
    if (!S.running || !video || !on(swShot)) return;
    const iv = Math.max(5, Math.min(3600, parseInt(intervalEl.value) || 60)) * 1000; shotTimer = setInterval(snap, iv);
  }
  function snap() {
    if (!S.running || !on(swShot) || !video || video.videoWidth === 0) return;
    const c = document.createElement('canvas'), W = Math.min(1920, video.videoWidth), H = Math.round(video.videoHeight * W / video.videoWidth); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(video, 0, 0, W, H);
    const sm = document.createElement('canvas'); sm.width = 96; sm.height = 54; const sg = sm.getContext('2d'); sg.drawImage(c, 0, 0, 96, 54);
    const px = sg.getImageData(0, 0, 96, 54).data; let h = 2166136261; for (let i = 0; i < px.length; i += 4) { h = Math.imul(h ^ (px[i] >> 3), 16777619); h = Math.imul(h ^ (px[i + 1] >> 3), 16777619); h = Math.imul(h ^ (px[i + 2] >> 3), 16777619); }
    if (h === lastShotHash) return; lastShotHash = h;
    const t = now(), file = `shot_${pad(S.shots.length + 1).padStart(4, '0')}_${hms(t).replace(/:/g, '-')}.jpg`, data = c.toDataURL('image/jpeg', 0.82);
    S.shots.push({ t, file, data }); addEntry({ kind: 'shot', file, data, t }, false); S.lastWho = ''; autosave(); renderShots();
  }
  intervalEl.addEventListener('change', restartShotTimer);

  // ---------------------------------------------------------------- start / stop
  async function start() {
    const wantSys = !MOBILE && on(swSys), wantMic = on(swMic), wantShot = !MOBILE && on(swShot);
    if (!wantSys && !wantMic) { setStatus('Turn on at least one audio source.'); return; }
    S.running = true; S.started = new Date(); S.t0 = performance.now(); spk.length = 0; embJobs.clear(); S.spkLog = []; S.names = {}; S.segs = []; S.shots = []; S.live = { Me: '', Others: '' }; S.lastWho = ''; S.lastT1 = -100; S.pendingOthers = 0; lastShotHash = 0;
    tv.innerHTML = ''; liveBox = null; exportbar.classList.remove('show'); $('restoreBanner').classList.remove('show'); $('search').value = ''; renderSpeakers(); renderShots();
    sessionFileId = null; clearInterval(sessionSaveTimer); sessionSaveTimer = setInterval(() => saveSession(false), 180000);
    S.active = { Others: wantSys, Me: wantMic }; btnStart.disabled = true;
    try {
      if (wantSys || wantShot) await startDisplay(wantSys, wantShot);
      if (wantMic) startMic();
    } catch (e) {
      S.running = false; btnStart.disabled = false;
      setStatus(e.name === 'NotAllowedError' ? 'Sharing was cancelled.' : 'Could not start: ' + e.message); cleanupMedia(); return;
    }
    btnStart.textContent = 'Stop recording'; btnStart.className = 'dark'; btnStart.disabled = false;
    pill.classList.add('rec'); pillText.textContent = 'Recording  0:00'; clockTimer = setInterval(() => pillText.textContent = 'Recording  ' + ms(now()), 1000);
    if (!/^(Downloading|Loading|Starting)/.test(status.textContent)) setStatus(MOBILE ? 'Listening.' : 'Recording.');
    try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function cleanupMedia() {
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    stopMic();
    for (const c of contexts) { try { c._flush?.(); c.close(); } catch (e) {} } contexts.length = 0;
    for (const r of voskRecs) { try { r.remove(); } catch (e) {} } voskRecs.length = 0;
    meter.Others = meter.Me = 0; frames.Others = frames.Me = 0;
    if (shotTimer) { clearInterval(shotTimer); shotTimer = null; }
    if (video) { video.srcObject = null; video = null; }
    for (const s of [display, mic]) s?.getTracks().forEach(t => t.stop()); display = mic = null;
  }
  async function stop() {
    S.running = false; clearInterval(clockTimer); setStatus('Finishing the last sentences…'); btnStart.disabled = true;
    cleanupMedia(); try { S.wake?.release(); } catch (e) {}
    const until = Date.now() + 10000; while ((S.pendingOthers > 0 || embJobs.size) && Date.now() < until) await new Promise(r => setTimeout(r, 150));
    applyPending(); S.live = { Me: '', Others: '' }; renderLive();
    btnStart.textContent = 'Start recording'; btnStart.className = 'primary'; btnStart.disabled = false;
    pill.classList.remove('rec'); pillText.textContent = 'Idle';
    setOn(swInclude, S.shots.length > 0); exportbar.classList.add('show'); rebuildView();
    setStatus(`Stopped. ${S.segs.length} sentences, ${S.shots.length} screenshots. Save it with the buttons above; nothing is kept once this tab is closed and discarded.`);
    idb.put({ started: S.started, segs: S.segs, shots: S.shots, names: S.names });
    clearInterval(sessionSaveTimer); saveSession(true);
  }
  btnStart.addEventListener('click', () => S.running ? stop() : start());

  // ---------------------------------------------------------------- exports
  const doc = withShots => ({ title: 'Meeting transcript', started: S.started ? S.started.toLocaleString() : '', duration: Math.max(0, ...S.segs.map(s => s.t1), ...S.shots.map(s => s.t)), entries: merged(withShots) });
  const fname = ext => `Transcript ${S.started ? S.started.toISOString().slice(0, 16).replace('T', ' ').replace(':', '-') : ''}.${ext}`;
  function buildTxt(d) {
    let o = `${d.title}\r\nStarted: ${d.started}\r\nDuration: ${hms(d.duration)}\r\n\r\n`;
    for (const e of d.entries) o += e.kind === 'shot' ? `[${hms(e.t)}] (screenshot: ${e.file})\r\n\r\n` : `[${hms(e.t)}] ${e.who}\r\n${e.text}\r\n\r\n`;
    return new Blob(['﻿' + o], { type: 'text/plain;charset=utf-8' });
  }
  function buildHtml(d) {
    let o = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>body{font:16px/1.65 'Segoe UI',Inter,system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 24px;color:#1d1c1a;background:#f7f5f1}h1{font-size:26px;margin:0 0 4px}.meta{color:#8a857d;font-size:13px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:28px}.e{display:grid;grid-template-columns:130px 1fr;gap:12px 20px;padding:14px 0;border-top:1px solid #e9e5df}.who{font-weight:600}.t{font:12px Consolas,monospace;color:#8a857d;margin-top:3px}.x{white-space:pre-wrap}img{max-width:100%;border:1px solid #e3dfd8;border-radius:8px}figure{margin:0}figcaption{font:12px Consolas,monospace;color:#8a857d;margin-top:6px}</style></head><body><h1>${esc(d.title)}</h1><div class="meta">${esc(d.started)} &middot; ${hms(d.duration)}</div>`;
    for (const e of d.entries) o += e.kind === 'shot'
      ? `<div class="e"><div><div class="who" style="color:#8a857d">Screenshot</div><div class="t">${ms(e.t)}</div></div><figure><img loading="lazy" src="${e.data}"><figcaption>${esc(e.file)}</figcaption></figure></div>`
      : `<div class="e"><div><div class="who" style="color:${whoHex(colorKey(e.id || e.who))}">${esc(e.who)}</div><div class="t">${ms(e.t)}</div></div><div class="x">${esc(e.text)}</div></div>`;
    return new Blob([o + '</body></html>'], { type: 'text/html;charset=utf-8' });
  }
  function imgSize(dataUrl) { return new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.onerror = () => r([16, 9]); i.src = dataUrl; }); }
  async function buildPdf(d) {
    const { jsPDF } = window.jspdf; const p = new jsPDF({ unit: 'pt', format: 'letter' });
    const PW = 612, PH = 792, ML = 56, MT = 60, MB = 56, LEFTW = 110, SZ = 10.5, LEAD = 15, TX = ML + LEFTW, TW = PW - 56 - TX; let y = PH - MT;
    p.setFont('helvetica', 'bold'); p.setFontSize(18); p.setTextColor(29, 28, 26); p.text(d.title, ML, PH - y + 0); y = MT + 22;
    p.setFont('helvetica', 'normal'); p.setFontSize(9); p.setTextColor(138, 133, 125); p.text(`${d.started}   -   ${hms(d.duration)}`, ML, y); y += 26;
    const need = h => { if (y + h > PH - MB) { p.addPage(); y = MT; } };
    for (const e of d.entries) {
      if (e.kind === 'shot') {
        const [iw, ih] = await imgSize(e.data); let w = Math.min(TW, 360), h = w * ih / iw; if (h > 300) { h = 300; w = h * iw / ih; }
        need(h + 20);
        p.setFont('helvetica', 'bold'); p.setFontSize(SZ); p.setTextColor(138, 133, 125); p.text('Screenshot', ML, y + 10); p.setFont('helvetica', 'normal'); p.setFontSize(8.5); p.text(ms(e.t), ML, y + 23);
        p.addImage(e.data, 'JPEG', TX, y, w, h); y += h + 18;
      } else {
        p.setFontSize(SZ); const lines = p.splitTextToSize(e.text, TW); need(Math.min(3 * LEAD, lines.length * LEAD));
        p.setFont('helvetica', 'bold'); p.setTextColor(29, 28, 26); p.text(e.who, ML, y + 10); p.setFont('helvetica', 'normal'); p.setFontSize(8.5); p.setTextColor(138, 133, 125); p.text(ms(e.t), ML, y + 23);
        p.setFontSize(SZ); p.setTextColor(29, 28, 26); let yy = y + 10;
        for (const ln of lines) { if (yy + LEAD > PH - MB) { p.addPage(); yy = MT + 10; } p.text(ln, TX, yy); yy += LEAD; }
        y = Math.max(y + 2 * LEAD, yy) + 10;
      }
    }
    return p.output('blob');
  }
  async function buildDocx(d) {
    const { Document, Packer, Paragraph, TextRun, ImageRun } = window.docx; const kids = [];
    const run = (t, o) => new TextRun(Object.assign({ text: t, font: 'Segoe UI' }, o));
    kids.push(new Paragraph({ children: [run(d.title, { bold: true, size: 36 })] }));
    kids.push(new Paragraph({ children: [run(`${d.started}  ·  ${hms(d.duration)}`, { color: '8A857D', size: 18 })], spacing: { after: 200 } }));
    for (const e of d.entries) {
      if (e.kind === 'shot') {
        const [iw, ih] = await imgSize(e.data); let w = 600, h = Math.round(ih * w / iw); if (h > 480) { h = 480; w = Math.round(iw * h / ih); }
        const bytes = Uint8Array.from(atob(e.data.split(',')[1]), c => c.charCodeAt(0));
        kids.push(new Paragraph({ children: [run('Screenshot', { bold: true, color: '8A857D', size: 20 }), run('   ' + ms(e.t), { color: '8A857D', size: 18 })], spacing: { before: 240, after: 60 } }));
        kids.push(new Paragraph({ children: [new ImageRun({ data: bytes, transformation: { width: w, height: h } })] }));
      } else {
        kids.push(new Paragraph({ children: [run(e.who, { bold: true, size: 22 }), run('   ' + ms(e.t), { color: '8A857D', size: 18 })], spacing: { before: 240, after: 40 } }));
        kids.push(new Paragraph({ children: [run(e.text, { size: 22 })], spacing: { after: 80, line: 300 } }));
      }
    }
    const document = new Document({ sections: [{ properties: { page: { margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 } } }, children: kids }] });
    return Packer.toBlob(document);
  }
  const builders = { txt: buildTxt, html: buildHtml, pdf: buildPdf, docx: buildDocx };
  const mimes = { txt: 'text/plain', html: 'text/html', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  async function build(fmt) { setStatus('Building ' + fmt.toUpperCase() + '…'); const b = await builders[fmt](doc(on(swInclude))); setStatus('Ready.'); return b; }
  async function download(fmt) {
    const blob = await build(fmt); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname(fmt); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    idb.del(); setStatus(`Saved ${a.download}.`);
  }
  exportbar.querySelectorAll('button[data-fmt]').forEach(b => b.addEventListener('click', () => download(b.dataset.fmt)));

  // ---------------------------------------------------------------- views, search, copy
  const views = ['recorder', 'recordings', 'settings', 'help'];
  function showView(v) { for (const x of views) { $('view' + x[0].toUpperCase() + x.slice(1)).classList.toggle('on', x === v); } document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v)); if (v === 'recordings') refreshLibrary(); }
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('btnNew').addEventListener('click', () => { showView('recorder'); if (!S.running) start(); });
  $('btnSettings').addEventListener('click', () => showView('settings'));
  $('search').addEventListener('input', () => {
    const q = $('search').value.trim().toLowerCase();
    for (const e of tv.querySelectorAll('.e')) { const hit = q && e.textContent.toLowerCase().includes(q); e.classList.toggle('hit', !!hit); e.classList.toggle('dim', !!q && !hit && !e.classList.contains('live')); }
  });
  $('btnCopy').addEventListener('click', () => {
    const txt = merged(false).map(e => `[${ms(e.t)}] ${e.who}: ${e.text}`).join('\n');
    navigator.clipboard.writeText(txt).then(() => setStatus('Transcript copied.')).catch(() => setStatus('Copy blocked by the browser; use Save as Text.'));
  });

  // ---------------------------------------------------------------- Google Drive: one-time connect, auto-saved sessions, library
  const CID_KEY = 'transcriber.clientId', CONN_KEY = 'transcriber.driveConnected', TOK_KEY = 'transcriber.driveToken';
  let token = null; try { token = JSON.parse(sessionStorage.getItem(TOK_KEY) || 'null'); } catch (e) {}
  const connected = () => { try { return localStorage.getItem(CONN_KEY) === '1' && !!localStorage.getItem(CID_KEY); } catch (e) { return false; } };
  function setDriveState(on, text) { $('driveState').classList.toggle('on', on); $('driveStateText').textContent = text; $('connectState').textContent = text; $('recSub').textContent = on ? 'Sessions saved to Google Drive, Transcriber/sessions.' : 'Connect Google Drive in Settings to keep every session here.'; }
  $('clientId').value = localStorage.getItem(CID_KEY) || '';
  $('dlgSave').addEventListener('click', () => { localStorage.setItem(CID_KEY, $('clientId').value.trim()); setStatus('Client ID saved. Now press Connect Google Drive.'); $('connectState').textContent = 'Client ID saved.'; });
  $('dlgCancel').addEventListener('click', () => $('dlgSettings').close());
  $('dlgDriveCancel').addEventListener('click', () => $('dlgDrive').close());
  $('btnDrive').addEventListener('click', () => { if (!localStorage.getItem(CID_KEY)) { showView('settings'); setStatus('Set up Google Drive first (Settings).'); return; } $('dlgDrive').showModal(); });
  $('driveFmts').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('dlgDrive').close(); saveToDrive(b.dataset.fmt); }));
  $('btnConnect').addEventListener('click', async () => {
    if (!localStorage.getItem(CID_KEY)) { $('connectState').textContent = 'Paste and save the Client ID first.'; return; }
    try { await getToken(true); localStorage.setItem(CONN_KEY, '1'); setDriveState(true, 'Google Drive connected'); refreshLibrary(); } catch (e) { setDriveState(false, 'Could not connect: ' + e.message); }
  });
  $('btnDisconnect').addEventListener('click', () => { localStorage.removeItem(CONN_KEY); sessionStorage.removeItem(TOK_KEY); token = null; setDriveState(false, 'Google Drive not connected'); $('recList').innerHTML = ''; $('recCount').textContent = '0'; });
  // Tokens last an hour; renew silently (no typing, usually no popup) when the user has connected before.
  function getToken(interactive) {
    return new Promise((resolve, reject) => {
      if (token && token.exp > Date.now()) return resolve(token.v);
      if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in script did not load.'));
      const tc = google.accounts.oauth2.initTokenClient({ client_id: localStorage.getItem(CID_KEY), scope: 'https://www.googleapis.com/auth/drive.file',
        error_callback: e => reject(new Error(e.type || 'sign-in cancelled')),
        callback: r => { if (r.error) return reject(new Error(r.error)); token = { v: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 }; try { sessionStorage.setItem(TOK_KEY, JSON.stringify(token)); } catch (e) {} resolve(token.v); } });
      tc.requestAccessToken(interactive ? {} : { prompt: '' });
    });
  }
  const H = tok => ({ Authorization: 'Bearer ' + tok });
  async function folderId(tok, name, parent) {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, { headers: H(tok) }).then(r => r.json());
    if (r.error) throw new Error(r.error.message);
    if (r.files?.[0]) return r.files[0].id;
    const c = await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { ...H(tok), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : undefined }) }).then(r => r.json());
    if (c.error) throw new Error(c.error.message); return c.id;
  }
  async function upload(tok, folder, name, blob, mime, description, existingId) {
    const form = new FormData(); form.append('metadata', new Blob([JSON.stringify(existingId ? { description } : { name, parents: [folder], description })], { type: 'application/json' })); form.append('file', blob, name);
    const url = existingId ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,webViewLink` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
    const r = await fetch(url, { method: existingId ? 'PATCH' : 'POST', headers: H(tok), body: form }).then(r => r.json()); if (r.error) throw new Error(r.error.message); return r;
  }
  async function saveToDrive(fmt) {
    try {
      const tok = await getToken(true), blob = await build(fmt); setStatus('Uploading to Google Drive…');
      const folder = await folderId(tok, 'Transcriber'); const r = await upload(tok, folder, fname(fmt), blob, mimes[fmt]);
      idb.del(); setStatus('Saved to Google Drive: Transcriber/' + fname(fmt)); if (r.webViewLink) window.open(r.webViewLink, '_blank');
    } catch (e) { setStatus('Google Drive: ' + e.message); }
  }
  // Session auto-save: one JSON per session (text + screenshots) in Transcriber/sessions, updated every 3 minutes and at Stop.
  let sessionFileId = null, sessionSaveTimer = null;
  const sessionName = () => fname('json').replace(/^Transcript /, 'Session ');
  const sessionSummary = () => { const spk = new Set(S.segs.map(s => s.who)); const dur = Math.max(0, ...S.segs.map(s => s.t1), ...S.shots.map(s => s.t)); return `${hms(dur)} · ${spk.size} speaker${spk.size === 1 ? '' : 's'} · ${S.shots.length} screenshot${S.shots.length === 1 ? '' : 's'}`; };
  async function saveSession(final) {
    if (!connected() || (!S.segs.length && !S.shots.length)) return;
    try {
      const tok = await getToken(false); const folder = await folderId(tok, 'sessions', await folderId(tok, 'Transcriber'));
      const body = new Blob([JSON.stringify({ started: S.started, segs: S.segs, shots: S.shots, names: S.names, engine: S.engine || '' })], { type: 'application/json' });
      const r = await upload(tok, folder, sessionName(), body, 'application/json', sessionSummary(), sessionFileId); sessionFileId = r.id;
      if (final) { idb.del(); setStatus('Session saved to Google Drive. ' + status.textContent.replace(/^Stopped\. /, '')); refreshLibrary(); }
    } catch (e) { setStatus('Google Drive save failed: ' + e.message + (final ? '. Use the Save buttons instead.' : '')); }
  }
  async function refreshLibrary() {
    const list = $('recList'); if (!connected()) { list.innerHTML = '<div class="note-box"><h3>Nothing kept yet</h3><p>Connect Google Drive in Settings and every session is saved automatically and listed here. Without it, each session is yours to save or discard when you stop.</p></div>'; $('recCount').textContent = '0'; return; }
    try {
      const tok = await getToken(false); const folder = await folderId(tok, 'sessions', await folderId(tok, 'Transcriber'));
      const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder}' in parents and trashed=false`)}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,createdTime,description,size)`, { headers: H(tok) }).then(r => r.json());
      if (r.error) throw new Error(r.error.message);
      const files = r.files || []; $('recCount').textContent = String(files.length); list.innerHTML = '';
      if (!files.length) list.innerHTML = '<div class="note-box"><h3>No recordings yet</h3><p>Sessions you record are saved here automatically.</p></div>';
      for (const f of files) {
        const d = document.createElement('div'); d.className = 'rec';
        d.innerHTML = `<div class="title"></div><div class="acts"><button data-act="open">Open</button><button data-act="del">Delete</button></div><div class="meta"></div>`;
        d.querySelector('.title').textContent = f.name.replace(/^Session /, '').replace(/\.json$/, '');
        d.querySelector('.meta').textContent = (f.description || '') + '  ·  ' + new Date(f.createdTime).toLocaleString();
        d.addEventListener('click', ev => { const act = ev.target.dataset.act; if (act === 'del') deleteSession(f.id, d); else openSession(f.id); });
        list.appendChild(d);
      }
      setDriveState(true, 'Google Drive connected');
    } catch (e) { list.innerHTML = `<div class="note-box"><h3>Could not read Google Drive</h3><p>${esc(e.message)}. Try Connect again in Settings.</p></div>`; setDriveState(false, 'Google Drive: reconnect needed'); }
  }
  async function openSession(id) {
    if (S.running) { setStatus('Stop the current recording first.'); return; }
    try {
      const tok = await getToken(false); setStatus('Loading session…');
      const j = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: H(tok) }).then(r => r.json());
      S.started = new Date(j.started); S.segs = j.segs || []; S.shots = j.shots || []; S.names = j.names || {}; S.engine = j.engine || S.engine; sessionFileId = id;
      $('restoreBanner').classList.remove('show'); setOn(swInclude, S.shots.length > 0); exportbar.classList.add('show'); rebuildView(); showView('recorder'); setStatus('Session loaded from Google Drive.');
    } catch (e) { setStatus('Could not load the session: ' + e.message); }
  }
  async function deleteSession(id, node) {
    try { const tok = await getToken(false); const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE', headers: H(tok) }); if (!r.ok) throw new Error('HTTP ' + r.status); node.remove(); $('recCount').textContent = String(Math.max(0, +$('recCount').textContent - 1)); }
    catch (e) { setStatus('Could not delete: ' + e.message); }
  }
  $('btnRefreshRecs').addEventListener('click', refreshLibrary);
  if (connected()) { setDriveState(true, 'Google Drive connected'); setTimeout(() => refreshLibrary(), 1500); } else setDriveState(false, 'Google Drive not connected');

  // ---------------------------------------------------------------- restore
  (async () => {
    if (!await idb.open()) return;
    const prev = await idb.get();
    if (prev && (prev.segs?.length || prev.shots?.length)) {
      $('restoreBanner').classList.add('show');
      $('btnRestore').onclick = () => { S.started = new Date(prev.started); S.segs = prev.segs; S.shots = prev.shots; S.names = prev.names || {}; $('restoreBanner').classList.remove('show'); setOn(swInclude, S.shots.length > 0); exportbar.classList.add('show'); rebuildView(); setStatus('Previous session restored.'); };
      $('btnDiscard').onclick = () => { idb.del(); $('restoreBanner').classList.remove('show'); };
    }
  })();
  // Warm up all three models as soon as the page opens, so Start is quick.
  async function preload() {
    if (S.running || MOBILE) return;
    const ok = await ensureWorker(); if (!ok) return;
    await ensureVosk(); if (!S.running) await ensureSpeaker();
    if (!S.running && !/failed|unavailable/.test(status.textContent)) setStatus('Ready. ' + (S.engine ? S.engine + '. ' : '') + 'Models are loaded.');
  }
  setTimeout(preload, 600);
  window.addEventListener('beforeunload', e => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });

  if (MOBILE) {
    for (const el of [swSys.closest('.seg'), swShot.closest('.seg'), swInclude]) if (el) el.hidden = true;
    setOn(swSys, false); setOn(swShot, false); setOn(swMic, true);
    const hint = document.querySelector('.hint'); if (hint) hint.hidden = false, hint.innerHTML = 'Phone mode: this device can only listen through its microphone, so put it where it hears everyone. Words appear as people speak; everything is labeled <b>Mic</b>. Screenshots and speaker labels need the desktop version.';
    const empty = $('empty'); if (empty) empty.querySelector('p:last-child').textContent = 'Allow the microphone when asked. Nothing is uploaded unless you connect Google Drive.';
    setStatus('Ready. Phone mode (microphone only).');
  }
  // test hook (used by the automated layout/export check, harmless otherwise)
  window.__transcriber = { S, final, addEntry, build, rebuildView, exportbar, setOn, swInclude, attachAudio, ensureWorker, ensureVosk, ensureSpeaker, spk, finish: () => { exportbar.classList.add('show'); rebuildView(); } };
})();
