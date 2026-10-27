using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

// Cerebro de la cocina. Cada pedido es una receta con pasos que se ven:
// 1) preparar en la mesa (amasar, cortar, salsa...), 2) cocinar en la estación, 3) embalar en caja de reparto,
// 4) entregar en la pila de cajas. La cámara sigue cada paso. Actualiza la pizarra de pedidos.
public class KitchenController : MonoBehaviour
{
    [Serializable]
    public class Dish
    {
        public string name;
        public GameObject prefab;
        public int station;          // 0 plancha, 1 hornalla, 2 freidora, 3 horno
        public float scale = 0.5f;
        public string kind = "generic";   // pizza, burger, fries, donut, generic
    }

    public ChefAnimator chef;
    public OrderBoard board;
    public FollowCamera cam;
    public Dish[] dishes;
    public Material foodMaterial;
    public float[] stationX = { -1.6f, -0.2f, 0.9f, 2.3f };
    public float standZ = -1.8f;
    public float counterY = 1.12f;
    public float counterZ = -2.9f;
    public Vector3 prepStand = new Vector3(0f, 0f, 0.15f);
    public Vector3 packStand = new Vector3(1.1f, 0f, 0.15f);
    public Vector3 stackBase = new Vector3(-2.7f, 0.9f, 0.6f);
    public int maxQueued = 40;
    // Repartidor que se lleva las cajas
    public GameObject courierPrefab;
    public RuntimeAnimatorController courierController;
    public float courierDelay = 5f;
    float pickupAt = -1f;
    bool courierBusy;
    // Dónde queda la comida en cada estación: plancha, hornalla (en la sartén), freidora (sobre el aceite) y horno (delante de la puerta)
    public Vector3[] foodPoint = { new Vector3(-1.6f, 1.17f, -2.9f), new Vector3(-0.2f, 1.27f, -2.85f), new Vector3(0.9f, 1.72f, -2.9f), new Vector3(2.3f, 1.02f, -2.5f) };

    class Job { public int id; public string user; public int dish; public int count; public float lastAdd; }
    int jobSeq;
    readonly List<Job> jobs = new List<Job>();
    Job current;
    /// Verdadero mientras el cocinero está preparando un pedido (la cámara está siguiendo esa receta).
    public bool Busy { get { return current != null || jobs.Count > 0; } }
    bool stepDone;
    readonly Dictionary<int, Material> mats = new Dictionary<int, Material>();
    Shader lit;
    readonly List<GameObject> cookingFood = new List<GameObject>();
    class Box { public GameObject go; public float h; }
    readonly List<Box> stack = new List<Box>();

    public bool paused;                 // en el menú de inicio no se atienden pedidos
    System.Action cookedHandler;
    public int totalOrders, totalServed;
    public string currentInfo = "";

    void Awake()
    {
        lit = Shader.Find("Universal Render Pipeline/Lit");
        // Mesa de reparto donde se apilan las cajas listas
        var t = GameObject.CreatePrimitive(PrimitiveType.Cube); t.name = "MesaReparto"; Destroy(t.GetComponent<Collider>());
        t.transform.position = new Vector3(stackBase.x, stackBase.y * 0.5f, stackBase.z); t.transform.localScale = new Vector3(1.0f, stackBase.y, 0.7f);
        t.GetComponent<Renderer>().sharedMaterial = M(new Color(0.6f, 0.63f, 0.66f));
    }

    Transform ovenDoor; GameObject ovenWindow; Light ovenLight;
    [Header("Horno real (modelo 3D)")]
    public bool realOven;                       // true = el horno de la escena es un modelo real con puerta propia
    public Vector3 ovenInPoint = new Vector3(2.0f, 0.95f, -2.9f);   // donde queda la comida adentro del horno
    void Start() { cookedHandler = () => stepDone = true; if (chef != null) chef.OnCooked += cookedHandler; BuildOvenDoor(); }

    /// Cambia de cocinero (cuando eligen otro personaje en el menú).
    public void SetChef(ChefAnimator c)
    {
        if (chef != null) chef.OnCooked -= cookedHandler;
        chef = c; chef.OnCooked += cookedHandler;
    }

    // ------------------------------------------------------------------ pedidos
    public int DishFor(string gift)
    {
        string g = (gift ?? "").ToLowerInvariant();
        if (g.Contains("rose")) return 0;                            // pizza
        if (g.Contains("finger") || g.Contains("heart")) return 1;   // hamburguesa
        if (g.Contains("doughnut") || g.Contains("donut")) return 2; // papas fritas
        if (g.Contains("gg")) return 3;                              // dona
        return Mathf.Abs(g.GetHashCode()) % dishes.Length;
    }

    // Pedidos por chat (gratis): "pizza", "hamburguesa", "papas" o "dona" en un mensaje corto. Uno por persona cada 30 s.
    readonly Dictionary<string, float> chatCool = new Dictionary<string, float>();
    public bool OnChatOrder(string user, string text)
    {
        if (paused || dishes == null || dishes.Length < 4 || string.IsNullOrEmpty(text) || text.Length > 60) return false;
        string t = text.ToLowerInvariant().Replace("á", "a").Replace("é", "e").Replace("í", "i").Replace("ó", "o").Replace("ú", "u").Replace("ü", "u");
        // acepta variantes y errores comunes: "pizza", "quiero una pizza", "=pizza", "piza", "2 pizzas", "hamburgesa", "papa frita", "donuts", emojis...
        int d = Rx(t, "p+i+z+a|p+i+s+a\\b|\U0001F355") ? 0
              : Rx(t, "h?a[mn]+b[uo]?r?[gj][ue]|burg?er|burguer|\U0001F354") ? 1
              : Rx(t, "papa|papit|frita|fries|\U0001F35F") ? 2
              : Rx(t, "\\bdona|donut|doughnut|rosquilla|\U0001F369") ? 3 : -1;
        if (d < 0 || string.IsNullOrEmpty(user) || jobs.Count >= 8) return false;
        string ck = user + "|" + d;
        float until; if (chatCool.TryGetValue(ck, out until) && Time.time < until) return false;       // el mismo plato repetido muy seguido (spam)
        int pend = 0; foreach (var j in jobs) if (j.user == user) pend++;
        if (pend >= 3) return false;
        chatCool[ck] = Time.time + 15f;
        int n = 1;
        var mc = System.Text.RegularExpressions.Regex.Match(t, "\\b([1-3])\\b|\\bx\\s*([1-3])\\b|\\b(dos|tres)\\b");
        if (mc.Success) { string g = mc.Groups[1].Success ? mc.Groups[1].Value : (mc.Groups[2].Success ? mc.Groups[2].Value : (mc.Groups[3].Value == "dos" ? "2" : "3")); int.TryParse(g, out n); n = Mathf.Clamp(n, 1, 3); }
        OnGift(user, d == 0 ? "Rose" : d == 1 ? "Heart" : d == 2 ? "Doughnut" : "GG", n);
        return true;
    }

    static bool Rx(string t, string pattern) { return System.Text.RegularExpressions.Regex.IsMatch(t, pattern); }

    public void OnGift(string user, string gift, int count)
    {
        if (paused || dishes == null || dishes.Length == 0) return;
        if (string.IsNullOrEmpty(user)) user = "anon";
        int d = DishFor(gift);
        count = Mathf.Max(count, 1);
        // Una ráfaga de regalos seguidos (menos de 3 s entre uno y otro) es un solo pedido; si pasa más tiempo, es un pedido nuevo.
        foreach (var j in jobs) if (j.user == user && j.dish == d && Time.time - j.lastAdd < 3f) { j.count += count; j.lastAdd = Time.time; board.AddCount(j.id, count); return; }
        if (jobs.Count < maxQueued)
        {
            var nj = new Job { id = ++jobSeq, user = user, dish = d, count = count, lastAdd = Time.time };
            jobs.Add(nj); board.Add(nj.id, user, dishes[d].name, count);
            totalOrders++;
        }
    }

    // ------------------------------------------------------------------ pala con la pizza (realismo de manos)
    GameObject peelObj, pizzaObj; Transform peelGrip;
    bool peelFollow, pizzaOnPeel, handsOnPeel;     // seguir al cocinero / la pizza va sobre la pala / las manos agarran el mango

    Vector3 PeelChest() { return chef.transform.position + chef.Forward * 0.85f + Vector3.up * (chef.Height * 0.5f); }

    GameObject MakePeel(Vector3 pos, Quaternion rot)
    {
        var root = new GameObject("Pala"); root.transform.position = pos; root.transform.rotation = rot;
        Color wood = new Color(0.62f, 0.44f, 0.24f);
        var board = Prim(PrimitiveType.Cube, wood, pos, new Vector3(0.5f, 0.012f, 0.5f), null); board.transform.SetParent(root.transform, true);
        var handle = Prim(PrimitiveType.Cube, wood * 0.9f, pos, new Vector3(0.05f, 0.02f, 0.32f), null);
        handle.transform.SetParent(root.transform, false); handle.transform.localPosition = new Vector3(0f, 0.004f, -0.41f); handle.transform.localRotation = Quaternion.identity;
        var grip = new GameObject("Mango"); grip.transform.SetParent(root.transform, false); grip.transform.localPosition = new Vector3(0f, 0.02f, -0.48f);
        peelGrip = grip.transform;
        return root;
    }

