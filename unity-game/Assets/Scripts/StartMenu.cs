using System;
using System.Text.RegularExpressions;
using UnityEngine;

// Pantalla de inicio: pide el usuario de TikTok al que se conecta el juego y deja elegir el cocinero.
// La cocina queda en pausa (sin pedidos ni reacciones) hasta tocar COMENZAR.
public class StartMenu : MonoBehaviour
{
    [Serializable]
    public class CharacterOption
    {
        public string name = "Encapuchado Verde";
        public string description = "Silencioso y rápido";
        public GameObject prefab;           // modelo (humanoide, rig Medium de KayKit)
        public string id = "";             // id en config/characters.json (define la voz y el estilo)
        public bool enabled = true;         // falso hasta que el modelo 3D esté cargado
        public float heightFactor = 1f;     // 1 = misma altura que el cocinero base; Piccolo > 1, etc.
        public float yawOffset = 0f;        // por si el modelo viene mirando para otro lado
    }

    // Altura (en el mundo) de todos los renderers de un objeto
    static float WorldHeight(GameObject g)
    {
        bool first = true; Bounds b = new Bounds(g.transform.position, Vector3.zero);
        foreach (var r in g.GetComponentsInChildren<Renderer>()) { if (first) { b = r.bounds; first = false; } else b.Encapsulate(r.bounds); }
        return first ? 0f : b.size.y;
    }

    public BridgeClient client;
    public KitchenController kitchen;
    public FollowCamera cam;
    public ChefAnimator chef;                         // el cocinero que está en la escena (opción 0 por defecto)
    public RuntimeAnimatorController chefController;
    public CharacterOption[] options;
    public int selected;

    public bool visible = true;
    string userInput = "";
    string pendingUser;                               // usuario a enviar apenas el bridge esté conectado
    string error = "";
    float t, fade = 1f;
    bool starting;
    int appliedIndex = 0;
    float baseHeight;

    GUIStyle sTitle, sSub, sLabel, sField, sBtn, sBtnBig, sArrow, sName, sDesc, sPanel, sStatus;
    Texture2D texPanel, texBtn, texBtnHover, texField, texAccent;
    bool stylesReady;

    void Start()
    {
        if (kitchen != null) { kitchen.paused = true; if (kitchen.board != null) kitchen.board.SetVisible(false); }
        if (client != null) client.reactions = false;
        userInput = PlayerPrefs.GetString("tiktokUser", "");
        if (client != null) client.OnCharacter += OnBridgeCharacter;
        if (cam != null) cam.Shot(MenuCam(), new Vector3(0f, 1.15f, -0.3f), 46f);
        foreach (var a in Environment.GetCommandLineArgs()) if (a == "-autostart") autoStartAt = 6f;   // el vigilante abre el juego así: empieza solo con el último usuario y cocinero
        restoreId = PlayerPrefs.GetString("chefId", "");
    }

    float autoStartAt = -1f; string restoreId = "";

    Vector3 MenuCam() { return new Vector3(Mathf.Sin(t * 0.35f) * 0.5f, 2.0f, 3.9f); }

    void Update()
    {
        t += Time.deltaTime;
        if (!string.IsNullOrEmpty(restoreId) && t > 0.5f) { var rid = restoreId; restoreId = ""; SelectById(rid); }
        if (autoStartAt > 0f && t >= autoStartAt && visible && !starting) { autoStartAt = -1f; Begin(); }
        if (visible && cam != null) cam.Shot(MenuCam(), new Vector3(0f, 1.15f, -0.3f), 46f);
        if (client != null && string.IsNullOrEmpty(userInput) && !string.IsNullOrEmpty(client.currentUser) && !starting) userInput = client.currentUser;
        // Manda el usuario cuando el bridge ya está conectado
        if (pendingUser != null && client != null && client.connected) { client.SetUser(pendingUser); pendingUser = null; }
        if (starting)
        {
            fade -= Time.deltaTime * 2.5f;
            if (fade <= 0f) { visible = false; starting = false; fade = 0f; }
        }
    }

    static string Normalize(string s) { return (s ?? "").Trim().TrimStart('@'); }
    static bool Valid(string s) { return Regex.IsMatch(s, @"^[A-Za-z0-9._]{2,40}$"); }

