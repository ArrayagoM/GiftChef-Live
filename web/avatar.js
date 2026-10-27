// Presentadora cyborg que se dibuja en un recuadro (tipo cámara) con el mismo renderer del juego.
// Si bot.json -> avatar.model apunta a un .glb con morph targets de boca/parpadeo
// (jawOpen, mouthOpen, viseme_aa, eyeBlink...), se usa ese modelo en lugar del procedural.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Emociones: cada una es un objetivo hacia el que se mueven la cara y las luces (con suavizado).
const NEUTRAL = { browL: 0, browR: 0, tilt: 0, eyeOpen: 1, smile: 0.5, mouthBase: 0, blush: 0.35, wink: 0, headTilt: 0, lookX: 0 };
const EMOTIONS = {
  neutral: {},
  happy: { browL: 0.03, browR: 0.03, eyeOpen: 0.85, smile: 1, blush: 0.8, color: '#3dffb8' },
  excited: { browL: 0.08, browR: 0.08, eyeOpen: 1.15, smile: 1.2, mouthBase: 0.3, blush: 1, color: '#ffd84d', emote: '✨' },
  surprised: { browL: 0.11, browR: 0.11, eyeOpen: 1.4, smile: 0, mouthBase: 0.65, blush: 0.2, color: '#ffe14d', emote: '❗' },
  angry: { browL: -0.02, browR: -0.02, tilt: 0.38, eyeOpen: 0.8, smile: -0.7, blush: 0, color: '#ff3b3b', emote: '💢' },
  sad: { browL: 0.03, browR: 0.03, tilt: -0.35, eyeOpen: 0.78, smile: -0.8, blush: 0.1, headTilt: 0.1, color: '#5b86ff', emote: '💧' },
  love: { browL: 0.04, browR: 0.04, eyeOpen: 0.9, smile: 1.1, blush: 1, color: '#ff5fa8', emote: '💖' },
  wink: { browR: 0.05, smile: 1.1, wink: 1, blush: 0.7, color: '#3dffb8' },
  thinking: { browL: -0.02, browR: 0.08, tilt: 0.12, eyeOpen: 0.95, smile: 0.15, headTilt: -0.12, lookX: 0.8, color: '#b08cff', emote: '💭' },
};

const emoteTextures = new Map();
function emoteTexture(ch) {
  let tex = emoteTextures.get(ch);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.font = '96px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ch, 64, 72);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    emoteTextures.set(ch, tex);
  }
  return tex;
}

