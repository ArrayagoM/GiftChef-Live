using UnityEngine;

// Panel de conexión (tecla F2): muestra a qué live de TikTok está conectado el juego y permite cambiar
// el usuario sin tocar archivos. Está oculto por defecto para que no salga en el live.
public class ConnectionPanel : MonoBehaviour
{
    public BridgeClient client;
    public KitchenController kitchen;
    public KeyCode toggleKey = KeyCode.F2;
    public bool visible;

    string input = "";
    bool inputInit;
    GUIStyle box, label, field, button, small;

    void OnGUI()
    {
        var e = Event.current;
        if (e.type == EventType.KeyDown && e.keyCode == toggleKey) { visible = !visible; e.Use(); }
        if (!visible || client == null) return;

        if (!inputInit && !string.IsNullOrEmpty(client.currentUser)) { input = client.currentUser; inputInit = true; }
        float s = Mathf.Max(1f, Screen.height / 960f);
        if (box == null)
        {
            box = new GUIStyle(GUI.skin.box); label = new GUIStyle(GUI.skin.label); field = new GUIStyle(GUI.skin.textField); button = new GUIStyle(GUI.skin.button); small = new GUIStyle(GUI.skin.label);
        }
        int fs = Mathf.RoundToInt(15 * s);
        label.fontSize = fs; field.fontSize = fs; button.fontSize = fs; small.fontSize = Mathf.RoundToInt(12 * s); label.normal.textColor = Color.white; small.normal.textColor = new Color(0.8f, 0.8f, 0.8f);

        float w = Screen.width - 20 * s;
        var r = new Rect(10 * s, 10 * s, w, 230 * s);
        GUI.Box(r, GUIContent.none, box);
        GUILayout.BeginArea(new Rect(r.x + 12 * s, r.y + 8 * s, r.width - 24 * s, r.height - 16 * s));
        GUILayout.Label("CONEXIÓN CON TIKTOK  (F2 para cerrar)", label);
        string bridge = client.connected ? "bridge OK" : "bridge sin conexión";
        string tk = client.bridgeStatus == "tiktok_connected" ? "EN VIVO" : (string.IsNullOrEmpty(client.bridgeStatus) ? "..." : client.bridgeStatus);
        GUILayout.Label("Usuario actual: @" + (string.IsNullOrEmpty(client.currentUser) ? "?" : client.currentUser) + "   |   " + bridge + "   |   TikTok: " + tk, label);
        GUILayout.Label("Eventos: " + client.received + "  (regalos " + client.gifts + ", likes " + client.likes + ", chats " + client.chats + ", entradas " + client.joins + ")", small);
        GUILayout.Space(6 * s);
        GUILayout.BeginHorizontal();
        GUILayout.Label("@", label, GUILayout.Width(18 * s));
        input = GUILayout.TextField(input, 40, field, GUILayout.Height(30 * s));
        GUILayout.EndHorizontal();
        GUILayout.Space(4 * s);
        if (GUILayout.Button("Conectar a este usuario", button, GUILayout.Height(34 * s))) client.SetUser(input);
        GUILayout.Label("Cambiar de usuario tarda unos segundos; TikTok limita si se hace muy seguido.", small);
        GUILayout.EndArea();
    }
}