    public void Begin()
    {
        string user = Normalize(userInput);
        if (!string.IsNullOrEmpty(user) && !Valid(user)) { error = "Usuario inválido: solo letras, números, punto y guion bajo."; return; }
        if (string.IsNullOrEmpty(user)) { error = "Escribí el @usuario del live al que querés conectarte."; return; }
        error = "";
        PlayerPrefs.SetString("tiktokUser", user);
        if (options != null && options.Length > 0) PlayerPrefs.SetString("chefId", options[Mathf.Clamp(selected, 0, options.Length - 1)].id);
        PlayerPrefs.Save();
        if (client != null && !string.Equals(client.currentUser, user, StringComparison.OrdinalIgnoreCase)) pendingUser = user;
        ApplyCharacter();
        if (client != null && options != null && options.Length > 0) client.SendSetCharacter(options[Mathf.Clamp(selected, 0, options.Length - 1)].id);
        if (kitchen != null) { kitchen.paused = false; if (kitchen.board != null) kitchen.board.SetVisible(true); }
        if (client != null) client.reactions = true;
        if (cam != null) cam.Release();
        starting = true;
    }

    // Cambia el modelo del cocinero si eligieron otro (la opción 0 ya es el que está en la escena)
    void ApplyCharacter()
    {
        if (options == null || options.Length == 0 || selected == appliedIndex) return;
        var opt = options[Mathf.Clamp(selected, 0, options.Length - 1)];
        if (opt.prefab == null) return;
        var old = chef.gameObject;
        Vector3 pos = old.transform.position; Quaternion rot = old.transform.rotation; float walk = chef.walkSpeed;
        var home = chef.homePosition;
        if (baseHeight <= 0f) baseHeight = WorldHeight(old) / Mathf.Max(0.01f, options[0].heightFactor);   // el de la opción 0 es la referencia
        float targetH = baseHeight;
        var go = Instantiate(opt.prefab, pos, rot * Quaternion.Euler(0f, opt.yawOffset, 0f));
        go.name = "Cocinero";
        // Algunos modelos traen objetos auxiliares (esferas de aura, etc.) que no son parte del cuerpo
        foreach (var r in go.GetComponentsInChildren<Renderer>(true)) if (r.gameObject.name.StartsWith("Icosphere")) DestroyImmediate(r.gameObject);
        go.transform.localScale = opt.prefab.transform.localScale;     // cada modelo parte de su propia escala (si hereda la del anterior, p. ej. Goku en cm, queda microscópico)
        // Normaliza la altura: cada modelo viene en una escala distinta
        float h = WorldHeight(go);
        if (h > 0.0001f && targetH > 0.01f) go.transform.localScale *= (targetH * opt.heightFactor) / h;
        var an = go.GetComponent<Animator>(); if (an == null) an = go.AddComponent<Animator>();
        an.runtimeAnimatorController = chefController; an.applyRootMotion = false;
        var nc = go.AddComponent<ChefAnimator>(); nc.homePosition = home; nc.walkSpeed = walk;
        Destroy(old);
        chef = nc; appliedIndex = selected;
        if (!string.IsNullOrEmpty(opt.id)) { PlayerPrefs.SetString("chefId", opt.id); PlayerPrefs.Save(); }   // se recuerda para el arranque automático
        if (kitchen != null) kitchen.SetChef(nc);
        if (cam != null) cam.chef = nc;
        if (client != null) client.chef = nc;
    }

    bool Usable(int i) { return options != null && i >= 0 && i < options.Length && options[i].enabled && options[i].prefab != null; }
    System.Collections.Generic.List<int> UsableIndices() { var l = new System.Collections.Generic.List<int>(); for (int i = 0; options != null && i < options.Length; i++) if (Usable(i)) l.Add(i); return l; }

    void Step(int dir)
    {
        if (UsableIndices().Count < 2) return;
        int i = selected;
        for (int k = 0; k < options.Length; k++) { i = (i + dir + options.Length) % options.Length; if (Usable(i)) break; }
        selected = i; PreviewChar();
    }

    void Prev() { Step(-1); }
    void Next() { Step(1); }
    // Se ve el personaje elegido en el centro mientras se decide, y el presentador pasa a hablar con su voz
    void PreviewChar() { ApplyCharacter(); if (client != null && options[selected].id != null) client.SendSetCharacter(options[selected].id); }

    /// Lo llama el panel de control (página aparte) a través del bridge.
    public void SelectById(string id)
    {
        if (options == null || string.IsNullOrEmpty(id)) return;
        for (int i = 0; i < options.Length; i++) if (options[i].id == id && Usable(i)) { if (selected != i) { selected = i; ApplyCharacter(); } return; }
    }

    void OnBridgeCharacter(BridgeClient.Evt e)
    {
        // El nombre puede haberse cambiado desde el panel
        if (options != null && !string.IsNullOrEmpty(e.name))
            for (int i = 0; i < options.Length; i++) if (options[i].id == e.character) options[i].name = e.name;
        SelectById(e.character);
    }
    void OnDestroy() { if (client != null) client.OnCharacter -= OnBridgeCharacter; }

