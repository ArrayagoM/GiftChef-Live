'use strict';

// Bridge: TikTok LIVE -> (este proceso) -> WebSocket ws://localhost:8080 -> Unity
// Uso:
//   node index.js                 conecta al live de TIKTOK_USERNAME (.env)
//   node index.js --mock          genera eventos falsos (no se conecta a TikTok)
//   node index.js --mock --burst  además manda ráfagas de 100 eventos en 1 s cada 10 s

const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const BURST = args.includes('--burst');

const CONFIG_DIR = path.join(__dirname, '..', 'config');
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
// Además de la consola, todo queda en logs/bridge-AAAA-MM-DD.log (para revisar después qué pasó en un live)
const LOG_DIR = path.join(__dirname, '..', 'logs');
function toFile(level, a) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${ts()}] ${level} ` + a.map((x) => (typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x))).join(' ') + '\n';
    fs.appendFileSync(path.join(LOG_DIR, `bridge-${new Date().toISOString().slice(0, 10)}.log`), line);
  } catch { /* el log nunca debe romper el bridge */ }
}
const log = (...a) => { console.log(`[${ts()}]`, ...a); toFile('INFO', a); };
const warn = (...a) => { console.warn(`[${ts()}] WARN`, ...a); toFile('WARN', a); };
const error = (...a) => { console.error(`[${ts()}] ERROR`, ...a); toFile('ERROR', a); };

require('./env').loadEnvFile(path.join(__dirname, '.env'));

const WS_PORT = parseInt(process.env.WS_PORT || '8080', 10);

// ---------------------------------------------------------------------------
// WebSocket server para Unity
// ---------------------------------------------------------------------------
let droppedSinceLastClient = 0;
let currentUser = '';
let lastUserSwitch = 0;
let lastStatus = 'starting';

const wss = new WebSocketServer({ port: WS_PORT });
wss.on('listening', () => log(`WebSocket escuchando en ws://localhost:${WS_PORT}`));
wss.on('error', (err) => {
  error(`WebSocket server: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    error(`El puerto ${WS_PORT} ya está en uso. ¿Hay otro bridge abierto?`);
    process.exit(1);
  }
});
wss.on('connection', (socket, req) => {
  log(`Unity conectado (${req.socket.remoteAddress}). Clientes: ${wss.clients.size}`);
  if (droppedSinceLastClient > 0) {
    log(`Se descartaron ${droppedSinceLastClient} eventos mientras Unity no estaba conectado`);
    droppedSinceLastClient = 0;
  }
  safeSend(socket, makeEvent('status', { text: lastStatus }));
  if (giftCatalog.length) safeSend(socket, catalogMessage());
  safeSend(socket, makeEvent('status', { text: `user:${currentUser}` }));
  safeSend(socket, presenter.catalog());
  socket.on('message', (raw) => {
    // El juego puede pedir cambiar el usuario de TikTok sin reiniciar el bridge: {"type":"setUser","user":"nombre"}
    try {
      const msg = JSON.parse(String(raw));
      if (msg && msg.type === 'setUser') handleSetUser(msg.user);
      else if (msg && msg.type === 'getInfo') safeSend(socket, makeEvent('status', { text: `user:${currentUser}` }));
      else if (msg && msg.type === 'hello') {
        socket.role = String(msg.role || ''); socket.voiceId = String(msg.clientId || ''); socket.since = Date.now();
        safeSend(socket, presenter.catalog());
        if (socket.role === 'voice') electVoiceOwner();
      }
      else if (msg && msg.type === 'speaking') presenter.onSpeaking(msg);
      else if (msg && msg.type === 'ctl') handleControl(msg);
    } catch { /* mensaje ajeno: se ignora */ }
  });
  socket.on('close', () => { log(`Unity desconectado. Clientes: ${wss.clients.size}`); if (socket.role === 'voice') setTimeout(electVoiceOwner, 50); });
  socket.on('error', (err) => warn(`Socket de Unity: ${err.message}`));
});

// Si hay varios paneles abiertos, habla UNO solo (el más antiguo que sigue conectado); los demás se quedan callados.
// Así nunca se superponen dos voces.
function electVoiceOwner() {
  const voices = [...wss.clients].filter((c) => c.role === 'voice' && c.readyState === WebSocket.OPEN).sort((a, b) => (a.since || 0) - (b.since || 0));
  const owner = voices[0];
  const evt = { type: 'voice_owner', clientId: owner ? owner.voiceId : '', count: voices.length };
  if (voices.length > 1) warn(`Hay ${voices.length} paneles de voz abiertos: habla solo uno`);
  for (const c of voices) safeSend(c, evt);
}

function safeSend(socket, evt) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(evt));
    return true;
  } catch (err) {
    warn(`No se pudo enviar a Unity: ${err.message}`);
    return false;
  }
}

function broadcast(evt) {
  let sent = 0;
  for (const client of wss.clients) if (safeSend(client, evt)) sent++;
  if (sent === 0) droppedSinceLastClient++;
  return sent;
}

// Esquema que consumen los clientes. "giftImage" (ícono del regalo) y "avatar" (foto de
// perfil del usuario) son extensiones opcionales; Unity las ignora.
function makeEvent(type, f = {}) {
  const evt = {
    type,
    user: f.user != null ? String(f.user) : '',
    userId: f.userId != null ? String(f.userId) : '',
    text: f.text ?? null,
    giftName: f.giftName ?? null,
    giftId: f.giftId ?? null,
    diamonds: f.diamonds ?? null,
    count: f.count ?? null,
    ts: Date.now(),
  };
  if (f.tt) evt.tt = f.tt; // hora en que TikTok creó el mensaje: sirve para medir su retraso
  if (type === 'gift') evt.giftImage = f.giftImage ?? null;
  if (f.avatar) evt.avatar = f.avatar;
  if (f.total) evt.total = f.total;   // likes totales del live según TikTok
  return evt;
}

// Retraso entre que TikTok crea el mensaje y llega a este bridge (depende de que el reloj de la PC esté en hora).
const lagNote = (evt) => (evt.tt ? ` [TikTok→bridge ${Math.max(0, evt.ts - evt.tt)} ms]` : '');
const createdAt = (data) => {
  const t = Number(data?.common?.createTime ?? data?.createTime);
  return Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : null;
};

// Presentador (voz y personalidad por personaje) y panel de control.
const { createPresenter } = require('./presenter');
const voiceCount = () => { let n = 0; for (const c of wss.clients) if (c.role === 'voice' && c.readyState === WebSocket.OPEN) n++; return n; };
const presenter = createPresenter({ broadcast: (o) => broadcast(o), log, warn, voiceCount });

// Órdenes del panel de control (página aparte, fuera de la captura del live).
function handleControl(msg) {
  switch (msg.action) {
    case 'setCharacter': presenter.setCharacter(String(msg.id || '')); break;
    case 'setUser': handleSetUser(msg.user); break;
    case 'mute': presenter.setMuted(!!msg.value); break;
    case 'rename': presenter.rename(String(msg.id || ''), msg.name); break;
    case 'pet': presenter.sayPet(msg.text, msg.name, msg.pitch, msg.rate); break;
    case 'voice': presenter.setVoice(String(msg.id || ''), { pitch: msg.pitch, rate: msg.rate, prefer: msg.prefer }); break;
    case 'say': presenter.sayTest(msg.text); break;
    case 'reload': presenter.reload(); broadcast(presenter.catalog()); break;
    case 'sim': simulate(msg); break;
    default: break;
  }
}

// Eventos de prueba con la misma forma que los de TikTok: pasan por el mismo camino (Unity y presentador).
function simulate(msg) {
  const user = String(msg.user || 'Prueba').slice(0, 30);
  const base = { user, userId: `sim_${user}` };
  switch (msg.what) {
    case 'gift': emit(makeEvent('gift', { ...base, giftName: String(msg.gift || 'Rose'), diamonds: Number(msg.diamonds) || 1, count: Math.max(1, Math.min(50, Number(msg.count) || 1)) })); break;
    case 'join': emit(makeEvent('join', base)); break;
    case 'chat': emit(makeEvent('chat', { ...base, text: String(msg.text || 'hola').slice(0, 200) })); break;
    case 'follow': emit(makeEvent('follow', base)); break;
    case 'like': emit(makeEvent('like', { ...base, count: Math.max(1, Math.min(100, Number(msg.count) || 15)), total: Number(msg.total) || 0 })); break;
    case 'crowd': {
      const n = Math.max(2, Math.min(60, Number(msg.count) || 8));
      for (let i = 0; i < n; i++) setTimeout(() => emit(makeEvent('join', { user: `Visitante${i + 1}`, userId: `sim_v${i}` })), i * 120);
      break;
    }
    default: break;
  }
}
function emit(evt) {
  const sent = broadcast(evt);
  if (evt.type !== 'status') presenter.onEvent(evt);
  const suffix = sent === 0 ? ' (Unity no conectado: descartado)' : '';
  switch (evt.type) {
    case 'chat': log(`chat   ${evt.user}: ${evt.text}${lagNote(evt)}${suffix}`); break;
    case 'gift': log(`gift   ${evt.user} -> ${evt.giftName} x${evt.count} (${evt.diamonds} diamantes c/u)${lagNote(evt)}${suffix}`); break;
    case 'like': log(`like   ${evt.user} x${evt.count}${suffix}`); break;
    case 'join': log(`join   ${evt.user}${suffix}`); break;
    case 'follow': log(`follow ${evt.user}${suffix}`); break;
    case 'status': log(`status ${evt.text}${suffix}`); break;
  }
}

// ---------------------------------------------------------------------------
// Catálogo de regalos (nombre, ícono oficial, costo). Se pide a TikTok al conectarse,
// se manda al juego como { type: "catalog", gifts: [...] } y se guarda en disco para que
// el modo mock también muestre los íconos reales.
// ---------------------------------------------------------------------------
const CATALOG_FILE = path.join(__dirname, 'gift-catalog.json');
let giftCatalog = [];
try {
  giftCatalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
} catch { /* todavía no hay catálogo guardado */ }

const catalogMessage = () => ({ type: 'catalog', gifts: giftCatalog, ts: Date.now() });

// La respuesta de TikTok cambia de forma según la versión: se buscan objetos con nombre + imagen.
function extractGifts(raw) {
  const found = new Map();
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
    const image = node.image?.url_list?.[0] || node.image?.urlList?.[0] || node.image?.url?.[0]
      || node.icon?.url_list?.[0] || node.icon?.urlList?.[0];
    if (typeof node.name === 'string' && node.name && image) {
      const key = node.name.toLowerCase();
      if (!found.has(key)) found.set(key, { name: node.name, image, diamonds: node.diamond_count ?? node.diamondCount ?? null });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, depth + 1);
  };
  visit(raw, 0);
  return [...found.values()];
}

function setCatalog(gifts) {
  if (!gifts.length) return;
  giftCatalog = gifts;
  try { fs.writeFileSync(CATALOG_FILE, JSON.stringify(gifts)); } catch (err) { warn(`No se pudo guardar el catálogo: ${err.message}`); }
  log(`Catálogo de regalos: ${gifts.length} regalos con ícono`);
  for (const client of wss.clients) safeSend(client, catalogMessage());
}

function setStatus(text) {
  lastStatus = text;
  emit(makeEvent('status', { text }));
}

// ---------------------------------------------------------------------------
// Normalización de eventos del conector (soporta formato v2 y v1)
// ---------------------------------------------------------------------------
// El conector v2 entrega los mensajes crudos del protocolo v3 de TikTok. Cada lector acepta
// ese formato primero y el viejo (v1) como respaldo. Nombres reales verificados en
// tiktok-live-proto/v3: chat.content, like.count, gift.gift.{name,type,diamondCount,image},
// user.{id,nickname,avatarThumb}.
function userOf(data) {
  const u = data.user || data;
  const avatar = u.avatarThumb?.urlList?.[0] || u.avatarMedium?.urlList?.[0] || u.avatarLarge?.urlList?.[0] || u.profilePictureUrl || null;
  return {
    user: u.nickname || u.displayId || u.uniqueId || 'anon',
    userId: u.id || u.idStr || u.userId || u.displayId || u.uniqueId || '',
    avatar,
  };
}

function onChat(data) {
  // v3 manda el texto en "content"; v1 lo mandaba en "comment".
  const comment = data.content ?? data.comment;
  if (typeof comment !== 'string' || comment.length === 0) return;
  emit(makeEvent('chat', { ...userOf(data), text: comment, tt: createdAt(data) }));
}

// REGLA DE RACHAS: giftType === 1 manda varios eventos; solo se emite el final
// (repeatEnd) con el total. El resto se emite al instante con count = 1.
// Racha sin cierre: si nunca llega repeatEnd (corte de conexión), se emite igual a los 6 s.
const openStreaks = new Map();
const STREAK_TIMEOUT_MS = 6000;

function giftFields(data) {
  // v3: data.gift. v1: data.giftDetails. Con enableExtendedGiftInfo: data.extendedGiftInfo.
  const g = data.gift || data.giftDetails || data.extendedGiftInfo || {};
  return {
    giftType: g.type ?? g.giftType ?? data.giftType,
    giftName: g.name ?? g.giftName ?? data.giftName ?? null,
    diamonds: g.diamondCount ?? g.diamond_count ?? data.diamondCount ?? null,
    giftId: data.giftId != null && !Number.isNaN(Number(data.giftId)) ? Number(data.giftId) : (g.id != null ? Number(g.id) : null),
    giftImage: g.image?.urlList?.[0] ?? g.icon?.urlList?.[0] ?? g.giftImage?.url?.[0] ?? g.giftImage?.giftPictureUrl ?? data.giftPictureUrl ?? null,
  };
}

function onGift(data) {
  const f = giftFields(data);
  const base = { ...userOf(data), giftName: f.giftName, giftId: f.giftId, diamonds: f.diamonds, giftImage: f.giftImage, tt: createdAt(data) };

  // Sin nombre no se puede aplicar ninguna regla: se avisa en vez de descartar en silencio.
  if (!f.giftName) warn(`Regalo sin nombre (giftId=${data.giftId}). Campos: ${Object.keys(data).slice(0, 12).join(', ')}`);

  if (f.giftType !== 1) {
    emit(makeEvent('gift', { ...base, count: 1 }));
    return;
  }

  // Regalo en racha (giftType 1): se emite una sola vez al terminar, con el total.
  const key = `${base.userId}|${data.groupId ?? f.giftId}`;
  const count = Number(data.repeatCount) || 1;
  const open = openStreaks.get(key);
  if (open) clearTimeout(open.timer);
  if (data.repeatEnd) {
    openStreaks.delete(key);
    emit(makeEvent('gift', { ...base, count }));
    return;
  }
  const timer = setTimeout(() => {
    openStreaks.delete(key);
    log(`Racha sin cierre de ${base.user} (${f.giftName}): se cuenta con el último total (${count})`);
    emit(makeEvent('gift', { ...base, count }));
  }, STREAK_TIMEOUT_MS);
  openStreaks.set(key, { timer });
}

function onFollow(data) {
  emit(makeEvent('follow', userOf(data)));
}

function onLike(data) {
  // v3: "count" = likes de este toque. v1: "likeCount".
  emit(makeEvent('like', { ...userOf(data), count: Number(data.count ?? data.likeCount) || 1, total: Number(data.totalLikeCount) || 0 }));
}

function onMember(data) {
  emit(makeEvent('join', userOf(data)));
}

// ---------------------------------------------------------------------------
// Modo en vivo
// ---------------------------------------------------------------------------
function startLive() {
  const username = (process.env.TIKTOK_USERNAME || '').trim().replace(/^@/, '');
  if (!username || username === 'tu_usuario') {
    error('Falta TIKTOK_USERNAME. Copiá .env.example a .env y poné tu usuario (o usá "npm run mock").');
    process.exit(1);
  }

  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
  // enableExtendedGiftInfo y fetchRoomInfoOnConnect usan endpoints de Euler Stream que piden
  // plan pago y hacen fallar la conexión: van apagados. El ícono de cada regalo igual llega en
  // el propio evento (giftDetails.giftImage). EULER_API_KEY (opcional) sube los límites gratis.
  const options = { enableExtendedGiftInfo: false, fetchRoomInfoOnConnect: false };
  if (process.env.EULER_API_KEY) options.signApiKey = process.env.EULER_API_KEY;
  const connection = new TikTokLiveConnection(username, options);
  currentUser = username;
  let stopped = false;
  let badKeyCount = 0;

  let attempt = 0;
  let waitCount = 0;
  let blockedStreak = 0;
  let reconnectTimer = null;

  // Al conectar, TikTok manda un lote de mensajes recientes y lo repite: se descartan los que
  // ya se vieron por su msgId, para que un regalo repetido nunca empuje dos veces.
  const seenMsgIds = new Set();
  const isDuplicate = (data) => {
    const id = String(data?.common?.msgId ?? '');
    if (!id || id === '0') return false;
    if (seenMsgIds.has(id)) return true;
    seenMsgIds.add(id);
    if (seenMsgIds.size > 2000) seenMsgIds.delete(seenMsgIds.values().next().value);
    return false;
  };

  // El lote de mensajes viejos llega ANTES de la confirmación de conexión (y a veces repetido
  // varias veces): hasta que TikTok confirma, no se procesa nada. Medido con un live real.
  let liveReady = false;

  // Vigilante para dejar el live solo: si está "conectado" pero pasan 15 min sin ningún evento, se reconecta por las dudas
  // (una conexión zombi se ve igual que un live vacío). Cuesta una consulta cada 15 min, nada que preocupe a TikTok.
  let lastEventAt = Date.now();
  const silenceTimer = setInterval(() => {
    if (stopped || !liveReady || reconnectTimer) return;
    if (Date.now() - lastEventAt < 10 * 60 * 1000) return;
    lastEventAt = Date.now();
    warn('10 min sin eventos de TikTok: reinicio el bridge entero (el vigilante lo reabre limpio) por si la conexión quedó pegada a una sala vieja');
    setTimeout(() => process.exit(3), 500);
  }, 60000);
  silenceTimer.unref();

  const guard = (fn) => (data) => {
    // Primero se anota el msgId (aunque todavía no esté listo): así la segunda copia del
    // historial, que llega justo después de la confirmación, se reconoce y se descarta.
    if (isDuplicate(data) || !liveReady) return;
    lastEventAt = Date.now();
    try { fn(data); } catch (err) { warn(`Evento con formato inesperado: ${err.message}`); }
  };

  connection.on(WebcastEvent.CHAT, guard(onChat));
  connection.on(WebcastEvent.GIFT, guard(onGift));
  connection.on(WebcastEvent.LIKE, guard(onLike));
  connection.on(WebcastEvent.MEMBER, guard(onMember));
  connection.on(WebcastEvent.FOLLOW, guard(onFollow));

  connection.on(ControlEvent.CONNECTED, () => {
    attempt = 0;
    waitCount = 0;
    badKeyCount = 0;
    blockedStreak = 0;
    liveReady = true;
    setStatus('tiktok_connected');
  });
  connection.on(ControlEvent.DISCONNECTED, () => {
    setStatus('tiktok_disconnected');
    scheduleReconnect('desconectado de TikTok');
  });
  connection.on(WebcastEvent.STREAM_END, () => {
    setStatus('stream_end');
    scheduleReconnect('el live terminó', true);
  });
  connection.on(ControlEvent.ERROR, (err) => {
    // El conector emite { info, exception } además de Error comunes.
    const detail = err?.info || err?.message || err?.exception?.message || JSON.stringify(err);
    warn(`Conector TikTok: ${detail}`);
  });

  function scheduleReconnect(reason, waitingForLive = false, forcedDelay = 0) {
    if (stopped || reconnectTimer) return;
    // Si el live todavía no empezó, se reintenta cada 20 s: alcanza para engancharse enseguida
    // después de "Iniciar LIVE" sin llenar de consultas a TikTok (que bloquea la IP si se abusa).
    // Para otros fallos (red) sigue el backoff 2,4,8...60 s.
    // Esperando el live: 20 s las primeras 15 veces (5 min) y después 60 s, para que dejarlo
    // abierto horas no sea un goteo constante de consultas a TikTok.
    const delay = forcedDelay || (waitingForLive ? (waitCount++ < 15 ? 20000 : 60000) : Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS));
    attempt++;
    log(`Reconectando a TikTok en ${delay / 1000} s (intento ${attempt}, motivo: ${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  async function connect() {
    if (stopped) return;
    liveReady = false;
    log(`Conectando al live de @${username}...`);
    try {
      if (connection.isConnected) await connection.disconnect();
      // Si TikTok no contesta en 25 s se corta y se reintenta (antes la conexión podía quedar colgada para siempre y no entraba ningún evento)
      const state = await Promise.race([
        connection.connect(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: TikTok no respondió en 25 s')), 25000)),
      ]);
      log(`Conectado a TikTok. roomId=${state.roomId}`);
      // Sin consulta extra del catálogo de regalos: cada una es un pedido más a TikTok.
      // Los íconos se aprenden solos con el primer regalo de cada tipo.
    } catch (err) {
      const msg = String(err?.message || err);
      warn(`No se pudo conectar: ${msg}`);
      // "illegal secret key" / fallos raros repetidos: la conexión quedó en mal estado; se reinicia el proceso (el vigilante lo reabre)
      if (/illegal secret key/i.test(msg) && ++badKeyCount >= 2) { warn('Fallo de clave repetido: reinicio el bridge'); setTimeout(() => process.exit(3), 500); }
      setStatus('tiktok_disconnected');
      try { await connection.disconnect(); } catch { /* ya estaba cerrada */ }
      const offline = /isn't online|not online|offline|not live/i.test(msg);
      // "Failed to retrieve ..." / 403 = TikTok está limitando consultas automáticas desde esta PC.
      // Insistir lo empeora: se espera cada vez más (hasta 5 min).
      const throttled = /failed to retrieve|403|forbidden|rate|too many|429/i.test(msg);
      if (throttled) {
        blockedStreak++;
        const wait = Math.min(30000 * blockedStreak, 300000);
        warn(`TikTok parece estar limitando las consultas desde esta PC. Espero ${wait / 1000} s antes de reintentar (no insistas: lo empeora).`);
        scheduleReconnect('TikTok limita las consultas', false, wait);
      } else {
        blockedStreak = 0;
        scheduleReconnect(offline ? 'tu live todavía no empezó' : 'fallo al conectar', offline);
      }
    }
  }

  connect();
  return () => { stopped = true; if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } return connection.disconnect().catch(() => {}); };
}

// ---------------------------------------------------------------------------
// Modo mock: genera eventos "crudos" con la misma forma que el conector v2 y
// los pasa por los mismos handlers, así la regla de rachas también se prueba.
// ---------------------------------------------------------------------------
function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
  } catch (err) {
    return null;
  }
}

function startMock() {
  // Regalos del juego de carrera (race.json) y del prototipo de Unity (gifts.json).
  const race = readJson('race.json') || {};
  const legacy = readJson('gifts.json') || {};
  const byName = new Map();
  for (const g of [...(race.gifts || []), ...(legacy.gifts || [])]) {
    if (g && g.name && !byName.has(g.name.toLowerCase())) byName.set(g.name.toLowerCase(), g);
  }
  if (byName.size === 0) byName.set('rose', { name: 'Rose', points: 5 });
  // Los regalos baratos salen más seguido; los que dan "wins" directos, casi nunca.
  const weighted = [...byName.values()].map((g) => ({
    name: g.name,
    diamonds: g.diamonds || null,
    weight: g.wins ? 0.03 : 1 / Math.sqrt(Math.max(1, g.diamonds || g.points || g.amount || 10)),
  }));
  weighted.push({ name: 'Mystery Box', weight: 0.05 }); // regalo desconocido: debe ignorarse
  const totalWeight = weighted.reduce((s, g) => s + g.weight, 0);
  const pickGift = () => {
    let r = Math.random() * totalWeight;
    for (const g of weighted) if ((r -= g.weight) <= 0) return g.name;
    return weighted[0].name;
  };
  const giftNames = weighted.map((g) => g.name);

  const users = ['ana_gamer', 'juanchi', 'lucia.live', 'elpepe', 'mati99', 'sofi_uwu', 'nico.tk', 'caro'];
  const triggers = (race.commands || []).map((c) => c.trigger);
  const chats = [...triggers, ...triggers, 'hola!!', 'vamos!!', 'jajaja', 'dale que llega', '!boost', '!salto'];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const timers = new Set();
  const later = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };

  function fakeUser() {
    const name = pick(users);
    // Foto de perfil de prueba que genera web-server.js.
    const avatarThumb = { urlList: [`http://localhost:${process.env.GAME_PORT || 8081}/mock-avatar/${encodeURIComponent(name)}.svg`] };
    // Mismo formato que entrega TikTok (protocolo v3): user.id, user.nickname, user.avatarThumb.
    return { id: String(1000 + users.indexOf(name)), nickname: name, avatarThumb };
  }

  // Los eventos de prueba tienen la forma REAL de TikTok (chat.content, like.count, gift.gift.*)
  // para que el modo mock ejercite exactamente el mismo camino que un live de verdad.
  function fakeGift(user, name, streak) {
    // Costo real del regalo si está en la config (así el mock empuja como en vivo).
    const diamondCount = weighted.find((g) => g.name === name)?.diamonds || rand(1, 30);
    const gift = (type) => ({ name, type, diamondCount, image: { urlList: [] } });
    const base = { user, giftId: String(5000 + giftNames.indexOf(name)), groupId: String(Math.random()).slice(2, 10) };
    if (!streak) {
      onGift({ ...base, gift: gift(2), repeatCount: 1, repeatEnd: 0 });
      return;
    }
    // Racha: varios eventos intermedios (repeatEnd=0) y uno final con el total.
    // Los regalos baratos a veces vienen en rachas largas (10, 20... rosas).
    const total = diamondCount <= 5 && Math.random() < 0.3 ? rand(10, 25) : rand(2, 6);
    for (let i = 1; i <= total; i++) {
      later(i * 60, () => onGift({ ...base, gift: gift(1), repeatCount: i, repeatEnd: 0 }));
    }
    later((total + 1) * 60, () => onGift({ ...base, gift: gift(1), repeatCount: total, repeatEnd: 1 }));
  }

  function randomEvent() {
    const user = fakeUser();
    const r = Math.random();
    if (r < 0.20) onChat({ user, content: pick(chats) });
    else if (r < 0.65) fakeGift(user, pickGift(), Math.random() < 0.4);
    else if (r < 0.85) onLike({ user, count: rand(1, 15) });
    else if (r < 0.93) onFollow({ user });
    else onMember({ user });
  }

  function loop() {
    randomEvent();
    later(rand(500, 1500), loop);
  }

  function burst() {
    log('Ráfaga: 100 eventos en 1 s');
    for (let i = 0; i < 100; i++) {
      later(i * 10, () => {
        const user = fakeUser();
        if (i % 2 === 0) onChat({ user, content: pick(chats) });
        else onGift({ user, giftId: '5000', gift: { name: pickGift(), type: 2, diamondCount: 1 }, repeatCount: 1, repeatEnd: 0 });
      });
    }
    later(10000, burst);
  }

  log(`MODO MOCK: generando eventos falsos cada 0,5-1,5 s (regalos: ${giftNames.join(', ')})`);
  setStatus('mock');
  loop();
  if (BURST) later(3000, burst);
  return () => { for (const t of timers) clearTimeout(t); };
}

// ---------------------------------------------------------------------------
let stop = MOCK ? startMock() : startLive();

// Cambio de usuario de TikTok en caliente (lo pide el juego). Se valida el nombre, se limita la frecuencia
// (TikTok bloquea la IP si se piden muchas conexiones) y se guarda en .env para el próximo arranque.
function persistUsername(name) {
  try {
    const file = path.join(__dirname, '.env');
    let text = fs.readFileSync(file, 'utf8');
    text = /^TIKTOK_USERNAME=.*$/m.test(text) ? text.replace(/^TIKTOK_USERNAME=.*$/m, `TIKTOK_USERNAME=${name}`) : `${text}\nTIKTOK_USERNAME=${name}\n`;
    fs.writeFileSync(file, text);
  } catch (err) { warn(`No se pudo guardar el usuario en .env: ${err.message}`); }
}

function handleSetUser(raw) {
  if (MOCK) return;
  const name = String(raw || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{2,40}$/.test(name)) { warn('Usuario inválido: se ignora el cambio'); return; }
  if (name === currentUser) { broadcast(makeEvent('status', { text: `user:${currentUser}` })); return; }
  if (Date.now() - lastUserSwitch < 10000) { warn('Cambio de usuario demasiado seguido: se ignora'); return; }
  lastUserSwitch = Date.now();
  log(`Cambio de usuario: @${currentUser} -> @${name}`);
  try { stop(); } catch { /* ignorar */ }
  process.env.TIKTOK_USERNAME = name;
  persistUsername(name);
  stop = startLive();
  broadcast(makeEvent('status', { text: `user:${currentUser}` }));
}

function shutdown() {
  log('Cerrando bridge...');
  try { stop(); } catch { /* ignorar */ }
  for (const client of wss.clients) client.terminate();
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => error(`Excepción no capturada: ${err.stack || err}`));
process.on('unhandledRejection', (err) => error(`Promesa rechazada sin manejar: ${err?.stack || err}`));
