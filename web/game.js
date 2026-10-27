// Héroes vs Villanos: cinchada 3D para TikTok LIVE.
// Recibe eventos del bridge (ws://localhost:8080) y las reglas de /config/race.json.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { configureSound, unlockAudio, sfx, toggleMusic, setMusic, duckMusic } from './sound.js';
import { Bot } from './bot.js';
import { HostAvatar } from './avatar.js';

// ?ws=8090 conecta a otro bridge (pruebas); ?monitor=1 es una vista sin sonido ni voz para
// controlar el live desde otra pantalla sin duplicar el audio.
const PARAMS = new URLSearchParams(location.search);
const MONITOR = PARAMS.has('monitor');
const WS_URL = `ws://${location.hostname || 'localhost'}:${Number(PARAMS.get('ws')) || 8080}`;
const TRACK_HALF = 55;          // unidades de mundo desde el centro hasta cada meta
const BALL_R = 1.3;
const MAX_PUSHERS = 9;          // personajes en pantalla a la vez (pantalla limpia)
const MAX_PUSHERS_BUSY = 14;    // con mucha cola (rachas grandes) se permiten más
const BACKLOG_LIMIT = 220;      // si la cola supera esto, se aplica directo (nunca se pierde nada)
const MAX_PUSHES_PER_GIFT = 100; // un muñeco da hasta 100 empujones; más unidades se reparten en esos 100
const USER_COMMAND_COOLDOWN_MS = 2000;
const CELEBRATE_MS = 4500;
const WINS_KEY = 'hv.wins.teams';
const ICONS_KEY = 'hv.giftIcons';
const TEAM_SIGN = { heroes: 1, villains: -1 };
const INK = '#0d1530';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const storage = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin storage */ } },
};

// ---------------------------------------------------------------------------
// Marca del autor (config/brand.json). Con valores por defecto por si el archivo falta.
// ---------------------------------------------------------------------------
const brand = {
  name: 'TinTech', handle: '@tinchotech', tagline: 'Desarrollador Full Stack · Robótica · IoT', presents: 'presenta',
  gameTitleTop: 'HÉROES', gameTitleMid: 'vs', gameTitleBottom: 'VILLANOS', accent: '#19e3ff', splashSeconds: 3.4, ballMark: 'T',
};

async function loadBrand() {
  try {
    Object.assign(brand, await (await fetch('/config/brand.json', { cache: 'no-store' })).json());
  } catch { /* se usan los valores por defecto */ }
  document.documentElement.style.setProperty('--accent', brand.accent);
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('brandName', brand.name); set('brandHandle', brand.handle);
  set('splashBrand', brand.name); set('splashPresents', brand.presents); set('splashTag', brand.tagline);
  set('stTop', brand.gameTitleTop); set('stMid', brand.gameTitleMid); set('stBottom', brand.gameTitleBottom);
  document.querySelectorAll('.sigName').forEach((e) => { e.textContent = brand.name; });
  document.querySelectorAll('.sigHandle').forEach((e) => { e.textContent = brand.handle; });
}

let splashTimer = 0;
function playSplash() {
  const el = $('splash');
  if (!el || !el.classList.contains('hidden')) return;
  el.classList.remove('out', 'hidden');
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.classList.add('hidden'), 650);
  }, Math.max(1.5, Number(brand.splashSeconds) || 3.4) * 1000);
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
let cfg = null;
const giftRules = new Map();      // nombre en minúsculas -> regla
const commandRules = new Map();   // trigger en minúsculas -> regla
let likeRule = null;
let followRule = null;
const giftIcons = storage.get(ICONS_KEY, {});

function normalizeRule(raw, key, label) {
  if (!raw || !TEAM_SIGN[raw.team]) return null;
  const explicit = raw.points ?? raw.pointsPerLike;
  const diamonds = Math.max(0, Number(raw.diamonds) || 0);
  return {
    key,
    label: label || raw.label || raw.name || key,
    team: raw.team,
    // Sin "points" explícito, cada unidad vale su costo en monedas (diamonds × pointsPerDiamond).
    points: explicit != null ? Math.max(0, Number(explicit) || 0) : null,
    diamonds,
    epic: raw.epic ?? null,
    emoji: raw.emoji || '🎁',
    wins: Math.max(0, Number(raw.wins ?? 0) || 0),
    image: raw.image || '',
    model: raw.model || (cfg?.defaultModel ?? ''),
    icon: raw.icon || '',
    cooldownSec: Number(raw.cooldownSec) || 0,
  };
}

async function loadConfig() {
  const res = await fetch('/config/race.json', { cache: 'no-store' });
  cfg = await res.json();
  cfg.trackPoints = Math.max(1, Number(cfg.trackPoints) || 300);
  cfg.goalWins = Math.max(1, Number(cfg.goalWins) || 70);
  cfg.winsPerRound = Math.max(0, Number(cfg.winsPerRound ?? 1));
  cfg.pointsPerDiamond = Math.max(0, Number(cfg.pointsPerDiamond ?? 1));
  cfg.giftBasePoints = Math.max(0, Number(cfg.giftBasePoints ?? 0));
  // Personaje 3D que usan todos los regalos que no tengan "model" propio ("" = muñeco simple).
  cfg.defaultModel = cfg.defaultModel === undefined ? 'assets/models/robot.glb' : cfg.defaultModel;
  cfg.epicFromDiamonds = Math.max(1, Number(cfg.epicFromDiamonds ?? 1000));
  cfg.teams = cfg.teams || {};
  for (const team of ['heroes', 'villains']) {
    cfg.teams[team] = { name: team === 'heroes' ? 'HÉROES' : 'VILLANOS', color: team === 'heroes' ? '#2f8fff' : '#e8323c', ...cfg.teams[team] };
  }
  document.documentElement.style.setProperty('--heroes', cfg.teams.heroes.color);
  document.documentElement.style.setProperty('--villains', cfg.teams.villains.color);

  for (const g of cfg.gifts || []) {
    const rule = normalizeRule(g, 'gift:' + String(g.name).toLowerCase(), g.name);
    if (rule) giftRules.set(String(g.name).toLowerCase(), rule);
    else console.warn('Regalo mal configurado en race.json:', g);
  }
  for (const c of cfg.commands || []) {
    const rule = normalizeRule(c, 'cmd:' + String(c.trigger).toLowerCase(), c.trigger);
    if (rule) commandRules.set(String(c.trigger).toLowerCase(), rule);
  }
  likeRule = normalizeRule(cfg.likes, 'likes', cfg.likes?.label || 'Tap Tap');
  followRule = normalizeRule(cfg.follows, 'follows', cfg.follows?.label || 'Follow');

  for (const rule of allRules()) if (rule.model) getModel(rule.model);
  // La lista de eventos recientes (abajo a la izquierda) queda justo donde TikTok pone su propio chat:
  // por defecto está oculta. Se vuelve a mostrar con "ui": { "showFeed": true } en race.json.
  const feedEl = $('feed');
  if (feedEl) feedEl.style.display = cfg.ui?.showFeed ? '' : 'none';
  // La música y la voz de Nova esperan a que haya un live conectado: antes de eso no hay
  // a quién hablarle (y mientras preparás LIVE Studio no suena nada).
  wantMusic = !!cfg.sound?.music;
  configureSound({ ...(cfg.sound || {}), music: false });
}

let wantMusic = false;
let liveConnected = false;

/** Se llama cuando el bridge confirma que está conectado a TikTok (o en modo prueba). */
function onLiveConnected() {
  if (liveConnected) return;
  liveConnected = true;
  if (!started || MONITOR) return; // si todavía no arrancó, startGame lo retoma
  bot?.start();
  if (wantMusic) setMusic(true);
}

const allRules = () => [likeRule, followRule, ...giftRules.values()].filter(Boolean);

// Reglas automáticas para regalos que no están en race.json (una por regalo y equipo).
const autoRules = new Map();
function autoRule(name, userKey, image) {
  let hash = 0;
  for (const ch of String(userKey)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const team = hash % 2 === 0 ? 'heroes' : 'villains';
  const key = `auto:${name.toLowerCase()}:${team}`;
  let rule = autoRules.get(key);
  if (!rule) {
    rule = normalizeRule({ team, diamonds: 0 }, key, name);
    rule.icon = image || '';
    autoRules.set(key, rule);
  }
  return rule;
}

/** Puntos que empuja UNA unidad de la regla (una rosa, un like...). */
function unitPoints(rule, eventDiamonds) {
  if (rule.points != null) return rule.points;
  // Base fija por regalo: hasta una rosa se nota, y los grandes siguen creciendo con su costo.
  return (cfg.giftBasePoints || 0) + (Number(eventDiamonds) || rule.diamonds || 1) * cfg.pointsPerDiamond;
}

function isEpic(rule, eventDiamonds) {
  if (rule.epic != null) return !!rule.epic;
  return (Number(eventDiamonds) || rule.diamonds || 0) >= cfg.epicFromDiamonds;
}

// Fotos de TikTok pasan por el proxy de web-server.js (mismo origen = se pueden usar en 3D).
function avatarUrl(raw) {
  if (!raw) return '';
  if (raw.startsWith('/') || raw.startsWith(location.origin)) return raw;
  return '/avatar?u=' + encodeURIComponent(raw);
}

// ---------------------------------------------------------------------------
// Escena 3D
// ---------------------------------------------------------------------------
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// 1.5 alcanza para que se vea nítido en la captura sin cargar de más la placa de video.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xe4eef8, 45, 150);
const camera = new THREE.PerspectiveCamera(52, 9 / 16, 0.1, 500);

function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

{
  const [c, g] = makeCanvas(4, 256);
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#7fb6ea');
  grad.addColorStop(0.55, '#cfe3f6');
  grad.addColorStop(1, '#eef5fb');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  scene.background = canvasTexture(c);
}

scene.add(new THREE.HemisphereLight(0xffffff, 0xaebfd6, 1.7));
const sun = new THREE.DirectionalLight(0xfff6e8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); // 1024 alcanza para una pista de 44x44 y cuesta 4 veces menos que 2048
Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 90 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

function groundY(x, z) {
  const t = THREE.MathUtils.smoothstep(Math.abs(x), 8, 30);
  const hills = 2.6 + 2.2 * Math.sin(x * 0.13 + 1.3) * Math.cos(z * 0.09) + 1.3 * Math.sin(z * 0.23 + x * 0.05);
  return -1 + t * Math.max(0, hills) * 1.5;
}

const snowMat = new THREE.MeshStandardMaterial({ color: 0xf3f7fc, roughness: 0.95 });
{
  // Terreno nevado con lomas a los costados.
  const length = TRACK_HALF * 2 + 220;
  const geo = new THREE.PlaneGeometry(320, length, 120, 160);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, -40);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, groundY(p.getX(i), p.getZ(i)));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, snowMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // Pista elevada con rieles y durmientes.
  const trackLen = TRACK_HALF * 2 + 60;
  const track = new THREE.Mesh(new THREE.BoxGeometry(6.4, 1, trackLen), new THREE.MeshStandardMaterial({ color: 0xf9fbfe, roughness: 0.8 }));
  track.position.y = -0.5;
  track.receiveShadow = true;
  scene.add(track);

  const railMat = new THREE.MeshStandardMaterial({ color: 0x7a4a2c, roughness: 0.6 });
  for (const x of [-2.3, 2.3]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.32, trackLen), railMat);
    rail.position.set(x, 0.16, 0);
    rail.castShadow = rail.receiveShadow = true;
    scene.add(rail);
  }
  const sleeperCount = Math.floor(trackLen / 2.4);
  const sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(5.4, 0.1, 0.55), new THREE.MeshStandardMaterial({ color: 0xc9b29a, roughness: 0.9 }), sleeperCount);
  const m = new THREE.Matrix4();
  for (let i = 0; i < sleeperCount; i++) {
    m.makeTranslation(0, 0.03, -trackLen / 2 + i * 2.4 + 1.2);
    sleepers.setMatrixAt(i, m);
  }
  sleepers.receiveShadow = true;
  scene.add(sleepers);

  // Canales de agua helada a los costados.
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x5cb3ee, roughness: 0.15, metalness: 0.1 });
  for (const x of [-5.3, 5.3]) {
    const water = new THREE.Mesh(new THREE.PlaneGeometry(2.6, trackLen), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(x, -0.93, 0);
    water.receiveShadow = true;
    scene.add(water);
  }
}