    void UpdatePeel()
    {
        if (peelObj == null || chef == null) return;
        if (peelFollow) { peelObj.transform.position = PeelChest(); peelObj.transform.rotation = Quaternion.LookRotation(chef.Forward, Vector3.up); }
        if (pizzaOnPeel && pizzaObj != null) { pizzaObj.transform.position = peelObj.transform.position + Vector3.up * 0.013f; pizzaObj.transform.rotation = peelObj.transform.rotation; }
        if (handsOnPeel && peelGrip != null) { var g = peelGrip.position; var r = peelObj.transform.right; chef.Hands(g - r * 0.09f, g + r * 0.09f); }
    }

    void ClearPeel()
    {
        handsOnPeel = false; peelFollow = false; pizzaOnPeel = false;
        if (chef != null) chef.HandsOff();
        if (knifeObj != null) { Destroy(knifeObj); knifeObj = null; }
        if (peelObj != null) Destroy(peelObj); peelObj = null; peelGrip = null;
        if (pizzaObj != null) Destroy(pizzaObj); pizzaObj = null;
    }

    IEnumerator MovePeel(Vector3 to, float dur)
    {
        Vector3 from = peelObj.transform.position; float t = 0f;
        while (t < dur && peelObj != null) { t += Time.deltaTime; peelObj.transform.position = Vector3.Lerp(from, to, Mathf.SmoothStep(0f, 1f, t / dur)); yield return null; }
    }

    IEnumerator PeelToChest(float dur)
    {
        peelFollow = false; Vector3 from = peelObj.transform.position; float t = 0f;
        Quaternion rot = Quaternion.LookRotation(chef.Forward, Vector3.up);
        while (t < dur && peelObj != null) { t += Time.deltaTime; float k = Mathf.SmoothStep(0f, 1f, t / dur); peelObj.transform.position = Vector3.Lerp(from, PeelChest(), k); peelObj.transform.rotation = Quaternion.Slerp(peelObj.transform.rotation, rot, k); yield return null; }
        peelFollow = true;
    }

    // Después de armar la pizza en la mesa: se pone una pala debajo, las manos agarran el mango y la levantan al frente del pecho
    IEnumerator PizzaToPeel(Vector3 tp, List<GameObject> props)
    {
        pizzaObj = new GameObject("Pizza"); pizzaObj.transform.position = tp;
        foreach (var p in props) if (p != null) p.transform.SetParent(pizzaObj.transform, true);
        props.Clear();
        pizzaObj.transform.position = tp + Vector3.up * 0.014f;       // la pala queda debajo de la pizza
        peelObj = MakePeel(tp + Vector3.up * 0.006f, Quaternion.LookRotation(chef.Forward, Vector3.up));
        pizzaOnPeel = true; handsOnPeel = true;
        yield return new WaitForSeconds(0.5f);                         // las manos llegan al mango
        yield return PeelToChest(0.6f);
    }

    void Update()
    {
        UpdatePeel();
        if (!paused && chef != null && current == null && jobs.Count > 0) StartCoroutine(Run());
        // Sin pedidos, el cocinero no se queda parado: limpia las mesas con un trapo
        if (!paused && chef != null && !chore && current == null && jobs.Count == 0 && !courierBusy && Time.time >= nextChore && !chef.IsCooking) StartCoroutine(IdleChore());
        // Repartidor: viene 5 s después de la última entrega (y si el cocinero no está justo entregando)
        if (!courierBusy && courierPrefab != null && stack.Count > 0 && pickupAt > 0f && Time.time >= pickupAt) StartCoroutine(CourierRun());
        // La comida que se cocina gira y rebota
        for (int i = 0; i < cookingFood.Count; i++)
        {
            var f = cookingFood[i]; if (f == null) continue;
            f.transform.Rotate(0f, 90f * Time.deltaTime, 0f, Space.World);
        }
    }

    IEnumerator Bubble(GameObject g)
    {
        if (g == null) yield break;
        float t = 0f, life = UnityEngine.Random.Range(0.7f, 1.2f); Vector3 s0 = g.transform.localScale;
        while (t < life && g != null) { t += Time.deltaTime; g.transform.position += Vector3.up * 0.12f * Time.deltaTime; g.transform.localScale = s0 * Mathf.Max(0.001f, 1f - t / life); yield return null; }
        if (g != null) Destroy(g);
    }

    // ------------------------------------------------------------------ tarea de espera: limpiar
    bool chore; float nextChore = 6f; int choreKind;
    IEnumerator IdleChore()
    {
        chore = true; Debug.Log("[Chore] limpiar");
        choreKind++;
        Vector3 stand = (choreKind % 2 == 0) ? prepStand : packStand;
        Vector3 at = new Vector3(stand.x, 0.9f, 0.72f);
        chef.Work(stand, 120f, "", 15f, false);
        cam.Shot(new Vector3(stand.x + 0.4f, 2.15f, 4.5f), new Vector3(stand.x, 1.0f, 0.7f), 44f);
        float guard = 0f;
        while (!chef.IsCooking && guard < 8f && jobs.Count == 0) { guard += Time.deltaTime; yield return null; }
        bool interrupted = jobs.Count > 0 || !chef.IsCooking;
        var cloth = Prim(PrimitiveType.Cube, new Color(0.98f, 0.86f, 0.15f), at, new Vector3(0.26f, 0.045f, 0.18f), null);   // esponja amarilla bien visible
        float nextBubble = 0f;
        float secs = UnityEngine.Random.Range(7f, 11f), t = 0f;
        while (!interrupted && t < secs)
        {
            if (jobs.Count > 0 || current != null) { interrupted = true; break; }
            t += Time.deltaTime;
            Vector3 r = chef.RightDir, f = chef.Forward;
            float ph = Time.time * 3.6f;
            Vector3 sp = at + Vector3.up * 0.025f + r * (Mathf.Sin(ph) * 0.30f) + f * (Mathf.Sin(ph * 0.5f) * 0.10f);   // pasadas largas de lado a lado
            Vector3 rh = sp + Vector3.up * 0.075f;
            Vector3 lh = at - r * 0.34f + Vector3.up * 0.04f;
            chef.Hands(lh, rh);
            cloth.transform.position = sp;
            cloth.transform.rotation = Quaternion.LookRotation(f, Vector3.up) * Quaternion.Euler(0f, Mathf.Sin(ph) * 12f, 0f);
            if (Time.time >= nextBubble) { nextBubble = Time.time + 0.08f; StartCoroutine(Bubble(Prim(PrimitiveType.Sphere, Color.white, sp + new Vector3(UnityEngine.Random.Range(-0.08f, 0.08f), 0.03f, UnityEngine.Random.Range(-0.06f, 0.06f)), Vector3.one * UnityEngine.Random.Range(0.025f, 0.05f), null))); }
            yield return null;
        }
        if (cloth != null) Destroy(cloth);
        if (!interrupted) Burst(at + Vector3.up * 0.05f, Color.white, 10);       // la mesa queda reluciente
        if (!interrupted && cam != null) cam.Release();
        if (chef != null && !handsOnPeel) chef.HandsOff();
        if (!interrupted && chef != null) { chef.FinishWork(); yield return new WaitForSeconds(0.4f); if (jobs.Count == 0 && current == null) chef.GoHome(); }
        nextChore = Time.time + UnityEngine.Random.Range(8f, 16f);
        chore = false;
    }

    // ------------------------------------------------------------------ receta
    IEnumerator Run()
    {
        current = jobs[0]; jobs.RemoveAt(0);
        var d = dishes[current.dish]; string who = current.user;
        int n = Mathf.Clamp(current.count, 1, 3);
        float sp = Mathf.Clamp(1f - jobs.Count * 0.06f, 0.5f, 1f);     // con muchos pedidos en fila, se apura
        currentInfo = who + " -> " + current.count + "x " + d.name;
        int jobId = current.id; board.SetCooking(jobId);
        var props = new List<GameObject>();
        ClearPeel();

        // 1) PREPARAR en la mesa (el cocinero mira a cámara)
        Vector3 tp = new Vector3(prepStand.x, 0.9f, 0.72f);
        cam.Shot(new Vector3(prepStand.x + 0.4f, 2.15f, 4.5f), new Vector3(prepStand.x, 1.0f, 0.7f), 44f);
        float prepT = PrepTime(d.kind) * sp;
        bool knead = d.kind == "pizza" || d.kind == "donut";
        bool pizza = d.kind == "pizza";
        // La pizza se trabaja con las manos (IK): sin gesto de animación; el resto mantiene su animación
        yield return WorkWhile(prepStand, d.kind == "generic" ? "Chop" : "", 15f, PrepRecipe(d.kind, tp, prepT, props));   // las manos las mueven los IK
        yield return new WaitForSeconds(0.2f);
        if (chef != null && !handsOnPeel) chef.HandsOff();             // termina de preparar: baja las manos (si no lleva la pala)
        if (knifeObj != null) { Destroy(knifeObj); knifeObj = null; }
        foreach (var p in props) if (p != null) Destroy(p);
        props.Clear();

        // 2) COCINAR en la estación
        int st = d.station % stationX.Length;
        float sx = stationX[st];
        // La cámara va del lado con más espacio (así nunca queda fuera de la pared) y el cocinero mira hacia ese lado.
        float side = sx > 0.9f ? -1f : 1f;
        cam.Shot(new Vector3(sx + side * 2.1f, 2.9f, 2.6f), new Vector3(sx - 0.1f * side, 1.3f, -2.5f), 49f);
        float cookT = Mathf.Max((2.6f + 0.4f * Mathf.Min(current.count, 6)) * sp, st == 3 ? (pizza ? 9.5f : 4.8f) : (st == 2 ? 3.8f : 3.2f));
        // Con la pala el cocinero mira derecho al horno (para meter la pizza en línea recta)
        yield return WorkAt(new Vector3(sx, 0f, standZ), cookT, pizza ? "" : (d.station == 3 ? "Work" : "Chop"), pizza ? 180f : (side > 0 ? 140f : 220f), CookEffects(d, st, n, cookT));

        // 3) EMBALAR en la caja de reparto
        cam.Shot(new Vector3(packStand.x + 0.4f, 2.15f, 4.5f), new Vector3(packStand.x, 1.0f, 0.7f), 44f);
        var box = MakeBox(d.kind, who, new Vector3(packStand.x, 0.9f, 0.72f));
        float packT = 2.6f * sp;
        yield return WorkWhile(packStand, "", 20f, PackSequence(box, d, packT));

        // 4) ENTREGAR: la caja cerrada se deja ahí mismo, sin que el cocinero cruce al frente: sale volando a la pila de reparto
        cam.Shot(new Vector3(stackBase.x + 1.6f, 1.9f, 4.0f), new Vector3(stackBase.x + 0.3f, 1.15f, stackBase.z + 0.4f), 46f);
        yield return Deliver(box);
        ClearPeel();
        chef.GoHome();
        board.SetDone(jobId);
        totalServed++;
        pickupAt = Time.time + courierDelay;
        yield return new WaitForSeconds(0.5f);
        cam.Release();
        foreach (var m in tempMats) if (m != null) Destroy(m);
        tempMats.Clear();
        foreach (var pr in props) if (pr != null) Destroy(pr);
        props.Clear();
        current = null;
    }

