using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

// Secuencia "cinemática" para las apariciones épicas: suspenso (luz baja, círculo mágico, brasas, temblor),
// rayos y columna de luz, destello + ondas + cámara lenta, y tarjeta de título con barras de cine.
// Todo con formas y texturas generadas por código (sin sonidos).
public class EpicFx : MonoBehaviour
{
    static EpicFx instance;
    public static EpicFx Get()
    {
        if (instance == null) { var g = new GameObject("EpicFx"); instance = g.AddComponent<EpicFx>(); }
        return instance;
    }

    Material baseMat;
    Texture2D texGlow, texRing, texRune, texPillar, texRays;
    FollowCamera cam;
    Light sun; float sunBase = -1f;
    Volume vol; Bloom bloom; Vignette vig; ChromaticAberration ca;
    // estado del overlay (barras, destello, título)
    float flashA, bars, titleStart = -99f, titleDur = 3f; string tMain = "", tSub = "", tTag = ""; Color tCol = Color.white;
    GUIStyle sMain, sSub, sTag;
    int running;

    // ------------------------------------------------------------------ texturas generadas
    static Texture2D Make(int n, Func<float, float, float, float, float> f)
    {
        var t = new Texture2D(n, n, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear };
        var px = new Color32[n * n];
        for (int y = 0; y < n; y++) for (int x = 0; x < n; x++)
        {
            float u = (x + 0.5f) / n * 2f - 1f, v = (y + 0.5f) / n * 2f - 1f;
            float r = Mathf.Sqrt(u * u + v * v), a = Mathf.Atan2(v, u);
            float al = Mathf.Clamp01(f(u, v, r, a));
            byte b = (byte)(al * 255f); px[y * n + x] = new Color32(255, 255, 255, b);
        }
        t.SetPixels32(px); t.Apply(); return t;
    }

    void BuildAssets()
    {
        if (baseMat != null) return;
        var m = Resources.Load<Material>("EpicAdditive");
        if (m == null) { var sh = Shader.Find("TinTech/EpicAdditive"); if (sh == null) sh = Shader.Find("Universal Render Pipeline/Unlit"); m = new Material(sh); }
        baseMat = m;
        texGlow = Make(128, (u, v, r, a) => r >= 1f ? 0f : Mathf.Pow(1f - r, 2.4f));
        texRing = Make(256, (u, v, r, a) => Mathf.Exp(-Mathf.Pow((r - 0.9f) / 0.035f, 2f)) + 0.25f * Mathf.Exp(-Mathf.Pow((r - 0.78f) / 0.25f, 2f)) * (r < 0.9f ? 1f : 0f));
        texRune = Make(512, (u, v, r, a) =>
        {
            float ring1 = Mathf.Exp(-Mathf.Pow((r - 0.96f) / 0.012f, 2f)), ring2 = Mathf.Exp(-Mathf.Pow((r - 0.86f) / 0.010f, 2f)), ring3 = Mathf.Exp(-Mathf.Pow((r - 0.52f) / 0.010f, 2f));
            float ticks = (r > 0.88f && r < 0.95f) ? Mathf.Pow(Mathf.Abs(Mathf.Sin(a * 24f)), 14f) : 0f;
            float star = (r > 0.1f && r < 0.86f) ? Mathf.Exp(-Mathf.Pow((r * Mathf.Cos(a * 3f) - 0.5f * 0.99f) / 0.012f, 2f)) * 0.9f : 0f;
            float star2 = (r > 0.1f && r < 0.86f) ? Mathf.Exp(-Mathf.Pow((r * Mathf.Cos(a * 3f + Mathf.PI) - 0.5f * 0.99f) / 0.012f, 2f)) * 0.9f : 0f;
            float runes = (r > 0.62f && r < 0.84f) ? Mathf.Pow(Mathf.Abs(Mathf.Sin(a * 9f + r * 14f)), 30f) * 0.8f : 0f;
            float fill = 0.12f * Mathf.Pow(1f - Mathf.Clamp01(r), 1.5f);
            return ring1 + ring2 + ring3 + ticks + star + star2 + runes + fill;
        });
        texPillar = Make(128, (u, v, r, a) => Mathf.Pow(1f - Mathf.Abs(u), 2.2f) * Mathf.Clamp01(0.25f + (v + 1f) * 0.5f * 0.9f) * (1f - Mathf.Pow(Mathf.Clamp01((v + 1f) * 0.5f), 6f) * 0f));
        texRays = Make(512, (u, v, r, a) => r >= 1f ? 0f : Mathf.Pow(Mathf.Abs(Mathf.Sin(a * 9f)), 12f) * Mathf.Pow(1f - r, 1.4f) + 0.5f * Mathf.Pow(Mathf.Abs(Mathf.Sin(a * 17f + 1f)), 22f) * Mathf.Pow(1f - r, 1.8f));
    }