{
  // Pinos nevados y rocas (posiciones fijas para que la escena sea siempre igual).
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Rendimiento: el pino entero es UNA geometría (con colores por vértice) dibujada con
  // InstancedMesh, así los 110 pinos cuestan una sola llamada de dibujo en vez de ~770.
  const part = (geo, color, y, r = 1) => {
    geo.scale(r, 1, r);
    geo.translate(0, y, 0);
    const c = new THREE.Color(color);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
  };
  const pieces = [part(new THREE.CylinderGeometry(0.25, 0.35, 1.4, 6), 0x6b4a32, 0.7)];
  for (let k = 0; k < 3; k++) {
    const r = 1.5 - k * 0.38;
    const y = 1.7 + k * 0.95;
    pieces.push(part(new THREE.ConeGeometry(1, 1.6, 7), 0x2f6b45, y, r));
    pieces.push(part(new THREE.ConeGeometry(0.62, 0.75, 7), 0xffffff, y + 0.45, r));
  }
  const treeGeo = mergeGeometries(pieces);
  const TREES = 110;
  const trees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, flatShading: true }), TREES);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < TREES; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    const x = side * (9 + rnd() * 45);
    const z = -TRACK_HALF - 120 + rnd() * (TRACK_HALF * 2 + 150);
    const s = 1 + rnd() * 1.4;
    q.setFromAxisAngle(up, rnd() * Math.PI);
    m.compose(new THREE.Vector3(x, groundY(x, z) - 0.1, z), q, new THREE.Vector3(s, s, s));
    trees.setMatrixAt(i, m);
  }
  trees.castShadow = true;
  scene.add(trees);

  const ROCKS = 30;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1), new THREE.MeshStandardMaterial({ color: 0x8b95a6, roughness: 0.9, flatShading: true }), ROCKS);
  const e = new THREE.Euler();
  for (let i = 0; i < ROCKS; i++) {
    const side = rnd() < 0.5 ? -1 : 1;
    const x = side * (7.5 + rnd() * 20);
    const z = -TRACK_HALF - 60 + rnd() * (TRACK_HALF * 2 + 80);
    const s = 0.6 + rnd() * 1.1;
    q.setFromEuler(e.set(rnd() * 3, rnd() * 3, rnd() * 3));
    m.compose(new THREE.Vector3(x, groundY(x, z), z), q, new THREE.Vector3(s, s, s));
    rocks.setMatrixAt(i, m);
  }
  rocks.castShadow = true;
  scene.add(rocks);
}