    IEnumerator Slide(Transform t, Vector3 localTo, float dur)
    {
        Vector3 from = t.localPosition; float k = 0f;
        while (k < dur && t != null) { k += Time.deltaTime; t.localPosition = Vector3.Lerp(from, localTo, Mathf.SmoothStep(0f, 1f, k / dur)); yield return null; }
    }

    // ------------------------------------------------------------------ repartidor
    // 5 segundos después de la última entrega, otro personaje viene, se lleva todas las cajas de la mesa y se va.
    IEnumerator CourierRun()
    {
        courierBusy = true;
        var carried = new List<Box>(stack); stack.Clear();
        Vector3 inPos = new Vector3(stackBase.x, 0f, 7.0f), standPos = new Vector3(stackBase.x + 0.1f, 0f, stackBase.z + 0.95f);
        var c = Instantiate(courierPrefab, inPos, Quaternion.Euler(0f, 180f, 0f));
        c.transform.localScale = Vector3.one * 0.8f;
        var an = c.GetComponent<Animator>(); if (an == null) an = c.AddComponent<Animator>();
        if (courierController != null) an.runtimeAnimatorController = courierController;
        an.applyRootMotion = false;
        bool camFree = current == null;
        if (camFree) cam.Shot(new Vector3(stackBase.x + 1.8f, 1.9f, 4.4f), new Vector3(stackBase.x, 1.1f, stackBase.z + 1.2f), 48f);
        yield return MoveTo(c.transform, an, standPos, 1.9f);                       // llega a la mesa
        yield return FaceYaw(c.transform, 180f);
        var pivot = new GameObject("Carga").transform; pivot.SetParent(c.transform, false); pivot.localPosition = new Vector3(0f, 1.0f, 0.4f);
        an.SetTrigger("Work"); yield return new WaitForSeconds(0.5f);
        float level = 0f;
        foreach (var b in carried)                                                  // toma las cajas una por una
        {
            if (b.go == null) continue;
            b.go.transform.SetParent(pivot, true);
            StartCoroutine(Slide(b.go.transform, new Vector3(0f, level, 0f), 0.4f));
            level += b.h; yield return new WaitForSeconds(0.3f);
        }
        yield return new WaitForSeconds(0.4f);
        yield return FaceYaw(c.transform, 0f);
        yield return MoveTo(c.transform, an, inPos, 2.2f);                         // se va con los pedidos
        foreach (var b in carried) if (b.go != null) { boxes.Remove(b.go); Destroy(b.go); }
        Destroy(c);
        if (camFree && current == null) cam.Release();
        courierBusy = false;
    }

    IEnumerator MoveTo(Transform t, Animator an, Vector3 target, float speed)
    {
        var path = KitchenNav.Path(new Vector3(t.position.x, 0f, t.position.z), new Vector3(target.x, 0f, target.z));
        foreach (var wp in path)
        {
            while (t != null && Vector3.Distance(new Vector3(t.position.x, 0, t.position.z), new Vector3(wp.x, 0, wp.z)) > 0.05f)
            {
                Vector3 dir = wp - t.position; dir.y = 0f;
                t.position = Vector3.MoveTowards(t.position, new Vector3(wp.x, t.position.y, wp.z), speed * Time.deltaTime);
                if (dir.sqrMagnitude > 0.001f) t.rotation = Quaternion.RotateTowards(t.rotation, Quaternion.LookRotation(dir.normalized, Vector3.up), 540f * Time.deltaTime);
                an.SetFloat("Speed", 1f);
                yield return null;
            }
        }
        an.SetFloat("Speed", 0f);
    }

    IEnumerator FaceYaw(Transform t, float yaw)
    {
        float guard = 0f;
        while (t != null && Quaternion.Angle(t.rotation, Quaternion.Euler(0f, yaw, 0f)) > 2f && guard < 1.5f) { guard += Time.deltaTime; t.rotation = Quaternion.RotateTowards(t.rotation, Quaternion.Euler(0f, yaw, 0f), 540f * Time.deltaTime); yield return null; }
    }

    // El cocinero trabaja en el puesto hasta que termine toda la animación "during" (así no queda nada a medias).
    IEnumerator WorkWhile(Vector3 stand, string trig, float yaw, IEnumerator during)
    {
        stepDone = false;
        chef.Work(stand, 120f, trig, yaw, false);
        float guard = 0f;
        while (!chef.IsCooking && guard < 8f) { guard += Time.deltaTime; yield return null; }
        bool finished = false;
        StartCoroutine(RunThen(during, () => finished = true));
        guard = 0f;
        while (!finished && guard < 30f) { guard += Time.deltaTime; yield return null; }
        chef.FinishWork();
        guard = 0f;
        while (!stepDone && guard < 3f) { guard += Time.deltaTime; yield return null; }
    }

    IEnumerator RunThen(IEnumerator inner, System.Action done) { yield return inner; done(); }

    IEnumerator WorkAt(Vector3 stand, float secs, string trig, float yaw, IEnumerator during)
    {
        stepDone = false;
        chef.Work(stand, secs, trig, yaw, false);
        float guard = 0f;
        while (!chef.IsCooking && guard < 8f) { guard += Time.deltaTime; yield return null; }
        if (during != null) StartCoroutine(during);
        guard = 0f;
        while (!stepDone && guard < secs + 6f) { guard += Time.deltaTime; yield return null; }
    }

    float PrepTime(string kind)
    {
        switch (kind) { case "pizza": return 4.2f; case "burger": return 3.8f; case "fries": return 3.0f; case "donut": return 3.8f; default: return 2.6f; }
    }

    // ------------------------------------------------------------------ ayudas visuales
    Material M(Color c)
    {
        int k = ((int)(c.r * 255) << 16) | ((int)(c.g * 255) << 8) | (int)(c.b * 255);
        Material m;
        if (!mats.TryGetValue(k, out m)) { m = new Material(lit); m.SetColor("_BaseColor", c); m.SetFloat("_Smoothness", 0.3f); mats[k] = m; }
        return m;
    }

    readonly Dictionary<PrimitiveType, Mesh> meshCache = new Dictionary<PrimitiveType, Mesh>();
    readonly List<Material> tempMats = new List<Material>();      // materiales propios de un pedido (se liberan al terminar)
    static MaterialPropertyBlock mpbShared;

    // Primitivas livianas: sin colisionador y con la malla compartida (se crean muchas por segundo: vapor, trocitos, ingredientes)
    Mesh PrimMesh(PrimitiveType t)
    {
        Mesh m;
        if (!meshCache.TryGetValue(t, out m)) { var tmp = GameObject.CreatePrimitive(t); m = tmp.GetComponent<MeshFilter>().sharedMesh; Destroy(tmp); meshCache[t] = m; }
        return m;
    }

    GameObject Prim(PrimitiveType t, Color c, Vector3 pos, Vector3 scale, List<GameObject> keep)
    {
        var g = new GameObject(t.ToString()); g.AddComponent<MeshFilter>().sharedMesh = PrimMesh(t); g.AddComponent<MeshRenderer>();
        g.GetComponent<Renderer>().sharedMaterial = M(c);
        g.transform.position = pos; g.transform.localScale = scale;
        if (keep != null) keep.Add(g);
        return g;
    }

    IEnumerator Grow(GameObject g, Vector3 to, float dur)
    {
        if (g == null) yield break;
        g.transform.localScale = Vector3.zero;
        float t = 0f;
        while (t < dur && g != null)
        {
            t += Time.deltaTime; float k = Mathf.SmoothStep(0f, 1f, t / dur);
            g.transform.localScale = to * k * (1f + 0.18f * Mathf.Sin(k * Mathf.PI));
            yield return null;
        }
        if (g != null) g.transform.localScale = to;
    }

