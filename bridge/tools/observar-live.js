'use strict';

// Observa un live PÚBLICO durante N minutos y guarda SOLO estadísticas agregadas y anónimas:
// ritmo de comentarios, likes, entradas, follows, regalos (nombre, monedas, cantidad), mensajes
// del propio anfitrión y temas frecuentes del chat. Nunca guarda nombres ni identificadores de
// espectadores (los regalos se agrupan con un código corto aleatorio distinto en cada corrida).
//
// Uso:  node tools/observar-live.js <usuario> [minutos=10]
// Una sola conexión, sin reconexión automática (para no llenar de consultas a TikTok).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const handle = String(process.argv[2] || '').replace(/^@/, '');
const minutes = Number(process.argv[3] || 10);
if (!handle) { console.error('Falta el usuario: node tools/observar-live.js <usuario> [minutos]'); process.exit(1); }

const salt = crypto.randomBytes(8).toString('hex');
const anon = (id) => crypto.createHash('sha256').update(String(id) + salt).digest('hex').slice(0, 6);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

let startAt = 0;
let ready = false;
let ended = false;
const seen = new Set();
const buckets = [];
const bucket = () => (buckets[Math.floor((Date.now() - startAt) / 60000)] ||= { chats: 0, likes: 0, joins: 0, follows: 0, social: 0, giftEvents: 0, coins: 0, viewers: null });
const sec = () => Math.round((Date.now() - startAt) / 1000);

const gifts = [];
const hostMsgs = [];
const words = new Map();
const samples = [];
const gifters = new Map();
const chatters = new Set();
const likers = new Set();
const socialKinds = new Map();
let chatTotal = 0;
let questions = 0;
let likesTotal = 0;
let maxViewers = 0;
let firstViewers = null;
let lastViewers = null;

const isNew = (data) => {
  const id = String(data?.common?.msgId ?? '');
  if (!id || id === '0') return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  return true;
};

const idOf = (data) => data?.user?.id || data?.user?.displayId || data?.user?.nickname || 'x';
const stream = (name) => `[${new Date().toLocaleTimeString()}] ${name}`;

const c = new TikTokLiveConnection(handle, { enableExtendedGiftInfo: false, fetchRoomInfoOnConnect: false });
const guard = (fn) => (data) => { if (!ended && isNew(data) && ready) { try { fn(data); } catch { /* evento raro */ } } };

c.on(WebcastEvent.CHAT, guard((d) => {
  const text = String(d.content ?? d.comment ?? '').trim();
  if (!text) return;
  const host = d.userIdentity?.isAnchor || norm(d.user?.displayId) === norm(handle);
  if (host) { hostMsgs.push({ t: sec(), text: text.slice(0, 200) }); return; }
  chatTotal++;
  bucket().chats++;
  chatters.add(anon(idOf(d)));
  if (text.includes('?')) questions++;
  for (const w of norm(text).match(/[a-z]{4,}/g) || []) words.set(w, (words.get(w) || 0) + 1);
  if (samples.length < 70 && text.length <= 90 && !/\d{6,}/.test(text) && !/@/.test(text)) samples.push(text);
}));

c.on(WebcastEvent.GIFT, guard((d) => {
  const g = d.gift || d.giftDetails || {};
  const name = g.name ?? g.giftName ?? 'desconocido';
  const coins = Number(g.diamondCount ?? g.diamond_count ?? 0);
  const streak = (g.type ?? g.giftType) === 1;
  if (streak && !d.repeatEnd) return; // las rachas se cuentan una sola vez, al cerrar
  const count = streak ? Number(d.repeatCount) || 1 : 1;
  const who = anon(idOf(d));
  gifts.push({ t: sec(), name, coins, count, who });
  const b = bucket();
  b.giftEvents++;
  b.coins += coins * count;
  const x = gifters.get(who) || { events: 0, coins: 0 };
  x.events++; x.coins += coins * count;
  gifters.set(who, x);
}));

c.on(WebcastEvent.LIKE, guard((d) => {
  const n = Number(d.count ?? d.likeCount) || 1;
  likesTotal += n;
  bucket().likes += n;
  likers.add(anon(idOf(d)));
}));
c.on(WebcastEvent.MEMBER, guard(() => { bucket().joins++; }));
c.on(WebcastEvent.FOLLOW, guard(() => { bucket().follows++; }));
c.on(WebcastEvent.SOCIAL, guard((d) => {
  bucket().social++;
  const k = String(d.action || d.shareType || 'otro');
  socialKinds.set(k, (socialKinds.get(k) || 0) + 1);
}));
c.on(WebcastEvent.ROOM_USER, (d) => {
  if (!ready || ended) return;
  const v = Number(d.totalUser ?? d.popularity ?? 0);
  if (!v) return;
  if (firstViewers === null) firstViewers = v;
  lastViewers = v;
  maxViewers = Math.max(maxViewers, v);
  bucket().viewers = v;
});

c.on(ControlEvent.CONNECTED, () => {
  startAt = Date.now();
  ready = true;
  console.log(stream(`Conectado a @${handle}. Observando ${minutes} min...`));
});
c.on(ControlEvent.DISCONNECTED, () => { if (!ended) { console.log(stream('Se cortó la conexión: termino con lo recogido.')); finish(); } });