function textCanvas(text, color, w = 1024, h = 256, size = 150) {
  const [c, g] = makeCanvas(w, h);
  g.font = `${size}px "Luckiest Guy", Impact, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = size * 0.16;
  g.strokeStyle = INK;
  g.strokeText(text, w / 2, h / 2 + size * 0.06);
  g.fillStyle = color;
  g.fillText(text, w / 2, h / 2 + size * 0.06);
  return c;
}

const goals = {};
function buildGoals() {
  for (const team of ['heroes', 'villains']) {
    const { name, color } = cfg.teams[team];
    const z = team === 'heroes' ? -TRACK_HALF - BALL_R : TRACK_HALF + BALL_R;
    const group = new THREE.Group();
    group.position.z = z;
    const teamMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });

    const line = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.9), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.02;
    line.receiveShadow = true;
    group.add(line);

    for (const x of [-3.6, 3.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 6.5, 12), teamMat);
      post.position.set(x, 2.25, 0);
      post.castShadow = true;
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }));
      flag.position.set(x + (x < 0 ? -0.8 : 0.8), 5, 0);
      group.add(post, flag);
    }
    // Solo la meta del fondo lleva cartel: la cercana quedaría entre la cámara y la pelota.
    if (team === 'heroes') {
      const banner = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 2),
        new THREE.MeshBasicMaterial({ map: canvasTexture(textCanvas(name, color)), transparent: true, side: THREE.DoubleSide }),
      );
      banner.position.y = 5.9;
      group.add(banner);
    }
    scene.add(group);
    goals[team] = group;
  }
}

// Pelota: mitad de cada equipo, con franja y botón.
let ball;
function buildBall() {
  const [c, g] = makeCanvas(1024, 512);
  g.fillStyle = cfg.teams.heroes.color;
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = cfg.teams.villains.color;
  g.fillRect(0, 256, 1024, 256);
  g.fillStyle = INK;
  g.fillRect(0, 234, 1024, 44);
  for (const x of [256, 768]) {
    g.beginPath(); g.fillStyle = INK; g.ellipse(x, 256, 70, 70, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.fillStyle = '#ffffff'; g.ellipse(x, 256, 46, 46, 0, 0, Math.PI * 2); g.fill();
    // Marca del autor en el botón de la pelota.
    g.font = '58px "Luckiest Guy", Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = INK;
    g.fillText(brand.ballMark, x, 260);
  }
  const mat = new THREE.MeshStandardMaterial({ map: canvasTexture(c), roughness: 0.32, metalness: 0.05 });
  ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 48, 32), mat);
  ball.rotation.z = Math.PI / 2; // franja vertical: se ve girar al rodar
  ball.castShadow = true;
  // body: posición en el centro de la pelota (y aplastamiento, alineado al mundo).
  // roll: el giro al rodar, centrado en el mismo punto que la esfera.
  const body = new THREE.Group();
  const roll = new THREE.Group();
  body.position.set(0, BALL_R, 0);
  roll.add(ball);
  body.add(roll);
  scene.add(body);
  ball.userData.body = body;
  ball.userData.roll = roll;
}

// Nieve cayendo alrededor de la cámara.
const snow = (() => {
  const count = 800;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = rand(-30, 30);
    pos[i * 3 + 1] = rand(0, 28);
    pos[i * 3 + 2] = rand(-70, 10);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const [c, g] = makeCanvas(32, 32);
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.28, map: canvasTexture(c), transparent: true, depthWrite: false, opacity: 0.9 }));
  scene.add(points);
  return { points, pos, count };
})();

function updateSnow(dt, t) {
  const { pos, count, points } = snow;
  for (let i = 0; i < count; i++) {
    let y = pos[i * 3 + 1] - dt * (1.6 + (i % 7) * 0.25);
    if (y < -1) y += 29;
    pos[i * 3 + 1] = y;
    pos[i * 3] += Math.sin(t * 0.8 + i) * dt * 0.3;
  }
  points.geometry.attributes.position.needsUpdate = true;
  points.position.z = camera.position.z - 10;
}

// Confeti al ganar una ronda.
const confetti = (() => {
  const count = 320;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.22, 0.38), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), count);
  mesh.visible = false;
  mesh.frustumCulled = false;
  // Crear el color por instancia desde el arranque: si se crea en el primer estallido,
  // three.js recompila el shader en pleno juego y congela la imagen unos cientos de ms.
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  scene.add(mesh);
  const parts = Array.from({ length: count }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), s: new THREE.Vector3() }));
  return { mesh, parts, age: 99 };
})();

function burstConfetti(z, teamColor) {
  const palette = [new THREE.Color(teamColor), new THREE.Color('#ffd84d'), new THREE.Color('#ffffff')];
  confetti.parts.forEach((part, i) => {
    part.p.set(rand(-1, 1), rand(1, 3), z + rand(-1, 1));
    part.v.set(rand(-9, 9), rand(7, 17), rand(-6, 6));
    part.r.set(rand(0, 6), rand(0, 6), rand(0, 6));
    part.s.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
    confetti.mesh.setColorAt(i, palette[i % palette.length]);
  });
  confetti.mesh.instanceColor.needsUpdate = true;
  confetti.age = 0;
  confetti.mesh.visible = true;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const one = new THREE.Vector3(1, 1, 1);
function updateConfetti(dt) {
  if (!confetti.mesh.visible) return;
  confetti.age += dt;
  if (confetti.age > 4.5) { confetti.mesh.visible = false; return; }
  confetti.parts.forEach((part, i) => {
    part.v.y -= 14 * dt;
    part.v.multiplyScalar(1 - dt * 0.9);
    part.p.addScaledVector(part.v, dt);
    part.r.x += part.s.x * dt; part.r.y += part.s.y * dt; part.r.z += part.s.z * dt;
    tmpQuat.setFromEuler(part.r);
    confetti.mesh.setMatrixAt(i, tmpMatrix.compose(part.p, tmpQuat, one));
  });
  confetti.mesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Personajes
// ---------------------------------------------------------------------------
const gltfLoader = new GLTFLoader();
const models = new Map();

function loadModel(path) {
  let entry = models.get(path);
  if (!entry) {
    entry = { status: 'loading' };
    entry.promise = new Promise((resolve) => {
      gltfLoader.load(path, (gltf) => {
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        entry.scale = 2.1 / (size.y || 1);
        entry.offsetY = -box.min.y * entry.scale;
        entry.scene = gltf.scene;
        entry.clips = gltf.animations || [];
        // Sin sombra real: con 14 piezas por robot duplicaría las llamadas de dibujo. Se usa una mancha.
        gltf.scene.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        entry.status = 'ready';
        resolve(entry);
      }, undefined, (err) => {
        entry.status = 'error'; // sin modelo, los personajes usan el muñeco simple
        console.warn(`No se pudo cargar el modelo ${path}:`, err?.message || err);
        resolve(entry);
      });
    });
    models.set(path, entry);
  }
  return entry;
}

function getModel(path) {
  const entry = loadModel(path);
  return entry.status === 'ready' ? entry : null;
}

// Banco de robots: se crean todos al arrancar y se reutilizan. Clonar un esqueleto con sus
// animaciones en pleno juego era lo más caro de todo (tirones al llegar ráfagas de regalos).
const robotPool = { heroes: [], villains: [] };

function buildRobot(model, team) {
  const inst = SkeletonUtils.clone(model.scene);
  inst.scale.setScalar(model.scale);
  inst.position.y = model.offsetY;
  tintModel(inst, team);
  const mixer = new THREE.AnimationMixer(inst);
  const actions = {};
  for (const clip of model.clips) actions[clip.name] = mixer.clipAction(clip);
  const faces = [];
  inst.traverse((o) => { if (o.isMesh && o.morphTargetDictionary?.Angry !== undefined) faces.push(o); });
  const robot = { inst, mixer, actions, faces, owner: null, team };
  mixer.addEventListener('finished', () => robot.owner?.onClipFinished());
  return robot;
}

const acquireRobot = (model, team) => robotPool[team].pop() || buildRobot(model, team);

function releaseRobot(robot) {
  robot.owner = null;
  robot.mixer.stopAllAction();
  for (const m of robot.faces) m.morphTargetInfluences.fill(0);
  robot.inst.removeFromParent();
  robotPool[robot.team].push(robot);
}

// El material "Main" del robot (naranja) se tiñe con el color del equipo. Se cachea por equipo.
const tintCache = new Map();
function tintModel(inst, team) {
  const color = new THREE.Color(cfg.teams[team].color);
  inst.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const out = list.map((m) => {
      if (!m || m.name !== 'Main') return m;
      const key = m.uuid + team;
      let tinted = tintCache.get(key);
      if (!tinted) {
        tinted = m.clone();
        tinted.color = color.clone();
        tinted.emissive = color.clone().multiplyScalar(0.18);
        tintCache.set(key, tinted);
      }
      return tinted;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
}

const cardTextures = new Map();
function cardTexture(rule) {
  let tex = cardTextures.get(rule.key);
  if (tex) return tex;
  const [c, g] = makeCanvas(256, 256);
  const color = cfg.teams[rule.team].color;
  const draw = (img) => {
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = INK;
    roundRect(g, 4, 4, 248, 248, 40); g.fill();
    g.fillStyle = color;
    roundRect(g, 14, 14, 228, 228, 32); g.fill();
    g.save();
    roundRect(g, 26, 26, 204, 204, 24); g.clip();
    if (img) {
      const s = Math.max(204 / img.width, 204 / img.height);
      g.drawImage(img, 128 - (img.width * s) / 2, 128 - (img.height * s) / 2, img.width * s, img.height * s);
    } else {
      g.fillStyle = 'rgba(255,255,255,.3)';
      g.fillRect(26, 26, 204, 204);
      // El emoji del regalo reconoce el personaje a simple vista.
      g.font = '140px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(rule.emoji, 128, 136);
    }
    g.restore();
  };
  draw(null);
  tex = canvasTexture(c);
  cardTextures.set(rule.key, tex);
  if (rule.image) {
    const img = new Image();
    img.onload = () => { draw(img); tex.needsUpdate = true; };
    img.onerror = () => console.warn(`No se pudo cargar la imagen ${rule.image}`);
    img.src = rule.image;
  }
  return tex;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Fotos de perfil ya cargadas (compartidas entre carteles).
const avatarImages = new Map();
function avatarImage(url) {
  if (!url) return null;
  let entry = avatarImages.get(url);
  if (!entry) {
    entry = { img: new Image(), ok: false, waiting: [] };
    entry.img.onload = () => { entry.ok = true; entry.waiting.splice(0).forEach((fn) => fn()); };
    entry.img.onerror = () => { entry.waiting.length = 0; };
    entry.img.src = url;
    if (avatarImages.size > 300) avatarImages.delete(avatarImages.keys().next().value);
    avatarImages.set(url, entry);
  }
  return entry;
}

function drawCircleImage(g, img, cx, cy, r, ring) {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r + 8, 0, Math.PI * 2);
  g.fillStyle = INK;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, r + 4, 0, Math.PI * 2);
  g.fillStyle = ring;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, r - 2, 0, Math.PI * 2);
  g.clip();
  const s = Math.max((2 * r) / img.width, (2 * r) / img.height);
  g.drawImage(img, cx - (img.width * s) / 2, cy - (img.height * s) / 2, img.width * s, img.height * s);
  g.restore();
}

/** Cartel sobre el personaje: foto de perfil + nombre + regalo. */
function nameTag(user, line2, avatar, ringColor) {
  const [c, g] = makeCanvas(640, 170);
  const entry = avatarImage(avatar);
  const draw = () => {
    g.clearRect(0, 0, 640, 170);
    const hasPhoto = entry?.ok;
    const textX = hasPhoto ? 380 : 320;
    if (hasPhoto) drawCircleImage(g, entry.img, 82, 85, 66, ringColor);
    g.textAlign = 'center';
    g.lineJoin = 'round';
    g.strokeStyle = INK;
    g.font = '58px "Luckiest Guy", Impact, sans-serif';
    g.lineWidth = 12;
    const name = user.length > 14 ? user.slice(0, 13) + '…' : user;
    g.strokeText(name, textX, 72, 480);
    g.fillStyle = '#ffffff';
    g.fillText(name, textX, 72, 480);
    g.font = '48px "Luckiest Guy", Impact, sans-serif';
    g.lineWidth = 10;
    g.strokeText(line2, textX, 138, 480);
    g.fillStyle = '#ffd84d';
    g.fillText(line2, textX, 138, 480);
  };
  draw();
  const tex = canvasTexture(c);
  if (entry && !entry.ok) entry.waiting.push(() => { draw(); tex.needsUpdate = true; });
  return tex;
}

/** Tarjeta del tap tap con la foto de perfil de quien toca (y la manito como sello). Sin foto, queda la tarjeta de siempre. */
function photoCard(avatar, rule) {
  const [c, g] = makeCanvas(256, 256);
  const color = cfg.teams[rule.team].color;
  const entry = avatarImage(avatar);
  const draw = () => {
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = INK; roundRect(g, 4, 4, 248, 248, 40); g.fill();
    g.fillStyle = color; roundRect(g, 14, 14, 228, 228, 32); g.fill();
    g.save();
    roundRect(g, 26, 26, 204, 204, 24); g.clip();
    if (entry?.ok) {
      const s = Math.max(204 / entry.img.width, 204 / entry.img.height);
      g.drawImage(entry.img, 128 - (entry.img.width * s) / 2, 128 - (entry.img.height * s) / 2, entry.img.width * s, entry.img.height * s);
    } else {
      g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(26, 26, 204, 204);
      g.font = '140px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(rule.emoji, 128, 136);
    }
    g.restore();
    if (entry?.ok) { // sello de la manito en la esquina
      g.font = '70px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(rule.emoji, 206, 212);
    }
  };
  draw();
  const tex = canvasTexture(c);
  if (entry && !entry.ok) entry.waiting.push(() => { draw(); tex.needsUpdate = true; });
  return tex;
}

// Carteles compartidos con conteo de referencias: se liberan cuando el último personaje se va.
const tagCache = new Map();
function acquireTag(key, create) {
  let entry = tagCache.get(key);
  if (!entry) {
    entry = { tex: create(), refs: 0 };
    tagCache.set(key, entry);
  }
  entry.refs++;
  return entry.tex;
}
function releaseTag(key) {
  const entry = tagCache.get(key);
  if (!entry || --entry.refs > 0) return;
  entry.tex.dispose();
  tagCache.delete(key);
}

const darkMat = new THREE.MeshStandardMaterial({ color: 0x1f2a48, roughness: 0.7 });
const torsoMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
const teamMats = {};
const torsoGeos = {};
const limbGeo = new THREE.CapsuleGeometry(0.13, 0.5, 4, 8);

function paint(geo, color) {
  const c = new THREE.Color(color);
  const colors = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// Cuerpo + cabeza + ojos en UNA geometría por equipo (menos llamadas de dibujo por personaje).
function torsoGeometry(team) {
  if (torsoGeos[team]) return torsoGeos[team];
  const body = paint(new THREE.CapsuleGeometry(0.42, 0.6, 6, 12).translate(0, 1.15, 0), cfg.teams[team].color);
  const head = paint(new THREE.SphereGeometry(0.38, 20, 16).translate(0, 2.1, 0), 0xffd6b0);
  const eyeL = paint(new THREE.SphereGeometry(0.055, 8, 8).translate(-0.13, 2.15, 0.34), 0x111111);
  const eyeR = paint(new THREE.SphereGeometry(0.055, 8, 8).translate(0.13, 2.15, 0.34), 0x111111);
  torsoGeos[team] = mergeGeometries([body, head, eyeL, eyeR]);
  return torsoGeos[team];
}

// Muñeco 3D por defecto (mirando a +z) cuando el regalo no tiene modelo .glb.
function proceduralCharacter(team) {
  teamMats[team] ||= new THREE.MeshStandardMaterial({ color: cfg.teams[team].color, roughness: 0.55 });
  const rig = new THREE.Group();
  const torso = new THREE.Mesh(torsoGeometry(team), torsoMat);
  torso.castShadow = true; // solo el torso proyecta sombra: brazos y piernas no se notan
  const legs = [-0.18, 0.18].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.72, 0);
    const leg = new THREE.Mesh(limbGeo, darkMat);
    leg.position.y = -0.38;
    pivot.add(leg);
    return pivot;
  });
  const arms = [-0.55, 0.55].map((x) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 1.55, 0);
    const arm = new THREE.Mesh(limbGeo, teamMats[team]);
    arm.position.y = -0.36;
    pivot.add(arm);
    return pivot;
  });
  rig.add(torso, ...legs, ...arms);
  return { rig, legs, arms };
}

// ---------------------------------------------------------------------------
// Efectos de impacto ("juice"). Se escalan por intensidad (chico / medio / grande) y
// se enganchan a eventos concretos: golpe, victoria de ronda, regalo épico. Cada evento
// combina varios canales a la vez (chispas + congelado + zoom + temblor), que es lo que
// hace que un golpe "pese". Todo en pools fijos: no se crean objetos durante el live.
// ---------------------------------------------------------------------------
const BASE_FOV = 52;
let hitStop = 0;   // segundos de "congelado" del juego tras un golpe fuerte
let fovKick = 0;   // empujón momentáneo del campo de visión (se apaga solo)

const sparkTexture = (() => {
  const [c, g] = makeCanvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,.65)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return canvasTexture(c);
})();

const SPARKS = 260;
const sparkPos = new Float32Array(SPARKS * 3);
const sparkCol = new Float32Array(SPARKS * 3);
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
const sparkPoints = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
  size: 0.5, map: sparkTexture, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
}));
sparkPoints.frustumCulled = false;
scene.add(sparkPoints);
const sparks = Array.from({ length: SPARKS }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, grav: 9 }));
let sparkCursor = 0;
let sparksDirty = false;
const sparkColor = new THREE.Color();

function spawnSparks(x, y, z, count, color, { speed = 6, up = 4, life = 0.6, spread = 1, grav = 9 } = {}) {
  sparkColor.set(color);
  for (let i = 0; i < count; i++) {
    const s = sparks[sparkCursor];
    sparkCursor = (sparkCursor + 1) % SPARKS;
    const a = Math.random() * Math.PI * 2;
    const k = rand(0.3, 1) * speed;
    s.x = x + rand(-spread, spread) * 0.3; s.y = y; s.z = z + rand(-spread, spread) * 0.3;
    s.vx = Math.cos(a) * k; s.vz = Math.sin(a) * k; s.vy = rand(0.3, 1) * up;
    s.life = s.max = life * rand(0.6, 1.1);
    s.r = sparkColor.r; s.g = sparkColor.g; s.b = sparkColor.b;
    s.grav = grav;
  }
  sparksDirty = true;
}

function updateSparks(dt) {
  if (!sparksDirty) return;
  let any = false;
  for (let i = 0; i < SPARKS; i++) {
    const s = sparks[i];
    const o = i * 3;
    if (s.life <= 0) { sparkCol[o] = sparkCol[o + 1] = sparkCol[o + 2] = 0; continue; }
    any = true;
    s.life -= dt;
    s.vy -= s.grav * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    if (s.y < 0.05) { s.y = 0.05; s.vy *= -0.3; }
    const f = Math.max(0, s.life / s.max);
    sparkPos[o] = s.x; sparkPos[o + 1] = s.y; sparkPos[o + 2] = s.z;
    sparkCol[o] = s.r * f; sparkCol[o + 1] = s.g * f; sparkCol[o + 2] = s.b * f;
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.color.needsUpdate = true;
  sparksDirty = any;
}

function impact(tier, team, x = 0, y = 1.4, z = ballZ) {
  const color = cfg.teams[team].color;
  if (tier === 'small') {
    spawnSparks(x, y, z, 5, color, { speed: 4, up: 3, life: 0.4 });
  } else if (tier === 'medium') {
    spawnSparks(x, y, z, 22, color, { speed: 7, up: 5, life: 0.6 });
    hitStop = Math.max(hitStop, 0.04);
    fovKick = Math.max(fovKick, 2);
    cameraShake = Math.max(cameraShake, 0.3);
  } else {
    spawnSparks(x, y, z, 80, color, { speed: 11, up: 9, life: 0.95, spread: 2 });
    spawnSparks(x, y, z, 40, '#ffffff', { speed: 8, up: 7, life: 0.7, spread: 2 });
    hitStop = Math.max(hitStop, 0.09);
    fovKick = Math.max(fovKick, 5);
    cameraShake = Math.max(cameraShake, 1);
  }
}

// Números flotantes ("+15") sobre el personaje, como los de daño en los juegos grandes.
const floatersEl = $('floaters');
const floatTmp = new THREE.Vector3();
let floaterCount = 0;
function floatText(text, color, worldPos) {
  if (!floatersEl || floaterCount >= 8) return;
  floatTmp.copy(worldPos).project(camera);
  if (floatTmp.z > 1) return;
  const x = (floatTmp.x * 0.5 + 0.5) * 100;
  const y = (-floatTmp.y * 0.5 + 0.5) * 100;
  if (x < -5 || x > 105) return;
  const el = document.createElement('div');
  el.className = 'floater';
  el.textContent = text;
  el.style.left = `${x}%`;
  el.style.top = `${y}%`;
  el.style.color = color;
  floatersEl.appendChild(el);
  floaterCount++;
  const anim = el.animate([
    { transform: 'translate(-50%, 0) scale(.5)', opacity: 0 },
    { transform: 'translate(-50%, -2.5cqh) scale(1.2)', opacity: 1, offset: 0.18 },
    { transform: 'translate(-50%, -9cqh) scale(1)', opacity: 0 },
  ], { duration: 900, easing: 'ease-out' });
  anim.onfinish = () => { el.remove(); floaterCount--; };
}

// Sombra falsa (mancha oscura) compartida por todos los personajes: casi no cuesta nada.
const blobGeo = new THREE.PlaneGeometry(2.4, 2.4);
const blobMat = (() => {
  const [c, g] = makeCanvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(10,20,50,.7)');
  grad.addColorStop(1, 'rgba(10,20,50,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true, depthWrite: false });
})();

const MAX_ROBOTS = 8; // robots completos a la vez; si hay más gente, el resto usa el muñeco liviano
let robotsActive = 0;
const pushers = [];

class Pusher {
  constructor(move) {
    this.move = move;
    this.dir = move.rule.team === 'heroes' ? -1 : 1; // sentido en z hacia donde empuja
    this.state = 'run';
    this.age = 0;
    this.phase = Math.random() * 10;
    this.root = new THREE.Group();
    this.rig = new THREE.Group();
    this.root.add(this.rig);

    const model = move.rule.model && (move.epic || robotsActive < MAX_ROBOTS) ? getModel(move.rule.model) : null;
    const blob = new THREE.Mesh(blobGeo, blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.04;
    this.root.add(blob);
    if (model) {
      this.usesModel = true;
      robotsActive++;
      this.robot = acquireRobot(model, move.rule.team);
      this.robot.owner = this;
      this.rig.add(this.robot.inst);
      this.mixer = this.robot.mixer;
      this.actions = this.robot.actions;
      this.current = null;
      this.applyFace();
      this.play('Running', 0, 1.3);
    } else {
      const parts = proceduralCharacter(move.rule.team);
      this.rig.add(parts.rig);
      this.legs = parts.legs;
      this.arms = parts.arms;
    }

    const teamColor = cfg.teams[move.rule.team].color;
    // Sobre el personaje solo va la tarjeta cuadrada con la foto de perfil (sin nombre ni texto del regalo);
    // el sello de la esquina dice si fue un tap o qué regalo. Sin foto queda la tarjeta del regalo.
    this.cardKey = move.avatar ? `card|${move.avatar}|${move.rule.key}` : null;
    const cardMap = this.cardKey ? acquireTag(this.cardKey, () => photoCard(move.avatar, move.rule)) : cardTexture(move.rule);
    this.card = new THREE.Sprite(new THREE.SpriteMaterial({ map: cardMap, depthTest: false, fog: false }));
    this.card.scale.set(1.5, 1.5, 1);
    this.card.position.y = 3.3;
    this.card.renderOrder = 10;
    this.root.add(this.card);

    this.epic = !!move.epic;
    if (this.epic) {
      // Aura brillante en los pies del personaje gigante.
      this.aura = new THREE.Mesh(
        new THREE.RingGeometry(0.9, 1.5, 48),
        new THREE.MeshBasicMaterial({ color: teamColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.aura.rotation.x = -Math.PI / 2;
      this.aura.position.y = 0.05;
      this.root.add(this.aura);
    }

    // Hacia los costados de la pelota, así los que empujan desde el lado de la cámara no la tapan.
    this.offsetX = this.epic ? 0 : (Math.random() < 0.5 ? -1 : 1) * rand(1.3, 2.2);
    this.root.position.set(this.offsetX * 1.6, 0, ballZ - this.dir * (this.epic ? rand(15, 18) : rand(9, 12)));
    this.root.rotation.y = this.dir === -1 ? Math.PI : 0;
    this.baseScale = this.epic ? 3.1 : 1.35;
    this.root.scale.setScalar(this.baseScale);
    scene.add(this.root);
  }

  // Animaciones del modelo (Running, Idle, Punch, ThumbsUp...) con fundido entre una y otra.
  onClipFinished() {
    if (this.state === 'push') this.play('Idle', 0.1);
  }

  // Cara: los Villanos con el ceño fruncido, el gigante sorprendido.
  applyFace() {
    for (const o of this.robot.faces) {
      const d = o.morphTargetDictionary;
      if (this.move.rule.team === 'villains') o.morphTargetInfluences[d.Angry] = 0.9;
      if (this.move.epic) o.morphTargetInfluences[d.Surprised] = 0.7;
    }
  }

  play(name, fade = 0.15, speed = 1, once = false) {
    const next = this.actions?.[name];
    if (!next || (this.current === next && !once)) return;
    next.reset();
    next.timeScale = speed;
    next.enabled = true;
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, fade, false);
    next.play();
    this.current = next;
  }

  contactZ() {
    // El gigante empuja de frente; los normales desde un costado (contacto más cerca del centro en z).
    if (this.epic) return ballZ - this.dir * (BALL_R + 1.2);
    return ballZ - this.dir * (BALL_R * 0.55 + 0.4);
  }

  update(dt) {
    this.age += dt;
    this.mixer?.update(dt);
    if (this.aura) {
      this.aura.rotation.z += dt * 3;
      this.aura.scale.setScalar(1 + Math.sin(this.age * 8) * 0.12);
    }
    const t = this.age * 12 + this.phase;
    const p = this.root.position;

    if (this.state === 'run') {
      const target = this.contactZ();
      // Más rápido que la pelota cuando ella se aleja, así siempre la alcanza.
      const step = (15 + Math.abs(ballVel)) * dt;
      p.z += clamp(target - p.z, -step, step);
      p.x += (this.offsetX - p.x) * Math.min(1, dt * 4);
      if (!this.actions) { // muñeco simple: el rebote lo hago a mano; el robot ya trae su animación
        this.rig.position.y = Math.abs(Math.sin(t)) * 0.25;
        this.swing(Math.sin(t) * 0.9, Math.sin(t) * 0.7);
      }
      if (Math.abs(target - p.z) < 0.25 || this.age > 1.6) {
        this.state = 'push';
        this.stateAge = 0;
        this.play('Idle', 0.15);
        this.strokesLeft = this.move.strokes;
        // 10 empujones en ~3 s; rachas largas más rápido para no tardar minutos.
        this.strokeInterval = clamp(4 / this.move.strokes, 0.06, 0.3);
        this.strokeTimer = 0;
      }
    } else if (this.state === 'push') {
      this.stateAge += dt;
      // Sigue a la pelota sin teletransportarse si llegó tarde.
      const follow = Math.max(BALL_MAX_SPEED, 15) * 1.2 * dt;
      p.z += clamp(this.contactZ() - p.z, -follow, follow);
      this.rig.position.y = 0;

      // Un empujón por cada unidad del regalo (10 rosas = 10 empujones del mismo muñeco).
      this.strokeTimer -= dt;
      if (this.strokesLeft > 0 && this.strokeTimer <= 0) {
        if (!pusherStroke(this)) return;
        this.strokesLeft--;
        this.strokeTimer = this.strokeInterval;
        this.lunge = 1;
        if (this.strokesLeft === 0) this.stateAge = 0;
      }
      this.lunge = Math.max(0, (this.lunge || 0) - dt * 6);
      // Se tira hacia adelante en cada empujón (el robot, además, da su golpe animado).
      this.rig.rotation.x = (this.actions ? 0.1 : 0.25) + this.lunge * 0.3;
      if (!this.actions) this.swing(Math.sin(t * 0.8) * 0.5, -Math.PI / 2.2 - this.lunge * 0.3);
      // Después del último empujón se queda un momento y se va.
      if (this.strokesLeft === 0 && this.stateAge > (this.epic ? 1.6 : 0.7)) this.leave();
    } else {
      // El robot festeja un momento antes de irse (menos si hay mucha cola, para dejar lugar).
      this.stateAge += dt;
      const hold = this.actions ? (queue.length > 10 ? 0.15 : 0.55) : 0;
      const s = Math.max(0, 1 - Math.max(0, this.stateAge - hold) / 0.35);
      this.root.scale.setScalar(s * this.baseScale);
      if (s === 0) this.dispose();
    }
  }

  swing(legAngle, armAngle) {
    if (!this.legs) return;
    this.legs[0].rotation.x = legAngle;
    this.legs[1].rotation.x = -legAngle;
    this.arms[0].rotation.x = this.state === 'push' ? armAngle : -legAngle * 0.8;
    this.arms[1].rotation.x = this.state === 'push' ? armAngle : legAngle * 0.8;
  }

  leave() {
    if (this.state === 'leave') return;
    this.state = 'leave';
    this.stateAge = 0;
    this.play('ThumbsUp', 0.15, 1.4, true);
  }

  dispose() {
    scene.remove(this.root);
    if (this.usesModel) robotsActive--;
    if (this.robot) { releaseRobot(this.robot); this.robot = null; }
    if (this.cardKey) releaseTag(this.cardKey);
    this.card.material.dispose();
    if (this.aura) { this.aura.geometry.dispose(); this.aura.material.dispose(); }
    const i = pushers.indexOf(this);
    if (i >= 0) pushers.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Estado del juego
// ---------------------------------------------------------------------------
let pos = 0;                 // puntos: + hacia la meta de Héroes, - hacia la de Villanos
const wins = loadWins();     // WINS de cada equipo { heroes, villains }
let celebrating = false;

function loadWins() {
  const saved = storage.get(WINS_KEY, null);
  if (saved && typeof saved === 'object') {
    return { heroes: Math.max(0, Number(saved.heroes) || 0), villains: Math.max(0, Number(saved.villains) || 0) };
  }
  // Versión anterior: un único contador numérico que era de Héroes.
  return { heroes: Math.max(0, Number(storage.get('hv.wins', 0)) || 0), villains: 0 };
}
const queue = [];            // movimientos pendientes { rule, user, delta, caption }
let nextSpawnAt = 0;
let ballZ = 0;
let ballVel = 0;

/** move: { rule, user, step (puntos por empujón, con signo), strokes, caption, avatar, epic } */
function enqueueMove(move) {
  if (!move.step || !move.strokes) return;
  // Los regalos épicos se adelantan en la cola para que la animación salga enseguida.
  if (move.epic) { queue.unshift(move); return; }

  // Un solo muñeco por persona: si ya tiene uno en pantalla, se le suman empujones; si tiene uno esperando, se junta con ese.
  const sign = Math.sign(move.step);
  const pts = Math.abs(move.step) * move.strokes;
  const live = pushers.find((p) => !p.epic && p.state !== 'leave' && p.strokesLeft > 0 && p.move.user === move.user && Math.sign(p.move.step) === sign);
  if (live) {
    live.strokesLeft = Math.min(live.strokesLeft + Math.min(MAX_PUSHES_PER_GIFT, Math.max(1, Math.round(pts / Math.abs(live.move.step)))), MAX_PUSHES_PER_GIFT * 2);
    return;
  }
  const waiting = queue.find((m) => !m.epic && m.user === move.user && Math.sign(m.step) === sign);
  if (waiting) {
    const total = Math.abs(waiting.step) * waiting.strokes + pts;
    waiting.strokes = Math.min(waiting.strokes + move.strokes, MAX_PUSHES_PER_GIFT);
    waiting.step = (sign * total) / waiting.strokes;
    return;
  }
  queue.push(move);
}

/** Un empujón del muñeco. Devuelve false si se cortó (festejo en curso). */
function pusherStroke(pusher) {
  const move = pusher.move;
  if (celebrating) {
    // La ronda terminó: los empujones que faltan se guardan para la ronda siguiente.
    if (pusher.strokesLeft > 0) queue.unshift({ ...move, strokes: pusher.strokesLeft, epic: false });
    pusher.strokesLeft = 0;
    pusher.leave();
    return false;
  }
  const magnitude = Math.abs(move.step);
  const firstStroke = pusher.strokesLeft === move.strokes;
  pusher.play('Punch', 0.05, 2.4, true);
  impact(!pusher.epic && magnitude >= 50 ? 'medium' : 'small', move.rule.team, pusher.root.position.x * 0.4, 1.4, ballZ - pusher.dir * BALL_R);
  if (firstStroke && move.rule !== likeRule) { // un solo "+N" por personaje (los taps no, para no llenar la pantalla)
    floatText(`+${Math.round(magnitude * move.strokes)}`, cfg.teams[move.rule.team].color,
      new THREE.Vector3(pusher.root.position.x, 3.6 * (pusher.baseScale / 1.35), pusher.root.position.z));
  }
  kickBall(move.step);
  sfx.push(move.rule.team, move.step);
  if (pusher.epic && firstStroke) epicImpact(move.rule.team);
  applyDelta(move.step, move.user);
  return true;
}

// Onda expansiva + temblor de cámara + confeti cuando el gigante golpea la pelota.
// Dos anillos creados una sola vez y reutilizados (no se crean objetos durante el live).
const shockwaves = [0, 1].map((i) => {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.3, 64),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  ring.userData.age = 99;
  ring.userData.delay = i * 0.12;
  scene.add(ring);
  return ring;
});
let cameraShake = 0;
function epicImpact(team) {
  const color = cfg.teams[team].color;
  shockwaves.forEach((ring, i) => {
    ring.material.color.set(i ? '#ffffff' : color);
    ring.position.set(0, 0.1, ballZ);
    ring.userData.age = -ring.userData.delay;
    ring.visible = true;
  });
  impact('large', team, 0, 1.6, ballZ);
  burstConfetti(ballZ, color);
  ballHopVel = Math.max(ballHopVel, 12);
}

function updateShockwaves(dt) {
  for (const ring of shockwaves) {
    if (!ring.visible) continue;
    ring.userData.age += dt;
    const a = Math.max(0, ring.userData.age);
    ring.scale.setScalar(1 + a * 14);
    ring.material.opacity = Math.max(0, 0.9 - a * 1.1);
    if (a > 0.85) ring.visible = false;
  }
}

function applyDelta(delta, user) {
  if (celebrating) return;
  damageBoss(delta);
  pos = clamp(pos + delta, -cfg.trackPoints, cfg.trackPoints);
  if (pos >= cfg.trackPoints) roundWon('heroes', user);
  else if (pos <= -cfg.trackPoints) roundWon('villains', user);
}

function dispatchQueue(now) {
  if (celebrating) return;
  while (queue.length > BACKLOG_LIMIT && !celebrating) {
    // Cola desbordada: se aplica directo el más viejo que no sea épico (nunca se pierde nada).
    const i = queue.findIndex((m) => !m.epic);
    if (i < 0) break;
    const [m] = queue.splice(i, 1);
    applyDelta(m.step * m.strokes, m.user);
  }
  const busy = queue.length > 10;
  const limit = busy ? MAX_PUSHERS_BUSY : MAX_PUSHERS;
  if (queue.length && pushers.length < limit && now >= nextSpawnAt && !celebrating) {
    pushers.push(new Pusher(queue.shift()));
    nextSpawnAt = now + (busy ? 35 : 140);
  }
}

const winsElementId = (team) => (team === 'heroes' ? 'winsHeroes' : 'winsVillains');

function renderWins(team) {
  $(winsElementId(team)).querySelector('.winCount').textContent = `${wins[team]}/${cfg.goalWins} WINS`;
}

/** Suma (o resta) WINS a un equipo. Devuelve el valor anterior. */
function addWins(team, amount, animate = true) {
  const before = wins[team];
  wins[team] = Math.max(0, Math.round(before + amount));
  storage.set(WINS_KEY, wins);
  renderWins(team);
  if (animate && wins[team] !== before) {
    // Web Animations: no obliga al navegador a recalcular el layout (sin tirones).
    $(winsElementId(team)).animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.25)', offset: 0.35 }, { transform: 'scale(1)' }],
      { duration: 500, easing: 'ease-out' },
    );
    sfx.wins(wins[team] > before);
  }
  return before;
}

let bannerTimer = 0;
function showBanner(title, sub, color, ms) {
  $('bannerTitle').textContent = title;
  $('bannerTitle').style.color = color;
  $('bannerSub').textContent = sub;
  $('banner').classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.remove('show'), ms);
}

// ---------------------------------------------------------------------------
// Enganche: podio de jugadores, MVP de la ronda, evento relámpago y meta del live.
// ---------------------------------------------------------------------------
const GOAL_KEY = 'hv.liveGoal';
const players = new Map();   // nombre -> { name, avatar, team, points, round }
let topDirty = true;
let goal = null;             // { target, done, level }
const boost = { until: 0, cooldownUntil: 0 };
let lastGiftAt = performance.now();
const BOOST_IDLE_MS = 40_000, BOOST_MS = 20_000, BOOST_COOLDOWN_MS = 90_000;
const boostMult = () => (performance.now() < boost.until ? 2 : 1);

function getGoal() {
  if (!goal) {
    const saved = storage.get(GOAL_KEY, null);
    const target = Math.max(10, Number(cfg.liveGoal?.target) || 200);
    goal = saved && saved.target ? { target: saved.target, done: saved.done || 0, level: saved.level || 0 } : { target, done: 0, level: 0 };
  }
  return goal;
}

// ---- Ranking semanal guardado en este navegador + quién volvió a jugar ----
const HALL_KEY = 'hv.hall';
function weekKey() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${Math.ceil(((t - y) / 864e5 + 1) / 7)}`;
}
let hall = null;
let hallDirty = false;
const seenThisSession = new Set();
function getHall() {
  if (!hall) {
    const saved = storage.get(HALL_KEY, null);
    hall = saved && saved.week === weekKey() && saved.users ? saved : { week: weekKey(), users: {} }; // cada semana arranca de cero
  }
  return hall;
}
setInterval(() => { if (hallDirty) { storage.set(HALL_KEY, getHall()); hallDirty = false; } }, 5000);

