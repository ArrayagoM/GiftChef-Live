using System.Collections.Generic;
using UnityEngine;

// Controla al cocinero: camina a un puesto (rodeando los muebles), hace una animación de trabajo y avisa cuando termina.
// Requiere un Animator con: Speed (float) y triggers Chop, Work, Cheer, Wave, Throw.
[RequireComponent(typeof(Animator))]
public class ChefAnimator : MonoBehaviour
{
    public Vector3 homePosition;
    public float walkSpeed = 1.9f;
    public float turnSpeed = 540f;
    public float cookYaw = 140f;          // hacia dónde mira mientras trabaja (grados)

    Animator anim;
    enum State { Idle, GoToStation, Cooking, Return }
    State state = State.Idle;
    Vector3 stationPos;
    float cookTimeLeft;
    string cookTrigger = "Chop";
    float retrigger;
    bool returnAfter = true;
    List<Vector3> path = new List<Vector3>();
    int pathIndex;

    bool talking; Vector3 baseScale; float talkT;
    void Awake() { anim = GetComponent<Animator>(); baseScale = transform.localScale; }

    /// Mientras habla, el cuerpo late suavemente (la voz sale de la página del panel).
    public void Talk(bool on) { talking = on; if (!on) transform.localScale = baseScale; }
    void Start() { if (homePosition == Vector3.zero) homePosition = transform.position; }

    // ------------------------------------------------------------------ manos (IK)
    // El cocinero puede poner las manos sobre un objeto (masa, pala, comida). Las posiciones son del mundo.
    Vector3 lTarget, rTarget; float lW, rW, lGoal, rGoal;
    float chefHeight;

    public void Hands(Vector3 left, Vector3 right) { lTarget = left; rTarget = right; lGoal = rGoal = 1f; }
    public void HandLeft(Vector3 p) { lTarget = p; lGoal = 1f; }
    public void HandRight(Vector3 p) { rTarget = p; rGoal = 1f; }
    public void HandsOff() { lGoal = rGoal = 0f; }
    public bool HandsActive { get { return lGoal > 0f || rGoal > 0f; } }

    public Vector3 Forward { get { var f = transform.forward; f.y = 0f; return f.sqrMagnitude < 0.0001f ? Vector3.forward : f.normalized; } }
    public Vector3 RightDir { get { var r = transform.right; r.y = 0f; return r.sqrMagnitude < 0.0001f ? Vector3.right : r.normalized; } }
    public float Height
    {
        get
        {
            if (chefHeight <= 0f)
            {
                bool first = true; Bounds b = new Bounds(transform.position, Vector3.zero);
                foreach (var r in GetComponentsInChildren<Renderer>()) { if (first) { b = r.bounds; first = false; } else b.Encapsulate(r.bounds); }
                chefHeight = first ? 1.8f : Mathf.Max(1.0f, b.size.y);
            }
            return chefHeight;
        }
    }

    float leanNow; public float leanDeg = 26f;

    void OnAnimatorIK(int layerIndex)
    {
        if (anim == null) return;
        float dt = Time.deltaTime;
        lW = Mathf.MoveTowards(lW, lGoal, dt * 5f); rW = Mathf.MoveTowards(rW, rGoal, dt * 5f);
        anim.SetIKPositionWeight(AvatarIKGoal.LeftHand, lW); anim.SetIKPosition(AvatarIKGoal.LeftHand, lTarget);
        anim.SetIKPositionWeight(AvatarIKGoal.RightHand, rW); anim.SetIKPosition(AvatarIKGoal.RightHand, rTarget);
        // palmas hacia abajo / hacia adentro para que se vea que agarran
        var down = Quaternion.LookRotation(Forward, Vector3.down);
        anim.SetIKRotationWeight(AvatarIKGoal.LeftHand, lW * 0.5f); anim.SetIKRotation(AvatarIKGoal.LeftHand, down * Quaternion.Euler(0f, 0f, -90f));
        anim.SetIKRotationWeight(AvatarIKGoal.RightHand, rW * 0.5f); anim.SetIKRotation(AvatarIKGoal.RightHand, down * Quaternion.Euler(0f, 0f, 90f));
        // Se inclina hacia la mesa mientras trabaja con las manos: así los hombros bajan, los brazos ya no quedan estirados y los codos se doblan
        float handsW = Mathf.Max(lW, rW);
        leanNow = Mathf.MoveTowards(leanNow, handsW, dt * 2.5f);
        if (leanNow > 0.01f)
        {
            foreach (var hb in new[] { HumanBodyBones.Spine, HumanBodyBones.Chest })
            {
                var bt = anim.GetBoneTransform(hb); if (bt == null || bt.parent == null) continue;
                Quaternion wr = Quaternion.AngleAxis(leanDeg * 0.5f * leanNow, RightDir) * bt.rotation;
                anim.SetBoneLocalRotation(hb, Quaternion.Inverse(bt.parent.rotation) * wr);
            }
        }
        // codos: la pista sigue a la mano (a medio camino entre el hombro y la mano, hacia afuera y abajo), así el codo se dobla y se mueve con el brazo
        Vector3 sL = transform.position + Vector3.up * Height * 0.80f - RightDir * 0.20f * (Height / 1.7f);
        Vector3 sR = transform.position + Vector3.up * Height * 0.80f + RightDir * 0.20f * (Height / 1.7f);
        Vector3 hl = sL + (lTarget - sL) * 0.5f - RightDir * 0.22f + Vector3.down * 0.18f - Forward * 0.08f;
        Vector3 hr = sR + (rTarget - sR) * 0.5f + RightDir * 0.22f + Vector3.down * 0.18f - Forward * 0.08f;
        anim.SetIKHintPositionWeight(AvatarIKHint.LeftElbow, lW * 0.9f); anim.SetIKHintPosition(AvatarIKHint.LeftElbow, hl);
        anim.SetIKHintPositionWeight(AvatarIKHint.RightElbow, rW * 0.9f); anim.SetIKHintPosition(AvatarIKHint.RightElbow, hr);
    }