    // ------------------------------------------------------------------ dibujo
    Texture2D Round(Color c, int size, int radius)
    {
        var t2 = new Texture2D(size, size, TextureFormat.RGBA32, false); t2.hideFlags = HideFlags.HideAndDontSave; t2.filterMode = FilterMode.Bilinear;
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++)
        {
            float dx = Mathf.Max(radius - x - 0.5f, x + 0.5f - (size - radius)), dy = Mathf.Max(radius - y - 0.5f, y + 0.5f - (size - radius));
            float d = (dx > 0 && dy > 0) ? Mathf.Sqrt(dx * dx + dy * dy) : Mathf.Max(dx, dy);
            float a = Mathf.Clamp01(radius - d + 0.5f);
            t2.SetPixel(x, y, new Color(c.r, c.g, c.b, c.a * a));
        }
        t2.Apply(); return t2;
    }

    void BuildStyles()
    {
        texPanel = Round(new Color(0.05f, 0.06f, 0.09f, 0.82f), 64, 22);
        texBtn = Round(new Color(0.92f, 0.22f, 0.18f, 1f), 48, 18);
        texBtnHover = Round(new Color(1f, 0.35f, 0.28f, 1f), 48, 18);
        texField = Round(new Color(0.12f, 0.14f, 0.2f, 1f), 64, 16);
        texAccent = Round(new Color(1f, 0.85f, 0.2f, 1f), 16, 8);
        sPanel = new GUIStyle(GUI.skin.box) { border = new RectOffset(22, 22, 22, 22) }; sPanel.normal.background = texPanel;
        sTitle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold }; sTitle.normal.textColor = new Color(1f, 0.85f, 0.2f);
        sSub = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter }; sSub.normal.textColor = new Color(0.85f, 0.88f, 0.95f);
        sLabel = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleLeft, fontStyle = FontStyle.Bold }; sLabel.normal.textColor = new Color(0.8f, 0.85f, 1f);
        sField = new GUIStyle(GUI.skin.textField) { alignment = TextAnchor.MiddleLeft, border = new RectOffset(16, 16, 16, 16), padding = new RectOffset(16, 16, 4, 4) };
        foreach (var st in new[] { sField.normal, sField.hover, sField.focused, sField.active }) { st.background = texField; st.textColor = Color.white; }
        sBtn = new GUIStyle(GUI.skin.button) { border = new RectOffset(18, 18, 18, 18), fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleCenter };
        sBtn.normal.background = texBtn; sBtn.hover.background = texBtnHover; sBtn.active.background = texBtnHover; sBtn.focused.background = texBtn;
        foreach (var st in new[] { sBtn.normal, sBtn.hover, sBtn.active, sBtn.focused }) st.textColor = Color.white;
        sBtnBig = new GUIStyle(sBtn);
        sArrow = new GUIStyle(sBtn) { fontStyle = FontStyle.Bold };
        sName = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontStyle = FontStyle.Bold }; sName.normal.textColor = Color.white;
        sDesc = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter }; sDesc.normal.textColor = new Color(0.7f, 0.75f, 0.85f);
        sStatus = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter };
        stylesReady = true;
    }

    void OnGUI()
    {
        if (!visible) return;
        if (!stylesReady) BuildStyles();
        float H = Screen.height, W = Screen.width, s = H / 960f;
        var prev = GUI.color; GUI.color = new Color(1f, 1f, 1f, Mathf.Clamp01(fade));
        var e = Event.current;
        if (e.type == EventType.KeyDown && (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter) && !starting) { Begin(); e.Use(); }
        if (e.type == EventType.KeyDown && !starting) { if (e.keyCode == KeyCode.LeftArrow && GUIUtility.keyboardControl == 0) { Prev(); e.Use(); } if (e.keyCode == KeyCode.RightArrow && GUIUtility.keyboardControl == 0) { Next(); e.Use(); } }

        sTitle.fontSize = Mathf.RoundToInt(44 * s); sSub.fontSize = Mathf.RoundToInt(17 * s); sLabel.fontSize = Mathf.RoundToInt(17 * s);
        sField.fontSize = Mathf.RoundToInt(24 * s); sBtn.fontSize = Mathf.RoundToInt(26 * s); sArrow.fontSize = Mathf.RoundToInt(30 * s);
        sName.fontSize = Mathf.RoundToInt(26 * s); sDesc.fontSize = Mathf.RoundToInt(16 * s); sStatus.fontSize = Mathf.RoundToInt(15 * s);

        // Panel de arriba: título y usuario
        float pw = W - 40 * s, px = 20 * s;
        var top = new Rect(px, 20 * s, pw, 250 * s);
        GUI.Box(top, GUIContent.none, sPanel);
        GUI.Label(new Rect(top.x, top.y + 12 * s, top.width, 60 * s), "COCINA TINTECH", sTitle);
        GUI.Label(new Rect(top.x, top.y + 68 * s, top.width, 26 * s), "¿A qué live te querés conectar?", sSub);
        GUI.Label(new Rect(top.x + 24 * s, top.y + 108 * s, 60 * s, 46 * s), "@", new GUIStyle(sTitle) { fontSize = Mathf.RoundToInt(34 * s), alignment = TextAnchor.MiddleCenter });
        GUI.SetNextControlName("user");
        userInput = GUI.TextField(new Rect(top.x + 70 * s, top.y + 108 * s, top.width - 94 * s, 48 * s), userInput, 40, sField);
        if (!string.IsNullOrEmpty(error)) { sStatus.normal.textColor = new Color(1f, 0.45f, 0.4f); GUI.Label(new Rect(top.x + 12 * s, top.y + 164 * s, top.width - 24 * s, 24 * s), error, sStatus); }
        else
        {
            string st; Color col;
            if (client == null || !client.connected) { st = "Iniciando la conexión…"; col = new Color(1f, 0.75f, 0.3f); }
            else if (client.bridgeStatus == "tiktok_connected") { st = "Conectado a @" + client.currentUser + "  ·  EN VIVO"; col = new Color(0.4f, 1f, 0.55f); }
            else { st = "Bridge listo. Último usuario: @" + (string.IsNullOrEmpty(client.currentUser) ? "?" : client.currentUser); col = new Color(0.8f, 0.85f, 1f); }
            sStatus.normal.textColor = col; GUI.Label(new Rect(top.x + 12 * s, top.y + 164 * s, top.width - 24 * s, 24 * s), st, sStatus);
        }
        GUI.Label(new Rect(top.x + 12 * s, top.y + 196 * s, top.width - 24 * s, 40 * s), "Si el live todavía no empezó, el juego espera y se engancha solo.", new GUIStyle(sDesc) { fontSize = Mathf.RoundToInt(13 * s) });

        // Panel de abajo: personaje y comenzar
        var bot = new Rect(px, H - 330 * s, pw, 310 * s);
        GUI.Box(bot, GUIContent.none, sPanel);
        GUI.Label(new Rect(bot.x, bot.y + 12 * s, bot.width, 26 * s), "ELEGÍ TU COCINERO", new GUIStyle(sSub) { fontStyle = FontStyle.Bold, fontSize = Mathf.RoundToInt(17 * s) });
        var opt = (options != null && options.Length > 0) ? options[Mathf.Clamp(selected, 0, options.Length - 1)] : null;
        var usable = UsableIndices();
        bool many = usable.Count > 1;
        GUI.enabled = many;
        float ab = Mathf.Max(64 * s, 44f);
        if (GUI.Button(new Rect(bot.x + 24 * s, bot.y + 56 * s, ab, ab), "‹", sArrow)) Prev();
        if (GUI.Button(new Rect(bot.xMax - 24 * s - ab, bot.y + 56 * s, ab, ab), "›", sArrow)) Next();
        GUI.enabled = true;
        GUI.Label(new Rect(bot.x + 100 * s, bot.y + 52 * s, bot.width - 200 * s, 40 * s), opt != null ? opt.name : "—", sName);
        GUI.Label(new Rect(bot.x + 100 * s, bot.y + 90 * s, bot.width - 200 * s, 28 * s), opt != null ? opt.description : "", sDesc);
        // puntitos de selección
        int n = usable.Count; float dot = 12 * s, gap = 10 * s, total = n * dot + (n - 1) * gap, dx = bot.center.x - total / 2f;
        for (int i = 0; i < n; i++) GUI.DrawTexture(new Rect(dx + i * (dot + gap), bot.y + 132 * s, dot, dot), texAccent, ScaleMode.StretchToFill, true, 0, usable[i] == selected ? new Color(1f, 0.85f, 0.2f, 1f) : new Color(0.4f, 0.4f, 0.5f, 1f), 0, 0);
        GUI.Label(new Rect(bot.x, bot.y + 150 * s, bot.width, 24 * s), "Más personajes muy pronto", new GUIStyle(sDesc) { fontSize = Mathf.RoundToInt(13 * s) });
        if (GUI.Button(new Rect(bot.x + 24 * s, bot.y + 190 * s, bot.width - 48 * s, Mathf.Max(84 * s, 40f)), "COMENZAR", sBtn) && !starting) Begin();
        GUI.Label(new Rect(bot.x, bot.yMax - 28 * s, bot.width, 22 * s), "Enter para comenzar  ·  F2 abre la conexión durante el juego", new GUIStyle(sDesc) { fontSize = Mathf.RoundToInt(12 * s) });
        GUI.color = prev;
    }
}