/** Registra la visita (una vez por sesión) y dice si es alguien que ya había jugado. El tráfico simulado no se guarda. */
function touchPlayer(user) {
  if (demoLevel > 0 || user in Object.prototype) return null;
  const u = getHall().users[user] || (getHall().users[user] = { pts: 0, visits: 0 });
  const returning = !seenThisSession.has(user) && u.visits > 0;
  if (!seenThisSession.has(user)) { seenThisSession.add(user); u.visits++; hallDirty = true; }
  return { returning, pts: Math.round(u.pts) };
}
const weeklyTop = (n = 3) => Object.entries(getHall().users).filter(([, u]) => u.pts > 0)
  .sort((a, b) => b[1].pts - a[1].pts).slice(0, n).map(([name]) => name);

// ---- Poderes por regalo: los regalos medianos y grandes potencian a su equipo unos segundos ----
const buffs = { heroes: { mult: 1, until: 0 }, villains: { mult: 1, until: 0 } };
const teamMult = (team) => (performance.now() < buffs[team].until ? buffs[team].mult : 1);
function grantBuff(team, unitDiamonds, user) {
  const mult = unitDiamonds >= 299 ? 2 : unitDiamonds >= 30 ? 1.5 : 0;
  if (!mult) return;
  const b = buffs[team];
  if (performance.now() < b.until && b.mult > mult) return;
  b.mult = mult;
  b.until = performance.now() + (mult === 2 ? 12 : 8) * 1000;
  showBanner(`⚡ PODER ${cfg.teams[team].name} x${mult}`, user, cfg.teams[team].color, 1600);
}

