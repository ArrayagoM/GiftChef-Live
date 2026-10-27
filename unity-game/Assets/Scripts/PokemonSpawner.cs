using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

// Pokémon que aparecen de visita en la cocina cuando llegan regalos.
// Cuanto más valioso el regalo, más raro y poderoso el Pokémon. Los pesos se pueden cambiar sin recompilar
// en config/pokemon.json (carpeta del bridge); si no existe se usan los valores de abajo.
// Se paran en puntos FIJOS del piso (lejos de las mesas, del cocinero y del carril del repartidor).
public class PokemonSpawner : MonoBehaviour
{
    [Serializable]
    public class Entry
    {
        public string id = "";
        public string name = "";
        public int rarity;                 // 0 común, 1 legendario menor, 2 legendario fuerte, 3 el más poderoso
        public GameObject prefab;
        public float height = 0.6f;        // tamaño en la cocina (metros)
        public float pitch;      // giro para enderezar modelos exportados con otro eje (grados sobre X)
        public float yaw = 0f;             // giro si el modelo viene mirando para otro lado
        public bool hover;                 // flota en el aire
        public bool still;                 // no salta (ej. Snorlax)
        public float weight = 1f;          // qué tan seguido sale entre los de su rareza
        // Mascota con animaciones propias (ej. Pikachu): camina con las patas, salta a la mesa y baja, baila y habla
        public bool actor;
        public AnimationClip idleClip, walkClip, jumpClip, danceClip;
        public float walkSpeed = 0.5f;     // m/s al caminar
        public float walkRefSpeed = 0.5f;  // a qué velocidad el ciclo de caminar no patina (se ajusta la velocidad de la animación)
        public string sound = "";          // lo que dice (ej. "Pika pika")
        public float soundPitch = 1.9f, soundRate = 1.35f;
    }

    [Serializable]
    public class Tier
    {
        public float minDiamonds;          // valor total del regalo (diamantes x cantidad) desde el cual aplica
        public float[] weights;            // chance de [común, menor, fuerte, supremo]
    }

    [Serializable]
    public class Config
    {
        public Tier[] tiers;
        public float lowGiftChance = 0.55f;   // regalos chicos: no todos traen visita
        public float lowGiftLimit = 10f;
        public int maxAlive = 3;              // visitas a la vez: si llegan más regalos NO se acumulan
        public float cooldown = 5f;           // segundos mínimos entre visitas comunes
        public int maxLegend = 1;             // legendarios a la vez
        public float legendCooldown = 12f;
        // Combo: si en `comboWindow` segundos se juntan regalos por `comboMin` diamantes o más, a veces (comboChance)
        // aparece UN legendario equivalente al total acumulado (y se vacía lo acumulado)
        public float comboWindow = 45f, comboMin = 100f, comboChance = 0.4f;
        public float stayCommon = 11f, stayRare = 7f, stayTop = 9f;
        public float stayActor = 38f;         // las mascotas con animaciones (Pikachu) se quedan más y recorren la cocina
    }

    public BridgeClient client;
    public Entry[] entries;
    public Config config = DefaultConfig();

    readonly List<GameObject> alive = new List<GameObject>();
    readonly bool[] slotUsed = new bool[5];
    // Puntos del piso (x, z). Libres de mesas (mesa de armado x -1.85..1.85 z 0.25..1.55), del cocinero (z < 0.3)
    // y del carril del repartidor (x < -2.0). Los dos primeros son para los grandes.
    // 0,1,4: frente a la mesa (comunes). 2,3: a la derecha de la mesa (legendarios, más grandes).
    static readonly Vector2[] slots = { new Vector2(0.45f, 2.7f), new Vector2(-0.45f, 2.7f), new Vector2(0.0f, 3.5f), new Vector2(0.0f, 3.5f), new Vector2(0.0f, 2.2f) };
    float lastSpawn;
    Material unlitMat;

    public static Config DefaultConfig()
    {
        return new Config
        {
            tiers = new[]
            {
                new Tier { minDiamonds = 0,     weights = new[] { 94f, 6f, 0f, 0f } },
                new Tier { minDiamonds = 10,    weights = new[] { 70f, 26f, 4f, 0f } },
                new Tier { minDiamonds = 100,   weights = new[] { 30f, 45f, 25f, 0f } },
                new Tier { minDiamonds = 1000,  weights = new[] { 0f, 25f, 60f, 15f } },
                new Tier { minDiamonds = 10000, weights = new[] { 0f, 0f, 0f, 100f } },
            }
        };
    }

    bool residentOn = true, residentSpawned;

    void Start()
    {
        TryLoadConfig();
        if (client != null) client.OnGift += OnGift;
    }

    void Update()
    {
        // Prueba: si existe spawn-test.txt (junto al juego) con un id, aparece ese Pokémon
        if (Time.frameCount % 20 == 0)
        {
            string tf = System.IO.Path.Combine(Application.dataPath, "..", "spawn-test.txt");
            if (System.IO.File.Exists(tf))
            {
                string id = System.IO.File.ReadAllText(tf).Trim(); System.IO.File.Delete(tf);
                if (entries != null) foreach (var e in entries) if (e.id == id) { legendAlive = 0; Spawn(e, "Prueba", 100f); break; }
            }
        }
        // Pikachu es el residente de la cocina: aparece apenas arranca el juego (cuando se toca COMENZAR) y se queda
        if (residentOn && !residentSpawned && client != null && client.reactions && entries != null)
        {
            foreach (var e in entries)
                if (e.id == "pikachu" && e.prefab != null)
                {
                    residentSpawned = true;
                    int slot = 0; slotUsed[slot] = true;
                    StartCoroutine(Visit(e, slot, ""));
                    break;
                }
        }
    }

    void OnDestroy() { if (client != null) client.OnGift -= OnGift; }