    // Trocitos que saltan (efecto de cortar / espolvorear)
    void Burst(Vector3 pos, Color c, int count = 6)
    {
        for (int i = 0; i < count; i++)
        {
            var g = Prim(PrimitiveType.Cube, c, pos, Vector3.one * 0.025f, null);
            var v = new Vector3(UnityEngine.Random.Range(-0.7f, 0.7f), UnityEngine.Random.Range(0.8f, 1.6f), UnityEngine.Random.Range(-0.5f, 0.5f));
            StartCoroutine(Chip(g, v));
        }
    }

    IEnumerator Chip(GameObject g, Vector3 v)
    {
        float t = 0f;
        while (t < 0.7f && g != null) { t += Time.deltaTime; v.y -= 5f * Time.deltaTime; g.transform.position += v * Time.deltaTime; g.transform.Rotate(300f * Time.deltaTime, 200f * Time.deltaTime, 0f); yield return null; }
        if (g != null) Destroy(g);
    }

    // Vapor que sube mientras cocina
    IEnumerator Steam(Vector3 pos, float duration)
    {
        float t = 0f;
        while (t < duration)
        {
            t += 0.12f;
            var g = Prim(PrimitiveType.Sphere, new Color(0.95f, 0.95f, 0.95f), pos + new Vector3(UnityEngine.Random.Range(-0.15f, 0.15f), 0.1f, UnityEngine.Random.Range(-0.1f, 0.1f)), Vector3.one * 0.06f, null);
            StartCoroutine(Rise(g));
            yield return new WaitForSeconds(0.12f);
        }
    }

    IEnumerator Rise(GameObject g)
    {
        float t = 0f;
        while (t < 0.9f && g != null) { t += Time.deltaTime; g.transform.position += Vector3.up * 0.5f * Time.deltaTime; g.transform.localScale = Vector3.one * Mathf.Lerp(0.06f, 0.16f, t / 0.9f) * (1f - t / 0.9f * 0.9f); yield return null; }
        if (g != null) Destroy(g);
    }

    // ------------------------------------------------------------------ 1) preparar
    IEnumerator PrepRecipe(string kind, Vector3 tp, float T, List<GameObject> props)
    {
        switch (kind)
        {
            case "pizza": return PrepPizza(tp, T, props);
            case "burger": return PrepBurger(tp, T, props);
            case "fries": return PrepFries(tp, T, props);
            case "donut": return PrepDonut(tp, T, props);
            default: return PrepGeneric(tp, T, props);
        }
    }

    IEnumerator Knead(GameObject dough, Vector3 basePos, float dur)
    {
        float t = 0f;
        while (t < dur && dough != null)
        {
            t += Time.deltaTime; float s = Mathf.Sin(t * 9f);
            dough.transform.localScale = new Vector3(0.2f + 0.03f * s, 0.12f - 0.03f * s, 0.2f + 0.03f * s);      // bola de masa: más redonda y baja
            dough.transform.position = basePos + Vector3.up * (0.07f - 0.02f * s);
            if (chef != null)
            {   // las dos manos amasan sobre la masa, una empuja mientras la otra vuelve
                // las manos se apoyan sobre la masa (pegadas a sus costados y sobre su parte de arriba) y la empujan
                Vector3 r = chef.RightDir, f = chef.Forward, c = basePos + Vector3.up * 0.075f;
                float p1 = Mathf.Sin(t * 9f), p2 = Mathf.Sin(t * 9f + Mathf.PI);
                chef.Hands(c - r * 0.07f + f * (0.0f + 0.05f * p1) + Vector3.up * (0.0f + 0.025f * Mathf.Max(0f, p1)),
                           c + r * 0.07f + f * (0.0f + 0.05f * p2) + Vector3.up * (0.0f + 0.025f * Mathf.Max(0f, p2)));
            }
            yield return null;
        }
    }

    IEnumerator PrepPizza(Vector3 tp, float T, List<GameObject> props)
    {
        var dough = Prim(PrimitiveType.Sphere, new Color(0.95f, 0.88f, 0.7f), tp + Vector3.up * 0.08f, Vector3.zero, props);
        yield return Grow(dough, new Vector3(0.2f, 0.16f, 0.2f), 0.3f);
        yield return Knead(dough, tp, 0.38f * T);                              // AMASAR
        // se aplana hasta ser la base de la pizza
        float t = 0f; Vector3 from = dough.transform.localScale;
        while (t < 0.5f) { t += Time.deltaTime; float k = t / 0.5f; dough.transform.localScale = Vector3.Lerp(from, new Vector3(0.44f, 0.03f, 0.44f), k); dough.transform.position = tp + Vector3.up * Mathf.Lerp(0.07f, 0.02f, k); yield return null; }
        var disc = Prim(PrimitiveType.Cylinder, new Color(0.95f, 0.88f, 0.7f), tp + Vector3.up * 0.02f, new Vector3(0.44f, 0.015f, 0.44f), props); Destroy(dough); props.Remove(dough);
        yield return new WaitForSeconds(0.15f);
        var sauce = Prim(PrimitiveType.Cylinder, new Color(0.78f, 0.12f, 0.08f), tp + Vector3.up * 0.04f, Vector3.zero, props);   // SALSA
        yield return Grow(sauce, new Vector3(0.36f, 0.006f, 0.36f), 0.5f);
        for (int i = 0; i < 14; i++)                                           // QUESO rallado
        {
            Vector2 r = UnityEngine.Random.insideUnitCircle * 0.15f;
            var ch = Prim(PrimitiveType.Cube, new Color(1f, 0.85f, 0.3f), tp + new Vector3(r.x, 0.055f, r.y), Vector3.zero, props);
            StartCoroutine(Grow(ch, new Vector3(0.05f, 0.012f, 0.03f), 0.12f));
            if (i % 3 == 0) Burst(tp + new Vector3(r.x, 0.2f, r.y), new Color(1f, 0.85f, 0.3f), 3);
            if (chef != null) { chef.HandRight(tp + new Vector3(r.x, 0.17f, r.y)); chef.HandLeft(tp - chef.RightDir * 0.32f + chef.Forward * 0.02f + Vector3.up * 0.03f); }
            yield return new WaitForSeconds(0.05f);
        }
        for (int i = 0; i < 5; i++)                                            // PEPERONI
        {
            Vector2 r = UnityEngine.Random.insideUnitCircle * 0.13f;
            var pp = Prim(PrimitiveType.Cylinder, new Color(0.6f, 0.1f, 0.1f), tp + new Vector3(r.x, 0.07f, r.y), Vector3.zero, props);
            StartCoroutine(Grow(pp, new Vector3(0.06f, 0.008f, 0.06f), 0.15f));
            if (chef != null) { chef.HandRight(tp + new Vector3(r.x, 0.15f, r.y)); chef.HandLeft(tp - chef.RightDir * 0.32f + chef.Forward * 0.02f + Vector3.up * 0.03f); }
            yield return new WaitForSeconds(0.12f);
        }
        chef.HandsOff();
        yield return PizzaToPeel(tp, props);              // la pizza queda lista sobre la pala, en las manos del cocinero
    }

    // ------------------------------------------------------------------ manos trabajando (cortar con cuchillo / poner ingredientes)
    GameObject knifeObj;
    GameObject GetKnife()
    {
        if (knifeObj == null)
        {
            knifeObj = new GameObject("Cuchillo");
            var blade = Prim(PrimitiveType.Cube, new Color(0.82f, 0.84f, 0.88f), Vector3.zero, new Vector3(0.03f, 0.004f, 0.2f), null); blade.transform.SetParent(knifeObj.transform, false); blade.transform.localPosition = new Vector3(0f, 0f, 0.12f);
            var hand = Prim(PrimitiveType.Cube, new Color(0.15f, 0.12f, 0.1f), Vector3.zero, new Vector3(0.03f, 0.028f, 0.1f), null); hand.transform.SetParent(knifeObj.transform, false); hand.transform.localPosition = new Vector3(0f, 0f, -0.04f);
        }
        return knifeObj;
    }

    IEnumerator HandsWork(Vector3 at, float secs, bool knife)
    {
        if (chef == null) { yield return new WaitForSeconds(secs); yield break; }
        var kf = GetKnife(); kf.SetActive(knife);
        float t = 0f;
        while (t < secs)
        {
            t += Time.deltaTime;
            Vector3 r = chef.RightDir, f = chef.Forward, rh, lh;
            if (knife)
            {   // corta: la mano derecha sube y baja con el cuchillo, la izquierda sujeta
                float ph = Mathf.Sin(Time.time * 16f);
                rh = at + Vector3.up * (0.06f + 0.06f * ph) + f * 0.02f; lh = at - r * 0.13f + Vector3.up * 0.035f;
                kf.transform.position = rh; kf.transform.rotation = Quaternion.LookRotation((f + Vector3.down * 0.55f).normalized, Vector3.up);
            }
            else
            {   // pone los ingredientes: la derecha trabaja sobre el punto, la izquierda apoyada en la mesa
                float ph = Time.time * 5f;
                rh = at + Vector3.up * 0.12f + r * Mathf.Sin(ph) * 0.04f + f * Mathf.Cos(ph) * 0.03f; lh = at - r * 0.2f + Vector3.up * 0.03f;
            }
            chef.Hands(lh, rh);
            yield return null;
        }
        if (knife && kf != null) kf.SetActive(false);
    }