function recordPlay(user, avatar, team, points) {
  const hu = touchPlayer(user) && getHall().users[user];
  if (hu) { hu.pts += points; hallDirty = true; }
  let p = players.get(user);
  if (!p) { p = { name: user, avatar, team, points: 0, round: 0 }; players.set(user, p); }
  p.team = team; if (avatar) p.avatar = avatar;
  p.points += points; p.round += points;
  topDirty = true;
}

function addGoal(amount) {
  const g = getGoal();
  g.done += amount;
  topDirty = true;
  if (g.done >= g.target && !celebrating) {
    g.level++;
    const reached = g.target;
    g.done = 0;
    g.target = Math.round((reached * 1.5) / 10) * 10;
    showBanner('¡META DEL LIVE CUMPLIDA!', `Nueva meta: ${g.target}`, '#19e3ff', 2800);
    burstConfetti(ballZ, '#19e3ff');
    hostAvatar?.setEmotion('excited', 3);
    bot?.say('goalReached', {}, 4);
  }
  storage.set(GOAL_KEY, g);
}

function renderTop() {
  if (!topDirty) return;
  topDirty = false;
  const g = getGoal();
  $('goalFill').style.width = `${Math.min(100, (g.done / g.target) * 100)}%`;
  $('goalText').textContent = `⚡ META DEL LIVE ${Math.round(g.done)}/${g.target}`;
  const top = [...players.values()].sort((a, b) => b.points - a.points).slice(0, 3);
  const pod = $('podium');
  pod.textContent = '';
  top.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'podRow';
    row.style.setProperty('--c', cfg.teams[p.team].color);
    const medal = document.createElement('span'); medal.className = 'medal'; medal.textContent = ['🥇', '🥈', '🥉'][i];
    row.appendChild(medal);
    // Foto de perfil; si no carga (o no hay), un círculo con la inicial.
    const initial = () => { const d = document.createElement('span'); d.className = 'pic'; d.textContent = (p.name.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase(); return d; };
    if (p.avatar) {
      const img = document.createElement('img'); img.src = p.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.replaceWith(initial());
      row.appendChild(img);
    } else row.appendChild(initial());
    const n = document.createElement('span'); n.className = 'pn'; n.textContent = p.name;
    const pts = document.createElement('span'); pts.className = 'pp'; pts.textContent = Math.round(p.points);
    row.append(n, pts);
    pod.appendChild(row);
  });
}

function startBoost() {
  boost.until = performance.now() + BOOST_MS;
  boost.cooldownUntil = boost.until + BOOST_COOLDOWN_MS;
  showBanner('⚡ EVENTO RELÁMPAGO', 'Todo empuja el DOBLE por 20 segundos', '#ffb020', 2600);
  hostAvatar?.setEmotion('excited', 3);
  bot?.say('boostStart', {}, 4);
}

// ---- Modo popular: muchos "." en el chat lo activan y los taps valen más (incentiva el tap tap) ----
const popular = { until: 0, cooldownUntil: 0, dots: [] };   // dots: { t, u }
const popularCfg = () => ({ minDots: 8, minUsers: 3, windowSec: 10, seconds: 15, cooldownSec: 60, likeMult: 3, ...(cfg.popular || {}) });
const likeMult = () => (performance.now() < popular.until ? popularCfg().likeMult : 1);

function popularProgress() {
  const p = popularCfg();
  const t = performance.now();
  popular.dots = popular.dots.filter((d) => t - d.t < p.windowSec * 1000);
  return { n: popular.dots.length, users: new Set(popular.dots.map((d) => d.u)).size, p };
}

function countDot(userKey) {
  popular.dots.push({ t: performance.now(), u: userKey });
  const { n, users, p } = popularProgress();
  const t = performance.now();
  if (t < popular.until || t < popular.cooldownUntil || celebrating) return;
  if (n >= p.minDots && users >= p.minUsers) {
    popular.until = t + p.seconds * 1000;
    popular.cooldownUntil = popular.until + p.cooldownSec * 1000;
    popular.dots = [];
    showBanner('🔥 ¡MODO POPULAR!', `Los taps valen x${p.likeMult} por ${p.seconds} segundos`, '#ff6a3d', 2800);
    burstConfetti(ballZ, '#ff6a3d');
    hostAvatar?.setEmotion('excited', 3);
    bot?.say('popularStart', {}, 4.2);
  }
}

setInterval(() => {
  renderTop();
  const now = performance.now();
  const boosting = now < boost.until;
  const el = $('boost');
  el.classList.toggle('on', boosting);
  if (boosting) el.textContent = `⚡ DOBLE EMPUJE ${Math.ceil((boost.until - now) / 1000)}s`;
  const act = ['heroes', 'villains'].filter((t) => now < buffs[t].until)
    .map((t) => `⚡ ${cfg.teams[t].name} x${buffs[t].mult} ${Math.ceil((buffs[t].until - now) / 1000)}s`);
  if (now < popular.until) act.push(`🔥 POPULAR x${popularCfg().likeMult} ${Math.ceil((popular.until - now) / 1000)}s`);
  else {
    const pr = popularProgress();
    if (pr.n >= 3 && now >= popular.cooldownUntil) act.push(`· POPULAR ${Math.min(pr.n, pr.p.minDots)}/${pr.p.minDots}`);
  }
  $('buffs').textContent = act.join('   ');
  // Si hace rato que nadie manda regalos pero hay gente conectada, se lanza un evento para reactivar el live.
  const viewersActive = stats.lastAt && Date.now() - stats.lastAt < 120_000;
  if (!boosting && !celebrating && now > boost.cooldownUntil && now - lastGiftAt > BOOST_IDLE_MS && viewersActive) startBoost();
}, 1000);

function roundWon(team, user) {
  celebrating = true;
  addWins(team, cfg.winsPerRound);
  const { name, color } = cfg.teams[team];
  // MVP: quien más empujó en esta ronda para el equipo ganador.
  let mvp = null;
  for (const p of players.values()) if (p.team === team && p.round > 0 && (!mvp || p.round > mvp.round)) mvp = p;
  const mvpInfo = mvp ? { name: mvp.name, pts: Math.round(mvp.round) } : null;
  for (const p of players.values()) p.round = 0;
  if (wins[team] >= cfg.goalWins) {
    championWon(team, user);
    return;
  }
  // Racha: con 3 victorias seguidas, el rival arranca la próxima ronda con ventaja (remontada).
  streak = streak.team === team ? { team, n: streak.n + 1 } : { team, n: 1 };
  roundCount++;
  const hot = streak.n >= 3;
  const sub = [hot ? `🔥 RACHA x${streak.n}` : '', mvpInfo ? `MVP: ${mvpInfo.name} (+${mvpInfo.pts})` : '', `Último empujón: ${user}`].filter(Boolean).join(' · ');
  showBanner(`¡GANAN LOS ${name}!`, sub, color, CELEBRATE_MS - 300);
  if (hot) bot?.say('streak', { team: name, n: streak.n, rival: cfg.teams[team === 'heroes' ? 'villains' : 'heroes'].name }, 4);
  if (mvpInfo) bot?.say('mvp', { user: bot.speakableName(mvpInfo.name), team: name }, 4);
  sfx.roundWon(team);
  impact('large', team, 0, 1.6, team === 'heroes' ? -TRACK_HALF : TRACK_HALF);
  bot?.onRoundWon(team, name, user, wins[team]);
  hostAvatar?.celebrate();
  hostAvatar?.setEmotion('excited', 4);
  burstConfetti(team === 'heroes' ? -TRACK_HALF : TRACK_HALF, color);
  for (const p of pushers) p.leave();
  setTimeout(() => {
    // Ventaja del 25% del camino para el rival de una racha larga.
    pos = hot ? -TEAM_SIGN[team] * cfg.trackPoints * 0.25 : 0;
    celebrating = false;
    const every = Number(cfg.boss?.everyRounds) || 0;
    if (every && roundCount % every === 0) startBoss();
  }, CELEBRATE_MS);
}

// ---- Jefe de ronda: entre los dos equipos tienen que bajarle la vida; el que más daño hace se lleva un WIN ----
let streak = { team: null, n: 0 };
let roundCount = 0;
const boss = { active: false, hp: 0, max: 0, endsAt: 0, dmg: { heroes: 0, villains: 0 } };

function renderBoss() {
  const el = $('bossBox');
  el.classList.toggle('on', boss.active);
  if (!boss.active) return;
  $('bossFill').style.width = `${Math.max(0, (boss.hp / boss.max) * 100)}%`;
  $('bossText').textContent = `👹 JEFE ${Math.max(0, Math.round(boss.hp))}/${boss.max} · ${Math.max(0, Math.ceil((boss.endsAt - performance.now()) / 1000))}s`;
}

function startBoss() {
  if (boss.active || championActive) return;
  boss.max = boss.hp = Math.max(50, Number(cfg.boss?.hp) || 600);
  boss.dmg = { heroes: 0, villains: 0 };
  boss.endsAt = performance.now() + (Number(cfg.boss?.seconds) || 45) * 1000;
  boss.active = true;
  showBanner('👹 ¡APARECE EL JEFE!', 'Empujen los dos: el que más daño haga gana 1 WIN extra', '#ff5470', 3000);
  hostAvatar?.setEmotion('surprised', 2);
  bot?.say('bossStart', {}, 4);
  renderBoss();
}