    void TryLoadConfig()
    {
        try
        {
            var bl = FindFirstObjectByType<BridgeLauncher>();
            string folder = bl != null ? bl.bridgeFolder : @"D:\Juego live TikTok\bridge";
            string p = System.IO.Path.Combine(folder, "..", "config", "pokemon.json");
            if (System.IO.File.Exists(p))
            {
                var c = JsonUtility.FromJson<Config>(System.IO.File.ReadAllText(p));
                if (c != null && c.tiers != null && c.tiers.Length > 0) config = c;
            }
        }
        catch (Exception) { /* se queda con lo de fábrica */ }
    }

    void OnGift(BridgeClient.Evt e)
    {
        if (client == null || !client.reactions || entries == null || entries.Length == 0) return;
        float total = Mathf.Max(1, e.diamonds) * Mathf.Max(1, e.count);
        if (residentSpawned && true) StartCoroutine(PikaLater("ok", 0.5f, 5f));   // Pikachu "confirma" que llegó un regalo

        // Acumulado de los últimos segundos (para el combo legendario)
        pool.Add(new KeyValuePair<float, float>(Time.time, total));
        pool.RemoveAll(p => Time.time - p.Key > config.comboWindow);
        float poolTotal = 0f; foreach (var p in pool) poolTotal += p.Value;
        if (poolTotal >= config.comboMin && Time.time >= nextCombo && legendAlive < config.maxLegend && UnityEngine.Random.value < config.comboChance)
        {
            int r = Mathf.Max(1, PickRarity(poolTotal));
            var legend = PickEntry(r);
            if (legend != null && legend.rarity >= 1 && Spawn(legend, e.user, poolTotal))
            {
                nextCombo = Time.time + config.legendCooldown;
                pool.Clear();
                return;
            }
        }

        // Visita normal por este regalo: nunca se amontonan (tope de visitas y tiempo mínimo entre una y otra)
        if (alive.Count >= config.maxAlive) return;
        if (total < config.lowGiftLimit && UnityEngine.Random.value > config.lowGiftChance) return;
        if (Time.time - lastSpawn < config.cooldown) return;
        int rarity = PickRarity(total);
        var entry = PickEntry(rarity);
        if (entry == null) return;
        if (entry.rarity > 0 && legendAlive >= config.maxLegend) entry = PickEntry(0);   // ya hay un legendario: viene uno común
        if (entry != null) Spawn(entry, e.user, total);
    }

    readonly List<KeyValuePair<float, float>> pool = new List<KeyValuePair<float, float>>();
    float nextCombo;
    int legendAlive;

    int PickRarity(float total)
    {
        Tier t = config.tiers[0];
        foreach (var x in config.tiers) if (total >= x.minDiamonds) t = x;
        float sum = 0f; foreach (var w in t.weights) sum += w;
        float r = UnityEngine.Random.value * Mathf.Max(0.0001f, sum), acc = 0f;
        for (int i = 0; i < t.weights.Length; i++) { acc += t.weights[i]; if (r <= acc) return i; }
        return 0;
    }

    Entry PickEntry(int rarity)
    {
        for (int rr = rarity; rr >= 0; rr--)
        {
            var list = new List<Entry>();
            foreach (var en in entries) if (en.prefab != null && en.rarity == rr && !(residentSpawned && en.id == "pikachu")) list.Add(en);
            if (list.Count > 0)
            {
                float sum = 0f; foreach (var x in list) sum += Mathf.Max(0.01f, x.weight);
                float r = UnityEngine.Random.value * sum, acc = 0f;
                foreach (var x in list) { acc += Mathf.Max(0.01f, x.weight); if (r <= acc) return x; }
                return list[list.Count - 1];
            }
        }
        return null;
    }

    // Tamaño de un objeto: la altura, o el ancho si es largo (serpientes, alas abiertas)
    static float WorldSize(GameObject g)
    {
        bool first = true; Bounds b = new Bounds(g.transform.position, Vector3.zero);
        foreach (var r in g.GetComponentsInChildren<Renderer>()) { if (first) { b = r.bounds; first = false; } else b.Encapsulate(r.bounds); }
        return first ? 0f : Mathf.Max(b.size.y, 0.75f * Mathf.Max(b.size.x, b.size.z));
    }

    // Premio (meta de taps / seguidor nuevo): aparece uno de la rareza pedida, sin gastar el tope de regalos
    public bool SpawnReward(int minRarity, int maxRarity, string user)
    {
        if (entries == null) return false;
        var list = new List<Entry>();
        foreach (var e in entries) if (!e.actor && e.prefab != null && e.rarity >= minRarity && e.rarity <= maxRarity) list.Add(e);
        if (list.Count == 0) return false;
        var en = list[UnityEngine.Random.Range(0, list.Count)];
        if (en.rarity > 0 && legendAlive >= config.maxLegend) { foreach (var e in entries) if (!e.actor && e.prefab != null && e.rarity == 0) { en = e; break; } }
        return Spawn(en, user, 100f);
    }

    public bool Spawn(Entry en, string user, float total)
    {
        // Un legendario del combo puede entrar aunque las visitas estén completas, pero nunca más de uno a la vez
        if (alive.Count >= config.maxAlive + (en.rarity > 0 ? 1 : 0)) return false;
        if (en.rarity > 0 && legendAlive >= config.maxLegend) return false;
        // Los grandes prefieren los costados (primeros dos puntos) para no tapar al cocinero
        // Los legendarios (grandes, con alas) van a los costados para no tapar la mesa ni al cocinero;
        // los comunes a los puntos del frente, y a los costados solo si no queda otro lugar.
        bool big = en.rarity >= 1 || en.height > 1.4f;
        var free = new List<int>();
        for (int i = 0; i < slotUsed.Length; i++) if (!slotUsed[i]) free.Add(i);
        if (free.Count == 0) return false;
        int slot = -1;
        if (big) { foreach (int i in free) if (i == 2 || i == 3) { slot = i; break; } if (slot < 0) return false; }
        else { var pref = free.FindAll(i => i == 0 || i == 1 || i == 4); slot = pref.Count > 0 ? pref[UnityEngine.Random.Range(0, pref.Count)] : free[free.Count - 1]; }
        lastSpawn = Time.time;
        slotUsed[slot] = true;
        if (en.rarity > 0) { legendAlive++; StartCoroutine(PikaLater("surprise", 1.0f, 3f)); }   // Pikachu se sorprende con un legendario
        StartCoroutine(Visit(en, slot, user));
        return true;
    }

