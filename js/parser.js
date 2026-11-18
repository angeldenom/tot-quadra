// Parser incremental de fluxos MP3 (MPEG-1/2/2.5 Layer III) i AAC (ADTS).
// Rep bytes tal com arriben de la xarxa i retorna trames completes amb la seva durada.

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

// Retorna la capçalera de la trama que comença a buf[i], o null si no n'hi ha cap de vàlida.
export function parseHeader(buf, i) {
  if (i + 7 > buf.length) return null;
  const b1 = buf[i + 1], b2 = buf[i + 2], b3 = buf[i + 3];
  if (buf[i] !== 0xff) return null;

  if ((b1 & 0xf6) === 0xf0) {
    // ADTS (AAC)
    const profile = b2 >> 6;
    const sfIdx = (b2 >> 2) & 0x0f;
    const chanCfg = ((b2 & 1) << 2) | (b3 >> 6);
    const length = ((b3 & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    const blocks = (buf[i + 6] & 3) + 1;
    const headerLen = (b1 & 1) ? 7 : 9;
    if (sfIdx > 12 || chanCfg === 0 || length <= headerLen) return null;
    const sampleRate = ADTS_RATES[sfIdx];
    return {
      kind: 'aac', length, headerLen, sampleRate, channels: chanCfg === 7 ? 8 : chanCfg,
      objectType: profile + 1, sfIdx, chanCfg, duration: (1024 * blocks) / sampleRate,
    };
  }

  if ((b1 & 0xe0) === 0xe0) {
    // MPEG àudio; només Layer III
    const version = (b1 >> 3) & 3; // 0=2.5, 2=2, 3=1
    const layer = (b1 >> 1) & 3; // 1 = Layer III
    const brIdx = b2 >> 4, srIdx = (b2 >> 2) & 3, pad = (b2 >> 1) & 1;
    if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    const bitrate = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[brIdx] * 1000;
    const sampleRate = MP3_RATES[version][srIdx];
    const samples = version === 3 ? 1152 : 576;
    const length = Math.floor((samples / 8) * bitrate / sampleRate) + pad;
    return {
      kind: 'mp3', length, headerLen: 4, sampleRate, channels: (b3 >> 6) === 3 ? 1 : 2,
      bitrate, duration: samples / sampleRate,
    };
  }
  return null;
}

// AudioSpecificConfig (2 bytes) a partir d'una capçalera ADTS, per al `description` de WebCodecs.
export function aacDescription(h) {
  return new Uint8Array([
    (h.objectType << 3) | (h.sfIdx >> 1),
    ((h.sfIdx & 1) << 7) | (h.chanCfg << 3),
  ]);
}

export class FrameParser {
  constructor() {
    this.buf = new Uint8Array(0);
    this.locked = false; // sincronitzat amb el flux
    this.format = null;  // primera capçalera trobada (defineix el còdec)
  }

  // Afegeix bytes i retorna les trames completes: [{ header, data }]
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const buf = merged;
    const frames = [];
    let i = 0;

    while (i + 7 <= buf.length) {
      const h = parseHeader(buf, i);
      const compatible = h && (!this.format || (h.kind === this.format.kind && h.sampleRate === this.format.sampleRate));
      if (!compatible) { this.locked = false; i++; continue; }
      if (i + h.length > buf.length) break; // trama incompleta, espera més dades

      if (!this.locked) {
        // Per evitar falsos sincronismes, exigeix que la trama següent també sigui vàlida.
        if (i + h.length + 7 > buf.length) break;
        const next = parseHeader(buf, i + h.length);
        if (!next || next.kind !== h.kind || next.sampleRate !== h.sampleRate) { i++; continue; }
        this.locked = true;
      }
      if (!this.format) this.format = h;
      frames.push({ header: h, data: buf.subarray(i, i + h.length) });
      i += h.length;
    }

    // Conserva la resta (limitant-la per si mai trobem sincronisme).
    const rest = buf.subarray(i);
    this.buf = rest.length > 65536 ? rest.slice(rest.length - 8192) : rest.slice();
    // Les trames retornades apunten a `merged`, que ja no es modifica.
    return frames;
  }
}
