// Sonidos sintetizados con Web Audio (no necesitan archivos ni tienen derechos de autor).
// Cada efecto se puede reemplazar por un archivo propio desde race.json -> "sound.files".

let ctx = null;
let master = null;
let musicGain = null;
let settings = { volume: 0.7, music: false, musicVolume: 0.25, files: {} };
const buffers = new Map();
let recent = [];
let musicTimer = 0;
let musicOn = false;

export function configureSound(cfg = {}) {
  settings = { ...settings, ...cfg, files: { ...(cfg.files || {}) } };
  if (master) master.gain.value = settings.volume;
  if (musicGain) musicGain.gain.value = settings.musicVolume;
}

export const isUnlocked = () => !!ctx && ctx.state === 'running';

/** Chrome exige un clic o una tecla antes de reproducir audio. */
export async function unlockAudio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = settings.volume;
    const comp = ctx.createDynamicsCompressor(); // evita saturar con muchos sonidos juntos
    master.connect(comp).connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = settings.musicVolume;
    const warm = ctx.createBiquadFilter(); // filtro pasa-bajos: sonido más cálido y suave
    warm.type = 'lowpass';
    warm.frequency.value = 1800;
    musicGain.connect(warm).connect(master);
    ensureNoiseBuffer();
    for (const [name, url] of Object.entries(settings.files)) loadFile(name, url);
    if (settings.music) setMusic(true);
  }
  if (ctx.state !== 'running') await ctx.resume();
  return isUnlocked();
}

async function loadFile(name, url) {
  if (!url) return;
  try {
    const data = await (await fetch(url)).arrayBuffer();
    buffers.set(name, await ctx.decodeAudioData(data));
  } catch (err) {
    console.warn(`No se pudo cargar el sonido ${url}:`, err.message || err);
  }
}

