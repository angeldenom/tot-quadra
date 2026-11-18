import { RadioEngine } from './engine.js';

const PRESETS = [
  { name: 'Catalunya Ràdio', url: 'https://shoutcast.ccma.cat/ccma/catalunyaradioHD.mp3' },
  { name: 'Catalunya Informació', url: 'https://shoutcast.ccma.cat/ccma/catalunyainformacioHD.mp3' },
  { name: 'RAC1', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RAC_1.mp3' },
  { name: 'RAC1 (AAC)', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/RAC_1AAC.aac' },
  { name: 'Tarragona Ràdio', url: 'https://relay.stream.enacast-cloud.com:40007/tarragona56.mp3' },
];
const RADIO_BROWSER = ['https://de1.api.radio-browser.info', 'https://at1.api.radio-browser.info', 'https://nl1.api.radio-browser.info'];

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rs.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rs.' + k, JSON.stringify(v)); } catch {} },
};

const engine = new RadioEngine();
let custom = store.get('custom', []);
let delays = store.get('delays', {});

// ---------- Emissores ----------

function allStations() { return [...PRESETS, ...custom]; }

function renderStations(selectUrl) {
  const sel = $('station');
  sel.innerHTML = '';
  const add = (list, label) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const s of list) g.append(new Option(s.name, s.url));
    sel.append(g);
  };
  add(PRESETS, 'Emissores');
  add(custom, 'Les meves');
  sel.value = selectUrl ?? store.get('station', PRESETS[0].url);
  if (!sel.value) sel.value = PRESETS[0].url;
}

function currentUrl() { return $('station').value; }

function addStation(name, url) {
  if (!allStations().some((s) => s.url === url)) {
    custom.push({ name, url });
    store.set('custom', custom);
  }
  renderStations(url);
  onStationChange();
}

function onStationChange() {
  store.set('station', currentUrl());
  setDelay(delays[currentUrl()] ?? delays._last ?? 30, { save: false });
  if (engine.running) start();
}