    // ------------------------------------------------------------------ la visita
    IEnumerator Visit(Entry en, int slot, string user)
    {
        Vector3 floor = new Vector3(slots[slot].x, 0f, slots[slot].y);
        var holder = new GameObject("Pokemon_" + en.id).transform;
        holder.position = floor;
        alive.Add(holder.gameObject);
        var model = Instantiate(en.prefab, holder);
        model.transform.localPosition = Vector3.zero; model.transform.localRotation = Quaternion.identity;
        foreach (var l in model.GetComponentsInChildren<Light>()) Destroy(l);
        if (en.pitch != 0f) model.transform.localRotation = Quaternion.Euler(en.pitch, 0f, 0f);
        // Quita accesorios que traen algunos modelos (pokebola de Psyduck, pedestal de Snorlax)
        foreach (var rd in model.GetComponentsInChildren<Renderer>())
            if ((en.id == "psyduck" && rd.name == "Object_10") || (en.id == "snorlax" && rd.name.StartsWith("peana"))) rd.gameObject.SetActive(false);
        float size = WorldSize(model);
        if (en.id == "zapdos")   // el modelo es la forma de Galar (naranja): se pasa al amarillo clásico
        {
            var yb = Resources.Load<Texture2D>("zapdos_amarillo_B"); var ya = Resources.Load<Texture2D>("zapdos_amarillo_A");
            foreach (var rd in model.GetComponentsInChildren<Renderer>())
                foreach (var m in rd.materials)
                {
                    var t = m.HasProperty("_BaseMap") ? m.GetTexture("_BaseMap") : m.mainTexture; if (t == null) continue;
                    Texture2D nt = t.name.Contains("BodyBVco") ? yb : (t.name.Contains("BodyA00") ? ya : null);
                    if (nt == null) continue;
                    if (m.HasProperty("_BaseMap")) m.SetTexture("_BaseMap", nt); else m.mainTexture = nt;
                }
        }
        if (size > 0.001f) model.transform.localScale *= en.height / size;
        // Apoya el punto más bajo en el piso y centra el cuerpo sobre el punto
        var rends = model.GetComponentsInChildren<Renderer>();
        if (rends.Length > 0)
        {
            Bounds b = rends[0].bounds; foreach (var r in rends) b.Encapsulate(r.bounds);
            model.transform.position += new Vector3(floor.x - b.center.x, floor.y - b.min.y, floor.z - b.center.z);
        }
        float hoverY = en.hover ? Mathf.Max(0.12f, en.height * 0.06f) : 0f;
        holder.localScale = Vector3.zero;
        // Animación propia del modelo (aletear, flotar, respirar) en bucle mientras está en la cocina
        Rig loopRig = null;
        if (en.idleClip != null && !en.actor)
        {
            var an0 = model.GetComponentInChildren<Animator>(); if (an0 == null) an0 = model.AddComponent<Animator>();
            an0.runtimeAnimatorController = null; an0.applyRootMotion = false;
            loopRig = Rig.Make(an0, new[] { en.idleClip }, "loop_" + en.id);
        }
        Color main = Palette(en.rarity);

        // Aviso del cocinero (voz y subtítulo) para los que no son comunes
        if (client != null && en.rarity > 0)
        {
            string who = string.IsNullOrEmpty(user) ? "un amigo" : user;
            string txt = en.rarity == 3 ? "Increíble. " + who + " trajo a " + en.name + ", el más poderoso de todos."
                       : en.rarity == 2 ? "Miren eso. Apareció " + en.name + " gracias a " + who + "."
                       : "Apareció " + en.name + ". Gracias " + who + ".";
            client.SendSay(txt);
        }

        StartCoroutine(Reveal(en, floor, hoverY));
        if (en.rarity >= 1 && !en.actor)
        {
            // Secuencia épica: suspenso, rayos, destello y título; el Pokémon aparece en el clímax
            bool climax = false;
            string sub = (user == "la meta de taps") ? "¡META DE TAPS CUMPLIDA!" : (string.IsNullOrEmpty(user) ? "" : "invocado por " + user);
            string tag = en.rarity >= 3 ? "★ LEGENDARIO ★" : (en.rarity == 2 ? "ÉPICO" : "RARO");
            StartCoroutine(EpicFx.Get().Sequence(en.name.ToUpperInvariant(), tag, sub, EpicColor(en, main), floor, en.height, hoverY, Mathf.Min(3, en.rarity + (en.rarity == 3 ? 0 : 0)), () => climax = true));
            float guard = 0f;
            while (!climax && guard < 9f) { guard += Time.unscaledDeltaTime; yield return null; }
            yield return EpicPop(holder, floor, hoverY);
        }
        else yield return Entrance(en, holder, floor, hoverY, main);

        // Mascota con animaciones: camina, salta a la mesa, baila y habla durante su visita
        if (en.actor && en.walkClip != null)
        {
            yield return ActorLife(en, holder, model, floor, main);
            yield return Exit(en, holder, holder != null ? holder.position : floor, 0f, main);
            alive.Remove(holder.gameObject);
            if (holder != null) Destroy(holder.gameObject);
            slotUsed[slot] = false;
            yield break;
        }

        // Se queda un rato: respira, mira a la cámara y de vez en cuando salta
        float stay = en.rarity == 0 ? config.stayCommon : (en.rarity == 3 ? config.stayTop : config.stayRare);
        float life = 0f, phase = UnityEngine.Random.value * 6.28f, nextHop = Time.time + UnityEngine.Random.Range(1.5f, 3.5f), hopT = 9f;
        while (life < stay && holder != null)
        {
            life += Time.deltaTime;
            float bob = en.hover ? 0.07f * Mathf.Sin(life * 1.6f + phase) : 0f;
            float hop = 0f;
            if (!en.hover && !en.still && Time.time >= nextHop) { hopT = 0f; nextHop = Time.time + UnityEngine.Random.Range(2.5f, 4.5f); }
            if (hopT < 0.5f) { hopT += Time.deltaTime; hop = Mathf.Sin(Mathf.Clamp01(hopT / 0.5f) * Mathf.PI) * 0.12f * Mathf.Max(0.5f, en.height); }
            float br = 1f + 0.014f * Mathf.Sin(life * 2.3f + phase);
            holder.position = floor + Vector3.up * (hoverY + bob + hop);
            holder.localScale = new Vector3(1f / Mathf.Sqrt(br), br, 1f / Mathf.Sqrt(br));
            if (loopRig != null) loopRig.Loop();
            Face(holder, en);
            yield return null;
        }

        yield return Exit(en, holder, floor, hoverY, main);
        if (loopRig != null) loopRig.Dispose();
        alive.Remove(holder.gameObject);
        if (holder != null) Destroy(holder.gameObject);
        slotUsed[slot] = false;
        if (en.rarity > 0) legendAlive = Mathf.Max(0, legendAlive - 1);
    }