    public bool IsBusy => state != State.Idle;
    public bool IsCooking => state == State.Cooking;
    public System.Action OnCooked;        // se llama al terminar de trabajar en el puesto

    void SetPath(Vector3 to)
    {
        path = KitchenNav.Path(new Vector3(transform.position.x, 0f, transform.position.z), new Vector3(to.x, 0f, to.z));
        pathIndex = 0;
    }

    /// Va al puesto `stand` (rodeando las mesas), trabaja `seconds` con la animación `trigger`, mirando hacia `yaw`.
    /// Si returnToHome es falso se queda ahí (para encadenar pasos); con GoHome() vuelve a su lugar.
    public void Work(Vector3 stand, float seconds, string trigger, float yaw, bool returnToHome)
    {
        stationPos = new Vector3(stand.x, homePosition.y, stand.z);
        cookTimeLeft = seconds;
        cookTrigger = trigger;
        cookYaw = yaw;
        returnAfter = returnToHome;
        retrigger = 0f;
        ClearGestures();
        SetPath(stationPos);
        state = State.GoToStation;
    }

    public void Cook(Vector3 station, float seconds, string trigger = "Chop") { Work(station, seconds, trigger, 140f, true); }

    /// Termina el trabajo actual (la animación de cocina ya terminó).
    public void FinishWork() { if (state == State.Cooking) cookTimeLeft = 0f; }

    // Borra gestos pendientes para que al caminar no se cuele una animación de trabajo vieja
    void ClearGestures() { anim.ResetTrigger("Chop"); anim.ResetTrigger("Work"); anim.ResetTrigger("Cheer"); anim.ResetTrigger("Wave"); anim.ResetTrigger("Throw"); }

    public void GoHome() { ClearGestures(); SetPath(homePosition); state = State.Return; }
    public void Celebrate() { anim.SetTrigger("Cheer"); }
    public void Greet() { anim.SetTrigger("Wave"); }

    void Update()
    {
        Vector3 pos = transform.position;
        float speed = 0f;
        bool walking = state == State.GoToStation || state == State.Return;

        if (walking)
        {
            // Sigue la ruta punto por punto
            while (pathIndex < path.Count && Flat(pos, path[pathIndex]) < 0.06f) pathIndex++;
            if (pathIndex >= path.Count)
            {
                if (state == State.GoToStation) { state = State.Cooking; retrigger = 0f; }
                else state = State.Idle;
            }
            else
            {
                Vector3 target = path[pathIndex];
                Vector3 dir = target - pos; dir.y = 0f;
                transform.position = Vector3.MoveTowards(pos, new Vector3(target.x, pos.y, target.z), walkSpeed * Time.deltaTime);
                if (dir.sqrMagnitude > 0.0001f)
                    transform.rotation = Quaternion.RotateTowards(transform.rotation, Quaternion.LookRotation(dir.normalized, Vector3.up), turnSpeed * Time.deltaTime);
                speed = 1f;
            }
        }

        if (state == State.Cooking)
        {
            cookTimeLeft -= Time.deltaTime;
            Face(cookYaw);
            retrigger -= Time.deltaTime;   // las animaciones de trabajo duran poco: se repiten mientras trabaja
            if (retrigger <= 0f) { if (!string.IsNullOrEmpty(cookTrigger)) anim.SetTrigger(cookTrigger); retrigger = 1.3f; }   // "" = sin gesto: las manos las manejan los IK
            if (cookTimeLeft <= 0f) { ClearGestures(); state = returnAfter ? State.Return : State.Idle; if (returnAfter) SetPath(homePosition); OnCooked?.Invoke(); }
        }
        else if (state == State.Idle) Face(0f);   // en reposo mira a la cámara

        anim.SetFloat("Speed", speed, 0.1f, Time.deltaTime);
        if (talking) { talkT += Time.deltaTime; float k = 1f + 0.018f * Mathf.Abs(Mathf.Sin(talkT * 9f)) + 0.006f * Mathf.Sin(talkT * 3.1f); transform.localScale = baseScale * k; }
    }

    static float Flat(Vector3 a, Vector3 b) { a.y = 0; b.y = 0; return Vector3.Distance(a, b); }

    void Face(float yaw)
    {
        transform.rotation = Quaternion.RotateTowards(transform.rotation, Quaternion.Euler(0f, yaw, 0f), turnSpeed * Time.deltaTime);
    }
}