// Limita la cantidad de sonidos simultáneos en ráfagas de regalos.
function allow(max = 10, windowMs = 150) {
  if (!isUnlocked()) return false;
  const now = performance.now();
  recent = recent.filter((t) => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  return true;
}

function playFile(name, rate = 1, gain = 1) {
  const buffer = buffers.get(name);
  if (!buffer) return false;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start();
  return true;
}

function tone({ freq, to = freq, type = 'sine', start = 0, dur = 0.2, gain = 0.3, attack = 0.005, dest = master }) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

let noiseBuffer = null;
// Se crea al iniciar el audio (clic en "TOCÁ PARA EMPEZAR"), no en el primer regalo del live.
function ensureNoiseBuffer() {
  if (noiseBuffer || !ctx) return;
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

function noise({ start = 0, dur = 0.15, gain = 0.3, freq = 800, to = freq, q = 1 }) {
  ensureNoiseBuffer();
  const t0 = ctx.currentTime + start;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = q;
  filter.frequency.setValueAtTime(freq, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

const note = (n) => 440 * 2 ** ((n - 69) / 12); // número MIDI -> Hz

export const sfx = {
  /** Llega un regalo: campanita (aguda para Héroes, grave para Villanos). */
  gift(team, big) {
    if (!allow()) return;
    if (playFile(big ? 'bigGift' : 'gift', team === 'heroes' ? 1.1 : 0.9)) return;
    const base = team === 'heroes' ? 79 : 72;
    tone({ freq: note(base), type: 'triangle', dur: 0.18, gain: 0.18 });
    tone({ freq: note(base + (team === 'heroes' ? 7 : 6)), type: 'triangle', start: 0.07, dur: 0.22, gain: 0.16 });
    if (big) {
      tone({ freq: 300, to: 1600, type: 'sawtooth', dur: 0.45, gain: 0.07 });
      for (let i = 0; i < 5; i++) tone({ freq: note(base + 12 + i * 2), start: 0.12 + i * 0.05, dur: 0.15, gain: 0.08 });
    }
  },

  /** El personaje empuja la pelota: golpe sordo + roce de nieve. */
  push(team, delta) {
    if (!allow(8, 120)) return;
    const strength = Math.min(1, 0.35 + Math.abs(delta) / 150);
    if (playFile('push', 0.9 + Math.random() * 0.2, strength)) return;
    tone({ freq: 140, to: 50, type: 'sine', dur: 0.18, gain: 0.45 * strength });
    noise({ dur: 0.12, gain: 0.18 * strength, freq: 1800, to: 400, q: 0.8 });
  },

  /** Un equipo gana la ronda. */
  roundWon(team) {
    if (!isUnlocked()) return;
    if (playFile(team === 'heroes' ? 'winHeroes' : 'winVillains')) return;
    if (team === 'heroes') {
      [72, 76, 79, 84].forEach((n, i) => tone({ freq: note(n), type: 'square', start: i * 0.12, dur: 0.22, gain: 0.12 }));
      tone({ freq: note(88), type: 'square', start: 0.5, dur: 0.7, gain: 0.12 });
      tone({ freq: note(84), type: 'triangle', start: 0.5, dur: 0.7, gain: 0.15 });
    } else {
      [67, 63, 60, 55].forEach((n, i) => tone({ freq: note(n), type: 'sawtooth', start: i * 0.15, dur: 0.3, gain: 0.1 }));
      tone({ freq: note(48), to: note(43), type: 'sawtooth', start: 0.6, dur: 0.9, gain: 0.12 });
    }
    for (let i = 0; i < 12; i++) noise({ start: 0.2 + i * 0.06, dur: 0.05, gain: 0.08, freq: 3000 + Math.random() * 3000, q: 4 });
  },

  /** Regalo épico (Galaxy, León...): subida, explosión y acorde brillante. */
  epic(team) {
    if (!isUnlocked()) return;
    if (playFile('epic')) return;
    tone({ freq: 110, to: 1760, type: 'sawtooth', dur: 1.1, gain: 0.09, attack: 0.3 });
    noise({ dur: 1.1, gain: 0.12, freq: 400, to: 6000, q: 0.7 });
    tone({ freq: 90, to: 30, type: 'sine', start: 1.05, dur: 0.9, gain: 0.7 });
    noise({ start: 1.05, dur: 0.8, gain: 0.35, freq: 900, to: 120, q: 0.5 });
    const chord = team === 'heroes' ? [72, 76, 79, 84, 88] : [69, 72, 76, 81, 84];
    chord.forEach((n, i) => tone({ freq: note(n), type: 'triangle', start: 1.1 + i * 0.04, dur: 1.6, gain: 0.09, attack: 0.02 }));
    for (let i = 0; i < 16; i++) tone({ freq: note(96 + (i % 5) * 2), start: 1.2 + i * 0.05, dur: 0.12, gain: 0.04 });
  },

  /** Un equipo llegó a la meta de WINS: fanfarria larga de campeones. */
  champion(team) {
    if (!isUnlocked()) return;
    if (playFile('champion')) return;
    const melody = [72, 72, 72, 76, 79, 79, 76, 79, 84];
    const times = [0, 0.15, 0.3, 0.45, 0.75, 0.9, 1.05, 1.2, 1.5];
    melody.forEach((n, i) => {
      tone({ freq: note(n), type: 'square', start: times[i], dur: 0.25, gain: 0.1 });
      tone({ freq: note(n - 12), type: 'triangle', start: times[i], dur: 0.25, gain: 0.12 });
    });
    [60, 64, 67, 72, 76, 79, 84].forEach((n) => tone({ freq: note(n), type: 'triangle', start: 1.5, dur: 2.2, gain: 0.07, attack: 0.05 }));
    tone({ freq: 70, to: 35, type: 'sine', start: 1.5, dur: 1, gain: 0.6 });
    for (let i = 0; i < 30; i++) {
      noise({ start: 1.6 + i * 0.15 + Math.random() * 0.1, dur: 0.25, gain: 0.08, freq: 2000 + Math.random() * 4000, to: 300, q: 1 });
    }
  },

  /** Cambia un contador de WINS. */
  wins(up) {
    if (!allow()) return;
    if (playFile(up ? 'winUp' : 'winDown')) return;
    tone({ freq: up ? 880 : 440, to: up ? 1760 : 220, type: 'square', dur: 0.15, gain: 0.08 });
  },
};

// ---------------------------------------------------------------------------
// Música de fondo simple (bucle chiptune). Se activa con la tecla M.
// ---------------------------------------------------------------------------
// Música suave tipo lo-fi: acordes largos, arpegio tranquilo y bajo.
const BPM = 72;
const STEPS_PER_CHORD = 8; // corcheas por acorde (un compás)
const CHORDS = [
  [60, 64, 67, 71], // Cmaj7
  [57, 60, 64, 67], // Am7
  [53, 57, 60, 64], // Fmaj7
  [55, 59, 62, 64], // G6
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 0];
let step = 0;
let nextTime = 0;

function scheduleMusic() {
  const stepDur = 60 / BPM / 2;
  while (nextTime < ctx.currentTime + 0.3) {
    const start = nextTime - ctx.currentTime;
    const chord = CHORDS[Math.floor(step / STEPS_PER_CHORD) % CHORDS.length];
    const inChord = step % STEPS_PER_CHORD;
    if (inChord === 0) {
      for (const n of chord) tone({ freq: note(n), type: 'sine', start, dur: stepDur * STEPS_PER_CHORD * 1.05, gain: 0.05, attack: 0.6, dest: musicGain });
      tone({ freq: note(chord[0] - 12), type: 'sine', start, dur: stepDur * 4, gain: 0.14, attack: 0.05, dest: musicGain });
    }
    if (inChord === 4) tone({ freq: note(chord[2] - 12), type: 'sine', start, dur: stepDur * 3.5, gain: 0.1, attack: 0.05, dest: musicGain });
    // El arpegio deja silencios para que no canse durante horas de live.
    if (inChord % 2 === 0 || Math.random() < 0.3) {
      tone({ freq: note(chord[ARP[inChord]] + 12), type: 'triangle', start, dur: stepDur * 1.8, gain: 0.035, attack: 0.02, dest: musicGain });
    }
    nextTime += stepDur;
    step++;
  }
}

let musicSource = null;

export function setMusic(on) {
  musicOn = on;
  clearInterval(musicTimer);
  if (musicSource) { musicSource.stop(); musicSource = null; }
  if (!ctx || !on) return;
  if (buffers.has('music')) {
    // Música propia en bucle si se configuró un archivo.
    musicSource = ctx.createBufferSource();
    musicSource.buffer = buffers.get('music');
    musicSource.loop = true;
    musicSource.connect(musicGain);
    musicSource.start();
    return;
  }
  nextTime = ctx.currentTime + 0.05;
  musicTimer = setInterval(scheduleMusic, 50);
}

export const toggleMusic = () => { setMusic(!musicOn); return musicOn; };

/** Baja la música mientras habla el bot para que se le entienda. */
export function duckMusic(on) {
  if (!musicGain) return;
  const target = on ? settings.musicVolume * 0.3 : settings.musicVolume;
  musicGain.gain.setTargetAtTime(target, ctx.currentTime, 0.15);
}