function damageBoss(delta) {
  if (!boss.active) return;
  const team = delta > 0 ? 'heroes' : 'villains';
  const d = Math.abs(delta);
  boss.dmg[team] += d;
  boss.hp -= d;
  if (boss.hp <= 0) endBoss(true);
}

function endBoss(defeated) {
  if (!boss.active) return;
  boss.active = false;
  renderBoss();
  if (!defeated) {
    showBanner('El jefe escapó...', 'La próxima lo vencemos', '#ffffff', 2500);
    bot?.say('bossLost', {}, 3);
    return;
  }
  const team = boss.dmg.heroes >= boss.dmg.villains ? 'heroes' : 'villains';
  const { name, color } = cfg.teams[team];
  showBanner('¡JEFE DERROTADO!', `Más daño: ${name} · +1 WIN`, color, 3200);
  burstConfetti(ballZ, color);
  sfx.roundWon(team);
  hostAvatar?.celebrate();
  bot?.say('bossWin', { team: name }, 4);
  if (!championActive) {
    addWins(team, 1);
    if (wins[team] >= cfg.goalWins) championWon(team, 'el jefe');
  }
}

setInterval(() => {
  if (!boss.active) return;
  if (performance.now() >= boss.endsAt) endBoss(false);
  else renderBoss();
}, 500);

// Un equipo llegó a la meta de WINS: gran festejo y torneo nuevo desde 0.
let championActive = false;
function championWon(team, user) {
  if (championActive) return;
  championActive = true;
  celebrating = true;
  const { name, color } = cfg.teams[team];
  const ms = Math.max(4, Number(cfg.championSeconds) || 9) * 1000;

  const el = $('champion');
  el.style.setProperty('--team', color);
  $('championTeam').textContent = name;
  $('championWins').textContent = `${cfg.goalWins} WINS`;
  $('championUser').textContent = `Último empujón: ${user}`;
  const wk = weeklyTop();
  $('championTop').textContent = wk.length ? `👑 Top de la semana: ${wk.join(' · ')}` : '';
  el.classList.add('show');
  $('banner').classList.remove('show');

  queue.length = 0;
  for (const p of pushers) p.leave();
  sfx.champion(team);
  hostAvatar?.celebrate();
  hostAvatar?.setEmotion('love', 5); // festeja con corazones
  if (bot) {
    bot.queue.length = 0;
    bot.say('champion', { team: name, wins: cfg.goalWins, user: bot.speakableName(user) }, 6);
  }

  // Fuegos artificiales de confeti a lo largo de la pista durante todo el festejo.
  const palette = [color, '#ffd84d', '#ffffff'];
  let shots = 0;
  const fireworks = setInterval(() => {
    burstConfetti(ballZ - 6 + Math.random() * 12, palette[shots % palette.length]);
    cameraShake = Math.max(cameraShake, 0.35);
    shots++;
  }, 650);

  const end = performance.now() + ms;
  const countdown = setInterval(() => {
    const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
    $('championCountdown').textContent = `Nuevo torneo en ${left}...`;
  }, 200);

  setTimeout(() => {
    clearInterval(fireworks);
    clearInterval(countdown);
    el.classList.remove('show');
    addWins('heroes', -wins.heroes, false);
    addWins('villains', -wins.villains, false);
    players.clear(); topDirty = true; // el podio es por torneo
    streak = { team: null, n: 0 }; roundCount = 0; boss.active = false; renderBoss();
    pos = 0;
    celebrating = false;
    championActive = false;
    showBanner('¡NUEVO TORNEO!', `Primero a ${cfg.goalWins} WINS`, '#ffffff', 2500);
  }, ms);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const rowsByKey = new Map();

function buildHud() {
  topDirty = true;
  for (const team of ['heroes', 'villains']) {
    const winBox = $(winsElementId(team));
    winBox.querySelector('.winTeam').textContent = cfg.teams[team].name;
    winBox.querySelector('.winTeam').style.color = cfg.teams[team].color;
    renderWins(team);
  }
  for (const team of ['heroes', 'villains']) {
    const box = $(team === 'heroes' ? 'teamHeroes' : 'teamVillains');
    const title = box.querySelector('.teamName');
    title.textContent = cfg.teams[team].name;
    title.style.color = cfg.teams[team].color;
    const rows = box.querySelector('.rows');
    rows.innerHTML = '';
    for (const rule of allRules().filter((r) => r.team === team)) {
      const row = document.createElement('div');
      row.className = 'row';
      const gift = document.createElement('div');
      gift.className = 'gift';
      const char = document.createElement('div');
      char.className = 'char';
      char.style.background = cfg.teams[team].color;
      if (rule.image) {
        const img = document.createElement('img');
        img.src = rule.image;
        img.alt = rule.label;
        char.appendChild(img);
      } else {
        char.textContent = rule.emoji;
        char.classList.add('emojiChar');
      }
      const pts = document.createElement('div');
      pts.className = 'pts';
      pts.style.color = '#fff';
      const per = rule.points ?? (rule.diamonds ? unitPoints(rule) : null);
      pts.textContent = rule.wins ? `+${rule.wins} WIN` : per != null ? `${per}` : '💎';
      row.append(gift, char, pts);
      rows.appendChild(row);
      rowsByKey.set(rule.key, { row, gift, rule });
      renderGiftIcon(rule);
    }
  }
}

function renderGiftIcon(rule) {
  const entry = rowsByKey.get(rule.key);
  if (!entry) return;
  // Ícono fijo (emoji) siempre visible; si llega el ícono oficial de TikTok se muestra encima.
  const url = rule.icon || giftIcons[rule.key];
  // Sin ícono oficial el hueco queda vacío (nada de etiquetas de texto): el personaje ya identifica la fila.
  entry.gift.innerHTML = '';
  if (url) {
    const img = new Image();
    img.alt = rule.label;
    img.referrerPolicy = 'no-referrer';
    // Con el ícono oficial, reemplaza al cuadro de color con emoji (queda en su lugar).
    img.onload = () => { entry.gift.innerHTML = ''; entry.gift.appendChild(img); entry.row.classList.add('hasIcon'); };
    img.src = url; // si falla, queda el emoji
  }
}

/** Íconos oficiales de TikTok para los regalos configurados (vienen del bridge al conectarse). */
function applyGiftCatalog(gifts) {
  if (!Array.isArray(gifts)) return;
  const byName = new Map(gifts.filter((g) => g && g.name && g.image).map((g) => [g.name.toLowerCase(), g.image]));
  let changed = 0;
  for (const [name, rule] of giftRules) {
    const image = byName.get(name);
    if (!image || rule.icon || giftIcons[rule.key] === image) continue;
    giftIcons[rule.key] = image;
    renderGiftIcon(rule);
    changed++;
  }
  if (changed) storage.set(ICONS_KEY, giftIcons);
  const missing = [...giftRules.keys()].filter((n) => !byName.has(n));
  if (missing.length) console.log('Regalos de race.json que no están en el catálogo de TikTok (revisá el nombre):', missing.join(', '));
}

function flashRow(rule) {
  const entry = rowsByKey.get(rule.key);
  if (!entry) return;
  entry.row.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.22)', offset: 0.3 }, { transform: 'scale(1)' }],
    { duration: 450, easing: 'ease-out' },
  );
}

function addFeed(user, text, team, avatar) {
  const feed = $('feed');
  const item = document.createElement('div');
  item.className = 'feedItem';
  item.style.setProperty('--c', team ? cfg.teams[team].color : '#fff');
  const pic = document.createElement('span');
  pic.className = 'feedPic';
  if (avatar) {
    const img = document.createElement('img');
    img.src = avatar;
    img.alt = '';
    img.onerror = () => { img.remove(); pic.textContent = user.charAt(0).toUpperCase(); };
    pic.appendChild(img);
  } else {
    pic.textContent = user.charAt(0).toUpperCase();
  }
  const b = document.createElement('b');
  b.textContent = user;
  item.append(pic, b, ' ' + text);
  feed.prepend(item);
  while (feed.children.length > 5) feed.lastChild.remove();
}

// Estado visible arriba a la izquierda: bridge, TikTok y cuántos eventos reales llegaron.
// Así se ve de un vistazo si el juego está recibiendo el live (tecla D lo oculta).
const stats = { chat: 0, like: 0, gift: 0, follow: 0, join: 0, ignored: 0, lastAt: 0 };
let bridgeUp = false;
let tiktokState = 'esperando';

function refreshStatus() {
  const ago = stats.lastAt ? Math.round((Date.now() - stats.lastAt) / 1000) : null;
  const tk = tiktokState === 'tiktok_connected' ? 'TikTok ✓'
    : tiktokState === 'mock' ? 'MODO PRUEBA'
    : tiktokState === 'stream_end' ? 'live terminó'
    : tiktokState === 'tiktok_disconnected' ? 'TikTok: esperando tu live…' : 'TikTok…';
  const dot = bridgeUp && (tiktokState === 'tiktok_connected' || tiktokState === 'mock') ? '#33d95a' : bridgeUp ? '#ffb020' : 'var(--villains)';
  $('dot').style.background = dot;
  $('connLabel').textContent = !bridgeUp
    ? 'Bridge desconectado'
    : `${tk} · 💬${stats.chat} ❤${stats.like} 🎁${stats.gift}${ago != null ? ` · hace ${ago}s` : ''}`;
}
setInterval(refreshStatus, 1000);

function setConnected(ok) {
  bridgeUp = ok;
  if (!ok) tiktokState = 'esperando';
  refreshStatus();
}

// ---------------------------------------------------------------------------
// Eventos del bridge
// ---------------------------------------------------------------------------
const userReadyAt = new Map();
const commandReadyAt = new Map();
const unknownGifts = new Set();

/**
 * Aplica una regla (regalo, likes, follow o comando).
 * Cada regalo es UN muñeco que empuja una vez por unidad: 10 rosas = 1 muñeco, 10 empujones,
 * cada uno del valor del regalo. Más de MAX_PUSHES_PER_GIFT unidades se reparten en ese máximo.
 */
function handleRule(rule, { user, count = 1, caption, avatar, diamonds, kind = 'gift' }) {
  const sign = TEAM_SIGN[rule.team];
  const team = rule.team;
  const teamName = cfg.teams[team].name;
  const epic = kind === 'gift' && isEpic(rule, diamonds);
  flashRow(rule);

  if (rule.wins) {
    const gained = rule.wins * count;
    sfx.gift(team, true);
    addWins(team, gained);
    if (wins[team] >= cfg.goalWins) championWon(team, user);
    addFeed(user, `${caption} (+${gained} WIN)`, team, avatar);
    if (epic) showEpic({ user, avatar, rule, count, extra: `+${gained} WIN` });
    else if (!celebrating) showBanner(`+${gained} WIN ${teamName}`, user, cfg.teams[team].color, 1800);
    bot?.onGift({ user, label: rule.label, count, team, teamName, big: true });
    return;
  }

  const each = unitPoints(rule, diamonds);
  if (!each) return;
  const total = each * count * boostMult() * teamMult(team) * (kind === 'like' ? likeMult() : 1);
  if (kind === 'gift' || kind === 'command') lastGiftAt = performance.now();
  recordPlay(user, avatar, team, kind === 'like' ? total * 0.2 : total);
  if (kind === 'gift') {
    const unitDiamonds = Number(diamonds) || rule.diamonds || 1;
    addGoal(unitDiamonds * count);
    grantBuff(team, unitDiamonds, user); // el poder rinde desde el próximo empujón
  }
  sfx.gift(team, epic || total >= 100);
  // Nova reacciona: un regalo grande la sorprende y después la emociona; uno chico la alegra.
  if (kind === 'gift' && hostAvatar) {
    if (epic) { hostAvatar.setEmotion('surprised', 1.1); setTimeout(() => hostAvatar?.setEmotion('excited', 2.6), 1100); }
    else if (total >= 100) hostAvatar.setEmotion('excited', 2.2);
    else if (hostAvatar.isNeutral()) hostAvatar.setEmotion('happy', 1.6);
  }

  const strokes = Math.min(count, MAX_PUSHES_PER_GIFT);
  enqueueMove({ rule, user, step: (sign * total) / strokes, strokes, caption, avatar, epic });
  if (epic) showEpic({ user, avatar, rule, count }); // el muñeco sale gigante: súper animación
  addFeed(user, caption, team, avatar);

  if (!bot) return;
  if (kind === 'like') bot.onLikes(user);
  else if (kind === 'follow') { bot.onFollow(user); hostAvatar?.setEmotion('love', 3); }
  else if (kind === 'gift') bot.onGift({ user, label: rule.label, count, team, teamName, big: epic });
}

