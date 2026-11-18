// Motor de ràdio amb retard fix respecte al directe.
//
// Idea: per a cada tros d'àudio sabem en quin instant era "en directe" al servidor.
// El reproduïm exactament `delay` segons després d'aquell instant, independentment
// del que hagi trigat a arribar o de si hi ha hagut reconnexions.
//
// Com estimem l'instant de directe: si `t` són els segons d'àudio rebuts fins ara en
// aquesta connexió, cada lectura de xarxa ens dona  v = arribada - t.  L'àudio que
// arriba al més aviat possible (sense esperes de xarxa) té la v mínima, de manera que
//   directe(t) ≈ min(v) + t
// Això també absorbeix la "ràfega" inicial que envien molts servidors en connectar
// (àudio d'uns segons enrere): aquell àudio ja no és directe, i la fórmula ho detecta.

import { FrameParser, aacDescription } from './parser.js';

const now = () => performance.now() / 1000;
const BLOCK_SEC = 0.5;     // mida dels blocs d'àudio descodificat
const LOOKAHEAD = 3;       // segons programats per endavant (aguanta pestanyes en segon pla)
const SNAP_TOL = 0.2;      // desviació màxima abans de corregir amb un salt
const MIN_WINDOW = 30;     // finestra (s) de l'estimació del directe
const SETTLE_SEC = 1.5;    // temps d'espera després de connectar abans de fiar-se de l'estimació
const STALL_SEC = 8;       // sense dades durant aquest temps → reconnecta
const KEEP_EXTRA = 60;     // segons d'historial addicionals (permet augmentar el retard a l'instant)

class Session {
  constructor(id) {
    this.id = id;
    this.start = now();
    this.t = 0;              // segons d'àudio rebuts
    this.window = [];        // cua monòtona [{w, v}] per al mínim lliscant
    this.offset = null;      // directe(t) = offset + t   (en segons de performance.now)
    this.parser = new FrameParser();
    this.decoder = null;
    this.acc = null;         // bloc en construcció
    this.firstBurst = null;  // segons de ràfega inicial (informatiu)
    this.firstData = null;   // instant de la primera dada rebuda
  }

  observe(arrival) {
    const v = arrival - this.t;
    while (this.window.length && this.window[this.window.length - 1].v >= v) this.window.pop();
    this.window.push({ w: arrival, v });
    while (this.window[0].w < arrival - MIN_WINDOW) this.window.shift();
    this.offset = this.window[0].v;
  }

  get settled() { return this.offset !== null && now() - this.firstData > SETTLE_SEC; }
}