    IEnumerator PrepBurger(Vector3 tp, float T, List<GameObject> props)
    {
        Color tan = new Color(0.86f, 0.6f, 0.28f);
        var bunB = Prim(PrimitiveType.Sphere, tan, tp + new Vector3(-0.55f, 0.04f, 0f), Vector3.zero, props);
        var bunT = Prim(PrimitiveType.Sphere, tan, tp + new Vector3(-0.2f, 0.07f, 0f), Vector3.zero, props);
        StartCoroutine(Grow(bunB, new Vector3(0.3f, 0.09f, 0.3f), 0.3f));
        yield return Grow(bunT, new Vector3(0.3f, 0.16f, 0.3f), 0.3f);                       // PAN (partido)
        Burst(tp + new Vector3(-0.38f, 0.15f, 0f), tan, 5);
        // TOMATE: se corta en rodajas
        var tom = Prim(PrimitiveType.Sphere, new Color(0.85f, 0.15f, 0.1f), tp + new Vector3(0.2f, 0.07f, 0.0f), Vector3.zero, props);
        yield return Grow(tom, Vector3.one * 0.14f, 0.25f);
        for (int i = 0; i < 4; i++)
        {
            yield return HandsWork(tp + new Vector3(0.2f, 0.08f, 0f), 0.4f, true);              // corta el tomate con el cuchillo
            Burst(tp + new Vector3(0.2f, 0.14f, 0f), new Color(0.9f, 0.2f, 0.15f), 4);
            var sl = Prim(PrimitiveType.Cylinder, new Color(0.9f, 0.2f, 0.15f), tp + new Vector3(0.35f + i * 0.06f, 0.02f, 0.12f), Vector3.zero, props);
            StartCoroutine(Grow(sl, new Vector3(0.1f, 0.006f, 0.1f), 0.1f));
            tom.transform.localScale = Vector3.one * (0.14f - 0.03f * (i + 1));
        }
        Destroy(tom); props.Remove(tom);
        // LECHUGA
        for (int i = 0; i < 3; i++)
        {
            var le = Prim(PrimitiveType.Cylinder, new Color(0.35f, 0.75f, 0.2f), tp + new Vector3(0.1f + i * 0.09f, 0.025f, -0.15f), Vector3.zero, props);
            StartCoroutine(Grow(le, new Vector3(0.16f, 0.006f, 0.12f), 0.15f));
            Burst(tp + new Vector3(0.1f + i * 0.09f, 0.15f, -0.15f), new Color(0.4f, 0.8f, 0.25f), 3);
            yield return HandsWork(tp + new Vector3(0.1f + i * 0.09f, 0.03f, -0.15f), 0.3f, false);
        }
        // QUESO y SALSA
        var qu = Prim(PrimitiveType.Cube, new Color(1f, 0.82f, 0.25f), tp + new Vector3(-0.2f, 0.17f, 0f), Vector3.zero, props);
        yield return Grow(qu, new Vector3(0.26f, 0.012f, 0.26f), 0.2f);
        var ket = Prim(PrimitiveType.Cube, new Color(0.8f, 0.1f, 0.08f), tp + new Vector3(-0.2f, 0.185f, 0f), Vector3.zero, props);
        yield return Grow(ket, new Vector3(0.2f, 0.01f, 0.03f), 0.3f);
    }

    IEnumerator PrepFries(Vector3 tp, float T, List<GameObject> props)
    {
        Color pot = new Color(0.8f, 0.65f, 0.35f);
        for (int p = 0; p < 3; p++)
        {
            var po = Prim(PrimitiveType.Capsule, pot, tp + new Vector3(-0.4f + p * 0.14f, 0.06f, 0f), Vector3.zero, props);
            StartCoroutine(Grow(po, new Vector3(0.09f, 0.07f, 0.09f), 0.2f));
            yield return new WaitForSeconds(0.12f);
        }
        yield return new WaitForSeconds(0.2f);
        int sticks = 18;
        for (int i = 0; i < sticks; i++)                                       // CORTAR en bastones
        {
            if (i % 6 == 0 && i / 6 < 3 && props[i / 6] != null) Destroy(props[i / 6]);   // cada papa se "gasta" al cortarla
            Burst(tp + new Vector3(-0.3f, 0.12f, 0f), pot, 2);
            var st = Prim(PrimitiveType.Cube, new Color(0.98f, 0.82f, 0.3f), tp + new Vector3(0.0f + (i % 6) * 0.06f, 0.02f + (i / 6) * 0.02f, 0.05f - (i / 6) * 0.04f), Vector3.zero, props);
            StartCoroutine(Grow(st, new Vector3(0.025f, 0.025f, 0.14f), 0.1f));
            yield return HandsWork(tp + new Vector3(-0.3f + (i % 6) * 0.03f, 0.07f, 0f), 0.18f, true);   // corta la papa en bastones
        }
    }

    IEnumerator PrepDonut(Vector3 tp, float T, List<GameObject> props)
    {
        Color tan = new Color(0.95f, 0.82f, 0.55f);
        var dough = Prim(PrimitiveType.Sphere, tan, tp + Vector3.up * 0.08f, Vector3.zero, props);
        yield return Grow(dough, new Vector3(0.2f, 0.16f, 0.2f), 0.3f);
        yield return Knead(dough, tp, 0.4f * T);                               // AMASAR
        Destroy(dough); props.Remove(dough);
        for (int i = 0; i < 10; i++)                                           // ARMAR el aro
        {
            float a = i / 10f * Mathf.PI * 2f;
            var b = Prim(PrimitiveType.Sphere, tan, tp + new Vector3(Mathf.Cos(a) * 0.09f, 0.04f, Mathf.Sin(a) * 0.09f), Vector3.zero, props);
            StartCoroutine(Grow(b, Vector3.one * 0.095f, 0.12f));
            yield return HandsWork(tp + new Vector3(Mathf.Cos(a) * 0.09f, 0.04f, Mathf.Sin(a) * 0.09f), 0.1f, false);
        }
        for (int i = 0; i < 10; i++)                                           // GLASEADO rosa
        {
            float a = i / 10f * Mathf.PI * 2f;
            var b = Prim(PrimitiveType.Sphere, new Color(1f, 0.45f, 0.65f), tp + new Vector3(Mathf.Cos(a) * 0.09f, 0.075f, Mathf.Sin(a) * 0.09f), Vector3.zero, props);
            StartCoroutine(Grow(b, new Vector3(0.1f, 0.05f, 0.1f), 0.12f));
            yield return new WaitForSeconds(0.05f);
        }
        Color[] sp = { Color.white, new Color(1f, 0.9f, 0.2f), new Color(0.3f, 0.7f, 1f), new Color(0.5f, 1f, 0.5f) };
        for (int i = 0; i < 12; i++)                                           // CONFITES
        {
            float a = UnityEngine.Random.value * Mathf.PI * 2f;
            var c = Prim(PrimitiveType.Cube, sp[i % sp.Length], tp + new Vector3(Mathf.Cos(a) * 0.09f, 0.11f, Mathf.Sin(a) * 0.09f), Vector3.zero, props);
            StartCoroutine(Grow(c, new Vector3(0.012f, 0.012f, 0.03f), 0.08f));
            yield return HandsWork(tp + new Vector3(Mathf.Cos(a) * 0.09f, 0.11f, Mathf.Sin(a) * 0.09f), 0.08f, false);
        }
    }

    IEnumerator PrepGeneric(Vector3 tp, float T, List<GameObject> props)
    {
        Color[] cs = { new Color(0.9f, 0.2f, 0.15f), new Color(0.4f, 0.8f, 0.25f), new Color(1f, 0.85f, 0.3f) };
        for (int i = 0; i < 3; i++)
        {
            var g = Prim(PrimitiveType.Cube, cs[i], tp + new Vector3(-0.2f + i * 0.2f, 0.05f, 0f), Vector3.zero, props);
            StartCoroutine(Grow(g, Vector3.one * 0.09f, 0.2f));
            yield return new WaitForSeconds(0.25f);
            Burst(g.transform.position + Vector3.up * 0.1f, cs[i], 4);
            yield return new WaitForSeconds(0.25f);
        }
    }