async function search() {
  const q = $('q').value.trim();
  if (!q) return;
  const ul = $('results');
  ul.innerHTML = '<li><small>Cercant…</small></li>';
  let list = null;
  for (const host of RADIO_BROWSER) {
    try {
      const r = await fetch(`${host}/json/stations/search?name=${encodeURIComponent(q)}&limit=30&hidebroken=true&order=clickcount&reverse=true`);
      if (r.ok) { list = await r.json(); break; }
    } catch {}
  }
  ul.innerHTML = '';
  if (!list) { ul.innerHTML = '<li><small>No s\'ha pogut consultar el directori de ràdios.</small></li>'; return; }
  const usable = list.filter((s) => /mp3|aac/i.test(s.codec));
  if (!usable.length) { ul.innerHTML = '<li><small>Cap resultat en MP3 o AAC.</small></li>'; return; }
  for (const s of usable) {
    const li = document.createElement('li');
    const insecure = location.protocol === 'https:' && s.url_resolved.startsWith('http:');
    const info = document.createElement('span');
    info.innerHTML = `${escapeHtml(s.name)} <small>${escapeHtml([s.state || s.country, s.codec, s.bitrate ? s.bitrate + ' kbps' : ''].filter(Boolean).join(' · '))}${insecure ? ' · http (pot fallar)' : ''}</small>`;
    const btn = document.createElement('button');
    btn.textContent = 'Afegeix';
    btn.onclick = () => addStation(s.name.trim(), s.url_resolved);
    li.append(info, btn);
    ul.append(li);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Retard ----------

function fmt(n, d = 1) { return n.toLocaleString('ca', { minimumFractionDigits: d, maximumFractionDigits: d }); }

function setDelay(v, { save = true } = {}) {
  v = Math.round(Math.min(600, Math.max(1, v)) * 10) / 10;
  $('delay').value = v.toFixed(1);
  engine.setDelay(v);
  if (save) {
    delays[currentUrl()] = v;
    delays._last = v;
    store.set('delays', delays);
  }
}

// ---------- Calibratge ----------

const marks = { radio: null, video: null };
function mark(kind) {
  marks[kind] = performance.now() / 1000;
  $(kind === 'radio' ? 'markRadio' : 'markVideo').classList.add('armed');
  if (marks.radio !== null && marks.video !== null) {
    const diff = marks.video - marks.radio; // positiu: la ràdio encara va massa d'hora
    if (Math.abs(diff) < 120) setDelay(engine.delay + diff);
    marks.radio = marks.video = null;
    $('markRadio').classList.remove('armed');
    $('markVideo').classList.remove('armed');
    flash(`Retard ajustat ${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff))} s`);
  }
}
let flashUntil = 0;
function flash(msg) { $('statusDetail').textContent = msg; flashUntil = performance.now() + 3000; }

// ---------- Reproducció i estat ----------

async function start() {
  try {
    $('play').disabled = true;
    await engine.start(currentUrl());
    $('stop').disabled = false;
  } catch (e) {
    showState('error', e.message);
    $('play').disabled = false;
  }
}

function stop() {
  engine.stop();
  $('play').disabled = false;
  $('stop').disabled = true;
}

const LABELS = { aturat: 'Aturat', connectant: 'Connectant…', reconnectant: 'Reconnectant…', esperant: 'Esperant àudio', sonant: 'Sonant', error: 'Error' };
function showState(state, detail) {
  $('statusBox').className = 'st-' + state;
  $('statusText').textContent = LABELS[state] ?? state;
  if (performance.now() > flashUntil) $('statusDetail').textContent = detail || '';
  if (state === 'error' || state === 'aturat') { $('play').disabled = false; $('stop').disabled = state === 'aturat'; }
}
engine.addEventListener('state', (e) => showState(e.detail.state, e.detail.detail));

setInterval(() => {
  const s = engine.stats();
  const sec = (v) => (v === null ? '—' : fmt(v) + ' s');
  $('sHeard').textContent = sec(s.heardDelay);
  $('sBurst').textContent = sec(s.burst);
  $('sHistory').textContent = sec(s.history);
  $('sReconn').textContent = s.reconnects;
  $('sCodec').textContent = s.codec || '—';
}, 250);

// ---------- Esdeveniments ----------

$('station').addEventListener('change', onStationChange);
$('play').addEventListener('click', start);
$('stop').addEventListener('click', stop);
$('search').addEventListener('click', search);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
$('addCustom').addEventListener('click', () => {
  const url = $('customUrl').value.trim();
  if (!/^https?:\/\//.test(url)) return;
  let name = url;
  try { name = new URL(url).hostname; } catch {}
  addStation(name, url);
  $('customUrl').value = '';
});
$('delay').addEventListener('change', () => setDelay(parseFloat($('delay').value) || 0));
for (const b of document.querySelectorAll('[data-step]')) b.addEventListener('click', () => setDelay(engine.delay + parseFloat(b.dataset.step)));
$('markRadio').addEventListener('click', () => mark('radio'));
$('markVideo').addEventListener('click', () => mark('video'));
$('vol').addEventListener('input', () => { engine.setVolume(+$('vol').value); store.set('vol', +$('vol').value); });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const steps = { ArrowLeft: e.shiftKey ? -1 : -0.2, ArrowRight: e.shiftKey ? 1 : 0.2, PageDown: -5, PageUp: 5 };
  if (e.key in steps) { e.preventDefault(); setDelay(engine.delay + steps[e.key]); }
  else if (e.key === 'r' || e.key === 'R') mark('radio');
  else if (e.key === 'v' || e.key === 'V') mark('video');
  else if (e.key === ' ') { e.preventDefault(); engine.running ? stop() : start(); }
});

// ---------- Inici ----------

renderStations();
$('vol').value = store.get('vol', 1);
engine.setVolume(+$('vol').value);
setDelay(delays[currentUrl()] ?? delays._last ?? 30, { save: false });