// Súper animación de pantalla completa para los regalos grandes.
let epicTimer = 0;
function showEpic({ user, avatar, rule, count, extra }) {
  const el = $('epic');
  const color = cfg.teams[rule.team].color;
  el.style.setProperty('--team', color);
  const photo = $('epicPhoto');
  photo.innerHTML = '';
  if (avatar) {
    const img = document.createElement('img');
    img.src = avatarUrl(avatar);
    img.alt = '';
    photo.appendChild(img);
  } else {
    photo.textContent = (user.match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
  }
  const iconUrl = rule.icon || giftIcons[rule.key];
  const epicGift = $('epicGift');
  epicGift.innerHTML = '';
  const bigEmoji = document.createElement('div');
  bigEmoji.className = 'bigEmoji';
  bigEmoji.textContent = rule.emoji;
  epicGift.appendChild(bigEmoji);
  if (iconUrl) {
    const img = new Image();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { epicGift.innerHTML = ''; epicGift.appendChild(img); };
    img.src = iconUrl;
  }
  $('epicTitle').textContent = `¡${rule.label.toUpperCase()}${count > 1 ? ` x${count}` : ''}!`;
  $('epicUser').textContent = user;
  $('epicSub').textContent = extra || `para los ${cfg.teams[rule.team].name}`;
  // Reinicia la animación CSS sin forzar layout: se quita la clase y se vuelve a poner en el próximo frame.
  el.classList.remove('show');
  requestAnimationFrame(() => el.classList.add('show'));
  sfx.epic(rule.team);
  hostAvatar?.celebrate();
  clearTimeout(epicTimer);
  epicTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function route(raw) {
  let e;
  try { e = JSON.parse(raw); } catch { console.warn('JSON inválido ignorado'); return; }
  if (!e || typeof e.type !== 'string') { console.warn('Evento sin "type" ignorado'); return; }
  const user = e.user || 'anon';
  const count = Math.max(1, Number(e.count) || 1);
  const avatar = avatarUrl(e.avatar);
  if (e.type in stats) stats[e.type]++;
  // Medición: cuánto tardó TikTok en entregar el mensaje y cuánto el trayecto bridge -> juego.
  if (e.tt && (e.type === 'chat' || e.type === 'gift')) bot?.log('feed', { type: e.type, tiktokToBridgeMs: Math.max(0, e.ts - e.tt), bridgeToGameMs: Math.max(0, Date.now() - e.ts) });
  if (e.type !== 'status' && e.type !== 'catalog') { stats.lastAt = Date.now(); refreshStatus(); }

  switch (e.type) {
    case 'gift': {
      const key = String(e.giftName || '').toLowerCase();
      let rule = giftRules.get(key);
      if (e.giftImage && rule && giftIcons[rule.key] !== e.giftImage) {
        giftIcons[rule.key] = e.giftImage;
        storage.set(ICONS_KEY, giftIcons);
        renderGiftIcon(rule);
      }
      if (!rule) {
        // Regalo que no está en race.json: igual cuenta. Va a un equipo según el usuario
        // (siempre el mismo para la misma persona) y empuja según su costo en monedas.
        rule = autoRule(e.giftName || 'Regalo', e.userId || user, e.giftImage);
        if (!unknownGifts.has(key)) { unknownGifts.add(key); console.log(`Regalo "${e.giftName}" no está en race.json: se cuenta igual por su costo (${e.diamonds ?? '?'} monedas)`); }
      }
      handleRule(rule, { user, count, caption: `${rule.label} x${count}`, avatar, diamonds: e.diamonds, kind: 'gift' });
      break;
    }
    case 'like':
      if (likeRule) handleRule(likeRule, { user, count, caption: `${likeRule.label} x${count}`, avatar, kind: 'like' });
      break;
    case 'follow':
      if (followRule) handleRule(followRule, { user, count: 1, caption: followRule.label, avatar, kind: 'follow' });
      break;
    case 'join':
      if (bot) { bot.onJoin(user, touchPlayer(user)); hostAvatar?.wave(); if (hostAvatar?.isNeutral()) hostAvatar.setEmotion('happy', 1.8); }
      break;
    case 'chat': {
      const text = String(e.text || '').trim();
      // Un comentario que son solo puntos no es para Nova: suma para activar el modo popular.
      if (text && /^[.·•\s]+$/.test(text) && text.includes('.')) { countDot(e.userId || user); return; }
      const word = text.split(/\s+/)[0].toLowerCase();
      const rule = commandRules.get(word);
      if (!rule) { bot?.onChat(user, text); return; }
      const now = performance.now();
      const userKey = e.userId || user;
      if ((userReadyAt.get(userKey) || 0) > now || (commandReadyAt.get(rule.key) || 0) > now) return;
      userReadyAt.set(userKey, now + USER_COMMAND_COOLDOWN_MS);
      commandReadyAt.set(rule.key, now + rule.cooldownSec * 1000);
      handleRule(rule, { user, count: 1, caption: rule.label, avatar, kind: 'command' });
      break;
    }
    case 'status':
      console.log('Bridge:', e.text);
      tiktokState = e.text;
      refreshStatus();
      if (e.text === 'tiktok_connected' || e.text === 'mock') onLiveConnected();
      break;
    case 'catalog':
      applyGiftCatalog(e.gifts);
      break;
    default:
      break;
  }
}

function connect() {
  let ws;
  try { ws = new WebSocket(WS_URL); } catch { setTimeout(connect, 3000); return; }
  ws.onopen = () => setConnected(true);
  ws.onmessage = (m) => route(m.data);
  ws.onclose = () => { setConnected(false); setTimeout(connect, 3000); };
  ws.onerror = () => ws.close();
}

// Sonido y voz: el navegador solo los permite después de un clic o una tecla del usuario.
// Por eso hay una pantalla inicial: el primer gesto arranca el audio Y la voz de Nova
// (speechSynthesis tiene que llamarse dentro del gesto, no antes).
let started = false;
async function startGame() {
  if (started) return;
  started = true;
  $('startGate').classList.add('hidden');
  if (MONITOR) return;
  playSplash(); // presentación de marca: se ve en el live apenas arranca
  await unlockAudio();
  $('soundHint').classList.add('hidden');
  if (liveConnected) { // si el live ya estaba conectado, Nova saluda y arranca la música ahora
    bot?.start();
    if (wantMusic) setMusic(true);
  }
}
for (const type of ['pointerdown', 'touchend']) window.addEventListener(type, startGame);

// Evita que Windows apague la pantalla o suspenda la PC durante el live (si el navegador lo permite).
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* sin permiso: no pasa nada */ }
}
document.addEventListener('visibilitychange', () => { if (!wakeLock) keepAwake(); });

// ---------------------------------------------------------------------------
// Tráfico simulado (solo dentro del juego: no toca TikTok ni el bridge).
// Tecla D: apagado -> suave -> medio -> fuerte -> apagado. También ?demo=1/2/3 al abrir.
// ---------------------------------------------------------------------------
const DEMO_LEVELS = [
  { name: 'apagado' },
  { name: 'SUAVE',  join: 6,  chat: 9,  like: 3,   gift: 14, follow: 40 },
  { name: 'MEDIO',  join: 3,  chat: 5,  like: 1.5, gift: 6,  follow: 20 },
  { name: 'FUERTE', join: 1.2, chat: 2.5, like: 0.6, gift: 2.2, follow: 9 },
];
const DEMO_NAMES = ['Sofi', 'Mateo', 'luna_77', 'Dani', 'Cami', 'Joaquín', 'Vale', 'Nico', 'Lu', 'Fran', 'Mica', 'Tomi', 'Aye', 'Gonza', 'Flor', 'Bauti'];
const DEMO_CHAT = ['hola nova', 'qué buen juego', 'vamos héroes', 'vamos villanos', 'cuánto sale el león?', 'sos un robot?', 'saludos desde córdoba', 'nova cómo estás', 'quién va ganando?', 'me encanta este live', 'cómo se juega', 'qué lindo el avatar', '!heroes', '!villanos', 'chau, me voy'];
let demoLevel = 0;
let demoTimers = [];

// 8 jugadores fijos: 4 con cada equipo (siempre los mismos, como gente que se queda jugando).
const DEMO_ROSTER = DEMO_NAMES.slice(0, 8).map((name, i) => ({ name, team: i % 2 ? 'villains' : 'heroes' }));
function demoEmit(ev, player = pickOne(DEMO_ROSTER)) {
  // Mientras se procesa un evento simulado, Nova lo ignora (no habla de gente falsa ni gasta la IA).
  window.__demoEvt = true;
  try { route(JSON.stringify({ user: player.name, userId: player.name, avatar: `/mock-avatar/${encodeURIComponent(player.name)}.svg`, ...ev })); } finally { window.__demoEvt = false; }
}
function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function setDemo(level) {
  demoTimers.forEach(clearTimeout);
  demoTimers = [];
  demoLevel = ((level % DEMO_LEVELS.length) + DEMO_LEVELS.length) % DEMO_LEVELS.length;
  const L = DEMO_LEVELS[demoLevel];
  showBanner(demoLevel ? `TRÁFICO SIMULADO: ${L.name}` : 'TRÁFICO SIMULADO: APAGADO', '', '#ffffff', 1200);
  if (!demoLevel) return;
  const loop = (every, fn) => {
    const tick = () => {
      if (!demoLevel) return;
      fn();
      demoTimers.push(setTimeout(tick, every * 1000 * (0.5 + Math.random())));
    };
    demoTimers.push(setTimeout(tick, every * 1000 * Math.random()));
  };
  const gifts = [...giftRules.values()].filter((r) => !r.wins && r.diamonds);
  const cheap = gifts.filter((r) => r.diamonds <= 30);
  loop(L.join * 2, () => demoEmit({ type: 'join' }));
  loop(L.chat, () => {
    const p = pickOne(DEMO_ROSTER);
    const cmd = Math.random() < 0.3;
    demoEmit({ type: 'chat', text: cmd ? (p.team === 'heroes' ? '!heroes' : '!villanos') : pickOne(DEMO_CHAT.filter((t) => !t.startsWith('!'))) }, p);
  });
  loop(L.like, () => demoEmit({ type: 'like', count: 1 + Math.floor(Math.random() * 8) }));
  loop(L.follow, () => demoEmit({ type: 'follow' }));
  loop(L.gift, () => {
    // Casi todos son regalos chicos; de vez en cuando uno mediano. Los grandes quedan para las teclas de prueba.
    const p = pickOne(DEMO_ROSTER);
    const mine = (list) => list.filter((r) => r.team === p.team);
    const pool = Math.random() < 0.85 && mine(cheap).length ? mine(cheap) : mine(gifts).filter((r) => r.diamonds <= 400);
    const r = pickOne(pool.length ? pool : mine(gifts));
    demoEmit({ type: 'gift', giftName: r.label, diamonds: r.diamonds, count: 1 + Math.floor(Math.random() * (r.diamonds <= 5 ? 10 : 2)) }, p);
  });
}
if (Number(PARAMS.get('demo')) > 0) setTimeout(() => setDemo(Number(PARAMS.get('demo'))), 4000);

// Atajos para el streamer.
window.addEventListener('keydown', (e) => {
  startGame();
  if (e.repeat) return;
  if (e.key === 'd' || e.key === 'D') { setDemo(demoLevel + 1); return; }
  const testRule = (team, epic = false) =>
    [...giftRules.values()].find((r) => r.team === team && !r.wins && isEpic(r) === epic) || null;
  const test = (team, count, epic) => {
    const r = testRule(team, epic);
    if (r) handleRule(r, { user: 'prueba', count, caption: `${r.label} x${count}`, avatar: '/mock-avatar/prueba.svg', kind: 'gift' });
  };
  switch (e.key) {
    case 'q': case 'Q': addWins('heroes', 1); break;
    case 'a': case 'A': addWins('heroes', -1); break;
    case 'p': case 'P': addWins('villains', 1); break;
    case 'l': case 'L': addWins('villains', -1); break;
    case '0': addWins('heroes', -wins.heroes); addWins('villains', -wins.villains); break;
    case 'j': case 'J': if (!celebrating) startBoss(); break;
    case 'o': case 'O': ['a', 'b', 'c', 'd', 'e'].forEach((u, i) => setTimeout(() => { countDot(u); countDot(u); }, i * 120)); break; // prueba: ráfaga de puntos
    case 'm': case 'M': showBanner(toggleMusic() ? 'MÚSICA ON' : 'MÚSICA OFF', '', '#ffffff', 900); break;
    case 'r': case 'R': if (!celebrating) pos = 0; break;
    // Pruebas de emociones de Nova: 1 neutral, 2 feliz, 3 eufórica, 4 sorprendida, 5 enojada, 6 triste, 7 enamorada, 8 guiño, 9 pensando.
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
      hostAvatar?.setEmotion(['neutral', 'happy', 'excited', 'surprised', 'angry', 'sad', 'love', 'wink', 'thinking'][Number(e.key) - 1], 3);
      break;
    case 'h': case 'H': test('heroes', 10, false); break;
    case 'v': case 'V': test('villains', 10, false); break;
    case 'g': case 'G': test('heroes', 1, true); break;
    case 'c': case 'C': if (!celebrating) championWon(Math.random() < 0.5 ? 'heroes' : 'villains', 'prueba'); break;
    case 'k': case 'K': test('villains', 1, true); break;
    case 'b': case 'B':
      if (bot) {
        bot.muted = !bot.muted;
        if (bot.muted) bot.stop();
        showBanner(bot.muted ? 'BOT EN SILENCIO' : 'BOT ACTIVADO', '', '#ffffff', 900);
      }
      break;
  }
});