    // ------------------------------------------------------------------ 2) cocinar
    IEnumerator CookEffects(Dish d, int st, int n, float T)
    {
        cookingFood.Clear();
        if (st == 3 && realOven && pizzaObj != null && peelObj != null) { yield return OvenPeelSequence(T); yield break; }   // pizza: con pala
        Vector3 fp = foodPoint[st];
        var tmp = new List<GameObject>();
        var rends = new List<Renderer>();
        var pattyMats = new List<Material>();
        bool patty = d.kind == "burger";        // en la plancha se cocina SOLO la carne; después se arma en el pan
        bool oven = st == 3, fryer = st == 2;

        for (int i = 0; i < n; i++)
        {
            Vector3 pos = fp + new Vector3((i - (n - 1) * 0.5f) * 0.3f, 0f, 0f);
            GameObject f;
            if (patty)
            {
                f = Prim(PrimitiveType.Cylinder, new Color(0.78f, 0.4f, 0.34f), pos, Vector3.zero, null); f.name = "Carne";
                var pm = new Material(lit); pm.SetColor("_BaseColor", new Color(0.78f, 0.4f, 0.34f)); pm.SetFloat("_Smoothness", 0.3f); f.GetComponent<Renderer>().sharedMaterial = pm; pattyMats.Add(pm); tempMats.Add(pm);
                StartCoroutine(Grow(f, new Vector3(0.2f, 0.03f, 0.2f), 0.35f));
            }
            else
            {
                if (d.prefab == null) continue;
                f = Instantiate(d.prefab, pos, Quaternion.identity);
                if (foodMaterial != null)
                    foreach (var r in f.GetComponentsInChildren<Renderer>())
                    {
                        var arr = new Material[r.sharedMaterials.Length];
                        for (int m = 0; m < arr.Length; m++) arr[m] = foodMaterial;
                        r.sharedMaterials = arr; rends.Add(r);
                    }
                StartCoroutine(Grow(f, Vector3.one * d.scale, 0.35f));
            }
            cookingFood.Add(f);
        }

        // Barra de progreso encima
        Vector3 barPos = fp + new Vector3(0f, 0.6f, 0.05f);
        var barBack = Prim(PrimitiveType.Cube, new Color(0.1f, 0.1f, 0.1f), barPos, new Vector3(0.46f, 0.07f, 0.02f), tmp);
        var barFill = Prim(PrimitiveType.Cube, new Color(0.3f, 0.9f, 0.35f), barPos + Vector3.back * 0.012f, new Vector3(0.001f, 0.05f, 0.02f), tmp);

        GameObject basket = null;
        if (fryer)   // canasta con las papas
        {
            basket = Prim(PrimitiveType.Cube, new Color(0.25f, 0.25f, 0.28f), fp + new Vector3(0f, 0.3f, 0f), new Vector3(0.36f, 0.05f, 0.26f), tmp);
            var handle = Prim(PrimitiveType.Cube, new Color(0.15f, 0.15f, 0.17f), fp + new Vector3(0f, 0.3f, 0.2f), new Vector3(0.03f, 0.03f, 0.34f), tmp); handle.transform.SetParent(basket.transform, true);
        }
        Vector3 ovenIn = realOven ? ovenInPoint : new Vector3(foodPoint[3].x, 1.25f, -2.85f);
        float tOpen = 0.55f, tIn = 1.2f, tClose = 1.75f, tOut1 = T - 1.5f, tOut2 = T - 0.9f, tEnd = T - 0.4f;
        bool flipDone = false; float fx = 0f, t = 0f;
        while (t < T)
        {
            t += Time.deltaTime; fx += Time.deltaTime; float k = Mathf.Clamp01(t / T);
            // la barra se llena
            if (barFill != null) { var s = barFill.transform.localScale; s.x = Mathf.Max(0.001f, 0.44f * k); barFill.transform.localScale = s; barFill.transform.position = barPos + new Vector3(-0.22f + s.x * 0.5f, 0f, -0.012f); }
            // se va dorando
            Color tint = Color.Lerp(new Color(1.15f, 1.12f, 1.1f), new Color(0.82f, 0.66f, 0.5f), k);
            if (mpbShared == null) mpbShared = new MaterialPropertyBlock();
            foreach (var r in rends) if (r != null) { r.GetPropertyBlock(mpbShared); mpbShared.SetColor("_BaseColor", tint); r.SetPropertyBlock(mpbShared); }
            foreach (var pm in pattyMats) pm.SetColor("_BaseColor", Color.Lerp(new Color(0.78f, 0.4f, 0.34f), new Color(0.3f, 0.17f, 0.1f), k));

            if (oven)
            {
                // puerta: se abre, entra la comida, se cierra, se cocina con brillo, se abre, sale, se cierra
                float ang = t < tOpen ? Mathf.Lerp(0f, 90f, t / tOpen) : t < tIn ? 90f : t < tClose ? Mathf.Lerp(90f, 0f, (t - tIn) / (tClose - tIn))
                          : t < tOut1 ? 0f : t < tOut2 ? Mathf.Lerp(0f, 90f, (t - tOut1) / (tOut2 - tOut1)) : t < tEnd ? 90f : Mathf.Lerp(90f, 0f, (t - tEnd) / 0.4f);
                SetOvenDoor(ang);
                bool cooking = t >= tClose && t < tOut1;
                if (ovenWindow != null) { ovenWindow.SetActive(cooking); if (cooking) ovenWindow.GetComponent<Renderer>().sharedMaterial.SetColor("_BaseColor", Color.Lerp(new Color(1f, 0.35f, 0.05f), new Color(1f, 0.7f, 0.2f), 0.5f + 0.5f * Mathf.Sin(t * 10f))); }
                if (ovenLight != null) ovenLight.intensity = cooking ? 3f + Mathf.Sin(t * 14f) * 0.8f : 0f;
                foreach (var f in cookingFood)
                {
                    if (f == null) continue;
                    Vector3 p; float sc = d.scale;
                    if (t < tOpen) p = fp;
                    else if (t < tIn) { float q = (t - tOpen) / (tIn - tOpen); p = Vector3.Lerp(fp, ovenIn, q); sc = Mathf.Lerp(d.scale, d.scale * 0.55f, q); }
                    else if (t < tOut1) { p = ovenIn; sc = d.scale * 0.55f; }
                    else if (t < tOut2) { float q = (t - tOut1) / (tOut2 - tOut1); p = Vector3.Lerp(ovenIn, fp, q); sc = Mathf.Lerp(d.scale * 0.55f, d.scale, q); }
                    else { p = fp; }
                    bool hidden = t >= tIn + 0.05f && t < tOut1 + 0.05f;
                    foreach (var r in f.GetComponentsInChildren<Renderer>()) r.enabled = !hidden;
                    f.transform.position = p; f.transform.localScale = Vector3.one * sc;
                }
            }
            else
            {
                for (int i = 0; i < cookingFood.Count; i++)
                {
                    var f = cookingFood[i]; if (f == null) continue;
                    var p = f.transform.position;
                    if (fryer && basket != null)
                    {
                        float by = t < 0.7f ? Mathf.Lerp(fp.y + 0.3f, fp.y - 0.02f, t / 0.7f) : (t > T - 0.8f ? Mathf.Lerp(fp.y - 0.02f, fp.y + 0.3f, (t - (T - 0.8f)) / 0.8f) + Mathf.Sin(t * 30f) * 0.01f : fp.y - 0.02f);
                        var bp = basket.transform.position; bp.y = by; basket.transform.position = bp;
                        p.y = by + 0.06f;
                    }
                    else p.y = fp.y + Mathf.Abs(Mathf.Sin(t * 4f + i)) * 0.02f;
                    f.transform.position = p;
                    // la carne se da vuelta a mitad de cocción
                    if (patty && !flipDone && t > T * 0.5f) { flipDone = true; StartCoroutine(Flip(f.transform, fp.y)); }
                }
            }
            if (fx > 0.12f)
            {
                fx = 0f;
                if (st == 0) Burst(fp + Vector3.up * 0.05f, new Color(1f, 0.9f, 0.6f), 2);
                if (st == 1) for (int a = 0; a < 3; a++) { float ang2 = UnityEngine.Random.value * 6.28f; var fl = Prim(PrimitiveType.Sphere, new Color(1f, 0.5f, 0.1f), fp + new Vector3(Mathf.Cos(ang2) * 0.17f, -0.08f, Mathf.Sin(ang2) * 0.17f), Vector3.one * 0.05f, null); StartCoroutine(Flame(fl)); }
                if (fryer) { var bub = Prim(PrimitiveType.Sphere, new Color(1f, 0.95f, 0.7f), fp + new Vector3(UnityEngine.Random.Range(-0.25f, 0.25f), -0.07f, UnityEngine.Random.Range(-0.15f, 0.15f)), Vector3.one * 0.04f, null); StartCoroutine(Rise(bub)); }
                if (!oven || (t >= tClose && t < tOut1)) StartCoroutine(Steam(oven ? new Vector3(fp.x, 1.55f, -2.9f) : fp + Vector3.up * 0.1f, 0.12f));
            }
            yield return null;
        }
        SetOvenDoor(0f);
        if (ovenWindow != null) ovenWindow.SetActive(false);
        if (ovenLight != null) ovenLight.intensity = 0f;
        foreach (var f in cookingFood) if (f != null) foreach (var r in f.GetComponentsInChildren<Renderer>()) r.enabled = true;
        Burst(fp + Vector3.up * 0.25f, new Color(1f, 0.9f, 0.3f), 12);
        foreach (var g in tmp) if (g != null) Destroy(g);
    }

    IEnumerator Flip(Transform f, float baseY)
    {
        float q = 0f;
        while (q < 0.5f && f != null) { q += Time.deltaTime; float k = q / 0.5f; var p = f.position; p.y = baseY + Mathf.Sin(k * Mathf.PI) * 0.4f; f.position = p; f.rotation = Quaternion.Euler(360f * k, 0f, 0f); yield return null; }
        if (f != null) f.rotation = Quaternion.identity;
    }

    IEnumerator Flame(GameObject g)
    {
        float t = 0f;
        while (t < 0.35f && g != null) { t += Time.deltaTime; g.transform.localScale = Vector3.one * Mathf.Lerp(0.06f, 0.01f, t / 0.35f); g.transform.position += Vector3.up * 0.25f * Time.deltaTime; yield return null; }
        if (g != null) Destroy(g);
    }

    float doorClosedAngle, doorOpenAngle = 45f, doorAng;
    // ang: 0 = cerrada, 90 = abierta del todo (igual que el horno viejo). En el horno real el modelo viene a medio abrir:
    // se cierra girando hacia atrás y se abre del todo hacia abajo (como una puerta de horno de pizza) para que entre la pala.
    void SetOvenDoor(float ang)
    {
        doorAng = ang;
        if (ovenDoor == null) return;
        if (realOven) ovenDoor.localRotation = Quaternion.Euler(Mathf.Lerp(-doorClosedAngle, doorOpenAngle, Mathf.Clamp01(ang / 90f)), 0f, 0f);
        else ovenDoor.localRotation = Quaternion.Euler(ang, 0f, 0f);
    }

