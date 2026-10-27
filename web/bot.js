// Bot presentador: decide qué decir según lo que pasa en el live y lo dice con la voz
// del navegador (speechSynthesis). Las frases salen de /config/bot.json.

// aiReply va por encima de los agradecimientos comunes: ya se pagó por generarla y le
// contesta a alguien que preguntó, así que no se descarta por una lluvia de rosas.
const STALE_MS = 20000; // una frase que esperó más que esto en la cola se descarta
// Orden de prioridad: primero saludar a quien entra, después agradecer regalos, después responder el chat
// con frases armadas y, por último, la IA. Los saludos caducan rápido (JOIN_STALE_MS): tarde ya no sirven.
const JOIN_STALE_MS = 8000;
const PRIORITY = { bigGift: 5, roundWin: 5, join: 4.5, intro: 4, gift: 4, follow: 4, chat: 3.8, aiReply: 3.5, ask: 2.5, close: 2, likes: 1, read: 1, promo: 0 };

const pickRandom = (arr) => (arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : '');
const now = () => performance.now();
const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export class Bot {
  /**
   * @param {object} cfg       contenido de bot.json
   * @param {object} hooks     { onSpeakStart(text), onSpeakEnd(), getState() -> { ratio, wins, teams } }
   */
  constructor(cfg, hooks) {
    this.cfg = cfg;
    this.hooks = hooks;
    this.queue = [];
    this.speaking = false;
    this.voice = null;
    this.giftBuffer = [];
    this.giftFlushTimer = 0;
    this.last = { join: 0, likes: 0, close: 0, promo: now(), chatReply: 0, readChat: now(), ideaThanks: 0, askStyle: now() - 150000 }; // la 1ª pregunta de estilo sale a los ~2,5 min
    this.ideasUntil = 0;
    this.stamps = { join: [], chat: [] }; // para medir cuánta gente hay
    this.chatBuffer = []; // comentarios candidatos para leer en voz alta
    this.nextPromoIn = this.randomPromoDelay();
    this.likeUsers = [];
    this.blocked = (cfg.blockedWords || []).map(normalize);
    this.speechTimeout = 0;
    this.introduced = false;
    this.recentGifts = []; // contexto para las respuestas con IA
    this.ai = { ready: false, inFlight: false, lastAt: 0 };

    if ('speechSynthesis' in window) {
      this.pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
    this.checkAi();
  }

  // -------------------------------------------------------------------------
  // IA (opcional): la llamada la hace web-server.js, la clave nunca está acá.
  // -------------------------------------------------------------------------
  async checkAi() {
    if (!this.cfg.ai?.enabled) return;
    try {
      const status = await (await fetch('/bot/status', { cache: 'no-store' })).json();
      this.ai.ready = !!status.available;
    } catch {
      this.ai.ready = false;
    }
    console.log(`IA del bot: ${this.ai.ready ? 'activa' : 'no disponible (se usan frases armadas)'}`);
  }

  async askAi(user, text, t0 = now()) {
    const ai = this.cfg.ai || {};
    if (!this.ai.ready || this.ai.inFlight || this.muted) return;
    const clean = String(text || '').trim();
    if (clean.length < 3 || clean.startsWith('!')) return;
    // Mismo límite que el servidor, para no hacer pedidos que igual se rechazarían.
    const gapMs = Math.max(60000 / Math.max(1, ai.maxRepliesPerMinute || 4), (ai.minSecondsBetween || 0) * 1000);
    if (now() - this.ai.lastAt < gapMs) { this.log('ai_skip', { why: 'gap' }); return; }
    // Si hay cosas más importantes esperando (regalos grandes, victorias), no sumar una charla.
    // Los agradecimientos comunes no cuentan: la respuesta les pasa adelante.
    if (this.queue.filter((q) => q.priority >= PRIORITY.bigGift).length >= 2) { this.log('ai_skip', { why: 'queue' }); return; }
    // La IA es solo para lo que no tiene respuesta armada: risas, saludos sueltos o textos sin letras no la gastan.
    if ((clean.match(/\p{L}/gu) || []).length < 4) { this.log('ai_skip', { why: 'short' }); return; }

    this.ai.inFlight = true;
    this.ai.lastAt = now();
    const askedAt = now();
    try {
      const s = this.hooks.getState();
      const res = await fetch('/bot/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user: this.speakableName(user),
          text: clean.slice(0, 300),
          state: { ratio: s.ratio, heroesWins: s.wins.heroes, villainsWins: s.wins.villains, recentGifts: this.recentGifts },
        }),
      });
      const body = await res.json();
      if (res.status === 503 || res.status === 403) this.ai.ready = false; // sin clave o apagada: no insistir
      // Una respuesta que llega muy tarde ya no tiene sentido en el live.
      this.log('ai', { ms: Math.round(now() - askedAt), http: res.status, reply: !!body.reply, why: body.reason });
      if (!body.reply || now() - askedAt > 12000 || this.isBlocked(body.reply)) return;
      this.enqueue(body.reply, PRIORITY.aiReply, { kind: 'ai', t0 });
    } catch {
      // Sin red o servidor caído: el bot sigue con frases armadas.
    } finally {
      this.ai.inFlight = false;
    }
  }

  // -------------------------------------------------------------------------
  // Voz
  // -------------------------------------------------------------------------
  pickVoice() {
    const voices = speechSynthesis.getVoices();
    const lang = (this.cfg.voice?.lang || 'es').toLowerCase();
    const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
    const preferred = this.cfg.voice?.preferred || [];
    for (const name of preferred) {
      const match = candidates.find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
      if (match) { this.voice = match; return; }
    }
    this.voice = candidates[0] || null;
  }

  get localVoice() {
    return speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('es') && v.localService) || null;
  }

  get voiceName() {
    return this.voice ? `${this.voice.name} (${this.voice.lang})` : 'sin voz (solo subtítulos)';
  }

  /** Debe llamarse después de un clic/tecla: Chrome bloquea la voz hasta entonces. */
  start() {
    if (this.introduced) return;
    this.introduced = true;
    this.say('intro', {}, PRIORITY.intro);
  }

  // -------------------------------------------------------------------------
  // Cola de frases
  // -------------------------------------------------------------------------
  fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
  }

  say(kind, vars = {}, priority = PRIORITY[kind] ?? 1, meta = {}) {
    if (this.muted) return;
    const template = pickRandom(this.cfg.phrases?.[kind]);
    if (!template) return;
    const text = this.fill(template, { bot: this.cfg.name || 'Nova', ...vars });
    this.enqueue(text, priority, { kind, ...meta });
  }

  /** Mide dónde se va el tiempo (cola, IA, voz). Queda en analisis/latencia.log y en window.__lat. */
  log(kind, data = {}) {
    const row = { k: kind, ...data };
    (window.__lat ||= []).push(row);
    if (window.__lat.length > 300) window.__lat.shift();
    try { navigator.sendBeacon?.('/telemetry', JSON.stringify(row)); } catch { /* sin medición */ }
  }

  enqueue(text, priority, meta = {}) {
    const max = this.cfg.maxQueued ?? 4;
    if (this.queue.length >= max) {
      // Cola llena: se descarta lo menos importante (nunca un regalo grande).
      let lowest = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[lowest].priority) lowest = i;
      if (this.queue[lowest].priority >= priority) return;
      this.queue.splice(lowest, 1);
    }
    this.queue.push({ text, priority, at: now(), meta });
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at);
    this.pump();
  }

  pump() {
    if (this.speaking || !this.queue.length) return;
    // Lo que esperó demasiado ya no tiene sentido en un live: se descarta (salvo regalos grandes y victorias).
    const t = now();
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      const limit = q.priority === PRIORITY.join ? JOIN_STALE_MS : STALE_MS;
      if (q.priority < PRIORITY.bigGift && t - q.at > limit) {
        this.queue.splice(i, 1);
        this.log('drop_stale', { kind: q.meta?.kind, ageMs: Math.round(t - q.at) });
      }
    }
    if (!this.queue.length) return;
    const { text, at, meta } = this.queue.shift();
    this.speaking = true;
    this.hooks.onSpeakStart?.(text);
    const startedAt = now();
    this.log('speak', { kind: meta?.kind, queueMs: Math.round(startedAt - at), fromEventMs: meta?.t0 ? Math.round(startedAt - meta.t0) : null, chars: text.length, left: this.queue.length });

    let byTimeout = false;
    const done = () => {
      clearTimeout(this.speechTimeout);
      if (!this.speaking) return;
      this.speaking = false;
      this.log('speech_end', { ms: Math.round(now() - startedAt), byTimeout });
      // Si la voz no avisó que terminó, se limpia la cola del navegador: si no, lo siguiente se acumula detrás y llega tarde.
      if (byTimeout && 'speechSynthesis' in window) speechSynthesis.cancel();
      this.hooks.onSpeakEnd?.();
      setTimeout(() => this.pump(), 120);
    };

    const rate = this.cfg.voice?.rate ?? 1;
    // Chrome a veces no dispara onend: tope de seguridad según el largo del texto.
    this.speechTimeout = setTimeout(() => { byTimeout = true; done(); }, 1500 + (text.length * 75) / rate);

    if (!('speechSynthesis' in window) || this.cfg.voice?.volume === 0) return;
    const speak = (voice) => {
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'es-ES';
      u.rate = rate;
      u.pitch = this.cfg.voice?.pitch ?? 1;
      u.volume = this.cfg.voice?.volume ?? 1;
      u.onend = done;
      u.onerror = (e) => {
        this.lastSpeechError = e.error || 'error';
        // Las voces "Natural" son en línea: sin internet fallan. Se repite con la voz local para no quedar mudo.
        const gaveUp = e.error === 'canceled' || e.error === 'interrupted';
        if (!gaveUp && voice && voice.localService === false && this.localVoice) {
          console.warn(`Voz en línea falló (${e.error}); uso la voz local ${this.localVoice.name}`);
          this.voice = this.localVoice;
          speak(this.localVoice);
          return;
        }
        done();
      };
      speechSynthesis.speak(u);
    };
    speak(this.voice);
  }

  stop() {
    this.queue.length = 0;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  // -------------------------------------------------------------------------
  // Nombres seguros para leer en voz alta
  // -------------------------------------------------------------------------
  speakableName(user) {
    let name = String(user || '')
      .replace(/[_.\-]+/g, ' ')
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (name.length > 18) name = name.slice(0, 18).trim();
    if (!name || this.isBlocked(name)) return 'amigo';
    return name;
  }

  isBlocked(text) {
    const t = normalize(text).replace(/[^a-z0-9 ]/g, '');
    return this.blocked.some((w) => w && t.includes(w));
  }

  // -------------------------------------------------------------------------
  // Eventos del juego
  // -------------------------------------------------------------------------
  onGift({ user, label, count, team, teamName, big }) {
    if (window.__demoEvt) return; // el tráfico simulado no ocupa la voz de Nova
    const name = this.speakableName(user);
    this.recentGifts.push({ user: name, label, count, team: teamName });
    if (this.recentGifts.length > 5) this.recentGifts.shift();
    if (big) {
      this.say('bigGift', { user: name, gift: label, count, team: teamName }, PRIORITY.bigGift);
      return;
    }
    // Se juntan los regalos de 1,5 s para agradecerlos en una sola frase.
    this.giftBuffer.push({ name, label, count, teamName, team });
    clearTimeout(this.giftFlushTimer);
    // Los regalos siempre se agradecen; con más gente se juntan por más tiempo para decir una sola frase.
    this.giftFlushTimer = setTimeout(() => this.flushGifts(), { small: 500, medium: 1000, large: 2000 }[this.crowd()]);
  }

  flushGifts() {
    const items = this.giftBuffer.splice(0);
    if (!items.length) return;
    const names = [...new Set(items.map((i) => i.name))];
    if (names.length === 1 && items.length === 1) {
      const g = items[0];
      this.say(g.count > 1 ? 'giftCount' : 'gift', { user: g.name, gift: g.label, count: g.count, team: g.teamName }, PRIORITY.gift);
    } else if (names.length === 1) {
      const total = items.reduce((s, i) => s + i.count, 0);
      this.say('giftCount', { user: names[0], gift: 'regalos', count: total, team: items[0].teamName }, PRIORITY.gift);
    } else {
      const shown = names.slice(0, 3);
      const rest = names.length - shown.length;
      const users = rest > 0 ? `${shown.join(', ')} y ${rest} más` : `${shown.slice(0, -1).join(', ')} y ${shown[shown.length - 1]}`;
      this.say('gifts', { users }, PRIORITY.gift);
    }
  }

  onFollow(user) {
    if (window.__demoEvt) return;
    this.say('follow', { user: this.speakableName(user) }, PRIORITY.follow);
  }

  onLikes(user) {
    if (window.__demoEvt) return;
    this.likeUsers.push(user);
    if (this.likeUsers.length > 50) this.likeUsers.shift();
    const level = this.crowd();
    if (level === 'large') return; // con multitud los taps se ignoran: no se agradece cada tanda
    const every = (this.cfg.thankLikesEverySec ?? 45) * (level === 'medium' ? 2 : 1) * 1000;
    if (now() - this.last.likes < every) return;
    this.last.likes = now();
    this.say('likes', { user: this.speakableName(this.likeUsers[this.likeUsers.length - 1]) }, PRIORITY.likes);
    this.likeUsers.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Criterio según cuánta gente hay: con pocos se saluda y contesta a casi todos; con mucha gente
  // se espacia, se saluda en grupo y solo se contesta lo importante, para no atrasar al resto.
  // Se mide por actividad de los últimos 60 s (entradas y comentarios).
  // ---------------------------------------------------------------------------
  crowd() {
    const c = this.cfg.crowd || {};
    const t = now();
    for (const k of ['join', 'chat']) { const a = this.stamps[k]; while (a.length && t - a[0] > 60000) a.shift(); }
    const j = this.stamps.join.length, ch = this.stamps.chat.length;
    if (j >= (c.largeJoinsPerMin ?? 20) || ch >= (c.largeChatsPerMin ?? 30)) return 'large';
    if (j >= (c.mediumJoinsPerMin ?? 6) || ch >= (c.mediumChatsPerMin ?? 12)) return 'medium';
    return 'small';
  }

  onJoin(user, info) {
    if (window.__demoEvt) return;
    this.stamps.join.push(now());
    const level = this.crowd();
    // Pocos: saluda a cada uno (2 s). Medio: uno cada 5 s. Mucha gente: un saludo general cada 20 s.
    const every = { small: this.cfg.greetJoinsEverySec ?? 2, medium: 5, large: 20 }[level] * 1000;
    if (now() - this.last.join < every) return;
    this.last.join = now();
    if (level === 'large') { this.say('welcomeAll', {}, PRIORITY.join); return; }
    // Si ya había jugado antes, se lo saluda distinto (y si estaba en el ranking de la semana, se le nota).
    const kind = info?.returning ? (info.pts > 0 ? 'welcomeBackRank' : 'welcomeBack') : 'join';
    this.say(kind, { user: this.speakableName(user) }, PRIORITY.join);
  }

  onChat(user, text) {
    if (window.__demoEvt) return;
    const t0 = now();
    this.stamps.chat.push(t0);
    if (this.isBlocked(text)) return;
    const t = normalize(text);
    const level = this.crowd();
    const asksNova = /\bnova\b/.test(t) || text.includes('?');
    for (const reply of this.cfg.chatReplies || []) {
      if (!(reply.match || []).some((m) => t.includes(normalize(m)))) continue;
      // Con mucha gente solo se contesta a quien le habla a Nova o pregunta; el resto de saludos se pierden entre la multitud.
      if (level === 'large' && !asksNova) return;
      // Separación entre respuestas: ~1 s con pocos, 4 s con gente, 10 s con multitud.
      if (now() - this.last.chatReply < { small: 1200, medium: 4000, large: 10000 }[level]) return;
      this.last.chatReply = now();
      const s = this.hooks.getState();
      this.say(reply.say, {
        user: this.speakableName(user),
        heroesWins: s.wins.heroes,
        villainsWins: s.wins.villains,
      }, PRIORITY.chat, { t0 });
      return;
    }
    // Ninguna frase armada coincide: el comentario queda como candidato para leerlo en voz alta.
    this.collectComment(user, text);
    // Mientras Nova pregunta qué juego quieren, lo que no es pregunta se anota como idea y se agradece (sin gastar IA).
    if (now() < this.ideasUntil && !text.includes('?') && text.trim().split(/\s+/).length >= 2) {
      this.log('idea', { user: this.speakableName(user), text: String(text).slice(0, 140) });
      if (now() - this.last.ideaThanks > { small: 6000, medium: 12000, large: 25000 }[level]) {
        this.last.ideaThanks = now();
        this.say('ideaThanks', { user: this.speakableName(user) }, PRIORITY.chat, { t0 });
      }
      return;
    }
    // Solo lo que no se pudo contestar con una frase armada llega a la IA (con multitud, solo si le hablan a Nova o preguntan).
    if (level === 'large' && !asksNova) return;
    this.askAi(user, text, t0);
  }

  // ---------------------------------------------------------------------------
  // Lectura de comentarios (sin IA). Lo que Nova dice en voz alta sale de texto de desconocidos,
  // así que el filtro es estricto: nada de enlaces, menciones, números largos, malas palabras,
  // spam de letras repetidas ni mensajes que sean solo emojis.
  // ---------------------------------------------------------------------------
  cleanForSpeech(text) {
    const maxChars = this.cfg.readChat?.maxChars ?? 80;
    let t = String(text || '').replace(/\p{Extended_Pictographic}|️|‍/gu, '').replace(/\s+/g, ' ').trim();
    if (t.length < 8 || t.length > maxChars) return null;
    if (/https?:|www\.|\.com|\.net|\.ar\b|@|#/i.test(t)) return null;
    if (/\d{5,}/.test(t)) return null;           // teléfonos, cuentas, códigos
    if (/(.)\1{4,}/i.test(t)) return null;       // "aaaaaaa"
    if (/(\p{L}{2,3})\1{3,}/iu.test(t)) return null; // "jajajajaja", "ajajajaj": risa larguísima
    if ((t.match(/\p{L}/gu) || []).length < 6) return null;
    if (this.isBlocked(t)) return null;
    return t;
  }

  collectComment(user, text) {
    if (this.cfg.readChat?.enabled === false) return;
    const clean = this.cleanForSpeech(text);
    if (!clean) return;
    const name = this.speakableName(user);
    if (name === 'amigo' && this.isBlocked(user)) return; // nombre no apto: no se lee nada de esa persona
    const t = normalize(clean);
    let score = 1;
    if (/\bnova\b/.test(t)) score += 5;   // le hablan a ella
    if (clean.includes('?')) score += 3;  // preguntas
    if (clean.length >= 15 && clean.length <= 60) score += 2;
    this.chatBuffer.push({ name, text: clean, score, at: now() });
    if (this.chatBuffer.length > 25) this.chatBuffer.shift();
  }

  readOneComment() {
    const fresh = this.chatBuffer.filter((c) => now() - c.at < 60000);
    this.chatBuffer = [];
    if (!fresh.length) return;
    fresh.sort((a, b) => b.score - a.score || b.at - a.at);
    const c = fresh[0];
    const t = normalize(c.text);
    let reaction;
    if (/jaj|jej|jij|xd|lol/.test(t)) reaction = pickRandom(['¡Jajaja, me encantó!', '¡Jaja, qué bueno!']);
    else if (/te amo|hermosa|linda|crack|genio|capo|grosa|groso/.test(t)) reaction = pickRandom(['¡Ay, gracias, qué dulce!', '¡Me hiciste sonrojar!']);
    else if (c.text.includes('?')) reaction = pickRandom(['¡Buena pregunta! ¿Alguien en el chat sabe?', 'Mmm, buena pregunta. ¡Ayúdenlo, chat!']);
    else reaction = pickRandom(['¡Gracias por comentar!', '¡Qué bueno tenerte por acá!', '¡Eso, así se habla!']);
    this.enqueue(`${c.name} dice: ${c.text}. ${reaction}`, PRIORITY.read);
  }

  onRoundWon(team, teamName, user, wins) {
    this.queue = this.queue.filter((q) => q.priority >= PRIORITY.gift);
    this.say('roundWin', { team: teamName, user: this.speakableName(user), wins }, PRIORITY.roundWin);
  }

  randomPromoDelay() {
    const [a, b] = this.cfg.promoEverySec || [55, 95];
    return (a + Math.random() * (b - a)) * 1000;
  }

  /** Llamar seguido (por ejemplo cada frame) para narrar y promocionar cuando hay calma. */
  tick() {
    if (!this.introduced) return;
    const s = this.hooks.getState();
    const t = now();
    // Cada tanto, si Nova está libre, lee en voz alta el mejor comentario reciente.
    const rc = this.cfg.readChat || {};
    if (rc.enabled !== false && !this.muted && !this.speaking && !this.queue.length && this.chatBuffer.length
      && t - this.last.readChat > (rc.everySec ?? 30) * 1000) {
      this.last.readChat = t;
      this.readOneComment();
    }
    if (Math.abs(s.ratio) > 0.75 && t - this.last.close > (this.cfg.narrateEverySec ?? 18) * 1000) {
      this.last.close = t;
      const team = s.ratio > 0 ? 'heroes' : 'villains';
      const rival = team === 'heroes' ? 'villains' : 'heroes';
      this.say('close', { team: s.teams[team].name, rival: s.teams[rival].name }, PRIORITY.close);
    }
    // Cada varios minutos pregunta qué estilo de juego quieren ver y anota las respuestas (analisis/ideas.log).
    const askEvery = (this.cfg.askStyleEverySec ?? 300) * 1000;
    if (askEvery && !this.speaking && !this.queue.length && t - this.last.askStyle > askEvery) {
      this.last.askStyle = t;
      this.ideasUntil = t + 90000;
      this.say('askStyle', {}, PRIORITY.ask);
    } else if (!this.speaking && !this.queue.length && t - this.last.promo > this.nextPromoIn) {
      this.last.promo = t;
      this.nextPromoIn = this.randomPromoDelay();
      // Con gente en el live, la mayoría de las promos incentivan los taps y los puntos del modo popular.
      const kind = this.crowd() !== 'small' && Math.random() < 0.6 ? 'tapPromo' : 'promo';
      this.say(kind, {}, PRIORITY.promo);
    }
  }
}
