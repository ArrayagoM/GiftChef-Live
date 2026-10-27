'use strict';

// Voces neuronales de Microsoft (las mismas "Natural" de Edge) generadas desde el bridge.
// A diferencia de speechSynthesis del navegador, acá el panel recibe un AUDIO y le puede cambiar el tono de verdad
// (para la voz de un niño: tono 1.3-1.5 sobre una voz de hombre). Una sola síntesis a la vez, con reintentos y caché.

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const cache = new Map();
let voicesCache = null;
let chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);
const enqueue = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

const FALLBACK = [
  ['es-MX-JorgeNeural', 'Male', 'es-MX'], ['es-MX-DaliaNeural', 'Female', 'es-MX'], ['es-AR-TomasNeural', 'Male', 'es-AR'], ['es-AR-ElenaNeural', 'Female', 'es-AR'],
  ['es-ES-AlvaroNeural', 'Male', 'es-ES'], ['es-ES-XimenaNeural', 'Female', 'es-ES'], ['es-CO-GonzaloNeural', 'Male', 'es-CO'], ['es-CO-SalomeNeural', 'Female', 'es-CO'],
].map(([short, gender, locale]) => ({ short, gender, locale, name: short.replace(/^es-\w+-/, '').replace(/Neural$/, '') }));

async function listVoices() {
  if (voicesCache) return voicesCache;
  try {
    const all = await withTimeout(new MsEdgeTTS().getVoices(), 15000);
    voicesCache = all.filter((v) => /^es-/.test(v.Locale)).map((v) => ({ short: v.ShortName, gender: v.Gender, locale: v.Locale, name: v.ShortName.replace(/^es-\w+-/, '').replace(/Neural$/, '') }));
    if (!voicesCache.length) voicesCache = FALLBACK;
  } catch { return FALLBACK; }
  return voicesCache;
}

// De la lista de preferidas del personaje ("Jorge", "Dalia"...) a un nombre completo de voz
async function pickVoice(prefer) {
  const voices = await listVoices();
  for (const p of prefer || []) {
    const v = voices.find((x) => x.name.toLowerCase() === String(p).toLowerCase()) || voices.find((x) => x.short.toLowerCase().includes(String(p).toLowerCase()));
    if (v) return v.short;
  }
  return (voices.find((x) => x.short === 'es-MX-JorgeNeural') || voices[0]).short;
}

function collect(stream, ms) {
  return new Promise((resolve, reject) => {
    const chunks = []; let done = false;
    const end = () => { if (!done) { done = true; clearTimeout(t); resolve(Buffer.concat(chunks)); } };
    const t = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', end); stream.on('close', end);
    stream.on('error', (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });
}

function synth(text, voice, rate) {
  const r = Math.max(0.5, Math.min(2, Number(rate) || 1));
  const key = `${voice}|${r.toFixed(2)}|${text}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  return enqueue(async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const tts = new MsEdgeTTS();
        await withTimeout(tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3), 12000);
        const { audioStream } = await withTimeout(tts.toStream(text, { rate: r }), 12000);
        const buf = await collect(audioStream, 20000);
        if (buf.length > 800) {
          if (cache.size > 120) cache.delete(cache.keys().next().value);
          cache.set(key, buf);
          return buf;
        }
      } catch { /* se reintenta */ }
      await sleep(600 * (attempt + 1));
    }
    throw new Error('tts no disponible');
  });
}

module.exports = { listVoices, pickVoice, synth };
