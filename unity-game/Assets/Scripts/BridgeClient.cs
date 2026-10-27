using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

// Se conecta al bridge de TikTok (ws://localhost:8080) y reparte los eventos:
// regalo -> pedido en la cocina; entrada/hola -> el cocinero saluda; follow/muchos likes -> festeja.
public class BridgeClient : MonoBehaviour
{
    public string url = "ws://localhost:8080";
    public ChefAnimator chef;
    public KitchenController kitchen;
    public bool reactions = true;
    public Action<Evt> OnGift;                               // llegó un regalo (para los Pokémon visitantes)
    public Action<Evt> OnSay, OnSpeaking, OnCharacter;   // eventos del presentador (voz y personaje)         // falso mientras está el menú de inicio

    [Serializable]
    public class Evt
    {
        public string type, user, userId, text, giftName, avatar;
        public string kind, character, name, state;       // del presentador: frase, personaje, estado de la voz
        public int diamonds, count, id, total;
    }

    // Contadores para verificar la conexión
    public bool connected;
    public int received, gifts, likes, chats, joins, follows, statuses;
    public string lastEvent = "";
    public string currentUser = "";      // usuario de TikTok al que está conectado el bridge
    public string bridgeStatus = "";     // tiktok_connected, tiktok_disconnected, stream_end...

    readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
    CancellationTokenSource cts;
    ClientWebSocket socket;
    int likeAccum;
    float lastGreet;

    void Awake() { Application.runInBackground = true; }

    void OnEnable()
    {
        cts = new CancellationTokenSource();
        _ = RunAsync(cts.Token);
    }

    void OnDisable() { cts?.Cancel(); }

    async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using (var ws = new ClientWebSocket())
                {
                    socket = ws;
                    await ws.ConnectAsync(new Uri(url), ct);
                    connected = true;
                    var buf = new byte[16384];
                    var sb = new StringBuilder();
                    while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
                    {
                        var res = await ws.ReceiveAsync(new ArraySegment<byte>(buf), ct);
                        if (res.MessageType == WebSocketMessageType.Close) break;
                        sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                        if (res.EndOfMessage) { inbox.Enqueue(sb.ToString()); sb.Clear(); }
                    }
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception) { /* sin bridge: se reintenta */ }
            connected = false;
            try { await Task.Delay(3000, ct); } catch (OperationCanceledException) { break; }
        }
        connected = false;
    }

    void Update()
    {
        int n = 0;
        while (n++ < 50 && inbox.TryDequeue(out var json))
        {
            Evt e;
            try { e = JsonUtility.FromJson<Evt>(json); } catch { continue; }
            if (e == null || string.IsNullOrEmpty(e.type)) continue;
            received++;
            Handle(e);
        }
    }

    void Handle(Evt e)
    {
        lastEvent = e.type + ":" + e.user;
        switch (e.type)
        {
            case "gift":
                gifts++;
                if (kitchen != null) kitchen.OnGift(e.user, e.giftName, Mathf.Max(e.count, 1));
                OnGift?.Invoke(e);
                break;
            case "like":
                likes++;
                likeAccum += Mathf.Max(e.count, 1);
                if (reactions) GoalHud.Taps(Mathf.Max(e.count, 1), e.total);
                if (reactions && likeAccum >= 50 && chef != null && !chef.IsBusy) { likeAccum = 0; chef.Celebrate(); }
                break;
            case "follow":
                follows++;
                if (reactions) { var pk = FindFirstObjectByType<PokemonSpawner>(); if (pk != null) pk.SpawnReward(0, 1, e.user); }
                if (reactions && chef != null && !chef.IsBusy) chef.Celebrate();
                break;
            case "join":
                joins++;
                Greet();
                break;
            case "chat":
                chats++;
                if (reactions && kitchen != null) kitchen.OnChatOrder(e.user, e.text);
                if (!string.IsNullOrEmpty(e.text) && e.text.ToLowerInvariant().Contains("hola")) Greet();
                break;
            case "say": OnSay?.Invoke(e); break;
            case "speaking": OnSpeaking?.Invoke(e); break;
            case "character": OnCharacter?.Invoke(e); break;
            case "status":
                statuses++;
                if (!string.IsNullOrEmpty(e.text)) { if (e.text.StartsWith("user:")) currentUser = e.text.Substring(5); else bridgeStatus = e.text; }
                break;
        }
    }

    /// Pide al bridge que se conecte al live de otro usuario de TikTok (sin reiniciar nada).
    public async void SetUser(string user)
    {
        user = (user ?? "").Trim().TrimStart('@');
        if (user.Length < 2 || socket == null || socket.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes("{\"type\":\"setUser\",\"user\":\"" + user.Replace("\\", "").Replace("\"", "") + "\"}");
        try { await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch (Exception) { }
    }

    /// Avisa al bridge qué personaje está en pantalla (para que hable con su voz y su estilo).
    public async void SendSetCharacter(string id)
    {
        if (string.IsNullOrEmpty(id) || socket == null || socket.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes("{\"type\":\"ctl\",\"action\":\"setCharacter\",\"id\":\"" + id.Replace("\\", "").Replace("\"", "") + "\"}");
        try { await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch (Exception) { }
    }

    /// Le pide al bridge que el cocinero diga una frase (voz y subtítulo).
    public async void SendSay(string text)
    {
        if (string.IsNullOrEmpty(text) || socket == null || socket.State != WebSocketState.Open) return;
        string clean = text.Replace("\\", "").Replace("\"", "").Replace("\n", " ");
        var bytes = Encoding.UTF8.GetBytes("{\"type\":\"ctl\",\"action\":\"say\",\"text\":\"" + clean + "\"}");
        try { await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch (Exception) { }
    }

    /// La mascota (ej. Pikachu) dice su sonido con su propia voz; no corta al cocinero.
    public async void SendPet(string text, string name, float pitch, float rate)
    {
        if (string.IsNullOrEmpty(text) || socket == null || socket.State != WebSocketState.Open) return;
        string t = text.Replace("\\", "").Replace("\"", ""), n = (name ?? "").Replace("\\", "").Replace("\"", "");
        var ci = System.Globalization.CultureInfo.InvariantCulture;
        var bytes = Encoding.UTF8.GetBytes("{\"type\":\"ctl\",\"action\":\"pet\",\"text\":\"" + t + "\",\"name\":\"" + n + "\",\"pitch\":" + pitch.ToString(ci) + ",\"rate\":" + rate.ToString(ci) + "}");
        try { await socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None); } catch (Exception) { }
    }

    void Greet()
    {
        if (!reactions || chef == null || chef.IsBusy || Time.time - lastGreet < 4f) return;
        lastGreet = Time.time;
        chef.Greet();
    }
}