    // Plano de cámara corto para que se vea la aparición. Los legendarios siempre; los comunes solo si la cocina está libre
    // (así no se interrumpe lo que está cocinando el personaje).
    IEnumerator Reveal(Entry en, Vector3 floor, float hoverY)
    {
        var cam = FindFirstObjectByType<FollowCamera>();
        var kitchen = FindFirstObjectByType<KitchenController>();
        if (cam == null) yield break;
        bool busy = kitchen != null && kitchen.Busy;
        // los comunes también tienen su plano corto, aunque la cocina esté ocupada (la cámara vuelve sola a la receta)
        Vector3 look = floor + Vector3.up * (hoverY + en.height * (en.rarity == 0 ? 0.45f : 0.68f));   // los legendarios más abajo en el cuadro: la pizarra de pedidos tapa el borde de arriba
        float dist = en.rarity == 0 ? 2.3f : Mathf.Max(5.0f, en.height * 1.8f + 1.4f);                   // que entre entero en el cuadro vertical
        Vector3 pos = floor + new Vector3(0.0f, 0.6f + en.height * 0.5f, dist);
        float secs = en.rarity == 0 ? 1.8f : (en.rarity == 3 ? config.stayTop : config.stayRare) + 3.0f;   // el plano dura mientras el legendario está presente
        cam.ShotLocked(pos, look, 46f, secs);
        yield return new WaitForSeconds(secs + 0.05f);
        if (kitchen != null && !kitchen.Busy && cam != null) cam.Release();   // si no hay pedido, la cámara vuelve al cocinero
    }

    // ------------------------------------------------------------------ mascota con animaciones (Pikachu)
    class Rig
    {
        public PlayableGraph graph; public AnimationMixerPlayable mixer; public AnimationClipPlayable[] cp; public float[] w;
        public static Rig Make(Animator an, AnimationClip[] clips, string name)
        {
            var r = new Rig();
            r.graph = PlayableGraph.Create(name);
            r.graph.SetTimeUpdateMode(DirectorUpdateMode.GameTime);
            var output = AnimationPlayableOutput.Create(r.graph, "anim", an);
            r.mixer = AnimationMixerPlayable.Create(r.graph, clips.Length);
            r.cp = new AnimationClipPlayable[clips.Length]; r.w = new float[clips.Length];
            for (int i = 0; i < clips.Length; i++)
            {
                r.cp[i] = AnimationClipPlayable.Create(r.graph, clips[i]);
                r.graph.Connect(r.cp[i], 0, r.mixer, i);
                r.mixer.SetInputWeight(i, 0f);
            }
            output.SetSourcePlayable(r.mixer);
            r.w[0] = 1f; r.mixer.SetInputWeight(0, 1f);
            r.graph.Play();
            return r;
        }
        public void Blend(int idx, float dt, float rate = 9f)
        {
            for (int i = 0; i < w.Length; i++) { w[i] = Mathf.MoveTowards(w[i], i == idx ? 1f : 0f, rate * dt); mixer.SetInputWeight(i, w[i]); }
        }
        public void Restart(int i) { cp[i].SetTime(0); }
        // Repite la animación aunque el modelo la traiga sin bucle
        public void Loop() { for (int i = 0; i < cp.Length; i++) { var c = cp[i].GetAnimationClip(); if (c != null && c.length > 0.05f && cp[i].GetTime() >= c.length) cp[i].SetTime(0); } }
        public void Dispose() { if (graph.IsValid()) graph.Destroy(); }
    }

    class ActorState { public Transform holder; public Rig rig; public Entry en; public Vector3 pos; public float yaw; public bool onTable; public Color color; public float nextSound; }

    const float TableTop = 0.9f, TableEdgeZ = 1.40f, StageZ = 2.05f;

    void Apply(ActorState s) { s.holder.position = s.pos; s.holder.rotation = Quaternion.Euler(0f, s.yaw + s.en.yaw, 0f); }

    void FaceCamera(ActorState s, float dt)
    {
        var cam = Camera.main; if (cam == null) return;
        Vector3 d = cam.transform.position - s.pos; d.y = 0f;
        if (d.sqrMagnitude > 0.01f) s.yaw = Mathf.MoveTowardsAngle(s.yaw, Mathf.Atan2(d.x, d.z) * Mathf.Rad2Deg, 220f * dt);
    }