    IEnumerator DoorTo(float to, float dur)
    {
        float from = doorAng, t = 0f;
        while (t < dur) { t += Time.deltaTime; SetOvenDoor(Mathf.Lerp(from, to, Mathf.SmoothStep(0f, 1f, t / dur))); yield return null; }
        SetOvenDoor(to);
    }

    IEnumerator PeelTo(Vector3 to, float dur) { peelFollow = false; yield return MovePeel(to, dur); }

    // Horno real con pala: abre, mete la pizza, retira la pala, cierra y cocina con brillo; después abre, la saca con la pala, y cierra.
    IEnumerator OvenPeelSequence(float T)
    {
        float t0 = Time.time;
        Vector3 inPeel = ovenInPoint - Vector3.up * 0.013f;
        var discs = new List<Renderer>(); var origin = new List<Color>();
        foreach (var r in pizzaObj.GetComponentsInChildren<Renderer>()) { discs.Add(r); origin.Add(r.sharedMaterial.GetColor("_BaseColor")); }
        if (mpbShared == null) mpbShared = new MaterialPropertyBlock();
        handsOnPeel = true;
        yield return DoorTo(90f, 0.7f);                                  // abre la puerta
        yield return PeelTo(inPeel, 1.0f);                                // mete la pala con la pizza
        pizzaOnPeel = false;                                              // la pizza queda en la parrilla
        yield return MovePeel(PeelChest(), 0.8f); peelFollow = true;      // retira la pala
        yield return DoorTo(0f, 0.7f);                                    // cierra la puerta
        float cookEnd = t0 + T - 4.0f;
        while (Time.time < cookEnd)                                       // se cocina con brillo y se va dorando
        {
            float k = Mathf.Clamp01((Time.time - t0) / Mathf.Max(0.1f, T - 4f));
            if (ovenLight != null) ovenLight.intensity = 3f + Mathf.Sin(Time.time * 14f) * 0.8f;
            for (int i = 0; i < discs.Count; i++)
                if (discs[i] != null) { discs[i].GetPropertyBlock(mpbShared); mpbShared.SetColor("_BaseColor", Color.Lerp(origin[i], origin[i] * new Color(0.86f, 0.68f, 0.45f, 1f), k)); discs[i].SetPropertyBlock(mpbShared); }
            yield return null;
        }
        if (ovenLight != null) ovenLight.intensity = 0f;
        yield return DoorTo(90f, 0.7f);
        yield return PeelTo(inPeel, 0.9f);                                // la pala entra por debajo de la pizza
        pizzaOnPeel = true;
        yield return MovePeel(PeelChest(), 0.9f); peelFollow = true;      // la saca al frente del pecho (sin atravesarlo)
        yield return DoorTo(0f, 0.7f);
    }

    // Empacar la pizza: se apoya la pala en la mesa junto a la caja, las manos levantan la pizza por los bordes y la bajan a la caja
    IEnumerator PackPizza(BoxParts bp)
    {
        Vector3 onTable = new Vector3(packStand.x - 0.5f, 0.906f, 0.72f);
        yield return PeelTo(onTable, 0.7f);
        handsOnPeel = false;
        yield return new WaitForSeconds(0.25f);
        pizzaOnPeel = false;
        Vector3 from = pizzaObj.transform.position, to = bp.content.position;      // la pizza queda apoyada en el fondo de la caja
        Vector3 r = chef.RightDir; float t = 0f, dur = 1.1f;
        while (t < dur)
        {
            t += Time.deltaTime; float k = Mathf.SmoothStep(0f, 1f, t / dur);
            Vector3 p = Vector3.Lerp(from, to, k); p.y += Mathf.Sin(k * Mathf.PI) * 0.16f;
            pizzaObj.transform.position = p;
            chef.Hands(p - r * 0.2f - Vector3.up * 0.01f, p + r * 0.2f - Vector3.up * 0.01f);       // las manos agarran la pizza por los bordes (a la altura de la masa)
            yield return null;
        }
        chef.HandsOff();
        pizzaObj.transform.SetParent(bp.content, true);                  // la pizza queda dentro de la caja (la limpia la caja)
        pizzaObj = null;
        if (peelObj != null) { Destroy(peelObj); peelObj = null; peelGrip = null; }
    }

    // Puerta del horno (siempre presente, cerrada) con ventanita de brillo
    void BuildOvenDoor()
    {
        float x = foodPoint[3].x;
        if (realOven)
        {   // Horno real: la puerta del modelo (pieza "group_51", viene abierta) gira desde su bisagra; el brillo de brasas va por dentro
            var rl = new GameObject("BrilloHorno"); rl.transform.position = ovenInPoint + new Vector3(0f, 0.1f, 0.25f); ovenLight = rl.AddComponent<Light>();
            ovenLight.type = LightType.Point; ovenLight.color = new Color(1f, 0.55f, 0.15f); ovenLight.range = 1.8f; ovenLight.intensity = 0f;
            var cocina = GameObject.Find("Cocina"); var horno = cocina != null ? cocina.transform.Find("HornoReal") : null;
            Transform doorT = null;
            if (horno != null) foreach (var tt in horno.GetComponentsInChildren<Transform>(true)) if (tt.name == "group_51") { doorT = tt; break; }
            if (doorT != null)
            {
                var drs = doorT.GetComponentsInChildren<Renderer>(); Bounds db = drs[0].bounds; foreach (var dr in drs) db.Encapsulate(dr.bounds);
                // bisagra: borde de abajo pegado al horno (z más chico), al medio del ancho
                var hinge = new GameObject("PuertaHornoReal").transform; hinge.position = new Vector3(db.center.x, db.min.y, db.min.z);
                doorT.SetParent(hinge, true);
                float phi = Mathf.Atan2(db.size.y, db.size.z) * Mathf.Rad2Deg;      // cuánto sube la puerta abierta sobre la horizontal
                doorClosedAngle = 90f - phi;
                doorOpenAngle = phi + 15f;                                          // abierta del todo: 15 grados por debajo de la horizontal
                ovenDoor = hinge; SetOvenDoor(0f);
            }
            return;
        }
        var pivot = new GameObject("PuertaHorno").transform; pivot.position = new Vector3(x, 1.04f, -2.655f);
        ovenDoor = pivot;
        var door = Prim(PrimitiveType.Cube, new Color(0.12f, 0.12f, 0.14f), pivot.position + new Vector3(0f, 0.17f, 0f), new Vector3(0.54f, 0.34f, 0.025f), null); door.transform.SetParent(pivot, true);
        var handle = Prim(PrimitiveType.Cube, new Color(0.8f, 0.8f, 0.85f), pivot.position + new Vector3(0f, 0.32f, 0.03f), new Vector3(0.4f, 0.02f, 0.02f), null); handle.transform.SetParent(pivot, true);
        var unlit = Shader.Find("Universal Render Pipeline/Unlit");
        var wm = new Material(unlit != null ? unlit : lit); wm.SetColor("_BaseColor", new Color(1f, 0.45f, 0.1f));
        ovenWindow = GameObject.CreatePrimitive(PrimitiveType.Cube); Destroy(ovenWindow.GetComponent<Collider>());
        ovenWindow.GetComponent<Renderer>().sharedMaterial = wm; ovenWindow.transform.SetParent(pivot, true);
        ovenWindow.transform.position = pivot.position + new Vector3(0f, 0.16f, 0.018f); ovenWindow.transform.localScale = new Vector3(0.4f, 0.2f, 0.005f);
        ovenWindow.SetActive(false);
        var lg = new GameObject("BrilloHorno"); lg.transform.position = new Vector3(x, 1.3f, -2.45f); ovenLight = lg.AddComponent<Light>();
        ovenLight.type = LightType.Point; ovenLight.color = new Color(1f, 0.55f, 0.15f); ovenLight.range = 2.2f; ovenLight.intensity = 0f;
    }
    // ------------------------------------------------------------------ 3) embalar
    class BoxParts { public GameObject root; public Transform lid; public Transform content; public float h; }
    readonly Dictionary<GameObject, BoxParts> boxes = new Dictionary<GameObject, BoxParts>();

