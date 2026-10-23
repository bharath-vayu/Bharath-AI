/* Transcriber (browser edition)
   Mic -> Web Speech API (instant live text, label "Me")
   Shared screen/tab audio -> whisper (transformers.js, in a worker, label "Others")
   Shared video -> screenshots every N seconds, unchanged frames skipped
   Export: Text / HTML / PDF / Word, optional Save to Google Drive                                    */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const tv = $('tv'), status = $('status'), pill = $('pill'), pillText = $('pillText'), btnStart = $('btnStart');
  const swSys = $('swSys'), swMic = $('swMic'), swShot = $('swShot'), swInclude = $('swInclude'), intervalEl = $('interval');
  const exportbar = $('exportbar');
  const SR = 16000;

  const S = { running: false, started: null, t0: 0, segs: [], shots: [], live: { Me: '', Others: '' }, lastWho: '', lastT1: -100, pendingOthers: 0 };
  let display = null, mic = null, rec = null, ac = null, worker = null, workerReady = false, shotTimer = null, clockTimer = null, video = null, lastShotHash = 0, jobs = new Map(), jobSeq = 0;

  const now = () => (performance.now() - S.t0) / 1000;
  const pad = n => String(n).padStart(2, '0');
  const hms = t => { const s = Math.max(0, t | 0); return `${pad(s / 3600 | 0)}:${pad(s / 60 % 60 | 0)}:${pad(s % 60)}`; };
  const ms = t => { const s = Math.max(0, t | 0); return s >= 3600 ? hms(t) : `${s / 60 | 0}:${pad(s % 60)}`; };
  const setStatus = s => status.textContent = s;
  const on = sw => sw.getAttribute('aria-checked') === 'true';
  const setOn = (sw, v) => sw.setAttribute('aria-checked', v ? 'true' : 'false');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SPK = ['#2563eb', '#c2410c', '#7c3aed', '#0e7490', '#b91c1c', '#4d7c0f', '#a16207', '#be185d'];
  const whoColor = w => w === 'Me' ? '#16805c' : w.startsWith('Speaker ') ? SPK[(parseInt(w.slice(8)) - 1) % 8] : 'var(--muted)';
  document.querySelectorAll('.switch').forEach(sw => sw.addEventListener('click', () => { if (!sw.disabled) { setOn(sw, !on(sw)); if (sw === swInclude) rebuildView(); } }));

  // ---------------------------------------------------------------- transcript view
  function entryNode(e) {
    const d = document.createElement('div');
    if (e.kind === 'shot') {
      d.className = 'e shot';
      d.innerHTML = `<div><div class="who">Screenshot</div><div class="t">${ms(e.t)}</div></div><div><img alt="Screenshot at ${ms(e.t)}"><div class="cap">${esc(e.file)}</div></div>`;
      d.querySelector('img').src = e.data;
    } else {
      d.className = 'e' + (e.kind === 'err' ? ' err' : '');
      d.innerHTML = `<div><div class="who" style="color:${e.kind === 'err' ? 'var(--primary)' : whoColor(e.who)}">${esc(e.who)}</div><div class="t">${ms(e.t)}</div></div><div class="x"></div>`;
      d.querySelector('.x').textContent = e.text;
    }
    return d;
  }
  let liveBox = null;
  function addEntry(e, merge) {
    $('empty')?.remove();
    const last = tv.querySelector('.e:not(.live):last-of-type');
    if (merge && last && !last.classList.contains('shot') && last.dataset.who === e.who) { last.querySelector('.x').textContent += ' ' + e.text; }
    else { const n = entryNode(e); n.dataset.who = e.who || ''; if (liveBox) tv.insertBefore(n, liveBox); else tv.appendChild(n); }
    tv.scrollTop = tv.scrollHeight;
  }
  function renderLive() {
    if (!liveBox) { liveBox = document.createElement('div'); tv.appendChild(liveBox); }
    liveBox.innerHTML = '';
    for (const who of ['Others', 'Me']) {
      const t = S.live[who]; if (!t) continue;
      const d = document.createElement('div'); d.className = 'e live';
      d.innerHTML = `<div><div class="who">${who}</div></div><div class="x"></div>`; d.querySelector('.x').textContent = t; liveBox.appendChild(d);
    }
    if (liveBox.children.length) tv.scrollTop = tv.scrollHeight;
  }
  function merged(withShots) {
    const v = []; let lw = '', lt = -100;
    for (const s of [...S.segs].sort((a, b) => a.t0 - b.t0)) {
      if (v.length && v[v.length - 1].kind === 'text' && s.who === lw && s.t0 - lt < 15) v[v.length - 1].text += ' ' + s.text;
      else v.push({ kind: 'text', who: s.who, text: s.text, t: s.t0 });
      lw = s.who; lt = s.t1;
    }
    if (withShots) for (const sh of S.shots) v.push({ kind: 'shot', file: sh.file, data: sh.data, t: sh.t });
    return v.sort((a, b) => a.t - b.t);
  }
  function rebuildView() { tv.innerHTML = ''; liveBox = null; for (const e of merged(on(swInclude))) addEntry(e, false); tv.scrollTop = 0; }

  // ---------------------------------------------------------------- autosave (IndexedDB)
  const idb = { db: null,
    open() { return new Promise(r => { const q = indexedDB.open('transcriber', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => { this.db = q.result; r(true); }; q.onerror = () => r(false); }); },
    put(v) { try { this.db.transaction('s', 'readwrite').objectStore('s').put(v, 'current'); } catch (e) {} },
    get() { return new Promise(r => { try { const q = this.db.transaction('s').objectStore('s').get('current'); q.onsuccess = () => r(q.result); q.onerror = () => r(null); } catch (e) { r(null); } }); },
    del() { try { this.db.transaction('s', 'readwrite').objectStore('s').delete('current'); } catch (e) {} } };
  let saveTimer = 0;
  const autosave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => idb.put({ started: S.started, segs: S.segs, shots: S.shots }), 400); };

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
          if (m.type === 'progress') { if (m.p && m.p.status === 'progress' && m.p.file && m.p.file.endsWith('.onnx')) setStatus(`Downloading speech model (first time only): ${Math.round(m.p.progress || 0)}%`); }
          else if (m.type === 'ready') { workerReady = true; setStatus(S.running ? 'Recording.' : 'Speech model ready.'); worker._res?.(true); }
          else if (m.type === 'error') { setStatus('Speech model failed to load: ' + m.error); worker._res?.(false); }
          else if (m.type === 'result') {
            const j = jobs.get(m.id); jobs.delete(m.id); S.pendingOthers--;
            if (S.pendingOthers <= 0) { S.pendingOthers = 0; S.live.Others = ''; renderLive(); }
            const text = (m.text || '').trim().replace(/\s+/g, ' ');
            if (j && text && !/^[\[\(\*].*[\]\)\*]$/.test(text) && /[a-z0-9]/i.test(text)) final('Others', text, j.t0, j.t1);
          }
        };
        worker.onerror = e => { setStatus('Speech worker error: ' + (e.message || e)); worker._res?.(false); };
      }
      worker._res = resolve; worker.postMessage({ type: 'load' });
    });
  }
  function transcribeOthers(audio, t0, t1) {
    if (!worker || !workerReady) return;
    const id = ++jobSeq; jobs.set(id, { t0, t1 }); S.pendingOthers++;
    S.live.Others = 'transcribing…'; renderLive();
    worker.postMessage({ type: 'transcribe', id, audio: normalize(audio) }, [audio.buffer]);
  }
  function final(who, text, t0, t1) {
    const s = { who, text, t0, t1 }; S.segs.push(s);
    addEntry({ kind: 'text', who, text, t: t0 }, who === S.lastWho && t0 - S.lastT1 < 15); S.lastWho = who; S.lastT1 = t1; autosave();
  }

  // ---------------------------------------------------------------- mic via Web Speech
  function startMic() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Rec) { addEntry({ kind: 'err', who: 'Error', text: 'This browser has no speech recognition for the microphone. Use Chrome or Edge.', t: now() }, false); return; }
    rec = new Rec(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'; let segStart = 0;
    rec.onresult = ev => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i], t = r[0].transcript.trim(); if (!t) continue;
        if (r.isFinal) { const t1 = now(); final('Me', t, segStart || t1 - 2, t1); segStart = 0; }
        else { if (!segStart) segStart = now(); interim += t + ' '; }
      }
      S.live.Me = interim.trim(); renderLive();
    };
    rec.onerror = ev => { if (ev.error === 'not-allowed') addEntry({ kind: 'err', who: 'Error', text: 'Microphone blocked. Allow it in the address bar and press Start again.', t: now() }, false); };
    rec.onend = () => { S.live.Me = ''; renderLive(); if (S.running && on(swMic)) { try { rec.start(); } catch (e) { setTimeout(() => S.running && rec.start(), 300); } } };
    rec.start();
  }

  // ---------------------------------------------------------------- shared screen: audio + screenshots
  async function startDisplay(wantAudio, wantVideo) {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false, systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false });
    display.getVideoTracks()[0].onended = () => { if (S.running) stop(); };
    if (wantAudio) {
      const at = display.getAudioTracks()[0];
      if (!at) addEntry({ kind: 'err', who: 'Error', text: 'The share has no audio. Stop, press Start again and tick "Share system audio" (entire screen) or "Share tab audio" (tab). Window shares carry no audio on Windows.', t: now() }, false);
      else {
        const ok = await ensureWorker();
        if (ok) {
          ac = new AudioContext({ sampleRate: SR });
          const src = ac.createMediaStreamSource(new MediaStream([at])), proc = ac.createScriptProcessor(4096, 1, 1), mute = ac.createGain(); mute.gain.value = 0;
          const chk = new Chunker(transcribeOthers); chk.tNow = now();
          proc.onaudioprocess = e => { if (S.running) chk.push(e.inputBuffer.getChannelData(0)); };
          src.connect(proc); proc.connect(mute); mute.connect(ac.destination); ac._chk = chk;
        }
      }
    }
    if (wantVideo) {
      video = document.createElement('video'); video.muted = true; video.srcObject = new MediaStream(display.getVideoTracks()); await video.play();
      const iv = Math.max(5, Math.min(3600, parseInt(intervalEl.value) || 60)) * 1000;
      const snap = () => { if (!S.running || video.videoWidth === 0) return;
        const c = document.createElement('canvas'), W = Math.min(1920, video.videoWidth), H = Math.round(video.videoHeight * W / video.videoWidth); c.width = W; c.height = H;
        const g = c.getContext('2d'); g.drawImage(video, 0, 0, W, H);
        const sm = document.createElement('canvas'); sm.width = 96; sm.height = 54; const sg = sm.getContext('2d'); sg.drawImage(c, 0, 0, 96, 54);
        const px = sg.getImageData(0, 0, 96, 54).data; let h = 2166136261; for (let i = 0; i < px.length; i += 4) { h = Math.imul(h ^ (px[i] >> 3), 16777619); h = Math.imul(h ^ (px[i + 1] >> 3), 16777619); h = Math.imul(h ^ (px[i + 2] >> 3), 16777619); }
        if (h === lastShotHash) return; lastShotHash = h;
        const t = now(), file = `shot_${pad(S.shots.length + 1).padStart(4, '0')}_${hms(t).replace(/:/g, '-')}.jpg`, data = c.toDataURL('image/jpeg', 0.82);
        S.shots.push({ t, file, data }); addEntry({ kind: 'shot', file, data, t }, false); S.lastWho = ''; autosave(); };
      setTimeout(snap, 800); shotTimer = setInterval(snap, iv);
    }
  }

  // ---------------------------------------------------------------- start / stop
  async function start() {
    const wantSys = on(swSys), wantMic = on(swMic), wantShot = on(swShot);
    if (!wantSys && !wantMic) { setStatus('Turn on at least one audio source.'); return; }
    S.running = true; S.started = new Date(); S.t0 = performance.now(); S.segs = []; S.shots = []; S.live = { Me: '', Others: '' }; S.lastWho = ''; S.lastT1 = -100; S.pendingOthers = 0; lastShotHash = 0;
    tv.innerHTML = ''; liveBox = null; exportbar.classList.remove('show'); $('restoreBanner').classList.remove('show');
    btnStart.disabled = true; [swSys, swMic, swShot, intervalEl].forEach(x => x.disabled = true);
    try {
      if (wantSys || wantShot) await startDisplay(wantSys, wantShot);
      if (wantMic) { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); startMic(); }
    } catch (e) {
      S.running = false; btnStart.disabled = false; [swSys, swMic, swShot, intervalEl].forEach(x => x.disabled = false);
      setStatus(e.name === 'NotAllowedError' ? 'Sharing was cancelled.' : 'Could not start: ' + e.message); cleanupMedia(); return;
    }
    btnStart.textContent = 'Stop'; btnStart.className = 'dark'; btnStart.disabled = false;
    pill.classList.add('rec'); pillText.textContent = 'Recording  0:00'; clockTimer = setInterval(() => pillText.textContent = 'Recording  ' + ms(now()), 1000);
    if (!status.textContent.startsWith('Downloading')) setStatus('Recording. Grey text is provisional; it is replaced when the sentence is finished.');
    try { if ('wakeLock' in navigator) S.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function cleanupMedia() {
    if (rec) { rec.onend = null; try { rec.stop(); } catch (e) {} rec = null; }
    if (ac) { try { ac._chk?.flush(); ac.close(); } catch (e) {} ac = null; }
    if (shotTimer) { clearInterval(shotTimer); shotTimer = null; }
    if (video) { video.srcObject = null; video = null; }
    for (const s of [display, mic]) s?.getTracks().forEach(t => t.stop()); display = mic = null;
  }
  async function stop() {
    S.running = false; clearInterval(clockTimer); setStatus('Finishing the last sentences…'); btnStart.disabled = true;
    cleanupMedia(); try { S.wake?.release(); } catch (e) {}
    const until = Date.now() + 30000; while (S.pendingOthers > 0 && Date.now() < until) await new Promise(r => setTimeout(r, 150));
    S.live = { Me: '', Others: '' }; renderLive();
    btnStart.textContent = 'Start'; btnStart.className = 'primary'; btnStart.disabled = false; [swSys, swMic, swShot, intervalEl].forEach(x => x.disabled = false);
    pill.classList.remove('rec'); pillText.textContent = 'Idle';
    setOn(swInclude, S.shots.length > 0); exportbar.classList.add('show'); rebuildView();
    setStatus(`Stopped. ${S.segs.length} sentences, ${S.shots.length} screenshots. Save it with the buttons above; nothing is kept once this tab is closed and discarded.`);
    idb.put({ started: S.started, segs: S.segs, shots: S.shots });
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
      : `<div class="e"><div><div class="who" style="color:${whoColor(e.who).replace('var(--muted)', '#8a857d')}">${esc(e.who)}</div><div class="t">${ms(e.t)}</div></div><div class="x">${esc(e.text)}</div></div>`;
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

  // ---------------------------------------------------------------- Google Drive
  const CID_KEY = 'transcriber.clientId'; let token = null;
  $('btnSettings').addEventListener('click', () => { $('clientId').value = localStorage.getItem(CID_KEY) || ''; $('dlgSettings').showModal(); });
  $('dlgCancel').addEventListener('click', () => $('dlgSettings').close());
  $('dlgSave').addEventListener('click', () => { localStorage.setItem(CID_KEY, $('clientId').value.trim()); $('dlgSettings').close(); setStatus('Google Drive client ID saved.'); });
  $('dlgDriveCancel').addEventListener('click', () => $('dlgDrive').close());
  $('btnDrive').addEventListener('click', () => {
    if (!localStorage.getItem(CID_KEY)) { $('clientId').value = ''; $('dlgSettings').showModal(); setStatus('Set a Google Drive client ID first (one-time, see README).'); return; }
    $('dlgDrive').showModal();
  });
  $('driveFmts').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('dlgDrive').close(); saveToDrive(b.dataset.fmt); }));
  function getToken() {
    return new Promise((resolve, reject) => {
      if (token && token.exp > Date.now()) return resolve(token.v);
      if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in script did not load.'));
      const tc = google.accounts.oauth2.initTokenClient({ client_id: localStorage.getItem(CID_KEY), scope: 'https://www.googleapis.com/auth/drive.file',
        callback: r => { if (r.error) return reject(new Error(r.error)); token = { v: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 }; resolve(token.v); } });
      tc.requestAccessToken();
    });
  }
  async function saveToDrive(fmt) {
    try {
      const tok = await getToken(), blob = await build(fmt), H = { Authorization: 'Bearer ' + tok };
      setStatus('Uploading to Google Drive…');
      let q = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent("name='Transcriber' and mimeType='application/vnd.google-apps.folder' and trashed=false")}&fields=files(id)`, { headers: H }).then(r => r.json());
      let folder = q.files?.[0]?.id;
      if (!folder) folder = (await fetch('https://www.googleapis.com/drive/v3/files', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Transcriber', mimeType: 'application/vnd.google-apps.folder' }) }).then(r => r.json())).id;
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ name: fname(fmt), parents: [folder] })], { type: 'application/json' }));
      form.append('file', blob, fname(fmt));
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', headers: H, body: form }).then(r => r.json());
      if (r.error) throw new Error(r.error.message);
      idb.del(); setStatus('Saved to Google Drive: Transcriber/' + fname(fmt));
      if (r.webViewLink) window.open(r.webViewLink, '_blank');
    } catch (e) { setStatus('Google Drive: ' + e.message); }
  }

  // ---------------------------------------------------------------- restore
  (async () => {
    if (!await idb.open()) return;
    const prev = await idb.get();
    if (prev && (prev.segs?.length || prev.shots?.length)) {
      $('restoreBanner').classList.add('show');
      $('btnRestore').onclick = () => { S.started = new Date(prev.started); S.segs = prev.segs; S.shots = prev.shots; $('restoreBanner').classList.remove('show'); setOn(swInclude, S.shots.length > 0); exportbar.classList.add('show'); rebuildView(); setStatus('Previous session restored.'); };
      $('btnDiscard').onclick = () => { idb.del(); $('restoreBanner').classList.remove('show'); };
    }
  })();
  window.addEventListener('beforeunload', e => { if (S.running) { e.preventDefault(); e.returnValue = ''; } });

  // test hook (used by the automated layout/export check, harmless otherwise)
  window.__transcriber = { S, final, addEntry, build, rebuildView, exportbar, setOn, swInclude, finish: () => { exportbar.classList.add('show'); rebuildView(); } };
})();