    // Si existe Assets/Resources/pikachu.wav (el sonido original, que pone el dueño del juego) se usa ese; si no, la voz sintética
    public bool petSounds = true;      // sonido suave de Pikachu (Assets/Resources/pikachu.mp3); sin ese archivo se queda en silencio
    float lastPetSound = -99f;

    // Tres sonidos de Pikachu (los puso el dueño en Assets/Resources): feliz, confirmación ("Pikachu") y sorpresa
    readonly Dictionary<string, AudioClip> pikaClips = new Dictionary<string, AudioClip>();
    AudioClip PikaClip(string kind)
    {
        AudioClip c; if (pikaClips.TryGetValue(kind, out c)) return c;
        string n = kind == "happy" ? "pikachu_feliz" : (kind == "ok" ? "pikachu_ok" : "pikachu_sorpresa");
        c = Resources.Load<AudioClip>(n); pikaClips[kind] = c; return c;
    }

    // Sin el archivo o con Pikachu ausente: silencio. minGap = segundos mínimos desde el último sonido (para que no moleste)
    void PlayPika(string kind, float minGap)
    {
        if (!petSounds || !residentSpawned || Time.time - lastPetSound < minGap) return;
        var c = PikaClip(kind); if (c == null) return;
        lastPetSound = Time.time;
        StartCoroutine(Cries(c, 1));
    }

    IEnumerator PikaLater(string kind, float delay, float minGap) { yield return new WaitForSeconds(delay); PlayPika(kind, minGap); }

    // Contento: al bailar, al aterrizar un salto, de vez en cuando
    void PetSound(ActorState s) { if (s.en.id == "pikachu") PlayPika("happy", 8f); }

    // "Pika pika": el grito original una o dos veces, con un poco de variación de tono (como expresiones distintas)
    IEnumerator Cries(AudioClip clip, int count)
    {
        for (int i = 0; i < count; i++)
        {
            var go = new GameObject("PikaGrito"); var src = go.AddComponent<AudioSource>();
            src.clip = clip; src.spatialBlend = 0f; src.volume = 0.7f; src.pitch = 1f; src.Play();
            Destroy(go, clip.length / src.pitch + 0.2f);
            yield return new WaitForSeconds(clip.length / src.pitch + 0.08f);
        }
    }

    IEnumerator ActorLife(Entry en, Transform holder, GameObject model, Vector3 floor, Color main)
    {
        var an = model.GetComponentInChildren<Animator>();
        if (an == null) an = model.AddComponent<Animator>();
        an.runtimeAnimatorController = null; an.applyRootMotion = false;
        var clips = new[] { en.idleClip != null ? en.idleClip : en.walkClip, en.walkClip, en.jumpClip != null ? en.jumpClip : en.walkClip, en.danceClip != null ? en.danceClip : (en.idleClip != null ? en.idleClip : en.walkClip) };
        var s = new ActorState { holder = holder, en = en, rig = Rig.Make(an, clips, "pk_" + en.id), pos = floor, yaw = holder.eulerAngles.y, color = main };
        s.nextSound = Time.time + UnityEngine.Random.Range(1.2f, 2.5f);
        holder.localScale = Vector3.one;
        float endAt = en.id == "pikachu" && residentOn ? float.PositiveInfinity : Time.time + config.stayActor;   // Pikachu vive en la cocina
        try
        {
            while (Time.time < endAt && holder != null)
            {
                if (Time.time >= s.nextSound) { PetSound(s); s.nextSound = Time.time + UnityEngine.Random.Range(12f, 20f); }
                int a = UnityEngine.Random.Range(0, 10);
                if (!s.onTable)
                {
                    if (a < 5) yield return WalkTo(s, new Vector3(UnityEngine.Random.Range(-1.5f, 1.7f), 0f, UnityEngine.Random.Range(2.1f, 3.0f)));
                    else if (a < 7) yield return IdleFor(s, UnityEngine.Random.Range(1.0f, 2.0f));
                    else if (a < 8) yield return DanceFor(s, 3.5f);
                    else
                    {   // va hasta el borde de la mesa y salta para subir
                        float x = Mathf.Clamp(s.pos.x, -1.3f, 1.3f);
                        yield return WalkTo(s, new Vector3(x, 0f, StageZ));
                        yield return JumpTo(s, new Vector3(x, TableTop, TableEdgeZ), 0.5f, 0.75f);
                        s.onTable = true;
                    }
                }
                else
                {
                    if (a < 6) yield return WalkTo(s, new Vector3(UnityEngine.Random.Range(-1.4f, 1.4f), TableTop, TableEdgeZ));
                    else if (a < 8) yield return IdleFor(s, UnityEngine.Random.Range(1.2f, 2.2f));
                    else
                    {   // baja de un salto al piso
                        yield return JumpTo(s, new Vector3(s.pos.x, 0f, StageZ + 0.1f), 0.45f, 0.7f);
                        s.onTable = false;
                    }
                }
            }
            if (s.onTable && holder != null)
            {
                yield return JumpTo(s, new Vector3(s.pos.x, 0f, StageZ + 0.1f), 0.45f, 0.7f);
                s.onTable = false;
            }
        }
        finally { s.rig.Dispose(); }
    }

    IEnumerator WalkTo(ActorState s, Vector3 target)
    {
        target.y = s.pos.y;
        float guard = 0f;
        while (s.holder != null && guard < 12f)
        {
            float dt = Time.deltaTime; guard += dt;
            Vector3 d = target - s.pos; d.y = 0f;
            float dist = d.magnitude;
            if (dist < 0.04f) break;
            float want = Mathf.Atan2(d.x, d.z) * Mathf.Rad2Deg;
            s.yaw = Mathf.MoveTowardsAngle(s.yaw, want, 420f * dt);
            bool aligned = Mathf.Abs(Mathf.DeltaAngle(s.yaw, want)) < 25f;      // primero gira, después camina
            float speed = aligned ? s.en.walkSpeed : 0f;
            s.pos += d.normalized * Mathf.Min(dist, speed * dt);
            s.rig.cp[1].SetSpeed(speed > 0f ? speed / Mathf.Max(0.05f, s.en.walkRefSpeed) : 1f);   // las patas acompañan la velocidad: no patina
            s.rig.Blend(speed > 0f ? 1 : 0, dt);
            Apply(s);
            yield return null;
        }
        s.rig.Blend(0, 1f, 100f);
    }

