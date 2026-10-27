using System.Collections;
using UnityEngine;

// Panel compacto y legible para el live: meta de taps (barra) y una línea rotativa que explica cómo participar gratis.
// Va justo debajo de la pizarra, sin tapar al cocinero ni la comida, y se oculta en el menú de inicio.
public class GoalHud : MonoBehaviour
{
    public static GoalHud Instance;
    BridgeClient client;
    PokemonSpawner pokemon;
    float eventEvery = 300f, nextEventAt = -1f; bool eventRunning;
    int goal = 600, taps, level;      // level = ronda actual (0 = primera)
    float shown, celebrateUntil;
    GUIStyle sLabel, sCta, sSmall;
    Texture2D white;
    static readonly string[] cta = {
        "Escribí PIZZA, HAMBURGUESA o PAPAS en el chat: gratis",
        "Seguime y mirá qué Pokémon te toca",
        "Tocá la pantalla: cada ronda trae un Pokémon más fuerte",
        "Rosa = pizza · Corazón = hamburguesa · Dona = papas",
    };

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot() { if (Instance == null) { var g = new GameObject("GoalHud"); Instance = g.AddComponent<GoalHud>(); } }

    public static void Taps(int n, int total = 0)
    {
        if (Instance == null) { var g = new GameObject("GoalHud"); Instance = g.AddComponent<GoalHud>(); }
        Instance.Add(n, total);
    }

    void Awake() { Instance = this; }

    // Metas: 600, 2600, 5600, 9600, 14600... (cada ronda cuesta más). Premio: 0 normal, 1 raro, 2 épico, 3 legendario (y los siguientes, legendarios).
    static int GoalFor(int lvl) { if (lvl <= 0) return 600; int g = 2600; for (int n = 2; n <= lvl; n++) g += 2000 + 1000 * (n - 1); return g; }
    static int PrizeFor(int lvl) { return Mathf.Min(3, lvl); }
    static readonly string[] prizeName = { "NORMAL", "RARO", "ÉPICO", "LEGENDARIO" };

    bool synced;     // ya se recibió el total real de taps del live
    // Los taps son el TOTAL del live (el mismo número que muestra TikTok) y las metas son absolutas: 600, 2600, 5600, 9600...
    void Add(int n, int total)
    {
        if (client == null) client = FindFirstObjectByType<BridgeClient>();
        if (total > 0)
        {
            if (!synced)
            {
                // Primera lectura (el juego recién arrancó o se reabrió): se toma el total y la ronda que le corresponde, sin dar premios viejos
                synced = true; taps = total; level = 0; while (GoalFor(level) <= taps) level++; goal = GoalFor(level); shown = taps;
                return;
            }
            taps = Mathf.Max(taps, total);
        }
        else taps += Mathf.Max(1, n);          // sin total (pruebas): se suma de a poco
        while (taps >= goal)
        {
            int prize = PrizeFor(level);
            level++; goal = GoalFor(level);
            celebrateUntil = Time.time + 4f;
            if (pokemon == null) pokemon = FindFirstObjectByType<PokemonSpawner>();
            if (pokemon != null) pokemon.SpawnReward(prize, prize, "la meta de taps");
            if (client != null)
            {
                string pk = prize == 0 ? "un Pokémon" : (prize == 1 ? "un Pokémon raro" : (prize == 2 ? "un Pokémon épico" : "un Pokémon legendario"));
                client.SendSay("¡Ronda " + level + " completada! Aparece " + pk + ". Ahora vamos por la ronda " + (level + 1) + ": " + goal + " taps, con un premio más poderoso.");
            }
        }
    }

    void Update()
    {
        if (client == null) client = FindFirstObjectByType<BridgeClient>();
        if (client != null && client.reactions)
        {
            if (nextEventAt < 0f) nextEventAt = Time.time + eventEvery;
            if (!eventRunning && Time.time >= nextEventAt) { nextEventAt = Time.time + eventEvery; StartCoroutine(SpecialEvent()); }
            if (Time.frameCount % 20 == 0)
            {
                string tf = System.IO.Path.Combine(Application.dataPath, "..", "event-test.txt");
                if (System.IO.File.Exists(tf)) { System.IO.File.Delete(tf); if (!eventRunning) StartCoroutine(SpecialEvent()); }
            }
        }
        shown = Mathf.MoveTowards(shown, taps, Mathf.Max(8f, goal * 0.6f) * Time.deltaTime);
        if (taps < shown) shown = taps;
    }