export class HostAvatar {
  constructor(cfg, boxElement) {
    this.cfg = cfg || {};
    this.box = boxElement;
    this.accent = new THREE.Color(this.cfg.accent || '#19e3ff');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    // Encuadre cerrado en la cabeza y los hombros: así se leen las expresiones aun en el recuadro chico.
    this.camera.position.set(0, 0.14, 3.9);
    this.camera.lookAt(0, 0.0, 0);
    this.t = 0;
    this.speaking = false;
    this.mouth = 0;
    this.blinkIn = 2;
    this.action = null; // { kind: 'wave' | 'celebrate', age }
    this.morphs = null;
    this.envReady = false;
    this.emo = { name: 'neutral', until: 0 };
    this.cur = { ...NEUTRAL };
    this.curColor = new THREE.Color(this.accent);
    this.targetColor = new THREE.Color(this.accent);
    this.nextIdle = 5;
    // Los íconos de emoción se dibujan al arrancar (y se suben a la GPU en el primer cuadro),
    // no la primera vez que Nova se emociona en pleno live.
    for (const em of Object.values(EMOTIONS)) if (em.emote) emoteTexture(em.emote);
    this.emotes = Array.from({ length: 8 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
      s.scale.set(0.42, 0.42, 1);
      s.visible = false;
      s.userData = { life: 0, vy: 0 };
      this.scene.add(s);
      return s;
    });

    this.scene.background = techBackground(this.cfg.accent || '#19e3ff');
    this.scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x1a2550, 0.6));
    const key = new THREE.DirectionalLight(0xfff2e6, 1.25);
    key.position.set(2, 3, 4);
    const rim = new THREE.DirectionalLight(this.accent, 2.6);
    rim.position.set(-3, 2, -2);
    this.scene.add(key, rim);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.buildProcedural();
    if (this.cfg.model) this.loadModel(this.cfg.model);
  }

  buildProcedural() {
    const c = this.cfg;
    const accent = this.accent;
    const std = (color, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const skin = std(c.skin || '#ffd9bf', 0.7);
    const hair = std(c.hair || '#14214a', 0.45);
    const outfit = std(c.outfit || '#16244f', 0.5, 0.2);
    const dark = std('#10142a', 0.4, 0.5);
    const metal = std('#8693b4', 0.32, 0.9);
    const darkMetal = std('#2b3556', 0.4, 0.85);
    // Piezas que brillan: emisivas, así parecen luz aun con poca iluminación.
    const glow = (intensity = 1.6) => new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: intensity, roughness: 0.3 });
    const irisMat = glow(1.8);
    const coreMat = glow(1.6);
    const tipMat = glow(2);
    const g = new THREE.Group();

    // ---- Cuerpo: traje azul noche con núcleo luminoso en el pecho ----
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 0.7, 8, 16), outfit);
    body.position.y = -1.35;
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.13, 24), coreMat);
    core.position.set(0, -1.02, 0.625);
    const coreRing = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.028, 10, 32), metal);
    coreRing.position.copy(core.position);
    const shoulders = [-1, 1].map((s) => {
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 12), metal);
      pad.position.set(s * 0.74, -0.84, 0);
      const strip = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.018, 8, 24), glow(1.4));
      strip.position.copy(pad.position);
      strip.rotation.y = Math.PI / 2;
      return [pad, strip];
    }).flat();

    // ---- Cuello: anillos metálicos y cables ----
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.32, 14), skin);
    neck.position.y = -0.55;
    const neckRings = [0, 1, 2].map((i) => {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 24), i === 1 ? glow(1.2) : metal);
      r.rotation.x = Math.PI / 2;
      r.position.y = -0.46 - i * 0.07;
      return r;
    });
    const cables = [-1, 1].map((s) => {
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 6), dark);
      cab.position.set(s * 0.19, -0.6, -0.06);
      cab.rotation.z = s * 0.28;
      return cab;
    });

    // ---- Cabeza ----
    const head = new THREE.Group();
    head.position.y = 0.05;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 24), skin);
    face.scale.set(1, 1.04, 0.95);
    // Placa metálica que cubre media cara (la mitad izquierda) y una línea de luz en la unión.
    const plate = new THREE.Mesh(new THREE.SphereGeometry(0.636, 32, 24, 0, Math.PI / 2, 0.4, 2.2), metal);
    plate.scale.set(1, 1.04, 0.95);
    const seamMat = glow(2);
    const barMat = glow(1.8);
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.82, 0.02), seamMat);
    seam.position.set(0, -0.05, 0.605);
    const bolts = [[-0.5, 0.3], [-0.55, -0.02], [-0.45, -0.3]].map(([x, y]) => {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), darkMetal);
      b.position.set(x, y, 0.37);
      return b;
    });
    // Barras de sonido en la mejilla metálica: suben y bajan cuando habla.
    const bars = [0, 1, 2, 3, 4].map((i) => {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.1, 0.02), barMat);
      bar.position.set(-0.46 + i * 0.062, -0.27, 0.43 - i * 0.012);
      return bar;
    });

    const back = new THREE.Mesh(new THREE.SphereGeometry(0.64, 24, 16), hair);
    back.position.set(0, -0.05, -0.12);
    back.scale.set(1.02, 1.05, 0.9);
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.67, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.52), hair);
    hairCap.position.set(0, 0.04, -0.03);
    hairCap.rotation.x = -0.25;
    const neonHair = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.2, roughness: 0.4 });
    const bangs = [-0.32, -0.1, 0.12, 0.33].map((x, i) => {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), i === 1 || i === 3 ? neonHair : hair);
      b.position.set(x, 0.43 - Math.abs(x) * 0.25, 0.42 - Math.abs(x) * 0.15);
      b.scale.set(1, 0.7, 0.6);
      b.rotation.z = (i - 1.5) * 0.25;
      return b;
    });
    const tails = [-1, 1].map((s) => {
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.55, 6, 12), s < 0 ? hair : neonHair);
      tail.position.set(s * 0.68, -0.25, -0.05);
      tail.rotation.z = s * 0.25;
      return tail;
    });

    // Ojos: el derecho es humano con iris celeste; el izquierdo es un lente cibernético que brilla.
    const eyes = new THREE.Group();
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), std('#ffffff', 0.3));
    white.position.set(0.21, 0.08, 0.52);
    white.scale.set(1, 1.2, 0.5);
    const pupilR = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), std('#0c6d86', 0.2));
    pupilR.position.set(0.21, 0.07, 0.575);
    pupilR.scale.set(1, 1.25, 0.5);
    const shineR = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    shineR.position.set(0.24, 0.11, 0.61);
    const lensRing = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.026, 10, 32), darkMetal);
    lensRing.position.set(-0.21, 0.08, 0.545);
    const lensBase = new THREE.Mesh(new THREE.CircleGeometry(0.105, 24), std('#06101f', 0.3, 0.4));
    lensBase.position.set(-0.21, 0.08, 0.553);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.068, 16, 12), irisMat);
    iris.position.set(-0.21, 0.08, 0.565);
    iris.scale.set(1, 1, 0.5);
    const scan = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.01), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    scan.position.set(-0.21, 0.08, 0.6);
    eyes.add(white, pupilR, shineR, lensRing, lensBase, iris, scan);

    const browR = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.14, 4, 8), hair);
    browR.rotation.z = Math.PI / 2 + 0.12;
    browR.position.set(0.21, 0.27, 0.54);
    const browL = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.035, 0.03), darkMetal);
    browL.position.set(-0.21, 0.28, 0.55);
    browL.rotation.z = -0.1;
    const brows = [browL, browR];
    const cheeks = [new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshStandardMaterial({ color: '#ff8fa8', transparent: true, opacity: 0.5 }))];
    cheeks[0].position.set(0.36, -0.08, 0.47);
    cheeks[0].scale.set(1.3, 0.7, 0.4);

    const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 12), std('#7a1f3d', 0.5));
    mouth.position.set(0.04, -0.2, 0.55);
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.018, 8, 20, Math.PI), std('#7a1f3d', 0.5));
    smile.position.set(0.04, -0.17, 0.585);
    smile.rotation.z = Math.PI;

    // Auriculares con aro luminoso, micrófono y antena con luz intermitente.
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.045, 10, 40, Math.PI), darkMetal);
    band.position.y = 0.02;
    const cups = [-1, 1].map((s) => {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 20), darkMetal);
      cup.rotation.z = Math.PI / 2;
      cup.position.set(s * 0.68, 0, 0);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.016, 8, 28), glow(1.6));
      ring.rotation.y = Math.PI / 2;
      ring.position.set(s * 0.745, 0, 0);
      return [cup, ring];
    }).flat();
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 8), dark);
    boom.position.set(0.5, -0.24, 0.32);
    boom.rotation.set(0.9, 0, 0.9);
    const mic = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), glow(1.4));
    mic.position.set(0.28, -0.36, 0.5);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.36, 8), metal);
    antenna.position.set(0.34, 0.74, -0.04);
    antenna.rotation.z = -0.28;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10), tipMat);
    tip.position.set(0.42, 0.91, -0.04);

    head.add(face, plate, seam, ...bolts, ...bars, back, hairCap, ...bangs, ...tails, eyes, ...brows, ...cheeks, mouth, smile, band, ...cups, boom, mic, antenna, tip);

    // Brazos: el izquierdo es mecánico (metal con luz), el derecho humano.
    const arms = [-1, 1].map((s) => {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.72, -0.85, 0);
      const mech = s < 0;
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.6, 6, 10), mech ? metal : outfit);
      arm.position.y = -0.4;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mech ? darkMetal : skin);
      hand.position.y = -0.82;
      pivot.add(arm, hand);
      if (mech) {
        const band2 = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.018, 8, 24), glow(1.6));
        band2.rotation.x = Math.PI / 2;
        band2.position.y = -0.5;
        pivot.add(band2);
      }
      pivot.rotation.z = s * 0.15;
      return pivot;
    });

    g.add(body, core, coreRing, ...shoulders, neck, ...neckRings, ...cables, head, ...arms);
    this.root.add(g);
    this.parts = {
      group: g, head, eyes, mouth, smile, brows, arms, bars, irisMat, coreMat, tipMat, scan,
      browL, browR, cheek: cheeks[0],
      humanEye: [white, pupilR, shineR].map((mesh) => ({ mesh, baseY: mesh.scale.y })),
      glowMats: [irisMat, coreMat, seamMat, barMat],
    };
  }

  loadModel(path) {
    new GLTFLoader().load(path, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      // Encuadre de busto: se escala para que la parte superior ocupe el recuadro.
      const scale = 3.2 / (size.y || 1);
      model.scale.setScalar(scale);
      model.position.y = -box.max.y * scale + 0.75;
      const morphs = { mouth: [], blink: [] };
      model.traverse((o) => {
        if (!o.isMesh || !o.morphTargetDictionary) return;
        for (const [name, index] of Object.entries(o.morphTargetDictionary)) {
          if (/jawopen|mouthopen|viseme_aa|^a$|mouth_a/i.test(name)) morphs.mouth.push([o, index]);
          if (/eyeblink|blink|eyesclosed/i.test(name)) morphs.blink.push([o, index]);
        }
      });
      this.root.remove(this.parts.group);
      this.parts = { group: model, head: model };
      this.morphs = morphs;
      this.root.add(model);
    }, undefined, (err) => console.warn('No se pudo cargar el avatar del bot:', err?.message || err));
  }

  setSpeaking(on) {
    this.speaking = on;
  }

  wave() {
    this.action = { kind: 'wave', age: 0 };
  }

  /** Cambia la emoción por unos segundos y después vuelve sola a neutral. */
  setEmotion(name, seconds = 2.4) {
    if (!EMOTIONS[name]) return;
    this.emo = { name, until: this.t + seconds };
    const emote = EMOTIONS[name].emote;
    if (emote) this.spawnEmote(emote, name === 'love' ? 3 : name === 'excited' ? 2 : 1);
  }

  isNeutral() {
    return this.emo.name === 'neutral';
  }

  spawnEmote(ch, count = 1) {
    for (let n = 0; n < count; n++) {
      const s = this.emotes.find((e) => !e.visible);
      if (!s) return;
      s.material.map = emoteTexture(ch);
      s.material.opacity = 1;
      s.material.needsUpdate = true;
      s.position.set(-0.55 + Math.random() * 1.1, 0.78 + Math.random() * 0.15, 0.6);
      s.userData.life = 1.7 + Math.random() * 0.4;
      s.userData.vy = 0.45 + Math.random() * 0.25;
      s.visible = true;
    }
  }

  // Lleva la cara, las luces y los íconos hacia la emoción actual (movimiento suave).
  updateEmotion(dt) {
    if (this.emo.name !== 'neutral' && this.t > this.emo.until) this.emo = { name: 'neutral', until: 0 };
    // Gestos espontáneos: de vez en cuando sonríe o guiña, como una persona.
    if (this.emo.name === 'neutral' && !this.speaking && this.t > this.nextIdle) {
      this.nextIdle = this.t + 5 + Math.random() * 7;
      this.setEmotion(Math.random() < 0.5 ? 'happy' : 'wink', 1.6);
    }
    const target = EMOTIONS[this.emo.name] || {};
    const k = Math.min(1, dt * 10);
    for (const key of Object.keys(this.cur)) this.cur[key] += ((target[key] ?? NEUTRAL[key]) - this.cur[key]) * k;

    this.targetColor.set(target.color || this.cfg.accent || '#19e3ff');
    this.curColor.lerp(this.targetColor, Math.min(1, dt * 6));
    for (const m of this.parts.glowMats) { m.color.copy(this.curColor); m.emissive.copy(this.curColor); }

    for (const s of this.emotes) {
      if (!s.visible) continue;
      s.userData.life -= dt;
      s.position.y += s.userData.vy * dt;
      s.material.opacity = Math.max(0, Math.min(1, s.userData.life / 0.5));
      if (s.userData.life <= 0) s.visible = false;
    }
  }

  celebrate() {
    this.action = { kind: 'celebrate', age: 0 };
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    const p = this.parts;

    // Boca: se abre y cierra con un ritmo irregular mientras habla.
    const target = this.speaking ? 0.35 + 0.65 * Math.abs(Math.sin(t * 13) * Math.sin(t * 7.3 + 1)) : 0;
    this.mouth += (target - this.mouth) * Math.min(1, dt * 18);

    this.blinkIn -= dt;
    let blink = 0;
    if (this.blinkIn < 0) {
      blink = 1 - Math.min(1, Math.abs(this.blinkIn + 0.07) / 0.07);
      if (this.blinkIn < -0.14) this.blinkIn = 2 + Math.random() * 3;
    }

    p.head.rotation.y = Math.sin(t * 0.6) * 0.18 + (this.speaking ? Math.sin(t * 2.3) * 0.06 : 0);
    p.head.rotation.x = Math.sin(t * 0.9) * 0.05 + (this.speaking ? Math.sin(t * 5.1) * 0.04 : 0);
    p.head.rotation.z = Math.sin(t * 0.45) * 0.05;
    p.group.position.y = Math.sin(t * 1.6) * 0.025;

    let jump = 0;
    let armL = 0.15;
    let armR = -0.15;
    let armLx = 0;
    let armRx = 0;
    if (this.action) {
      const a = this.action;
      a.age += dt;
      if (a.kind === 'wave') {
        armR = -2.6 + Math.sin(a.age * 14) * 0.35;
        if (a.age > 1.6) this.action = null;
      } else if (a.kind === 'celebrate') {
        armL = 2.7 + Math.sin(a.age * 16) * 0.2;
        armR = -2.7 - Math.sin(a.age * 16) * 0.2;
        jump = Math.abs(Math.sin(a.age * 7)) * 0.25;
        if (a.age > 2.5) this.action = null;
      }
    } else if (this.speaking) {
      armLx = Math.sin(t * 3) * 0.25; // gesticula al hablar
      armRx = Math.sin(t * 2.4 + 1) * 0.25;
    }
    p.group.position.y += jump;

    if (this.morphs) {
      for (const [mesh, i] of this.morphs.mouth) mesh.morphTargetInfluences[i] = this.mouth * 0.8;
      for (const [mesh, i] of this.morphs.blink) mesh.morphTargetInfluences[i] = blink;
      return;
    }
    // ---- Cara según la emoción ----
    this.updateEmotion(dt);
    const e = this.cur;
    const open = Math.max(this.mouth, e.mouthBase);
    p.mouth.scale.set(1.3 - open * 0.3, 0.12 + open * 1.1, 0.5);
    p.mouth.visible = open > 0.05;
    p.smile.visible = !p.mouth.visible;
    p.smile.rotation.z = e.smile >= 0 ? Math.PI : 0; // sonrisa curva hacia abajo, ceño hacia arriba
    p.smile.scale.set(1, Math.max(0.2, Math.abs(e.smile)), 1);
    p.smile.position.y = e.smile >= 0 ? -0.17 : -0.25;
    p.eyes.scale.y = Math.max(0.05, e.eyeOpen * (1 - blink * 0.9));
    p.eyes.position.y = blink * 0.01;
    p.eyes.position.x = e.lookX * 0.04;
    for (const h of p.humanEye) h.mesh.scale.y = h.baseY * (1 - e.wink * 0.92); // guiño: solo el ojo humano
    const wiggle = this.speaking ? Math.abs(Math.sin(t * 3)) * 0.03 : 0;
    p.browR.position.y = 0.27 + e.browR + wiggle;
    p.browL.position.y = 0.28 + e.browL + wiggle;
    p.browR.rotation.z = Math.PI / 2 + 0.12 + e.tilt;
    p.browL.rotation.z = -0.1 - e.tilt;
    p.cheek.material.opacity = e.blush * 0.7;
    p.head.rotation.z += e.headTilt;
    const lerp = Math.min(1, dt * 10);
    p.arms[0].rotation.z += (armL - p.arms[0].rotation.z) * lerp;
    p.arms[1].rotation.z += (armR - p.arms[1].rotation.z) * lerp;
    p.arms[0].rotation.x += (armLx - p.arms[0].rotation.x) * lerp;
    p.arms[1].rotation.x += (armRx - p.arms[1].rotation.x) * lerp;

    // ---- Detalles cyborg ----
    // Ojo cibernético: pulsa y brilla más cuando habla; una línea de escaneo lo recorre.
    p.irisMat.emissiveIntensity = 1.4 + 0.6 * Math.sin(t * 3) + (this.speaking ? 1 : 0);
    p.scan.position.y = 0.08 + Math.sin(t * 2.2) * 0.075;
    p.scan.visible = !blink;
    // Núcleo del pecho: late como un reactor. La antena parpadea.
    p.coreMat.emissiveIntensity = 1.2 + 0.9 * (0.5 + 0.5 * Math.sin(t * 2.4));
    p.tipMat.emissiveIntensity = Math.sin(t * 5) > 0.2 ? 2.4 : 0.35;
    // Ecualizador de voz en la mejilla metálica.
    for (let i = 0; i < p.bars.length; i++) {
      const level = this.speaking ? 0.25 + this.mouth * (0.4 + 0.6 * Math.abs(Math.sin(t * (9 + i * 2.7) + i))) * 2.2 : 0.18 + 0.1 * Math.sin(t * 2 + i);
      p.bars[i].scale.y = level;
    }
  }

  /** Dibuja a la presentadora dentro del rectángulo del elemento #hostBox. */
  render(renderer, canvas) {
    if (!this.envReady) {
      // Reflejos para que el metal se vea metal. Se arma una sola vez (en el arranque, no en pleno live).
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.4;
      pmrem.dispose();
      for (const tex of emoteTextures.values()) renderer.initTexture(tex);
      this.envReady = true;
    }
    const box = this.box.getBoundingClientRect();
    const host = canvas.getBoundingClientRect();
    const w = box.width;
    const h = box.height;
    if (w < 2 || h < 2) return;
    const x = box.left - host.left;
    const y = host.bottom - box.bottom; // WebGL cuenta desde abajo
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, host.width, host.height);
  }
}

// Fondo tecnológico: degradé azul noche → turquesa con una grilla tenue.
function techBackground(accent) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#040a1f');
  grad.addColorStop(0.55, '#0a2a52');
  grad.addColorStop(1, '#0d6f8f');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 512);
  g.strokeStyle = accent;
  g.globalAlpha = 0.16;
  g.lineWidth = 1;
  for (let x = 0; x <= 256; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke(); }
  for (let y = 0; y <= 512; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