    IEnumerator IdleFor(ActorState s, float secs)
    {
        float t = 0f;
        while (t < secs && s.holder != null)
        {
            float dt = Time.deltaTime; t += dt;
            s.rig.Blend(0, dt); FaceCamera(s, dt); Apply(s);
            yield return null;
        }
    }

    IEnumerator DanceFor(ActorState s, float secs)
    {
        s.rig.Restart(3);
        PetSound(s); s.nextSound = Time.time + 8f;
        float t = 0f;
        while (t < secs && s.holder != null)
        {
            float dt = Time.deltaTime; t += dt;
            s.rig.Blend(3, dt); FaceCamera(s, dt); Apply(s);
            yield return null;
        }
    }

    // Salto de verdad: se agacha, vuela en arco, cae con un aplastón y polvo
    IEnumerator JumpTo(ActorState s, Vector3 target, float height, float dur)
    {
        if (s.holder == null) yield break;
        Vector3 from = s.pos;
        Vector3 d = target - from; d.y = 0f;
        float want = d.sqrMagnitude > 0.0001f ? Mathf.Atan2(d.x, d.z) * Mathf.Rad2Deg : s.yaw;
        float t = 0f;
        while (t < 0.18f && s.holder != null) { float dt = Time.deltaTime; t += dt; s.yaw = Mathf.MoveTowardsAngle(s.yaw, want, 600f * dt); s.rig.Blend(0, dt); Apply(s); yield return null; }
        float clipLen = Mathf.Max(0.2f, s.rig.cp[2].GetAnimationClip().length);
        s.rig.Restart(2); s.rig.cp[2].SetSpeed(clipLen / (0.25f + dur + 0.2f));
        s.rig.Blend(2, 1f, 100f);
        t = 0f;
        while (t < 0.25f && s.holder != null)      // se agacha para tomar impulso
        {
            t += Time.deltaTime; float k = t / 0.25f;
            s.holder.localScale = new Vector3(1f + 0.1f * k, 1f - 0.16f * k, 1f + 0.1f * k);
            Apply(s); yield return null;
        }
        t = 0f;
        while (t < dur && s.holder != null)        // en el aire
        {
            t += Time.deltaTime; float k = Mathf.Clamp01(t / dur);
            Vector3 p = Vector3.Lerp(from, target, k);
            p.y += 4f * height * k * (1f - k);
            s.pos = p;
            s.holder.localScale = new Vector3(1f - 0.06f * Mathf.Sin(k * Mathf.PI), 1f + 0.1f * Mathf.Sin(k * Mathf.PI), 1f - 0.06f * Mathf.Sin(k * Mathf.PI));
            Apply(s); yield return null;
        }
        s.pos = target; Apply(s);
        Landing(target, 0.3f, s.color);
        t = 0f;
        while (t < 0.22f && s.holder != null)      // aplastón al caer y se acomoda
        {
            t += Time.deltaTime; float k = Mathf.Clamp01(t / 0.22f);
            float sq = Mathf.Sin(k * Mathf.PI);
            s.holder.localScale = new Vector3(1f + 0.18f * sq, 1f - 0.2f * sq, 1f + 0.18f * sq);
            Apply(s); yield return null;
        }
        if (s.holder != null) s.holder.localScale = Vector3.one;
        s.rig.Blend(0, 1f, 100f);
        PetSound(s); s.nextSound = Time.time + UnityEngine.Random.Range(12f, 20f);
    }

    static Color Palette(int rarity)
    {
        switch (rarity)
        {
            case 1: return new Color(0.4f, 0.9f, 1f);
            case 2: return new Color(1f, 0.55f, 0.2f);
            case 3: return new Color(1f, 0.9f, 0.4f);
            default: return new Color(1f, 0.95f, 0.6f);
        }
    }

    // ------------------------------------------------------------------ entrada
    // Color del efecto según el Pokémon (si no, el de su rareza)
    Color EpicColor(Entry en, Color fallback)
    {
        switch (en.id)
        {
            case "arceus": return new Color(1f, 0.88f, 0.45f);
            case "mewtwo": return new Color(0.7f, 0.4f, 1f);
            case "lugia": return new Color(0.5f, 0.8f, 1f);
            case "hooh": return new Color(1f, 0.45f, 0.1f);
            case "zapdos": return new Color(1f, 0.92f, 0.25f);
            case "dragonite": return new Color(1f, 0.62f, 0.2f);
            case "charizard": return new Color(1f, 0.4f, 0.1f);
            case "garchomp": return new Color(0.45f, 0.5f, 1f);
            case "greninja": return new Color(0.3f, 0.65f, 1f);
            case "umbreon": return new Color(1f, 0.9f, 0.3f);
            case "mimikyu": return new Color(0.8f, 0.4f, 1f);
        }
        return fallback;
    }

    // Aparece con un rebote grande (en cámara lenta durante el clímax)
    IEnumerator EpicPop(Transform holder, Vector3 floor, float hoverY)
    {
        float t = 0f, dur = 0.55f;
        while (t < dur && holder != null)
        {
            t += Time.deltaTime; float k = Mathf.Clamp01(t / dur);
            float e = 1f - Mathf.Pow(1f - k, 3f);
            float s = e * (1f + 0.25f * Mathf.Sin(k * Mathf.PI));
            holder.position = floor + Vector3.up * (hoverY + Mathf.Lerp(1.2f, 0f, e));
            holder.localScale = Vector3.one * Mathf.Max(0.001f, s);
            yield return null;
        }
        if (holder != null) { holder.position = floor + Vector3.up * hoverY; holder.localScale = Vector3.one; }
    }