function finish() {
  if (ended) return;
  ended = true;
  const dur = Math.max(1, (Date.now() - startAt) / 60000);
  const byGift = {};
  for (const g of gifts) {
    const e = (byGift[g.name] ||= { veces: 0, unidades: 0, monedasPorUnidad: g.coins, monedasTotal: 0 });
    e.veces++; e.unidades += g.count; e.monedasTotal += g.coins * g.count;
  }
  const tiers = { '1': 0, '2-9': 0, '10-99': 0, '100-999': 0, '1000+': 0 };
  for (const g of gifts) {
    const v = g.coins;
    tiers[v <= 1 ? '1' : v < 10 ? '2-9' : v < 100 ? '10-99' : v < 1000 ? '100-999' : '1000+'] += g.count;
  }
  const totalCoins = gifts.reduce((s, g) => s + g.coins * g.count, 0);
  const sorted = [...gifters.values()].sort((a, b) => b.coins - a.coins);
  const top3 = sorted.slice(0, 3).reduce((s, x) => s + x.coins, 0);
  const repeat = sorted.filter((x) => x.events > 1).length;

  // ¿Suben los regalos justo después de que el anfitrión escribe? (ventana de 30 s)
  let after = 0;
  for (const h of hostMsgs) after += gifts.filter((g) => g.t >= h.t && g.t < h.t + 30).length;
  const baselinePer30 = gifts.length / (dur * 2);
  const afterPer30 = hostMsgs.length ? after / hostMsgs.length : null;

  // Ráfagas: regalos separados por menos de 20 s.
  let bursts = 0; let last = -999;
  for (const g of gifts) { if (g.t - last > 20) bursts++; last = g.t; }

  const stop = new Set(['para', 'pero', 'como', 'esta', 'este', 'todo', 'tengo', 'quiero', 'jajaja', 'jajajaja', 'porque', 'bien', 'mejor', 'puedes', 'hola', 'gracias', 'estas', 'buenas', 'noche']);
  const topWords = [...words.entries()].filter(([w]) => !stop.has(w)).sort((a, b) => b[1] - a[1]).slice(0, 30);

  const out = {
    cuenta: handle,
    fecha: new Date().toISOString(),
    minutosObservados: +dur.toFixed(1),
    espectadores: { inicio: firstViewers, final: lastViewers, maximo: maxViewers },
    totales: {
      comentarios: chatTotal, comentaristasUnicos: chatters.size, likes: likesTotal, likersUnicos: likers.size,
      entradas: buckets.reduce((s, b) => s + (b?.joins || 0), 0), follows: buckets.reduce((s, b) => s + (b?.follows || 0), 0),
      eventosSociales: Object.fromEntries(socialKinds),
      regalos: gifts.length, monedas: totalCoins, donantesUnicos: gifters.size,
    },
    ritmoPorMinuto: buckets.map((b, i) => ({ min: i + 1, ...(b || {}) })),
    regalosPorNombre: byGift,
    regalosPorValor: tiers,
    concentracion: { top3DonantesPct: totalCoins ? Math.round((top3 / totalCoins) * 100) : null, donantesQueRepiten: repeat },
    rafagasDeRegalos: bursts,
    regalosPor30sBase: +baselinePer30.toFixed(2),
    regalosPor30sTrasMensajeDelAnfitrion: afterPer30 === null ? null : +afterPer30.toFixed(2),
    preguntasEnChat: questions,
    palabrasFrecuentes: topWords,
    mensajesDelAnfitrion: hostMsgs,
    muestraDeComentarios: samples,
    lineaDeTiempoRegalos: gifts.map((g) => ({ t: g.t, regalo: g.name, monedas: g.coins, cant: g.count, donante: g.who })),
  };
  const dir = path.join(__dirname, '..', '..', 'analisis');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `observacion_${handle}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(stream(`Listo. Guardado en ${file}`));
  console.log(JSON.stringify({ ...out, lineaDeTiempoRegalos: undefined, muestraDeComentarios: undefined, mensajesDelAnfitrion: out.mensajesDelAnfitrion.length + ' mensajes' }, null, 1));
  c.disconnect().catch(() => {}).finally(() => process.exit(0));
}

// Resumen en vivo cada minuto.
setInterval(() => {
  if (!ready || ended) return;
  const b = buckets[Math.floor((Date.now() - startAt) / 60000)] || {};
  console.log(stream(`min ${Math.floor((Date.now() - startAt) / 60000) + 1}: espectadores=${lastViewers ?? '?'} comentarios=${chatTotal} likes=${likesTotal} regalos=${gifts.length} monedas=${gifts.reduce((s, g) => s + g.coins * g.count, 0)} (este min: ${b.giftEvents || 0} regalos)`));
}, 60000).unref();

c.connect()
  .then(() => setTimeout(finish, minutes * 60000))
  .catch((e) => { console.error(stream(`No se pudo conectar: ${e?.message || e}`)); process.exit(1); });
