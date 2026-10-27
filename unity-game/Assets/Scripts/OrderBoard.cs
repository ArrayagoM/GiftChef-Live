using System.Collections.Generic;
using System.Text;
using UnityEngine;

// Pizarra negra de pedidos. Va pegada a la cámara (siempre visible arriba de la pantalla).
// Cada regalo suma al pedido de su usuario; el pedido en cocina se marca con ">" y los terminados con "OK".
public class OrderBoard : MonoBehaviour
{
    public int maxLines = 6;
    public float width = 1.5f, height = 0.95f;
    public Vector3 localPosition = new Vector3(0f, 0.85f, 3.0f);

    class Entry
    {
        public int id;
        public string user, dish;
        public int count;
        public int state;           // 0 pendiente, 1 cocinando, 2 listo
        public float doneAt;
    }

    readonly List<Entry> entries = new List<Entry>();
    TextMesh title;
    Transform boardRoot;
    bool shown = true;

    /// Muestra u oculta la pizarra (oculta mientras está el menú de inicio).
    public void SetVisible(bool v) { shown = v; if (boardRoot != null) boardRoot.gameObject.SetActive(v); }

    TextMesh[] lines;
    bool dirty = true;

    void Start() { Build(); }

    void Build()
    {
        var root = new GameObject("PizarraPedidos").transform;
        root.SetParent(Camera.main != null ? Camera.main.transform : transform, false);
        root.localPosition = localPosition;
        root.localRotation = Quaternion.identity;
        boardRoot = root;

        var unlit = Shader.Find("Universal Render Pipeline/Unlit");
        if (unlit == null) unlit = Shader.Find("Unlit/Color");
        Material M(Color c) { var m = new Material(unlit); m.SetColor("_BaseColor", c); m.color = c; return m; }

        var frame = GameObject.CreatePrimitive(PrimitiveType.Quad); frame.name = "Marco"; frame.transform.SetParent(root, false);
        frame.transform.localScale = new Vector3(width + 0.06f, height + 0.06f, 1f); frame.GetComponent<Renderer>().sharedMaterial = M(new Color(0.45f, 0.3f, 0.18f)); Destroy(frame.GetComponent<Collider>());
        var board = GameObject.CreatePrimitive(PrimitiveType.Quad); board.name = "Pizarra"; board.transform.SetParent(root, false);
        board.transform.localPosition = new Vector3(0, 0, -0.002f); board.transform.localScale = new Vector3(width, height, 1f);
        board.GetComponent<Renderer>().sharedMaterial = M(new Color(0.05f, 0.06f, 0.06f)); Destroy(board.GetComponent<Collider>());

        title = MakeText(root, "Titulo", new Vector3(0, height * 0.5f - 0.065f, -0.01f), 0.013f, new Color(1f, 0.85f, 0.2f), TextAnchor.MiddleCenter);
        title.text = "PEDIDOS";
        // El shader por defecto del texto dibuja siempre encima de todo; este respeta la profundidad (el cartel del menú no se mete).
        lines = new TextMesh[maxLines];
        float step = (height - 0.2f) / maxLines;
        for (int i = 0; i < maxLines; i++)
            lines[i] = MakeText(root, "Linea" + i, new Vector3(-width * 0.5f + 0.05f, height * 0.5f - 0.15f - i * step, -0.01f), 0.0068f, Color.white, TextAnchor.MiddleLeft);

        root.gameObject.SetActive(shown);
        // La pizarra se dibuja al final (después del texto 3D de la cocina, que ignora la profundidad), así siempre queda delante.
        foreach (var r in root.GetComponentsInChildren<Renderer>())
        {
            var mat = new Material(r.sharedMaterial);
            mat.renderQueue = r is MeshRenderer && r.GetComponent<TextMesh>() != null ? 4000 : 3500;
            r.sharedMaterial = mat;
        }
    }

    static TextMesh MakeText(Transform parent, string name, Vector3 pos, float size, Color color, TextAnchor anchor)
    {
        var go = new GameObject(name); go.transform.SetParent(parent, false); go.transform.localPosition = pos;
        var tm = go.AddComponent<TextMesh>(); tm.fontSize = 64; tm.characterSize = size; tm.anchor = anchor; tm.color = color; tm.text = "";
        return tm;
    }

    Entry Find(int id) { foreach (var e in entries) if (e.id == id) return e; return null; }

    /// Pedido nuevo: cada pedido es un renglón propio.
    public void Add(int id, string user, string dish, int count)
    {
        entries.Add(new Entry { id = id, user = user, dish = dish, count = Mathf.Max(count, 1) });
        dirty = true;
    }

    /// Suma unidades a un pedido que todavía no empezó (ráfaga de regalos seguidos).
    public void AddCount(int id, int count) { var e = Find(id); if (e != null && e.state == 0) { e.count += Mathf.Max(count, 1); dirty = true; } }

    public void SetCooking(int id) { var e = Find(id); if (e != null) { e.state = 1; dirty = true; } }
    public void SetDone(int id) { var e = Find(id); if (e != null) { e.state = 2; e.doneAt = Time.time; dirty = true; } }

    void Update()
    {
        for (int i = entries.Count - 1; i >= 0; i--)
            if (entries[i].state == 2 && Time.time - entries[i].doneAt > 3f) { entries.RemoveAt(i); dirty = true; }
        if (!dirty || lines == null) return;
        dirty = false;

        int shown = 0;
        foreach (var e in entries)
        {
            if (shown >= maxLines) break;
            var sb = new StringBuilder();
            sb.Append(e.state == 1 ? "> " : (e.state == 2 ? "OK " : "- "));
            string name = e.user.Length > 9 ? e.user.Substring(0, 9) : e.user;
            sb.Append(Clean(name)).Append(": ");
            sb.Append(e.count).Append("x ").Append(e.dish);
            var t = lines[shown++];
            t.text = Trim(sb.ToString(), 30);
            t.color = e.state == 1 ? new Color(1f, 0.85f, 0.2f) : (e.state == 2 ? new Color(0.4f, 1f, 0.5f) : Color.white);
        }
        for (; shown < maxLines; shown++) lines[shown].text = "";
        title.text = entries.Count > maxLines ? "PEDIDOS (+" + (entries.Count - maxLines) + ")" : "PEDIDOS";
    }

    static string Clean(string s)
    {
        // La letra por defecto no tiene emojis ni letras raras: se quitan, y si no queda nada legible se pone "Cliente".
        var sb = new StringBuilder();
        foreach (var c in s) if (c < 128 && c >= 32) sb.Append(c);
        string r = sb.ToString().Trim();
        return r.Length < 2 ? "Cliente" : r;
    }

    static string Trim(string s, int max) { return s.Length <= max ? s : s.Substring(0, max - 1) + "."; }
}
