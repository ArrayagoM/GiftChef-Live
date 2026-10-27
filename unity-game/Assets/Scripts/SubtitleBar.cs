using UnityEngine;

// Subtítulos de lo que dice el personaje (para quienes miran sin sonido) y gestos mientras habla.
// Se ubica por encima de la zona donde TikTok pone el chat en el celular.
public class SubtitleBar : MonoBehaviour
{
    public BridgeClient client;
    public StartMenu menu;          // de acá sale el cocinero actual (cambia si cambian de personaje)
    public bool show = true;
    [Range(0.1f, 0.4f)] public float bottomMargin = 0.24f;

    string who = "", line = "";
    bool lastPet;
    Color color = Color.white;
    float hideAt;
    GUIStyle sBox, sName, sText;
    Texture2D texBox;

    void Start()
    {
        if (client == null) return;
        client.OnSay += OnSay;
        client.OnSpeaking += OnSpeaking;
    }

    void OnDestroy()
    {
        if (client == null) return;
        client.OnSay -= OnSay;
        client.OnSpeaking -= OnSpeaking;
    }

    ChefAnimator Chef { get { return menu != null ? menu.chef : null; } }

    void OnSay(BridgeClient.Evt e)
    {
        who = e.name ?? ""; line = e.text ?? ""; lastPet = e.kind == "pet";
        float h = Mathf.Abs((who.GetHashCode() % 360) / 360f);
        color = Color.HSVToRGB(h, 0.45f, 1f);
        hideAt = Time.time + 25f;                      // por si no llega el aviso de que terminó
        var c = Chef;
        if (c != null && e.kind != "pet")        // lo que dice la mascota no hace hablar al cocinero
        {
            c.Talk(true);
            if (e.kind == "hello" && !c.IsBusy) c.Greet();
        }
    }

    void OnSpeaking(BridgeClient.Evt e)
    {
        if (e.state == "end")
        {
            hideAt = Time.time + 1.2f;
            var c = Chef; if (c != null && !lastPet) c.Talk(false);
        }
    }

    static Texture2D Round(Color col, int size, int radius)
    {
        var t = new Texture2D(size, size, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave, filterMode = FilterMode.Bilinear };
        for (int y = 0; y < size; y++) for (int x = 0; x < size; x++)
        {
            float dx = Mathf.Max(radius - x - 0.5f, x + 0.5f - (size - radius)), dy = Mathf.Max(radius - y - 0.5f, y + 0.5f - (size - radius));
            float d = (dx > 0 && dy > 0) ? Mathf.Sqrt(dx * dx + dy * dy) : Mathf.Max(dx, dy);
            t.SetPixel(x, y, new Color(col.r, col.g, col.b, col.a * Mathf.Clamp01(radius - d + 0.5f)));
        }
        t.Apply(); return t;
    }

    void OnGUI()
    {
        if (!show || string.IsNullOrEmpty(line) || Time.time > hideAt) return;
        if (menu != null && menu.visible) return;            // no mientras está el menú de inicio
        if (sBox == null)
        {
            texBox = Round(new Color(0.04f, 0.05f, 0.08f, 0.78f), 48, 18);
            sBox = new GUIStyle(GUI.skin.box) { border = new RectOffset(18, 18, 18, 18) }; sBox.normal.background = texBox;
            sName = new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, alignment = TextAnchor.MiddleLeft };
            sText = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.UpperLeft, wordWrap = true }; sText.normal.textColor = Color.white;
        }
        float s = Screen.height / 960f, pad = 14 * s;
        sName.fontSize = Mathf.RoundToInt(17 * s); sText.fontSize = Mathf.RoundToInt(22 * s); sName.normal.textColor = color;
        float w = Screen.width - 40 * s;
        float th = sText.CalcHeight(new GUIContent(line), w - 2 * pad);
        float h = th + 34 * s + 2 * pad * 0.6f;
        float y = Screen.height * (1f - bottomMargin) - h;
        var r = new Rect(20 * s, y, w, h);
        GUI.Box(r, GUIContent.none, sBox);
        GUI.Label(new Rect(r.x + pad, r.y + 8 * s, r.width - 2 * pad, 24 * s), who, sName);
        GUI.Label(new Rect(r.x + pad, r.y + 34 * s, r.width - 2 * pad, th + 6 * s), line, sText);
    }
}