    IEnumerator Entrance(Entry en, Transform holder, Vector3 floor, float hoverY, Color main)
    {
        if (en.rarity == 0)
        {
            // Cae del cielo con estiramiento, aplasta al aterrizar, rebota y se acomoda
            float t = 0f, fall = 0.42f, h0 = 3.0f;
            holder.localScale = new Vector3(0.9f, 1.15f, 0.9f);
            while (t < fall && holder != null)
            {
                t += Time.deltaTime; float k = Mathf.Clamp01(t / fall);
                holder.position = floor + Vector3.up * (Mathf.Lerp(h0, hoverY, k * k));
                holder.localScale = new Vector3(0.9f, 1.15f, 0.9f);
                holder.rotation = Quaternion.Euler(0f, k * 360f, 0f);
                yield return null;
            }
            if (holder == null) yield break;
            Landing(floor, 0.5f, main);
            yield return Squash(holder, floor, 0.10f, new Vector3(1.3f, 0.68f, 1.3f));
            yield return Rebound(holder, floor, 0.26f * Mathf.Max(0.5f, en.height), 0.24f);
            yield return Squash(holder, floor, 0.07f, new Vector3(1.12f, 0.88f, 1.12f));
            yield return Squash(holder, floor, 0.14f, Vector3.one);
        }
        else
        {
            // Destello de luz + rayo + onda expansiva; aparece girando y creciendo mientras desciende
            float power = en.rarity == 3 ? 1.6f : (en.rarity == 2 ? 1.2f : 0.9f);
            StartCoroutine(Flash(floor + Vector3.up * (hoverY + en.height * 0.5f), main, 5f * power, 0.8f));
            StartCoroutine(Beam(floor, main, 0.22f * power, 4.5f, 0.7f));
            StartCoroutine(Shock(floor, main, 1.2f * power + en.height * 0.5f, 0.55f));
            Sparkles(floor + Vector3.up * (hoverY + en.height * 0.4f), main, 22 + (int)(14 * power), 1.6f * power);
            float t = 0f, dur = 0.9f, from = 1.8f;
            while (t < dur && holder != null)
            {
                t += Time.deltaTime; float k = Mathf.Clamp01(t / dur);
                float e = 1f - Mathf.Pow(1f - k, 3f);
                float s = e * (1f + 0.22f * Mathf.Sin(k * Mathf.PI));
                holder.position = floor + Vector3.up * (hoverY + Mathf.Lerp(from, 0f, e));
                holder.localScale = Vector3.one * Mathf.Max(0.001f, s);
                holder.rotation = Quaternion.Euler(0f, (1f - e) * 540f, 0f);
                yield return null;
            }
            if (holder != null) { holder.position = floor + Vector3.up * hoverY; holder.localScale = Vector3.one; }
        }
    }

    IEnumerator Squash(Transform holder, Vector3 floor, float dur, Vector3 to)
    {
        if (holder == null) yield break;
        Vector3 from = holder.localScale; float t = 0f;
        while (t < dur && holder != null)
        {
            t += Time.deltaTime; holder.localScale = Vector3.Lerp(from, to, Mathf.SmoothStep(0f, 1f, t / dur));
            holder.position = new Vector3(floor.x, floor.y, floor.z);
            yield return null;
        }
    }

    IEnumerator Rebound(Transform holder, Vector3 floor, float height, float dur)
    {
        float t = 0f;
        while (t < dur && holder != null)
        {
            t += Time.deltaTime; float k = Mathf.Clamp01(t / dur);
            holder.position = floor + Vector3.up * (Mathf.Sin(k * Mathf.PI) * height);
            float st = Mathf.Sin(k * Mathf.PI);
            holder.localScale = new Vector3(Mathf.Lerp(1.15f, 0.92f, st), Mathf.Lerp(0.85f, 1.1f, st), Mathf.Lerp(1.15f, 0.92f, st));
            yield return null;
        }
        if (holder != null) holder.position = floor;
    }

    // ------------------------------------------------------------------ salida
    IEnumerator Exit(Entry en, Transform holder, Vector3 floor, float hoverY, Color main)
    {
        if (holder == null) yield break;
        float t = 0f, dur = en.rarity == 0 ? 0.5f : 0.7f;
        Vector3 from = holder.position;
        Vector3 s0 = holder.localScale;
        Sparkles(from + Vector3.up * en.height * 0.5f, main, en.rarity == 0 ? 10 : 24, en.rarity == 0 ? 1.0f : 1.6f);
        if (en.rarity > 0) StartCoroutine(Flash(from + Vector3.up * en.height * 0.5f, main, 3f, 0.5f));
        while (t < dur && holder != null)
        {
            t += Time.deltaTime; float k = Mathf.Clamp01(t / dur);
            float up = en.rarity == 0 ? Mathf.Sin(k * Mathf.PI) * 0.3f : k * 1.2f;
            holder.position = from + Vector3.up * up;
            holder.localScale = s0 * Mathf.Max(0.001f, 1f - k * k);
            holder.rotation *= Quaternion.Euler(0f, 700f * Time.deltaTime, 0f);
            yield return null;
        }
    }

    void Face(Transform holder, Entry en)
    {
        var cam = Camera.main; if (cam == null) return;
        Vector3 d = cam.transform.position - holder.position; d.y = 0f;
        if (d.sqrMagnitude < 0.01f) return;
        var target = Quaternion.LookRotation(d.normalized, Vector3.up) * Quaternion.Euler(0f, en.yaw, 0f);
        holder.rotation = Quaternion.RotateTowards(holder.rotation, target, 300f * Time.deltaTime);
    }