    Material Mat(Texture2D tex, Color c)
    {
        var m = new Material(baseMat) { hideFlags = HideFlags.HideAndDontSave };
        if (m.HasProperty("_MainTex")) m.SetTexture("_MainTex", tex); else if (m.HasProperty("_BaseMap")) m.SetTexture("_BaseMap", tex);
        if (m.HasProperty("_Color")) m.SetColor("_Color", c); else if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c);
        return m;
    }

    static void SetAlpha(Material m, Color c, float a) { c.a = a; if (m.HasProperty("_Color")) m.SetColor("_Color", c); else if (m.HasProperty("_BaseColor")) m.SetColor("_BaseColor", c); }

    GameObject Quad(Texture2D tex, Color c, Vector3 pos, Vector3 scale, Quaternion rot)
    {
        var g = GameObject.CreatePrimitive(PrimitiveType.Quad);
        var col = g.GetComponent<Collider>(); if (col != null) Destroy(col);
        var r = g.GetComponent<Renderer>(); r.sharedMaterial = Mat(tex, c); r.shadowCastingMode = ShadowCastingMode.Off; r.receiveShadows = false;
        g.transform.position = pos; g.transform.localScale = scale; g.transform.rotation = rot;
        return g;
    }

    void Kill(GameObject g) { if (g == null) return; var r = g.GetComponent<Renderer>(); if (r != null && r.sharedMaterial != null) Destroy(r.sharedMaterial); Destroy(g); }

    // ------------------------------------------------------------------ luces y posproceso
    void Prepare()
    {
        BuildAssets();
        if (cam == null) cam = FindFirstObjectByType<FollowCamera>();
        if (sun == null)
        {
            foreach (var l in FindObjectsByType<Light>(FindObjectsSortMode.None)) if (l.type == LightType.Directional) { sun = l; break; }
        }
        if (sun != null && sunBase < 0f) sunBase = sun.intensity;
        if (vol == null)
        {
            try
            {
                var go = new GameObject("EpicVolume"); DontDestroyOnLoad(go);
                vol = go.AddComponent<Volume>(); vol.isGlobal = true; vol.priority = 50f; vol.weight = 1f;
                var prof = ScriptableObject.CreateInstance<VolumeProfile>();
                bloom = prof.Add<Bloom>(true); bloom.intensity.Override(0f); bloom.threshold.Override(0.85f); bloom.scatter.Override(0.7f);
                vig = prof.Add<Vignette>(true); vig.intensity.Override(0f); vig.smoothness.Override(0.7f); vig.color.Override(Color.black);
                ca = prof.Add<ChromaticAberration>(true); ca.intensity.Override(0f);
                vol.profile = prof;
                var c = Camera.main; if (c != null) { var d = c.GetUniversalAdditionalCameraData(); if (d != null) d.renderPostProcessing = true; }
            }
            catch (Exception e) { Debug.LogWarning("[EpicFx] sin posproceso: " + e.Message); vol = null; }
        }
    }

    void Post(float dim, float glow, float aberr)
    {
        if (sun != null && sunBase >= 0f) sun.intensity = Mathf.Lerp(sunBase, sunBase * 0.3f, dim);
        if (bloom != null) bloom.intensity.value = glow * 2.2f;
        if (vig != null) vig.intensity.value = dim * 0.5f;
        if (ca != null) ca.intensity.value = aberr;
    }

    void OnDestroy() { Restore(); }

    void Restore()
    {
        if (sun != null && sunBase >= 0f) sun.intensity = sunBase;
        if (bloom != null) bloom.intensity.value = 0f;
        if (vig != null) vig.intensity.value = 0f;
        if (ca != null) ca.intensity.value = 0f;
        if (cam != null) cam.shake = 0f;
        Time.timeScale = 1f;
    }

    // ------------------------------------------------------------------ secuencia
    // tier: 1 = raro (corto), 2 = épico, 3 = legendario (completo)
    public IEnumerator Sequence(string title, string tag, string sub, Color col, Vector3 floor, float height, float hover, int tier, Action onClimax)
    {
        Prepare();
        running++;
        var cam3 = Camera.main != null ? Camera.main.transform : null;
        float R = Mathf.Clamp(0.55f + height * 0.55f, 0.9f, 2.0f);
        float antic = tier >= 3 ? 2.1f : (tier == 2 ? 1.5f : 0.8f);
        float total = antic + (tier >= 3 ? 3.4f : (tier == 2 ? 2.6f : 1.6f));
        Color hot = Color.Lerp(col, Color.white, 0.55f);
        var created = new List<GameObject>();
        // círculo mágico en el piso, pilar y rayos
        var circle = Quad(texRune, col, floor + Vector3.up * 0.03f, Vector3.one * 0.2f, Quaternion.Euler(90f, 0f, 0f)); created.Add(circle);
        var ringA = Quad(texRing, hot, floor + Vector3.up * 0.04f, Vector3.one * 0.1f, Quaternion.Euler(90f, 0f, 0f)); created.Add(ringA);
        var ringB = Quad(texRing, col, floor + Vector3.up * 0.04f, Vector3.one * 0.1f, Quaternion.Euler(90f, 0f, 0f)); created.Add(ringB);
        float pillarH = 9f;
        var pillar = Quad(texPillar, hot, floor + Vector3.up * pillarH * 0.5f, new Vector3(0.01f, pillarH, 1f), Quaternion.identity); created.Add(pillar);
        var pillar2 = Quad(texPillar, col, floor + Vector3.up * pillarH * 0.5f, new Vector3(0.01f, pillarH, 1f), Quaternion.identity); created.Add(pillar2);
        var rays = Quad(texRays, hot, floor + Vector3.up * (hover + height * 0.5f), Vector3.one * 0.1f, Quaternion.identity); created.Add(rays);
        var halo = Quad(texGlow, col, floor + Vector3.up * (hover + height * 0.5f), Vector3.one * 0.1f, Quaternion.identity); created.Add(halo);
        var ground = new GameObject("EpicGlow"); ground.transform.position = floor + Vector3.up * 0.5f;
        var gl = ground.AddComponent<Light>(); gl.type = LightType.Point; gl.color = col; gl.range = 7f; gl.intensity = 0f; gl.shadows = LightShadows.None;
        var embers = MakeEmbers(floor, R, col, tier);
        float t = 0f; bool climax = false; float slowUntil = -1f; float nextBolt = antic * 0.55f; float shake = 0f;
        titleStart = -99f;
        try
        {
            while (t < total)
            {
                float dt = Time.unscaledDeltaTime; t += dt;
                // --- suspenso
                float a = Mathf.Clamp01(t / antic);
                float dim = t < antic ? Mathf.SmoothStep(0f, 1f, Mathf.Min(1f, t / (antic * 0.5f))) : Mathf.Clamp01(1f - (t - antic - 0.6f) / 1.2f);
                float after = Mathf.Max(0f, t - antic);
                bars = tier >= 2 ? Mathf.MoveTowards(bars, (t < total - 0.5f) ? 1f : 0f, dt * 2.2f) : 0f;
                float cs = Mathf.SmoothStep(0f, 1f, Mathf.Min(1f, t / (antic * 0.7f)));
                float circleA = (t < antic + 1.0f) ? cs : Mathf.Clamp01(1f - (t - antic - 1.0f) / 1.2f);
                float spin = t * (tier >= 3 ? 70f : 50f);
                circle.transform.localScale = Vector3.one * (R * 2.2f * Mathf.Lerp(0.3f, 1f, cs));
                circle.transform.rotation = Quaternion.Euler(90f, spin, 0f);
                SetAlpha(circle.GetComponent<Renderer>().sharedMaterial, col, circleA * (0.75f + 0.25f * Mathf.Sin(t * 9f)));
                // --- rayos eléctricos durante la espera
                if (tier >= 2 && t > nextBolt && t < antic + 0.2f)
                {
                    nextBolt = t + UnityEngine.Random.Range(0.12f, 0.35f);
                    StartCoroutine(Bolt(floor + new Vector3(UnityEngine.Random.Range(-1f, 1f), 0f, UnityEngine.Random.Range(-1f, 1f)).normalized * R * UnityEngine.Random.Range(0.4f, 1.1f), hot, tier));
                    shake = Mathf.Max(shake, 0.02f + 0.03f * a);
                }
                // --- clímax
                if (!climax && t >= antic)
                {
                    climax = true; flashA = 1f; shake = tier >= 3 ? 0.16f : 0.1f;
                    if (tier >= 2) slowUntil = Time.unscaledTime + (tier >= 3 ? 0.75f : 0.5f);
                    StartCoroutine(Ring(floor, hot, R * 3.2f, 0.9f)); StartCoroutine(Ring(floor, col, R * 4.6f, 1.3f));
                    if (tier >= 3) StartCoroutine(Ring(floor, Color.white, R * 6.5f, 1.6f));
                    Burst(floor + Vector3.up * (hover + height * 0.45f), col, tier);
                    StartCoroutine(StrikeBolts(floor, R, hot, tier));
                    titleStart = Time.unscaledTime; titleDur = total - antic + 0.4f; tMain = title; tSub = sub; tTag = tag; tCol = Color.Lerp(col, Color.white, 0.3f);
                    onClimax?.Invoke();
                }
                // --- pilar de luz
                float pk = climax ? Mathf.Clamp01(1f - (after - 0.5f) / 1.4f) : Mathf.Clamp01((a - 0.75f) / 0.25f) * 0.35f;
                float pw = (climax ? 1.4f + 0.2f * Mathf.Sin(t * 30f) : 0.5f) * (0.5f + R * 0.55f) * Mathf.Min(1f, 0.15f + after * 6f + (climax ? 0f : 1f));
                pillar.transform.localScale = new Vector3(Mathf.Max(0.01f, pw), pillarH, 1f); pillar2.transform.localScale = new Vector3(Mathf.Max(0.01f, pw * 0.55f), pillarH, 1f);
                SetAlpha(pillar.GetComponent<Renderer>().sharedMaterial, hot, pk * 0.9f); SetAlpha(pillar2.GetComponent<Renderer>().sharedMaterial, Color.white, pk);
                if (cam3 != null) { pillar.transform.rotation = Quaternion.Euler(0f, cam3.eulerAngles.y, 0f); pillar2.transform.rotation = pillar.transform.rotation; }
                // --- rayos radiales y halo detrás del Pokémon (miran a la cámara)
                float rk = climax ? Mathf.Clamp01(after / 0.25f) * Mathf.Clamp01(1f - (after - 0.4f) / 2.4f) : 0f;
                float rs = (3.2f + height * 2.2f) * (0.6f + Mathf.Clamp01(after / 0.5f) * 0.6f);
                rays.transform.localScale = Vector3.one * rs; halo.transform.localScale = Vector3.one * rs * 0.85f;
                if (cam3 != null) { rays.transform.rotation = cam3.rotation * Quaternion.Euler(0f, 0f, t * 25f); halo.transform.rotation = cam3.rotation; }
                SetAlpha(rays.GetComponent<Renderer>().sharedMaterial, hot, rk * 0.85f); SetAlpha(halo.GetComponent<Renderer>().sharedMaterial, col, rk * 0.7f + (climax ? 0f : 0f));
                gl.intensity = (climax ? (tier >= 3 ? 14f : 9f) * Mathf.Clamp01(1f - after / 2.4f) : 5f * a * a) + 0f;
                // --- cámara lenta, temblor, posproceso
                Time.timeScale = Time.unscaledTime < slowUntil ? 0.3f : 1f;
                shake = Mathf.MoveTowards(shake, 0f, dt * 0.12f);
                if (cam != null) cam.shake = shake + (t < antic ? 0.012f * a : 0f);
                flashA = Mathf.MoveTowards(flashA, 0f, dt * 1.4f);
                Post(dim, climax ? Mathf.Clamp01(1f - after / 2.4f) * 0.8f + 0.2f : a * 0.5f, climax ? Mathf.Clamp01(1f - after / 0.9f) * 0.7f : 0f);
                yield return null;
            }
        }
        finally
        {
            foreach (var g in created) Kill(g);
            if (ground != null) Destroy(ground);
            if (embers != null) Destroy(embers.gameObject);
            running--;
            if (running <= 0) { running = 0; bars = 0f; flashA = 0f; Restore(); }
        }
    }

    // ------------------------------------------------------------------ piezas
    ParticleSystem MakeEmbers(Vector3 floor, float R, Color col, int tier)
    {
        var go = new GameObject("EpicEmbers"); go.transform.position = floor + Vector3.up * 0.05f;
        var ps = go.AddComponent<ParticleSystem>();
        var r = go.GetComponent<ParticleSystemRenderer>(); r.sharedMaterial = Mat(texGlow, Color.white); r.renderMode = ParticleSystemRenderMode.Billboard;
        var main = ps.main; main.loop = true; main.startLifetime = new ParticleSystem.MinMaxCurve(1.6f, 3.2f); main.startSpeed = new ParticleSystem.MinMaxCurve(0.2f, 0.7f);
        main.startSize = new ParticleSystem.MinMaxCurve(0.07f, 0.2f); main.maxParticles = 260; main.gravityModifier = -0.08f; main.simulationSpace = ParticleSystemSimulationSpace.World;
        main.startColor = new ParticleSystem.MinMaxGradient(Color.Lerp(col, Color.white, 0.2f), Color.Lerp(col, Color.white, 0.8f));
        var em = ps.emission; em.rateOverTime = tier >= 3 ? 90f : 55f;
        var sh = ps.shape; sh.shapeType = ParticleSystemShapeType.Circle; sh.radius = R * 0.9f; sh.radiusThickness = 0.5f; sh.rotation = new Vector3(-90f, 0f, 0f);
        var col2 = ps.colorOverLifetime; col2.enabled = true;
        var g = new Gradient(); g.SetKeys(new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) }, new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(1f, 0.2f), new GradientAlphaKey(0f, 1f) });
        col2.color = g;
        return ps;
    }

    void Burst(Vector3 pos, Color col, int tier)
    {
        var go = new GameObject("EpicBurst"); go.transform.position = pos;
        var ps = go.AddComponent<ParticleSystem>(); ps.Stop();
        var r = go.GetComponent<ParticleSystemRenderer>(); r.sharedMaterial = Mat(texGlow, Color.white);
        var main = ps.main; main.loop = false; main.duration = 0.5f; main.startLifetime = new ParticleSystem.MinMaxCurve(0.9f, 1.8f); main.startSpeed = new ParticleSystem.MinMaxCurve(2.5f, tier >= 3 ? 9f : 6f);
        main.startSize = new ParticleSystem.MinMaxCurve(0.08f, 0.26f); main.gravityModifier = 0.35f; main.simulationSpace = ParticleSystemSimulationSpace.World; main.maxParticles = 400;
        main.startColor = new ParticleSystem.MinMaxGradient(col, Color.white);
        var em = ps.emission; em.rateOverTime = 0f; em.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)(tier >= 3 ? 260 : 150)) });
        var sh = ps.shape; sh.shapeType = ParticleSystemShapeType.Sphere; sh.radius = 0.25f;
        var col2 = ps.colorOverLifetime; col2.enabled = true;
        var g = new Gradient(); g.SetKeys(new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) }, new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(0f, 1f) });
        col2.color = g;
        var sz = ps.sizeOverLifetime; sz.enabled = true; sz.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 1f, 1f, 0.1f));
        ps.Play(); Destroy(go, 3.5f);
    }

    IEnumerator Ring(Vector3 floor, Color c, float radius, float dur)
    {
        var g = Quad(texRing, c, floor + Vector3.up * 0.05f, Vector3.one * 0.1f, Quaternion.Euler(90f, 0f, 0f));
        float t = 0f;
        while (t < dur && g != null)
        {
            t += Time.unscaledDeltaTime; float k = t / dur; float e = 1f - Mathf.Pow(1f - k, 3f);
            g.transform.localScale = Vector3.one * Mathf.Max(0.05f, radius * 2f * e);
            SetAlpha(g.GetComponent<Renderer>().sharedMaterial, c, (1f - k) * 0.95f);
            yield return null;
        }
        Kill(g);
    }

    IEnumerator StrikeBolts(Vector3 floor, float R, Color c, int tier)
    {
        int n = tier >= 3 ? 6 : 3;
        for (int i = 0; i < n; i++)
        {
            float a = UnityEngine.Random.value * Mathf.PI * 2f;
            StartCoroutine(Bolt(floor + new Vector3(Mathf.Cos(a), 0f, Mathf.Sin(a)) * R * UnityEngine.Random.Range(0.5f, 1.2f), c, tier));
            yield return new WaitForSecondsRealtime(UnityEngine.Random.Range(0.04f, 0.12f));
        }
    }

    IEnumerator Bolt(Vector3 ground, Color c, int tier)
    {
        var go = new GameObject("EpicBolt");
        var lr = go.AddComponent<LineRenderer>(); lr.sharedMaterial = Mat(texGlow, Color.Lerp(c, Color.white, 0.5f)); lr.numCapVertices = 2; lr.shadowCastingMode = ShadowCastingMode.Off;
        lr.textureMode = LineTextureMode.Stretch; lr.useWorldSpace = true; lr.alignment = LineAlignment.View;
        float life = 0.16f, t = 0f; int seg = 14;
        Vector3 top = ground + new Vector3(UnityEngine.Random.Range(-1.2f, 1.2f), 7.5f, UnityEngine.Random.Range(-1.2f, 1.2f));
        while (t < life && go != null)
        {
            t += Time.unscaledDeltaTime;
            lr.positionCount = seg + 1;
            for (int i = 0; i <= seg; i++)
            {
                float k = i / (float)seg; Vector3 p = Vector3.Lerp(top, ground, k);
                if (i > 0 && i < seg) p += new Vector3(UnityEngine.Random.Range(-0.35f, 0.35f), 0f, UnityEngine.Random.Range(-0.35f, 0.35f));
                lr.SetPosition(i, p);
            }
            float w = (0.12f + 0.06f * UnityEngine.Random.value) * (1f - t / life * 0.6f);
            lr.startWidth = w * 0.4f; lr.endWidth = w; lr.widthMultiplier = 1f;
            yield return null;
        }
        if (lr != null && lr.sharedMaterial != null) Destroy(lr.sharedMaterial);
        Destroy(go);
    }

    /// Tarjeta de título + destello para eventos especiales (sin la secuencia completa del Pokémon).
    public void Announce(string tag, string main, string sub, Color col, float dur)
    {
        titleStart = Time.unscaledTime; titleDur = dur; tTag = tag; tMain = main; tSub = sub; tCol = Color.Lerp(col, Color.white, 0.3f); flashA = Mathf.Max(flashA, 0.55f);
    }

    // ------------------------------------------------------------------ pantalla: barras de cine, destello y título
    void OnGUI()
    {
        if (Event.current.type != EventType.Repaint) return;
        float W = Screen.width, H = Screen.height, u = H / 960f;
        var white = Texture2D.whiteTexture;
        if (bars > 0.001f) { GUI.color = new Color(0f, 0f, 0f, 0.96f); float bh = H * 0.085f * bars; GUI.DrawTexture(new Rect(0, 0, W, bh), white); GUI.DrawTexture(new Rect(0, H - bh, W, bh), white); }
        if (flashA > 0.001f) { GUI.color = new Color(1f, 1f, 1f, Mathf.Clamp01(flashA) * 0.9f); GUI.DrawTexture(new Rect(0, 0, W, H), white); }
        GUI.color = Color.white;
        float ts = Time.unscaledTime - titleStart;
        if (ts >= 0f && ts < titleDur)
        {
            if (sMain == null)
            {
                sMain = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
                sSub = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
                sTag = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
            }
            float fadeIn = Mathf.Clamp01(ts / 0.25f), fadeOut = Mathf.Clamp01((titleDur - ts) / 0.5f), al = Mathf.Min(fadeIn, fadeOut);
            float pop = 1f + Mathf.Max(0f, 1f - ts / 0.4f) * 0.7f;
            float cy = H * 0.575f;
            // etiqueta
            sTag.fontSize = Mathf.RoundToInt(22f * u); sTag.normal.textColor = new Color(tCol.r, tCol.g, tCol.b, al);
            GUI.Label(new Rect(0, cy - 70f * u, W, 34f * u), tTag, sTag);
            // nombre: sombra de color (brillo) + texto blanco, con rebote al entrar
            sMain.fontSize = Mathf.RoundToInt(Mathf.Min(78f * u, W / Mathf.Max(5f, tMain.Length * 0.62f)));
            Matrix4x4 m0 = GUI.matrix; GUIUtility.ScaleAroundPivot(new Vector2(pop, pop), new Vector2(W * 0.5f, cy));
            Rect rr = new Rect(0, cy - 44f * u, W, 88f * u);
            for (int i = 0; i < 8; i++)
            {
                float an = i / 8f * Mathf.PI * 2f; var rg = rr; rg.x += Mathf.Cos(an) * 4f * u; rg.y += Mathf.Sin(an) * 4f * u;
                sMain.normal.textColor = new Color(tCol.r, tCol.g, tCol.b, 0.55f * al); GUI.Label(rg, tMain, sMain);
            }
            sMain.normal.textColor = new Color(1f, 1f, 1f, al); GUI.Label(rr, tMain, sMain);
            GUI.matrix = m0;
            sSub.fontSize = Mathf.RoundToInt(20f * u); sSub.normal.textColor = new Color(1f, 1f, 1f, al * 0.95f);
            GUI.Label(new Rect(0, cy + 48f * u, W, 30f * u), tSub, sSub);
        }
        GUI.color = Color.white;
    }
}
