using UnityEngine;

// Cámara de cocina: en reposo toma abierta siguiendo al cocinero; durante un pedido, el controlador
// le indica tomas ("manual") para enfocar la masa, la cocción, el embalaje y la entrega.
// Siempre se mantiene dentro de la cocina (nunca atraviesa las paredes).
public class FollowCamera : MonoBehaviour
{
    public ChefAnimator chef;
    public Vector3 wideOffset = new Vector3(0f, 2.4f, 6.2f);
    public float wideFov = 55f;
    public float smoothTime = 0.55f;
    public float limitX = 2.4f;

    // Límites de la cocina (paredes en x = +-4, pared del fondo en z = -3.5)
    public Vector3 boundsMin = new Vector3(-3.5f, 0.7f, -2.6f);
    public Vector3 boundsMax = new Vector3(3.5f, 4.0f, 9.5f);

    // Toma manual (la fija KitchenController)
    public bool manual;
    public Vector3 targetPos, targetLook;
    public float targetFov = 48f;

    // Para verificar que nunca se sale
    public Vector3 seenMin = new Vector3(999, 999, 999), seenMax = new Vector3(-999, -999, -999);

    Vector3 vel;
    Camera cam;

    void Start() { cam = GetComponent<Camera>(); }

    // Mientras hay un plano "bloqueado" (ej. la aparición de un Pokémon), los planos que pide la cocina quedan en espera
    // y se aplican apenas termina el bloqueo, para que la cámara vuelva sola a donde estaba la acción.
    float lockUntil;
    bool pendingShot, pendingRelease, snap, wasLocked;
    public float shake;                 // temblor (lo usan los efectos épicos)
    Vector3 pPos, pLook; float pFov;

    public void Shot(Vector3 pos, Vector3 look, float fov)
    {
        if (Time.time < lockUntil) { pendingShot = true; pendingRelease = false; pPos = pos; pLook = look; pFov = fov; return; }
        if (wasLocked) { snap = true; wasLocked = false; }
        manual = true; targetPos = pos; targetLook = look; targetFov = fov;
    }

    public void Release()
    {
        if (Time.time < lockUntil) { pendingRelease = true; pendingShot = false; return; }
        manual = false; if (wasLocked) { snap = true; wasLocked = false; }
    }

    public void ShotLocked(Vector3 pos, Vector3 look, float fov, float seconds)
    {
        lockUntil = 0f; manual = true; targetPos = pos; targetLook = look; targetFov = fov;
        lockUntil = Time.time + seconds; snap = true; wasLocked = true;
    }

    void ApplyPending()
    {
        if (Time.time < lockUntil) return;
        if (pendingShot) { pendingShot = false; if (wasLocked) { snap = true; wasLocked = false; } manual = true; targetPos = pPos; targetLook = pLook; targetFov = pFov; }
        else if (pendingRelease) { pendingRelease = false; manual = false; if (wasLocked) { snap = true; wasLocked = false; } }
    }

    Vector3 Clamp(Vector3 p)
    {
        return new Vector3(Mathf.Clamp(p.x, boundsMin.x, boundsMax.x), Mathf.Clamp(p.y, boundsMin.y, boundsMax.y), Mathf.Clamp(p.z, boundsMin.z, boundsMax.z));
    }

    void LateUpdate()
    {
        ApplyPending();
        Vector3 desired, look; float fov;
        if (manual) { desired = targetPos; look = targetLook; fov = targetFov; }
        else
        {
            if (chef == null) return;
            float x = Mathf.Clamp(chef.transform.position.x, -limitX, limitX);
            desired = new Vector3(x, wideOffset.y, chef.transform.position.z + wideOffset.z);
            look = new Vector3(x, 1.0f, -1.2f);
            fov = wideFov;
        }
        desired = Clamp(desired);
        if (snap) { snap = false; transform.position = desired; vel = Vector3.zero; transform.rotation = Quaternion.LookRotation(look - desired, Vector3.up); if (cam != null) cam.fieldOfView = fov; }
        transform.position = Clamp(Vector3.SmoothDamp(transform.position, desired, ref vel, smoothTime));
        if (shake > 0.0005f) transform.position += Random.insideUnitSphere * shake;
        Quaternion r = Quaternion.LookRotation(look - transform.position, Vector3.up);
        transform.rotation = Quaternion.Slerp(transform.rotation, r, 4f * Time.deltaTime);
        if (cam != null) cam.fieldOfView = Mathf.Lerp(cam.fieldOfView, fov, 3f * Time.deltaTime);
        seenMin = Vector3.Min(seenMin, transform.position); seenMax = Vector3.Max(seenMax, transform.position);
    }
}