export class RadioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.gain = null;
    this.delay = 30;
    this.volume = 1;
    this.blocks = [];        // {session, t0, dur, buffer, scheduled}
    this.sources = new Set();
    this.playlog = [];       // què sona i quan: {session, t, ctxStart, ctxEnd}
    this.last = null;        // últim bloc programat {session, tEnd, ctxEnd}
    this.session = null;
    this.sessionCount = 0;
    this.reconnects = 0;
    this.running = false;
    this.url = null;
    this.state = 'aturat';
    this.codecInfo = '';
    this.timer = null;
  }

  async start(url) {
    this.stop();
    if (!('AudioDecoder' in window)) throw new Error('Aquest navegador no suporta WebCodecs (AudioDecoder). Prova amb un Chrome o Firefox recent.');
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.url = url;
    this.running = true;
    this.reconnects = 0;
    this.sessionCount = 0;
    this.timer = setInterval(() => this.tick(), 200);
    this.connectLoop();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.abort?.abort();
    this.resetPlayback();
    this.blocks = [];
    this.closeDecoder(this.session);
    this.session = null;
    this.setState('aturat');
  }

  setDelay(sec) {
    this.delay = Math.max(0, sec);
    this.resetPlayback();
    this.tick();
  }

  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }

  setState(s, detail = '') {
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: { state: s, detail } }));
  }

  // ---------- Xarxa ----------

  async connectLoop() {
    while (this.running) {
      const ctrl = new AbortController();
      this.abort = ctrl;
      const s = new Session(++this.sessionCount);
      if (this.session) this.closeDecoder(this.session);
      this.session = s;
      this.setState(this.sessionCount === 1 ? 'connectant' : 'reconnectant');
      let lastData = now();
      const watchdog = setInterval(() => { if (now() - lastData > STALL_SEC) ctrl.abort(); }, 1000);
      try {
        // `Range: bytes=0-` és necessari per a StreamTheWorld (RAC1…): sense, talla els navegadors als 32 KB.
        // És una capçalera CORS "segura", no provoca cap petició prèvia (preflight).
        const res = await fetch(this.url, { signal: ctrl.signal, cache: 'no-store', headers: { Range: 'bytes=0-' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        while (this.running) {
          const { value, done } = await reader.read();
          if (done) break;
          lastData = now();
          this.onBytes(s, value, lastData);
        }
      } catch (e) {
        if (!this.running) break;
        if (this.sessionCount === 1 && s.t === 0) {
          // No ha arribat mai res: probablement CORS, URL incorrecta o contingut mixt (http en pàgina https).
          this.running = false;
          clearInterval(watchdog);
          this.setState('error', `No s'ha pogut obrir el flux (${e.message}). Pot ser la URL, CORS, o una emissora http:// des d'una pàgina https://.`);
          return;
        }
      } finally {
        clearInterval(watchdog);
      }
      if (!this.running) break;
      this.reconnects++;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  onBytes(s, bytes, arrival) {
    if (s.firstData === null) s.firstData = arrival;
    const frames = s.parser.push(bytes);
    if (!frames.length) return;
    if (!s.decoder) this.openDecoder(s, frames[0].header);
    for (const { header, data } of frames) {
      const payload = header.kind === 'aac' ? data.subarray(header.headerLen) : data;
      if (s.decoder && s.decoder.state === 'configured') {
        s.decoder.decode(new EncodedAudioChunk({
          type: 'key', timestamp: Math.round(s.t * 1e6), duration: Math.round(header.duration * 1e6), data: payload,
        }));
      }
      s.t += header.duration;
    }
    s.observe(arrival);
    if (s.firstBurst === null && arrival - s.firstData > SETTLE_SEC) s.firstBurst = s.t - (arrival - s.firstData);
  }

  openDecoder(s, h) {
    const config = h.kind === 'aac'
      ? { codec: `mp4a.40.${h.objectType}`, sampleRate: h.sampleRate, numberOfChannels: h.channels, description: aacDescription(h) }
      : { codec: 'mp3', sampleRate: h.sampleRate, numberOfChannels: h.channels };
    this.codecInfo = `${h.kind.toUpperCase()} · ${h.sampleRate / 1000} kHz · ${h.channels === 1 ? 'mono' : 'estèreo'}${h.bitrate ? ` · ${h.bitrate / 1000} kbps` : ''}`;
    s.decoder = new AudioDecoder({
      output: (data) => this.onDecoded(s, data),
      error: (e) => {
        if (s !== this.session) return;
        this.running = false;
        this.abort?.abort();
        this.setState('error', `El navegador no pot descodificar aquest flux (${config.codec}): ${e.message}`);
      },
    });
    s.decoder.configure(config);
  }

  closeDecoder(s) {
    if (s?.decoder && s.decoder.state !== 'closed') { try { s.decoder.close(); } catch {} }
  }

  // ---------- Descodificació → blocs ----------

  onDecoded(s, data) {
    try {
      const ch = data.numberOfChannels, n = data.numberOfFrames, sr = data.sampleRate;
      const planes = copyPlanes(data);
      const t = data.timestamp / 1e6;
      let a = s.acc;
      if (a && (a.ch !== ch || a.sr !== sr || Math.abs(a.t0 + a.frames / a.sr - t) > 0.01)) { this.flushBlock(s); a = null; }
      if (!a) a = s.acc = { t0: t, ch, sr, frames: 0, parts: [] };
      a.parts.push(planes);
      a.frames += n;
      if (a.frames / sr >= BLOCK_SEC) this.flushBlock(s);
    } finally {
      data.close();
    }
  }

  flushBlock(s) {
    const a = s.acc;
    s.acc = null;
    if (!a || !a.frames || s !== this.session) return;
    const buffer = this.ctx.createBuffer(a.ch, a.frames, a.sr);
    for (let c = 0; c < a.ch; c++) {
      const out = buffer.getChannelData(c);
      let pos = 0;
      for (const p of a.parts) { out.set(p[c], pos); pos += p[c].length; }
    }
    this.blocks.push({ session: s, t0: a.t0, dur: a.frames / a.sr, buffer, scheduled: false });
  }

  // ---------- Programació de la reproducció ----------

  // Converteix temps de performance.now (s) a temps de l'AudioContext, tenint en compte la latència de sortida.
  clockMap() {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) {
      const base = ts.contextTime - ts.performanceTime / 1000;
      return (w) => w + base;
    }
    const base = this.ctx.currentTime - now();
    return (w) => w + base;
  }

  resetPlayback() {
    for (const src of this.sources) { try { src.stop(); } catch {} }
    this.sources.clear();
    this.playlog = [];
    for (const b of this.blocks) b.scheduled = false;
    this.last = null;
  }

  tick() {
    if (!this.running || !this.ctx) return;
    const toCtx = this.clockMap();
    const ctxNow = this.ctx.currentTime;
    const wNow = now();
    let playing = false;

    for (const b of this.blocks) {
      if (b.scheduled || !b.session.settled) continue;
      let start = toCtx(b.session.offset + b.t0 + this.delay);
      if (start > ctxNow + LOOKAHEAD) break;
      if (start + b.dur <= ctxNow + 0.05) { b.scheduled = true; continue; } // massa tard: es descarta

      const L = this.last;
      if (L && L.session === b.session && Math.abs(L.tEnd - b.t0) < 0.01 && Math.abs(start - L.ctxEnd) < SNAP_TOL) {
        start = L.ctxEnd; // continu amb l'anterior: enganxa'l sense buits ni clics
      }
      let offset = 0;
      if (L && start < L.ctxEnd) { offset = L.ctxEnd - start; start = L.ctxEnd; }          // solapament (salt endavant / reconnexió)
      if (start < ctxNow + 0.02) { offset += ctxNow + 0.02 - start; start = ctxNow + 0.02; } // arribem tard: retalla l'inici
      b.scheduled = true;
      if (offset >= b.dur - 0.005) continue;

      const src = this.ctx.createBufferSource();
      src.buffer = b.buffer;
      src.connect(this.gain);
      src.onended = () => this.sources.delete(src);
      src.start(start, offset);
      this.sources.add(src);
      this.last = { session: b.session, tEnd: b.t0 + b.dur, ctxEnd: start + b.dur - offset };
      this.playlog.push({ session: b.session, t: b.t0 + offset, ctxStart: start, ctxEnd: this.last.ctxEnd });
      playing = true;
    }

    // Allibera l'historial que ja no pot servir ni augmentant el retard una mica.
    const keepFrom = wNow - this.delay - KEEP_EXTRA;
    while (this.blocks.length && this.blocks[0].scheduled && this.blocks[0].session.offset + this.blocks[0].t0 + this.blocks[0].dur < keepFrom) {
      this.blocks.shift();
    }
    // Blocs d'una sessió antiga que mai no s'han pogut estabilitzar
    if (this.blocks.length > 4000) this.blocks.splice(0, this.blocks.length - 4000);

    while (this.playlog.length && this.playlog[0].ctxEnd < ctxNow - 1) this.playlog.shift();
    if (this.state !== 'error') {
      const st = this.stats();
      if (st.heardDelay !== null) this.setState('sonant', this.session?.settled ? '' : 'Reconnectant amb l\'emissora… (el retard es mantindrà)');
      else if (st.startsIn !== null && st.startsIn > 0.5) this.setState('esperant', `Acumulant àudio: començarà a sonar d'aquí a ${Math.ceil(st.startsIn)} s`);
    }
    if (playing) this.dispatchEvent(new Event('scheduled'));
  }

  // Estat mesurat: quin retard té realment el que sona ara, quant falta per començar, etc.
  stats() {
    const s = this.session;
    const out = {
      heardDelay: null, startsIn: null, liveLatency: null, burst: s?.firstBurst ?? null,
      reconnects: this.reconnects, codec: this.codecInfo, history: null,
    };
    if (!this.ctx || !s) return out;
    const wNow = now();
    const heardAt = this.clockMap()(wNow); // temps de context del que surt ara pels altaveus
    const p = this.playlog.find((e) => e.ctxStart <= heardAt && heardAt < e.ctxEnd);
    if (p && p.session.offset !== null) out.heardDelay = wNow - (p.session.offset + p.t + (heardAt - p.ctxStart));
    if (s.offset === null) return out; // la connexió nova encara no ha rebut res
    out.liveLatency = wNow - (s.offset + s.t);
    const first = this.blocks.find((b) => b.session === s);
    if (first) out.history = wNow - (s.offset + first.t0);
    if (out.heardDelay === null) {
      const next = this.blocks.find((b) => b.session === s && !b.scheduled);
      out.startsIn = next ? s.offset + next.t0 + this.delay - wNow : this.delay - (out.history ?? 0);
    }
    return out;
  }
}

// Copia els canals d'un AudioData a Float32Array per canal, sigui quin sigui el format.
function copyPlanes(data) {
  const ch = data.numberOfChannels, n = data.numberOfFrames;
  const planes = [];
  try {
    for (let c = 0; c < ch; c++) {
      const arr = new Float32Array(n);
      data.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
      planes.push(arr);
    }
    return planes;
  } catch {
    planes.length = 0;
  }
  const fmt = data.format || 'f32';
  const planar = fmt.endsWith('-planar');
  const base = fmt.replace('-planar', '');
  const Ctor = { f32: Float32Array, s16: Int16Array, s32: Int32Array, u8: Uint8Array }[base];
  const scale = { f32: 1, s16: 1 / 32768, s32: 1 / 2147483648, u8: 1 / 128 }[base];
  const bias = base === 'u8' ? -128 : 0;
  if (planar) {
    for (let c = 0; c < ch; c++) {
      const raw = new Ctor(n);
      data.copyTo(raw, { planeIndex: c });
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = (raw[i] + bias) * scale;
      planes.push(out);
    }
  } else {
    const raw = new Ctor(n * ch);
    data.copyTo(raw, { planeIndex: 0 });
    for (let c = 0; c < ch; c++) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = (raw[i * ch + c] + bias) * scale;
      planes.push(out);
    }
  }
  return planes;
}