    GameObject MakeBox(string kind, string user, Vector3 pos)
    {
        Vector3 size = kind == "pizza" ? new Vector3(0.52f, 0.07f, 0.52f) : kind == "fries" ? new Vector3(0.26f, 0.16f, 0.2f) : new Vector3(0.3f, 0.13f, 0.3f);
        Color kraft = kind == "pizza" ? new Color(0.92f, 0.88f, 0.8f) : new Color(0.78f, 0.58f, 0.34f);
        var root = new GameObject("Caja_" + user); root.transform.position = pos;
        if (kind == "pizza") size.y = 0.13f;       // la pizza (con sus ingredientes) tiene que entrar adentro y la tapa cerrar encima
        // Caja hueca: fondo + 4 paredes finas (antes era un bloque sólido y la comida quedaba encima)
        float wall = 0.014f;
        var fondo = Prim(PrimitiveType.Cube, kraft, pos + Vector3.up * (wall * 0.5f), new Vector3(size.x, wall, size.z), null); fondo.transform.SetParent(root.transform, true);
        var pIzq = Prim(PrimitiveType.Cube, kraft, pos + new Vector3(-size.x * 0.5f + wall * 0.5f, size.y * 0.5f, 0f), new Vector3(wall, size.y, size.z), null); pIzq.transform.SetParent(root.transform, true);
        var pDer = Prim(PrimitiveType.Cube, kraft, pos + new Vector3(size.x * 0.5f - wall * 0.5f, size.y * 0.5f, 0f), new Vector3(wall, size.y, size.z), null); pDer.transform.SetParent(root.transform, true);
        var pFre = Prim(PrimitiveType.Cube, kraft, pos + new Vector3(0f, size.y * 0.5f, -size.z * 0.5f + wall * 0.5f), new Vector3(size.x, size.y, wall), null); pFre.transform.SetParent(root.transform, true);
        var pAtr = Prim(PrimitiveType.Cube, kraft, pos + new Vector3(0f, size.y * 0.5f, size.z * 0.5f - wall * 0.5f), new Vector3(size.x, size.y, wall), null); pAtr.transform.SetParent(root.transform, true);
        // tapa con bisagra atrás
        var hinge = new GameObject("Bisagra"); hinge.transform.SetParent(root.transform, true);
        hinge.transform.position = pos + new Vector3(0f, size.y, size.z * 0.5f);
        var lid = Prim(PrimitiveType.Cube, kraft * 0.95f, hinge.transform.position + new Vector3(0f, 0.01f, -size.z * 0.5f), new Vector3(size.x, 0.02f, size.z), null);
        lid.transform.SetParent(hinge.transform, true);
        hinge.transform.localRotation = Quaternion.Euler(-125f, 0f, 0f);       // bien abierta
        // etiqueta de color del cliente (color por nombre)
        float hue = Mathf.Abs(user.GetHashCode() % 100) / 100f;
        var tag = Prim(PrimitiveType.Cube, Color.HSVToRGB(hue, 0.75f, 0.95f), lid.transform.position + new Vector3(0f, 0.015f, 0f), new Vector3(size.x * 0.4f, 0.01f, size.z * 0.25f), null);
        tag.transform.SetParent(hinge.transform, true);
        var content = new GameObject("Contenido"); content.transform.SetParent(root.transform, true); content.transform.position = pos + Vector3.up * (wall + 0.005f);   // apoyado en el fondo, adentro de la caja
        boxes[root] = new BoxParts { root = root, lid = hinge.transform, content = content.transform, h = size.y + 0.03f };
        return root;
    }

    IEnumerator PackSequence(GameObject box, Dish d, float T)
    {
        var bp = boxes[box];
        string kind = d.kind;
        yield return new WaitForSeconds(0.2f);
        var foods = new List<GameObject>(cookingFood); cookingFood.Clear();

        if (kind == "burger")
        {
            // La carne cocinada se pone en el pan y se arma la hamburguesa
            Vector3 asm = new Vector3(packStand.x - 0.55f, 0.9f, 0.72f);
            var parts = new List<GameObject>();
            Color tan = new Color(0.86f, 0.6f, 0.28f);
            var bunB = Prim(PrimitiveType.Sphere, tan, asm + Vector3.up * 0.04f, Vector3.zero, parts); yield return Grow(bunB, new Vector3(0.3f, 0.09f, 0.3f), 0.25f);
            float y = asm.y + 0.09f;
            foreach (var f in foods)                                              // la carne viaja a la plancha -> pan
            {
                if (f == null) continue;
                Vector3 from = f.transform.position, to = new Vector3(asm.x, y + 0.02f, asm.z); float q = 0f;
                while (q < 0.7f) { q += Time.deltaTime; float k = Mathf.SmoothStep(0f, 1f, q / 0.7f); var p = Vector3.Lerp(from, to, k); p.y += Mathf.Sin(k * Mathf.PI) * 0.6f; f.transform.position = p; yield return null; }
                y += 0.05f; parts.Add(f);
            }
            var qu = Prim(PrimitiveType.Cube, new Color(1f, 0.82f, 0.25f), new Vector3(asm.x, y + 0.01f, asm.z), Vector3.zero, parts); yield return Grow(qu, new Vector3(0.26f, 0.012f, 0.26f), 0.15f); y += 0.02f;
            for (int i = 0; i < 2; i++) { var tm = Prim(PrimitiveType.Cylinder, new Color(0.9f, 0.2f, 0.15f), new Vector3(asm.x + (i - 0.5f) * 0.07f, y + 0.01f, asm.z), Vector3.zero, parts); yield return Grow(tm, new Vector3(0.1f, 0.006f, 0.1f), 0.12f); y += 0.015f; }
            var le = Prim(PrimitiveType.Cylinder, new Color(0.35f, 0.75f, 0.2f), new Vector3(asm.x, y + 0.01f, asm.z), Vector3.zero, parts); yield return Grow(le, new Vector3(0.2f, 0.006f, 0.16f), 0.12f); y += 0.015f;
            var bunT = Prim(PrimitiveType.Sphere, tan, new Vector3(asm.x, y + 0.2f, asm.z), new Vector3(0.3f, 0.16f, 0.3f), parts);   // la tapa del pan cae encima
            float dq = 0f; while (dq < 0.3f) { dq += Time.deltaTime; var p = bunT.transform.position; p.y = Mathf.Lerp(y + 0.2f, y + 0.07f, dq / 0.3f); bunT.transform.position = p; yield return null; }
            Burst(new Vector3(asm.x, y + 0.1f, asm.z), tan, 6);
            foreach (var g in parts) if (g != null) Destroy(g);
            // la hamburguesa terminada
            foods.Clear();
            if (d.prefab != null)
            {
                var burger = Instantiate(d.prefab, new Vector3(asm.x, asm.y + 0.02f, asm.z), Quaternion.identity);
                if (foodMaterial != null) foreach (var r in burger.GetComponentsInChildren<Renderer>()) { var arr = new Material[r.sharedMaterials.Length]; for (int m = 0; m < arr.Length; m++) arr[m] = foodMaterial; r.sharedMaterials = arr; }
                yield return Grow(burger, Vector3.one * d.scale, 0.3f);
                foods.Add(burger);
            }
            yield return new WaitForSeconds(0.2f);
        }

        // Pizza: la pala se apoya en la mesa y las manos levantan la pizza a la caja
        if (kind == "pizza" && pizzaObj != null && peelObj != null) yield return PackPizza(bp);

        // La comida se pone dentro de la caja abierta, llevada por las manos
        float t = 0f; var starts = new List<Vector3>(); foreach (var f in foods) starts.Add(f != null ? f.transform.position : Vector3.zero);
        float flight = foods.Count > 0 ? 1.0f : 0f;
        while (t < flight)
        {
            t += Time.deltaTime; float k = Mathf.SmoothStep(0f, 1f, t / flight);
            for (int i = 0; i < foods.Count; i++)
            {
                if (foods[i] == null) continue;
                Vector3 to = bp.content.position + new Vector3((i - (foods.Count - 1) * 0.5f) * 0.12f, 0.03f, 0f);
                Vector3 p = Vector3.Lerp(starts[i], to, k); p.y += Mathf.Sin(k * Mathf.PI) * 0.22f;
                foods[i].transform.position = p;
            }
            if (foods.Count > 0 && foods[0] != null && chef != null)
            {   // las manos agarran la comida y la llevan a la caja
                Vector3 c0 = foods[0].transform.position, rr = chef.RightDir;
                chef.Hands(c0 - rr * 0.13f + Vector3.up * 0.03f, c0 + rr * 0.13f + Vector3.up * 0.03f);
            }
            yield return null;
        }
        if (chef != null) chef.HandsOff();
        foreach (var f in foods) if (f != null) { f.transform.SetParent(bp.content, true); f.transform.localScale *= (kind == "pizza" ? 0.95f : 0.6f); }
        yield return new WaitForSeconds(0.7f);       // la comida se ve dentro de la caja abierta
        // Cierra la tapa
        t = 0f; Quaternion lidFrom = bp.lid.localRotation;
        while (t < 0.8f) { t += Time.deltaTime; bp.lid.localRotation = Quaternion.Slerp(lidFrom, Quaternion.identity, t / 0.8f); yield return null; }
        Burst(bp.root.transform.position + Vector3.up * 0.2f, new Color(1f, 0.85f, 0.3f), 8);
    }
    // ------------------------------------------------------------------ 4) entregar
    IEnumerator Deliver(GameObject box)
    {
        var bp = boxes[box];
        float level = 0f; foreach (var b in stack) level += b.h;
        Vector3 to = stackBase + new Vector3(0f, level + bp.h * 0.0f, 0f);
        Vector3 from = box.transform.position;
        float t = 0f, dur = 1.0f;
        while (t < dur)
        {
            t += Time.deltaTime; float k = Mathf.SmoothStep(0f, 1f, t / dur);
            Vector3 p = Vector3.Lerp(from, to, k); p.y += Mathf.Sin(k * Mathf.PI) * 0.5f;
            box.transform.position = p;
            yield return null;
        }
        box.transform.position = to;
        stack.Add(new Box { go = box, h = bp.h });
        if (stack.Count > 7) { boxes.Remove(stack[0].go); Destroy(stack[0].go); stack.RemoveAt(0); Restack(); }
        yield return new WaitForSeconds(0.6f);
    }

    void Restack()
    {
        float level = 0f;
        foreach (var b in stack) { if (b.go != null) b.go.transform.position = stackBase + new Vector3(0f, level, 0f); level += b.h; }
    }
}
