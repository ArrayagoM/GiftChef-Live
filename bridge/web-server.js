'use strict';

// Servidor estático del juego web: sirve /web, los JSON de /config y three.js
// desde node_modules (así el juego no depende de un CDN durante el live).
// http://localhost:8081

const http = require('http');
const fs = require('fs');
const path = require('path');

require('./env').loadEnvFile(path.join(__dirname, '.env'));
const botAi = require('./bot-ai');

const PORT = parseInt(process.env.GAME_PORT || '8081', 10);
const ROOT = path.join(__dirname, '..');
const mounts = [
  ['/config/', path.join(ROOT, 'config')],
  ['/three/', path.join(__dirname, 'node_modules', 'three')],
  ['/', path.join(ROOT, 'web')],
];
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
};

function resolve(urlPath) {
  for (const [prefix, dir] of mounts) {
    if (!urlPath.startsWith(prefix)) continue;
    let rel = decodeURIComponent(urlPath.slice(prefix.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) return null; // evita ../
    return file;
  }
  return null;
}

// Fotos de perfil de TikTok: se piden desde acá para que el navegador las reciba del mismo
// origen y el motor 3D pueda usarlas como textura (TikTok no manda cabeceras CORS).
const AVATAR_HOSTS = /(^|\.)(tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|ibyteimg\.com|muscdn\.com|byteimg\.com|tiktok\.com)$/i;
const avatarCache = new Map();

async function serveAvatar(rawUrl, res) {
  let url;
  try { url = new URL(rawUrl); } catch { res.writeHead(400).end('bad url'); return; }
  if (url.protocol !== 'https:' || !AVATAR_HOSTS.test(url.hostname)) {
    res.writeHead(403).end('host not allowed');
    return;
  }
  let entry = avatarCache.get(url.href);
  if (!entry) {
    try {
      const r = await fetch(url.href, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      entry = { type: r.headers.get('content-type') || 'image/jpeg', data: Buffer.from(await r.arrayBuffer()) };
      if (avatarCache.size > 500) avatarCache.delete(avatarCache.keys().next().value);
      avatarCache.set(url.href, entry);
    } catch (err) {
      res.writeHead(502).end('avatar unavailable');
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'max-age=3600' }).end(entry.data);
}

// Avatar de prueba para el modo mock: círculo de color con la inicial.
function mockAvatar(name, res) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const letter = (name.match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},80%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},75%,42%)"/></linearGradient></defs>
<rect width="128" height="128" fill="url(#g)"/>
<text x="64" y="84" font-family="Arial Black,Arial,sans-serif" font-size="64" font-weight="900" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' }).end(svg);
}

// Respuestas con IA del bot. Solo desde esta misma PC: así nadie de la red puede gastar la clave.
const isLoopback = (req) => /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress || '');
const sendJson = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

function handleBotReply(req, res) {
  if (!isLoopback(req)) return sendJson(res, 403, { skip: true, reason: 'forbidden' });
  if (req.method !== 'POST') return sendJson(res, 405, { skip: true, reason: 'method' });
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 8192) { sendJson(res, 413, { skip: true, reason: 'too_large' }); req.destroy(); }
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    let input;
    try { input = JSON.parse(raw); } catch { return sendJson(res, 400, { skip: true, reason: 'bad_json' }); }
    const { status, body } = await botAi.generateReply(input || {});
    if (body.reply) console.log(`[bot-ai] ${input.user}: "${String(input.text).slice(0, 80)}" -> "${body.reply}"`);
    sendJson(res, status, body);
  });
}

// Mediciones de latencia del bot (las manda el juego): se guardan en analisis/latencia.log.
const LAT_LOG = path.join(ROOT, 'analisis', 'latencia.log');
function handleTelemetry(req, res) {
  if (!isLoopback(req) || req.method !== 'POST') return res.writeHead(403).end();
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
  req.on('end', () => {
    const line = `${new Date().toISOString()} ${raw.replace(/\s+/g, ' ')}\n`;
    try {
      // Las ideas de juego que escriben los espectadores van a su propio archivo.
      fs.appendFileSync(raw.includes('"k":"idea"') ? path.join(ROOT, 'analisis', 'ideas.log') : LAT_LOG, line);
    } catch { /* sin carpeta: se ignora */ }
    res.writeHead(204).end();
  });
}

// Voz neuronal (Microsoft): devuelve un mp3. Solo desde esta PC.
let tts = null;
try { tts = require('./tts-service'); } catch (e) { console.log(`[tts] no disponible: ${e.message}`); }

async function handleTts(reqUrl, req, res) {
  if (!isLoopback(req)) return res.writeHead(403).end();
  if (!tts) return res.writeHead(503).end('tts no instalado');
  if (reqUrl.pathname === '/tts/voices') return sendJson(res, 200, await tts.listVoices());
  const text = (reqUrl.searchParams.get('text') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return res.writeHead(400).end('sin texto');
  try {
    const voice = reqUrl.searchParams.get('voice') || await tts.pickVoice((reqUrl.searchParams.get('prefer') || '').split(',').map((s) => s.trim()).filter(Boolean));
    const buf = await tts.synth(text, voice, reqUrl.searchParams.get('rate'));
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Voice': voice }).end(buf);
  } catch (err) {
    res.writeHead(502).end('tts: ' + err.message);
  }
}

http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  if (reqUrl.pathname === '/tts' || reqUrl.pathname === '/tts/voices') {
    handleTts(reqUrl, req, res);
    return;
  }
  if (reqUrl.pathname === '/telemetry') {
    handleTelemetry(req, res);
    return;
  }
  if (reqUrl.pathname === '/bot/status') {
    sendJson(res, 200, botAi.status());
    return;
  }
  if (reqUrl.pathname === '/bot/reply') {
    handleBotReply(req, res);
    return;
  }
  if (reqUrl.pathname === '/avatar') {
    serveAvatar(reqUrl.searchParams.get('u') || '', res);
    return;
  }
  if (reqUrl.pathname.startsWith('/mock-avatar/')) {
    mockAvatar(decodeURIComponent(reqUrl.pathname.slice('/mock-avatar/'.length)).replace(/\.svg$/, ''), res);
    return;
  }
  const file = resolve(reqUrl.pathname);
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(data);
  });
}).listen(PORT, () => {
  console.log(`Juego en http://localhost:${PORT}`);
  const ai = botAi.status();
  console.log(`IA del bot: ${!ai.enabled ? 'apagada (bot.json -> ai.enabled)' : ai.available ? 'activa' : 'sin ANTHROPIC_API_KEY en bridge/.env (se usan frases armadas)'}`);
});