    // ------------------------------------------------------------------ evento especial: lluvia de pizzas + 3 Pokémon
    IEnumerator SpecialEvent()
    {
        eventRunning = true;
        if (pokemon == null) pokemon = FindFirstObjectByType<PokemonSpawner>();
        if (client != null) client.SendSay("¡Evento especial! Llueven pizzas y llegan Pokémon para todos. ¡Miren!");
        EpicFx.Get().Announce("★ EVENTO ESPECIAL ★", "LLUVIA DE PIZZAS", "¡y Pokémon para todos!", new Color(1f, 0.6f, 0.2f), 5f);
        StartCoroutine(PizzaRain(7f));
        yield return new WaitForSeconds(1.5f);
        if (pokemon != null) pokemon.SpawnReward(0, 1, "el evento");
        yield return new WaitForSeconds(3f);
        if (pokemon != null) pokemon.SpawnReward(1, 2, "el evento");
        yield return new WaitForSeconds(4f);
        if (pokemon != null) pokemon.SpawnReward(0, 0, "el evento");
        yield return new WaitForSeconds(2f);
        eventRunning = false;
    }

    IEnumerator PizzaRain(float secs)
    {
        var sh = Shader.Find("Universal Render Pipeline/Unlit"); if (sh == null) sh = Shader.Find("Universal Render Pipeline/Lit");
        var crust = new Material(sh); crust.SetColor("_BaseColor", new Color(0.9f, 0.7f, 0.35f));
        var sauce = new Material(sh); sauce.SetColor("_BaseColor", new Color(0.8f, 0.15f, 0.08f));
        var cheese = new Material(sh); cheese.SetColor("_BaseColor", new Color(1f, 0.85f, 0.3f));
        var rain = new System.Collections.Generic.List<Transform>(); var vel = new System.Collections.Generic.List<float>(); var spin = new System.Collections.Generic.List<float>(); var born = new System.Collections.Generic.List<float>();
        float t = 0f, nextSpawn = 0f;
        while (t < secs + 4f || rain.Count > 0)
        {
            t += Time.deltaTime;
            if (t < secs && t >= nextSpawn)
            {
                nextSpawn = t + 0.12f;
                var g = new GameObject("Pizza");
                var a = GameObject.CreatePrimitive(PrimitiveType.Cylinder); Destroy(a.GetComponent<Collider>()); a.transform.SetParent(g.transform, false); a.transform.localScale = new Vector3(0.36f, 0.012f, 0.36f); a.GetComponent<Renderer>().sharedMaterial = crust;
                var b = GameObject.CreatePrimitive(PrimitiveType.Cylinder); Destroy(b.GetComponent<Collider>()); b.transform.SetParent(g.transform, false); b.transform.localPosition = Vector3.up * 0.012f; b.transform.localScale = new Vector3(0.3f, 0.012f, 0.3f); b.GetComponent<Renderer>().sharedMaterial = sauce;
                var c = GameObject.CreatePrimitive(PrimitiveType.Cylinder); Destroy(c.GetComponent<Collider>()); c.transform.SetParent(g.transform, false); c.transform.localPosition = Vector3.up * 0.022f; c.transform.localScale = new Vector3(0.24f, 0.01f, 0.24f); c.GetComponent<Renderer>().sharedMaterial = cheese;
                g.transform.position = new Vector3(Random.Range(-2.4f, 2.4f), Random.Range(4.5f, 6f), Random.Range(0.8f, 3.6f));
                g.transform.rotation = Random.rotation;
                rain.Add(g.transform); vel.Add(0f); spin.Add(Random.Range(-360f, 360f)); born.Add(Time.time);
            }
            for (int i = rain.Count - 1; i >= 0; i--)
            {
                var tr = rain[i]; if (tr == null) { rain.RemoveAt(i); vel.RemoveAt(i); spin.RemoveAt(i); born.RemoveAt(i); continue; }
                vel[i] -= 7f * Time.deltaTime; var p = tr.position; p.y += vel[i] * Time.deltaTime;
                if (p.y <= 0.04f) { p.y = 0.04f; vel[i] = Mathf.Abs(vel[i]) * 0.25f; spin[i] *= 0.4f; if (vel[i] < 0.4f) { vel[i] = 0f; } }
                tr.position = p; tr.Rotate(spin[i] * Time.deltaTime, spin[i] * 0.6f * Time.deltaTime, 0f);
                if (Time.time - born[i] > 7f) { float k = Mathf.Clamp01(1f - (Time.time - born[i] - 7f) / 0.8f); tr.localScale = Vector3.one * k; if (k <= 0.01f) { Destroy(tr.gameObject); rain.RemoveAt(i); vel.RemoveAt(i); spin.RemoveAt(i); born.RemoveAt(i); } }
            }
            yield return null;
        }
        Destroy(crust); Destroy(sauce); Destroy(cheese);
    }