    // ------------------------------------------------------------------ efectos (solo formas simples, sin texturas)
    Material Unlit(Color c)
    {
        if (unlitMat == null)
        {
            var sh = Shader.Find("Universal Render Pipeline/Unlit");
            if (sh == null) sh = Shader.Find("Universal Render Pipeline/Lit");
            unlitMat = new Material(sh) { hideFlags = HideFlags.HideAndDontSave };
        }
        var m = new Material(unlitMat);
        m.SetColor("_BaseColor", c); m.color = c;
        return m;
    }

    GameObject Shape(PrimitiveType t, Color c, Vector3 pos, Vector3 scale)
    {
        var g = GameObject.CreatePrimitive(t);
        var col = g.GetComponent<Collider>(); if (col != null) Destroy(col);
        var r = g.GetComponent<Renderer>(); r.sharedMaterial = Unlit(c); r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off; r.receiveShadows = false;
        g.transform.position = pos; g.transform.localScale = scale;
        return g;
    }

    void Cleanup(GameObject g) { if (g == null) return; var r = g.GetComponent<Renderer>(); if (r != null && r.sharedMaterial != null) Destroy(r.sharedMaterial); Destroy(g); }

    // Polvo y chispitas al aterrizar
    void Landing(Vector3 floor, float size, Color main)
    {
        for (int i = 0; i < 8; i++)
        {
            float a = i / 8f * Mathf.PI * 2f + UnityEngine.Random.value;
            var g = Shape(PrimitiveType.Sphere, new Color(0.93f, 0.92f, 0.9f), floor + new Vector3(Mathf.Cos(a), 0.05f, Mathf.Sin(a)) * 0.1f, Vector3.one * 0.09f * size * 2f);
            StartCoroutine(Puff(g, new Vector3(Mathf.Cos(a), 0.35f, Mathf.Sin(a)) * (0.7f + size), 0.5f));
        }
        Sparkles(floor + Vector3.up * 0.1f, main, 8, 1.0f);
    }

    IEnumerator Puff(GameObject g, Vector3 v, float dur)
    {
        float t = 0f; Vector3 s0 = g != null ? g.transform.localScale : Vector3.one;
        while (t < dur && g != null)
        {
            t += Time.deltaTime; float k = t / dur;
            g.transform.position += v * (1f - k) * Time.deltaTime;
            g.transform.localScale = s0 * (1f + 0.8f * k) * Mathf.Max(0.001f, 1f - k * k);
            yield return null;
        }
        Cleanup(g);
    }

    void Sparkles(Vector3 center, Color c, int count, float speed)
    {
        for (int i = 0; i < count; i++)
        {
            var col = Color.Lerp(c, Color.white, UnityEngine.Random.value * 0.6f);
            var g = Shape(i % 3 == 0 ? PrimitiveType.Cube : PrimitiveType.Sphere, col, center, Vector3.one * UnityEngine.Random.Range(0.03f, 0.06f));
            var v = UnityEngine.Random.onUnitSphere; v.y = Mathf.Abs(v.y) * 0.9f + 0.4f;
            StartCoroutine(Spark(g, v * speed * UnityEngine.Random.Range(0.6f, 1.4f)));
        }
    }

    IEnumerator Spark(GameObject g, Vector3 v)
    {
        float t = 0f, life = UnityEngine.Random.Range(0.6f, 1.0f); Vector3 s0 = g != null ? g.transform.localScale : Vector3.one;
        while (t < life && g != null)
        {
            t += Time.deltaTime; v.y -= 2.6f * Time.deltaTime;
            g.transform.position += v * Time.deltaTime;
            g.transform.Rotate(240f * Time.deltaTime, 180f * Time.deltaTime, 0f);
            g.transform.localScale = s0 * Mathf.Max(0.001f, 1f - t / life);
            yield return null;
        }
        Cleanup(g);
    }

    IEnumerator Flash(Vector3 pos, Color c, float intensity, float dur)
    {
        var go = new GameObject("PokemonFlash"); go.transform.position = pos;
        var l = go.AddComponent<Light>(); l.type = LightType.Point; l.color = c; l.range = 5f; l.intensity = intensity; l.shadows = LightShadows.None;
        float t = 0f;
        while (t < dur && go != null) { t += Time.deltaTime; l.intensity = intensity * Mathf.Pow(1f - t / dur, 2f); yield return null; }
        if (go != null) Destroy(go);
    }

    // Columna de luz que baja del cielo
    IEnumerator Beam(Vector3 floor, Color c, float width, float height, float dur)
    {
        var g = Shape(PrimitiveType.Cylinder, Color.Lerp(c, Color.white, 0.5f), floor + Vector3.up * height * 0.5f, new Vector3(width, height * 0.5f, width));
        float t = 0f;
        while (t < dur && g != null)
        {
            t += Time.deltaTime; float k = t / dur;
            float w = width * (k < 0.2f ? k / 0.2f : 1f - (k - 0.2f) / 0.8f);
            g.transform.localScale = new Vector3(Mathf.Max(0.001f, w), height * 0.5f, Mathf.Max(0.001f, w));
            yield return null;
        }
        Cleanup(g);
    }

    // Onda en el piso que se abre y se aplana
    IEnumerator Shock(Vector3 floor, Color c, float radius, float dur)
    {
        var g = Shape(PrimitiveType.Cylinder, Color.Lerp(c, Color.white, 0.4f), floor + Vector3.up * 0.02f, new Vector3(0.1f, 0.012f, 0.1f));
        float t = 0f;
        while (t < dur && g != null)
        {
            t += Time.deltaTime; float k = t / dur; float e = 1f - Mathf.Pow(1f - k, 3f);
            float r = Mathf.Lerp(0.2f, radius, e);
            g.transform.localScale = new Vector3(r, Mathf.Max(0.0005f, 0.012f * (1f - k)), r);
            yield return null;
        }
        Cleanup(g);
    }
}
