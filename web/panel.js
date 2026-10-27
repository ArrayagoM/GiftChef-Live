'use strict';

// Panel de control + motor de voz. Abrir en una ventana de Edge APARTE (no la que captura el live):
// desde acá se cambia el personaje, se hacen pruebas y es la página que habla con las voces del personaje.

const $ = (id) => document.getElementById(id);
const WS_URL = `ws://${location.hostname || 'localhost'}:8080`;
let ws = null;
let catalog = { current: '', muted: false, characters: [] };
let voices = [];
let lastVoiceName = '';
let audioReady = false;

// ---------------------------------------------------------------- registro
function log(text, cls = '') {
  const box = $('log');
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  box.appendChild(d);
  while (box.children.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- voces
function loadVoices() {
  voices = (speechSynthesis.getVoices() || []).filter((v) => /^es/i.test(v.lang));
  const natural = voices.filter((v) => /natural|online/i.test(v.name)).length;
  $('pillVoice').textContent = natural > 0 ? `Voz: ${voices.length} en español (${natural} naturales)` : `Voz: ${voices.length} en español, SIN voces Naturales: abrí este panel en Microsoft Edge`;
  try { if (catalog && catalog.characters && catalog.characters.length) loadCalibrator(); } catch (e) { /* el panel aún no terminó de cargar */ }
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

// Orden: 1) la voz Natural (Microsoft, humana) que pide el personaje, 2) cualquier otra voz Natural en español
// (primero es-AR / es-MX / es-US), 3) recién ahí las voces comunes (robóticas), por si no hay ninguna Natural.
function pickVoice(prefs) {
  const isNat = (x) => /natural|online/i.test(x.name);
  for (const p of prefs || []) {
    const v = voices.find((x) => x.name.toLowerCase().includes(String(p).toLowerCase()) && isNat(x));
    if (v) return v;
  }
  const naturals = voices.filter(isNat);
  if (naturals.length) {
    for (const lang of ['es-AR', 'es-MX', 'es-US', 'es-CO', 'es-ES']) { const v = naturals.find((x) => x.lang.replace('_', '-').toLowerCase() === lang.toLowerCase()); if (v) return v; }
    return naturals[0];
  }
  for (const p of prefs || []) {
    const v = voices.find((x) => x.name.toLowerCase().includes(String(p).toLowerCase()));
    if (v) return v;
  }
  return voices[0] || null;
}

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

var MY_ID = Math.random().toString(36).slice(2, 10), voiceOwner = '', lastSayId = -1;

// ---------------------------------------------------------------- voz neuronal con tono real
// El audio lo genera el bridge (voces Natural de Microsoft) y acá se reproduce cambiando la velocidad SIN conservar el tono:
// así la barra de tono sube o baja la voz de verdad (tono 1.3-1.5 sobre una voz de hombre = voz de niño).
var neuralVoices = [], currentAudio = null;
const clampN = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function useNeural() { const c = $('chkNeural'); return !c || c.checked; }

async function speakNeural(msg) {
  const done = (state) => { if (!msg.local) send({ type: 'speaking', state, id: msg.id }); };
  if (catalog.muted) { setTimeout(() => done('end'), 200); return; }
  const prof = msg.voice || {};
  const pitch = clampN(prof.pitch, 0.5, 2, 1), vel = clampN(prof.rate, 0.5, 2, 1);
  const rate = clampN(vel / pitch, 0.5, 2, 1);                      // compensa: el tempo final queda en "vel"
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 22000);
  const r = await fetch(`/tts?text=${encodeURIComponent(msg.text)}&prefer=${encodeURIComponent((prof.prefer || []).join(','))}&rate=${rate}`, { signal: ctrl.signal });
  clearTimeout(to);
  if (!r.ok) throw new Error('tts ' + r.status);
  const blob = await r.blob();
  if (msg._t !== speakToken) { done('end'); return; }      // mientras se generaba llegó una frase más nueva: esta ya no se dice
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  a.preservesPitch = false; a.mozPreservesPitch = false; a.webkitPreservesPitch = false;
  a.playbackRate = pitch;
  a.volume = msg.volume != null ? Number(msg.volume) : Number($('vol').value);
  lastVoiceName = r.headers.get('X-Voice') || 'neural';
  $('voiceInfo').textContent = `voz: ${lastVoiceName} · tono ${pitch} · vel ${vel}`;
  if (currentAudio) { try { currentAudio.pause(); } catch (e) { /* ya terminó */ } }
  speechSynthesis.cancel();
  currentAudio = a;
  await new Promise((resolve, reject) => {
    let ended = false, started = false;
    const finish = () => { if (!ended) { ended = true; URL.revokeObjectURL(url); done('end'); resolve(); } };
    a.onplay = () => { started = true; done('start'); };
    a.onended = finish;
    a.onerror = () => { if (!ended) { ended = true; URL.revokeObjectURL(url); started ? resolve() : reject(new Error('audio')); } };   // si ya sonó, no se repite con otra voz
    setTimeout(finish, 6000 + msg.text.length * 200);
    a.play().catch((e) => {
      if (ended) return;
      ended = true;
      if (currentAudio !== a) { done('end'); resolve(); return; }   // la interrumpió otra frase: se descarta, sin voz de respaldo
      reject(e);
    });
  });
}

var speakToken = 0;
function speak(msg) {
  const token = ++speakToken;              // cada frase nueva anula a la anterior: nunca hablan dos a la vez
  msg._t = token;
  if (useNeural() && !catalog.muted) {
    speakNeural(msg).catch((e) => {
      if (token !== speakToken) return;    // la cortó una frase más nueva: no se repite con otra voz
      log(`Voz neural no disponible (${e.message}); uso la voz del navegador`, 'err'); speakLocal(msg);
    });
    return;
  }
  speakLocal(msg);
}

function speakLocal(msg) {
  const done = (state) => { if (!msg.local) send({ type: 'speaking', state, id: msg.id }); };   // local = prueba del calibrador: no avisa al bridge
  if (catalog.muted || !('speechSynthesis' in window)) { setTimeout(() => done('end'), 200); return; }
  const prof = msg.voice || {};
  const u = new SpeechSynthesisUtterance(msg.text);
  const v = pickVoice(prof.prefer);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-AR';
  u.pitch = Math.max(0, Math.min(2, Number(prof.pitch) || 1));
  u.rate = Math.max(0.5, Math.min(2, Number(prof.rate) || 1));
  u.volume = msg.volume != null ? Number(msg.volume) : Number($('vol').value);
  lastVoiceName = v ? v.name : 'predeterminada';
  $('voiceInfo').textContent = `voz: ${lastVoiceName} · tono ${u.pitch} · vel ${u.rate}`;
  let ended = false;
  const finish = () => { if (!ended) { ended = true; done('end'); } };
  u.onstart = () => done('start');
  u.onend = finish;
  u.onerror = (e) => { log(`Error de voz: ${e.error}`, 'err'); finish(); };
  // Por si el navegador no avisa que terminó
  setTimeout(finish, 4000 + msg.text.length * 160);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------- audio (un toque para habilitarlo)
function unlockAudio() {
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    audioReady = true;
    $('audioBanner').style.display = 'none';
    log('Audio activado');
  } catch (e) { log('No se pudo activar el audio: ' + e.message, 'err'); }
}
$('btnAudio').onclick = unlockAudio;
// Si Edge se abrió con --autoplay-policy=no-user-gesture-required, anda sin tocar nada; si no, se muestra el aviso.
setTimeout(() => { if (!audioReady) $('audioBanner').style.display = 'block'; }, 2500);
window.addEventListener('pointerdown', () => { if (!audioReady) unlockAudio(); }, { once: true });

// ---------------------------------------------------------------- conexión con el bridge
function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;   // nunca dos conexiones: dos conexiones = dos voces
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    $('dotBridge').className = 'dot ok'; $('txtBridge').textContent = 'Bridge conectado';
    send({ type: 'hello', role: 'voice', clientId: MY_ID });
    send({ type: 'getInfo' });
    log('Conectado al bridge');
  };
  ws.onclose = () => {
    $('dotBridge').className = 'dot'; $('txtBridge').textContent = 'Sin conexión con el bridge';
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
}

// Contador de eventos reales (los de prueba empiezan con sim_) para ver de un vistazo si TikTok está mandando datos
const evCount = { like: 0, chat: 0, gift: 0, follow: 0, join: 0 }; let lastReal = 0;
function countReal(m) {
  if (!(m.type in evCount) || String(m.userId || '').startsWith('sim_')) return;
  evCount[m.type] += (m.type === 'like' ? Math.max(1, m.count || 1) : 1); lastReal = Date.now();
}
setInterval(() => {
  const el = $('pillEv'); if (!el) return;
  const ago = lastReal ? Math.round((Date.now() - lastReal) / 1000) : -1;
  el.textContent = ago < 0 ? 'Eventos reales: todavía ninguno' : `Último evento real hace ${ago < 90 ? ago + ' s' : Math.round(ago / 60) + ' min'} · taps ${evCount.like} · chat ${evCount.chat} · regalos ${evCount.gift} · seguidores ${evCount.follow}`;
  el.style.color = ago >= 0 && ago < 60 ? '' : '#ffb347';
}, 1000);

function handle(m) {
  countReal(m);
  switch (m.type) {
    case 'catalog_chars': catalog = m; $('chkMute').checked = !!m.muted; renderChars(); loadCalibrator(); break;
    case 'voice_owner': voiceOwner = m.clientId; $('pillVoice').title = m.count > 1 ? `Hay ${m.count} paneles abiertos; habla ${voiceOwner === MY_ID ? 'este' : 'otro'}` : ''; break;
    case 'say':
      log(`${m.name}: ${m.text}`, 'say');
      if (voiceOwner && voiceOwner !== MY_ID) break;     // hay otro panel abierto que es el que habla: este se queda callado
      if (m.id === lastSayId) break;                     // la misma frase no se dice dos veces
      lastSayId = m.id;
      speak(m);
      break;
    case 'character': log(`Personaje: ${m.name}`, 'evt'); break;
    case 'status':
      if (String(m.text || '').startsWith('user:')) { $('userHint').textContent = `Usuario actual: @${m.text.slice(5)}`; if (!$('userInput').value) $('userInput').value = m.text.slice(5); }
      else if (m.text === 'tiktok_connected') { $('dotTk').className = 'dot ok'; $('txtTk').textContent = 'TikTok: en vivo'; }
      else if (m.text) { $('dotTk').className = m.text === 'stream_end' || m.text === 'tiktok_disconnected' ? 'dot' : 'dot warn'; $('txtTk').textContent = `TikTok: ${m.text}`; }
      break;
    case 'gift': log(`🎁 ${m.user} → ${m.giftName} x${m.count || 1}`, 'evt'); break;
    case 'join': log(`👤 ${m.user} entró`, 'evt'); break;
    case 'chat': log(`💬 ${m.user}: ${m.text}`, 'evt'); break;
    case 'follow': log(`➕ ${m.user} te sigue`, 'evt'); break;
    default: break;
  }
}

// ---------------------------------------------------------------- interfaz
function renderChars() {
  const box = $('chars');
  box.textContent = '';
  for (const c of catalog.characters) {
    const b = document.createElement('button');
    b.className = 'char' + (c.id === catalog.current ? ' on' : '');
    b.disabled = !c.enabled;
    const n = document.createElement('b'); n.textContent = c.name;
    const s = document.createElement('small'); s.textContent = c.id === catalog.current ? 'activo' : (c.enabled ? 'tocá para usarlo' : 'sin modelo');
    b.append(n, s);
    b.onclick = () => send({ type: 'ctl', action: 'setCharacter', id: c.id });
    box.appendChild(b);
  }
}

// ---------------------------------------------------------------- calibrar la voz del cocinero
function shortVoice(name) { const m = /Microsoft\s+(\S+)/i.exec(name || ''); return m ? m[1] : (name || ''); }
var calBase = null;   // valores guardados del cocinero activo (para "Deshacer")

function fillVoiceSelect(selectedPrefer) {
  const sel = $('calVoice'); sel.textContent = '';
  const auto = document.createElement('option'); auto.value = ''; auto.textContent = '(automática del personaje)'; sel.appendChild(auto);
  let chosen = '';
  if (useNeural() && neuralVoices.length) {
    const label = (v) => `${v.name} · ${v.locale.replace('es-', '')} · ${v.gender === 'Male' ? 'hombre' : 'mujer'}`;
    for (const v of neuralVoices) { const o = document.createElement('option'); o.value = v.name; o.textContent = label(v); sel.appendChild(o); }
    for (const p of selectedPrefer || []) { const v = neuralVoices.find((x) => x.name.toLowerCase() === String(p).toLowerCase()); if (v) { chosen = v.name; break; } }
  } else {
    for (const v of voices) { const o = document.createElement('option'); o.value = shortVoice(v.name); o.textContent = v.name; sel.appendChild(o); }
    for (const p of selectedPrefer || []) { const v = voices.find((x) => x.name.toLowerCase().includes(String(p).toLowerCase())); if (v) { chosen = shortVoice(v.name); break; } }
  }
  sel.value = chosen;
}

fetch('/tts/voices').then((r) => r.json()).then((v) => { neuralVoices = Array.isArray(v) ? v : []; try { loadCalibrator(); } catch (e) { /* aún no hay personajes */ } }).catch(() => {});
try { const saved = localStorage.getItem('useNeural'); if (saved !== null && $('chkNeural')) $('chkNeural').checked = saved === '1'; } catch (e) { /* sin almacenamiento */ }
if ($('chkNeural')) $('chkNeural').onchange = () => { try { localStorage.setItem('useNeural', $('chkNeural').checked ? '1' : '0'); } catch (e) { /* ok */ } loadCalibrator(); };

function calValues() {
  return { pitch: Number($('calPitchN').value) || 1, rate: Number($('calRateN').value) || 1, voice: $('calVoice').value, volume: Number($('calVolN').value) };
}
function calMark() {
  const v = calValues(); const same = calBase && Math.abs(v.pitch - calBase.pitch) < 0.005 && Math.abs(v.rate - calBase.rate) < 0.005 && v.voice === calBase.voice;
  $('calInfo').textContent = same ? 'sin cambios' : 'cambios sin guardar';
}
function calLink(rangeId, numId, lo, hi, after) {
  const r = $(rangeId), n = $(numId);
  r.oninput = () => { n.value = r.value; after && after(); calMark(); };
  n.oninput = () => { let x = Number(n.value); if (!Number.isFinite(x)) return; x = Math.max(lo, Math.min(hi, x)); r.value = x; after && after(); calMark(); };
}
calLink('calPitch', 'calPitchN', 0.5, 2);
calLink('calRate', 'calRateN', 0.5, 2);
calLink('calVol', 'calVolN', 0, 1, () => { $('vol').value = $('calVolN').value; });
$('calVoice').onchange = calMark;
$('vol').addEventListener('input', () => { $('calVol').value = $('vol').value; $('calVolN').value = $('vol').value; });

function loadCalibrator() {
  const c = catalog.characters.find((x) => x.id === catalog.current);
  if (!c) return;
  const v = c.voice || {};
  $('calName').textContent = c.name;
  fillVoiceSelect(v.prefer);
  const pitch = Number(v.pitch) || 1, rate = Number(v.rate) || 1;
  $('calPitch').value = $('calPitchN').value = pitch; $('calRate').value = $('calRateN').value = rate;
  $('calVol').value = $('calVolN').value = $('vol').value;
  calBase = { pitch, rate, voice: $('calVoice').value };
  calMark();
}

$('calTest').onclick = () => {
  const v = calValues();
  speechSynthesis.cancel();
  speak({ id: -1, local: true, text: $('calText').value || 'Hola', volume: v.volume, voice: { prefer: v.voice ? [v.voice] : (catalog.characters.find((x) => x.id === catalog.current)?.voice?.prefer || []), pitch: v.pitch, rate: v.rate } });
};
$('calSave').onclick = () => {
  const v = calValues();
  // La voz elegida va primero y se conservan las de respaldo del personaje (así anda también en otra PC)
  const base = (catalog.characters.find((x) => x.id === catalog.current)?.voice?.prefer) || [];
  const prefer = v.voice ? [v.voice, ...base.filter((p) => String(p).toLowerCase() !== v.voice.toLowerCase())] : base;
  send({ type: 'ctl', action: 'voice', id: catalog.current, pitch: v.pitch, rate: v.rate, prefer });
  log(`Voz guardada: tono ${v.pitch}, velocidad ${v.rate}, voz ${v.voice || 'automática'}`);
};
$('calUndo').onclick = () => { if (!calBase) return; $('calPitch').value = $('calPitchN').value = calBase.pitch; $('calRate').value = $('calRateN').value = calBase.rate; $('calVoice').value = calBase.voice; calMark(); };

$('btnRename').onclick = () => {
  const n = $('chefName').value.trim();
  if (n.length < 2) { log('Escribí un nombre de al menos 2 letras', 'err'); return; }
  send({ type: 'ctl', action: 'rename', id: catalog.current, name: n });
  $('chefName').value = '';
};
$('chkMute').onchange = (e) => send({ type: 'ctl', action: 'mute', value: e.target.checked });
$('btnSay').onclick = () => send({ type: 'ctl', action: 'say', text: $('sayText').value });
$('btnUser').onclick = () => {
  const u = $('userInput').value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{2,40}$/.test(u)) { log('Usuario inválido (letras, números, punto y guion bajo)', 'err'); return; }
  send({ type: 'ctl', action: 'setUser', user: u });
  log(`Pidiendo conectar a @${u}`);
};
document.querySelectorAll('[data-sim]').forEach((b) => {
  b.onclick = () => { const d = JSON.parse(b.dataset.sim); send({ type: 'ctl', action: 'sim', ...d }); };
});

connect();