    string Countdown()
    {
        if (nextEventAt < 0f) return "";
        int s = Mathf.Max(0, Mathf.CeilToInt(nextEventAt - Time.time));
        return string.Format("{0}:{1:00}", s / 60, s % 60);
    }

    void OnGUI()
    {
        if (client == null) client = FindFirstObjectByType<BridgeClient>();
        if (client == null || !client.reactions) return;          // en el menú de inicio no se muestra
        if (Event.current.type != EventType.Repaint) return;
        if (white == null) white = Texture2D.whiteTexture;
        float W = Screen.width, H = Screen.height, u = H / 960f;
        if (sLabel == null)
        {
            sLabel = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft, wordWrap = false, clipping = TextClipping.Clip };
            sCta = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft, wordWrap = true };
            sSmall = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleRight };
        }
        float y = H * 0.268f, h = 52f * u, gap = 8f * u, pad = 6f * u;
        // ---- meta de taps (izquierda)
        Rect meta = new Rect(W * 0.025f, y, W * 0.44f, h);
        Box(meta, new Color(0f, 0f, 0f, 0.55f));
        Rect bar = new Rect(meta.x + pad, meta.y + h * 0.54f, meta.width - 2 * pad, h * 0.34f);
        Box(bar, new Color(1f, 1f, 1f, 0.18f));
        int prevGoal = level <= 0 ? 0 : GoalFor(level - 1);
        float k = Mathf.Clamp01((shown - prevGoal) / Mathf.Max(1f, goal - prevGoal));
        Color fill = Color.Lerp(new Color(1f, 0.5f, 0.25f), new Color(1f, 0.85f, 0.2f), k);
        if (Time.time < celebrateUntil) fill = Color.Lerp(fill, Color.white, 0.5f + 0.5f * Mathf.Sin(Time.time * 14f));
        Box(new Rect(bar.x, bar.y, bar.width * k, bar.height), fill);
        sLabel.fontSize = Mathf.RoundToInt(13f * u); sLabel.normal.textColor = Color.white;
        GUI.Label(new Rect(meta.x + pad, meta.y + 2f * u, meta.width * 0.72f, h * 0.5f), Time.time < celebrateUntil ? "¡RONDA " + level + " COMPLETADA!" : "RONDA " + (level + 1) + " · " + prizeName[PrizeFor(level)], sLabel);
        sSmall.fontSize = Mathf.RoundToInt(13f * u); sSmall.normal.textColor = new Color(1f, 0.9f, 0.5f);
        GUI.Label(new Rect(meta.x, meta.y + 1f * u, meta.width - pad, h * 0.5f), Mathf.FloorToInt(shown) + " / " + goal, sSmall);
        // ---- cómo participar (derecha): una línea que va rotando cada 6 s
        Rect cr = new Rect(meta.xMax + gap, y, W - meta.xMax - gap - W * 0.025f, h);
        Box(cr, new Color(0f, 0f, 0f, 0.55f));
        float remain = nextEventAt - Time.time;
        bool soon = nextEventAt > 0f && remain <= 30f && !eventRunning;
        int idx = Mathf.FloorToInt(Time.time / 6f) % (cta.Length + 1);          // el último lugar de la rotación es la cuenta regresiva
        float ph = Time.time % 6f;
        float fade = Mathf.Clamp01(Mathf.Min(ph / 0.4f, (6f - ph) / 0.4f));
        sCta.fontSize = Mathf.RoundToInt(12.5f * u); sCta.normal.textColor = new Color(1f, 1f, 1f, (remain <= 30f && nextEventAt > 0f) ? 1f : fade);
        string msg = (soon || idx >= cta.Length) ? (nextEventAt > 0f ? (eventRunning ? "¡EVENTO ESPECIAL EN CURSO!" : "PRÓXIMO EVENTO ESPECIAL EN " + Countdown()) : cta[0]) : cta[idx];
        if (soon) { sCta.normal.textColor = new Color(1f, 0.85f, 0.3f, 0.6f + 0.4f * Mathf.Sin(Time.time * 6f)); }
        GUI.Label(new Rect(cr.x + pad, cr.y, cr.width - 2 * pad, cr.height), msg, sCta);
        GUI.color = Color.white;
    }

    void Box(Rect r, Color c) { GUI.color = c; GUI.DrawTexture(r, white); GUI.color = Color.white; }
}