// ---------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------
function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// Física de la pelota: un resorte hacia la posición del puntaje con inercia, rozamiento
// y velocidad máxima, integrado en sub-pasos fijos para que sea estable con cualquier FPS.
const BALL_STIFFNESS = 14;
const BALL_DAMPING = 2 * Math.sqrt(BALL_STIFFNESS) * 0.8; // apenas sub-amortiguado: un pequeño rebote
const BALL_MAX_SPEED = 24;          // unidades por segundo
const PHYSICS_STEP = 1 / 120;
const GRAVITY = 30;
let ballHop = 0;
let ballHopVel = 0;
let physicsAccumulator = 0;

function stepBall(targetZ, dt) {
  physicsAccumulator += dt;
  while (physicsAccumulator >= PHYSICS_STEP) {
    physicsAccumulator -= PHYSICS_STEP;
    const accel = BALL_STIFFNESS * (targetZ - ballZ) - BALL_DAMPING * ballVel;
    ballVel = clamp(ballVel + accel * PHYSICS_STEP, -BALL_MAX_SPEED, BALL_MAX_SPEED);
    ballZ = clamp(ballZ + ballVel * PHYSICS_STEP, -TRACK_HALF - 1, TRACK_HALF + 1);

    ballHopVel -= GRAVITY * PHYSICS_STEP;
    ballHop += ballHopVel * PHYSICS_STEP;
    if (ballHop <= 0) {
      ballHop = 0;
      // Rebota perdiendo energía hasta quedar quieta en el piso.
      ballHopVel = ballHopVel < -2 ? -ballHopVel * 0.35 : 0;
    }
  }
}

function kickBall(delta) {
  // Cuanto más fuerte el empujón, más salta la pelota (con tope).
  ballHopVel = Math.max(ballHopVel, Math.min(9, 3 + Math.abs(delta) * 0.08));
}

const camLook = new THREE.Vector3();
const barMarker = $('barMarker');
let lastMarkerPct = null;
let last = performance.now();

// Calidad adaptativa: LIVE Studio captura a 30 FPS, así que dibujar de más solo le roba GPU al
// codificador de video. Se limita a 60 FPS y, si la PC no llega, baja la resolución (y al final
// las sombras) sola, antes de que se noten los tirones. Solo baja, nunca sube (evita oscilar).
const FRAME_MS = 1000 / (Number(PARAMS.get('fps')) || 60);
const QUALITY_STEPS = [1.5, 1.25, 1, 0.85, 0.7];
let qualityLevel = Math.max(0, QUALITY_STEPS.findIndex((r) => r <= Math.min(window.devicePixelRatio, 1.5)));
let slowSince = 0;
let avgMs = 16;
const bootAt = performance.now();

function adaptQuality(now, dtMs) {
  avgMs += (dtMs - avgMs) * 0.05;
  if (document.hidden || now - bootAt < 10000) return; // los primeros segundos compilan shaders y cargan fotos
  if (avgMs < 26) { slowSince = 0; return; }
  slowSince = slowSince || now;
  if (now - slowSince < 3000) return; // hace falta un rato lento sostenido, no un tirón aislado
  slowSince = 0;
  avgMs = 16;
  if (qualityLevel < QUALITY_STEPS.length - 1) {
    qualityLevel++;
    renderer.setPixelRatio(QUALITY_STEPS[qualityLevel]);
    resize();
    console.warn(`PC lenta: bajo la resolución del juego (x${QUALITY_STEPS[qualityLevel]})`);
  } else if (renderer.shadowMap.enabled) {
    renderer.shadowMap.enabled = false;
    sun.castShadow = false;
    scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    console.warn('PC lenta: apago las sombras');
  }
}

let nextFrameAt = 0;

function frame(now) {
  // Tope de FPS con reloj propio: reparte los cuadros parejo en pantallas de 60, 75 o 144 Hz.
  if (now < nextFrameAt - 1) { requestAnimationFrame(frame); return; }
  nextFrameAt = now - nextFrameAt > FRAME_MS ? now + FRAME_MS : nextFrameAt + FRAME_MS;
  const rawMs = now - last;
  const dt = Math.min(0.05, rawMs / 1000);
  last = now;
  adaptQuality(now, rawMs);
  const t = now / 1000;

  dispatchQueue(now);

  // Hit-stop: tras un golpe fuerte, la acción casi se congela unas centésimas de segundo
  // (los efectos y la cámara siguen en tiempo real). Es lo que hace que un golpe "pese".
  const gdt = hitStop > 0 ? dt * 0.08 : dt;
  hitStop = Math.max(0, hitStop - dt);

  const targetZ = (-pos / cfg.trackPoints) * TRACK_HALF;
  const prevZ = ballZ;
  stepBall(targetZ, gdt);
  const { body, roll } = ball.userData;
  roll.rotation.x += (ballZ - prevZ) / BALL_R; // rueda sin deslizar, sobre su centro
  // Se aplasta un poco al tocar el piso; el centro baja lo justo para que siga apoyada.
  const squash = ballHop === 0 ? Math.min(0.12, Math.abs(ballHopVel) * 0.02) : 0;
  body.scale.set(1 + squash, 1 - squash, 1 + squash);
  body.position.set(0, BALL_R * (1 - squash) + ballHop, ballZ);

  for (const p of [...pushers]) p.update(gdt);
  updateConfetti(dt);
  updateSnow(dt, t);
  updateShockwaves(dt);

  // Estela brillante detrás de la pelota cuando va rápido, del color del equipo que la empuja.
  if (Math.abs(ballVel) > 5) {
    spawnSparks(0, 0.6 + ballHop, ballZ - Math.sign(ballVel) * BALL_R, 1,
      cfg.teams[ballVel < 0 ? 'heroes' : 'villains'].color, { speed: 1.4, up: 1.2, life: 0.5, spread: 3, grav: 1.5 });
  }
  updateSparks(dt);

  // La cámara va atada a la pelota (sin retraso en z): nunca la pierde de vista.
  const camZ = clamp(ballZ + 17, -TRACK_HALF + 8, TRACK_HALF + 15);
  cameraShake = Math.max(0, cameraShake - dt * 1.6);
  const shake = cameraShake * cameraShake * 0.6;
  camera.position.x += (Math.sin(t * 0.3) * 0.6 - camera.position.x) * Math.min(1, dt * 2);
  camera.position.y = 11.5 + (Math.random() - 0.5) * shake;
  camera.position.z = camZ + (Math.random() - 0.5) * shake;
  camLook.set((Math.random() - 0.5) * shake, 0, camZ - 19);
  camera.lookAt(camLook);
  // Tirón del zoom en los impactos: el campo de visión se abre un poco y vuelve solo.
  if (fovKick > 0.02) {
    fovKick *= Math.exp(-dt * 9);
    camera.fov = BASE_FOV + fovKick;
    camera.updateProjectionMatrix();
  } else if (camera.fov !== BASE_FOV) {
    fovKick = 0;
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
  }

  sun.position.set(-18, 38, ballZ + 14);
  sun.target.position.set(0, 0, ballZ - 4);

  // Solo se toca el DOM si el marcador se movió de verdad (evita recalcular el layout cada frame).
  const markerPct = Math.round((50 + (ballZ / TRACK_HALF) * 50) * 10) / 10;
  if (markerPct !== lastMarkerPct) {
    lastMarkerPct = markerPct;
    barMarker.style.left = `${markerPct}%`;
  }

  renderer.render(scene, camera);
  if (hostAvatar) {
    hostAvatar.update(dt);
    hostAvatar.render(renderer, canvas);
  }
  bot?.tick();
  requestAnimationFrame(frame);
}

// Compila de antemano todos los shaders que aparecen durante el juego (personajes, gigante,
// onda expansiva, confeti). Si no, la primera vez que aparecen congelan la imagen un instante.
function warmUpShaders() {
  const temp = [];
  for (const team of ['heroes', 'villains']) {
    const rule = allRules().find((r) => r.team === team);
    if (!rule) continue;
    temp.push(new Pusher({ rule, user: 'warmup', step: 0, strokes: 0, caption: '', avatar: '' }));
    temp.push(new Pusher({ rule, user: 'warmup', step: 0, strokes: 0, caption: '', avatar: '', epic: true }));
  }
  shockwaves.forEach((r) => { r.visible = true; });
  confetti.mesh.visible = true;
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  shockwaves.forEach((r) => { r.visible = false; });
  confetti.mesh.visible = false;
  for (const p of temp) p.dispose();
}

// ---------------------------------------------------------------------------
// Bot presentador
// ---------------------------------------------------------------------------
let bot = null;
let hostAvatar = null;
let bubbleTimer = 0;

async function setupBot() {
  let botCfg;
  try {
    botCfg = await (await fetch('/config/bot.json', { cache: 'no-store' })).json();
  } catch {
    return; // sin bot.json no hay presentador
  }
  if (!botCfg.enabled) return;
  if (MONITOR) {
    $('soundHint').textContent = 'MONITOR (sin sonido)';
    botCfg.voice = { ...botCfg.voice, volume: 0 }; // subtítulos sí, voz no
  }
  $('host').classList.add('on');
  $('hostName').textContent = `${(botCfg.name || 'Nova').toUpperCase()} · IA`; // aclara que es una IA
  hostAvatar = new HostAvatar(botCfg.avatar, $('hostBox'));
  bot = new Bot(botCfg, {
    onSpeakStart(text) {
      // Si no hay una emoción más específica en curso, la cara acompaña lo que dice.
      if (hostAvatar.isNeutral()) {
        const mood = /wow|incre[ií]ble|no lo puedo creer|campeon|victoria|ganan/i.test(text) ? 'excited'
          : /cuidado|a punto|casi/i.test(text) ? 'surprised'
          : /\?/.test(text) ? 'thinking'
          : /gracias|bienvenid|hola/i.test(text) ? 'happy'
          : null;
        if (mood) hostAvatar.setEmotion(mood, 2.6);
      }
      hostAvatar.setSpeaking(true);
      duckMusic(true);
      clearTimeout(bubbleTimer);
      $('bubble').textContent = text;
      $('bubble').classList.add('show');
    },
    onSpeakEnd() {
      hostAvatar.setSpeaking(false);
      duckMusic(false);
      bubbleTimer = setTimeout(() => $('bubble').classList.remove('show'), 1200);
    },
    getState: () => ({ ratio: pos / cfg.trackPoints, wins, teams: cfg.teams }),
  });
  console.log('Voz del bot:', bot.voiceName);
}

// ---------------------------------------------------------------------------
async function start() {
  try {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    await document.fonts.load('60px "Luckiest Guy"').catch(() => {});
  } catch { /* sin fuentes web */ }
  await loadBrand();
  try {
    await loadConfig();
  } catch (err) {
    document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;color:#f66;background:#000;padding:12px">No se pudo leer /config/race.json: ${err.message}</pre>`);
    return;
  }
  buildGoals();
  buildBall();
  buildHud();
  resize();
  // Acceso de diagnóstico desde la consola del navegador.
  window.hv = { camera, renderer, get ball() { return ball; }, get ballZ() { return ballZ; }, get pos() { return pos; }, get pushers() { return pushers.length; }, get queue() { return queue.length; }, get strokesLeft() { return pushers.map((p) => p.strokesLeft ?? p.move.strokes); } };
  camera.position.set(0, 11.5, 17);
  // El modelo 3D tiene que estar cargado antes de precompilar shaders, si no el primer robot
  // compila su shader en pleno live. Si tarda o falla, se sigue con el muñeco simple.
  if (cfg.defaultModel) {
    await Promise.race([loadModel(cfg.defaultModel).promise, new Promise((r) => setTimeout(r, 5000))]);
    const model = getModel(cfg.defaultModel);
    if (model) { // banco inicial: 8 robots por equipo ya armados
      for (const team of ['heroes', 'villains']) for (let i = 0; i < MAX_ROBOTS; i++) robotPool[team].push(buildRobot(model, team));
    }
  }
  warmUpShaders();
  await setupBot();
  if (MONITOR) startGame(); // el monitor no necesita pantalla inicial ni audio
  // El lanzador abre la página con ?auto=1 y con --autoplay-policy=no-user-gesture-required,
  // que permite audio y voz sin clic (comprobado en Edge). Así el live arranca sin nadie delante.
  // Abierta a mano, sin ese parámetro, queda la pantalla "TOCÁ PARA EMPEZAR".
  if (PARAMS.has('auto')) setTimeout(startGame, 1500);
  keepAwake();
  connect();
  requestAnimationFrame(frame);
}

start();
