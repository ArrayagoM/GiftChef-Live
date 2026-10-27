using UnityEngine;

// Tope de cuadros por segundo: sin esto el juego corre lo más rápido posible y gasta CPU y GPU de más.
// Para un live alcanzan 30 FPS (lo mismo que se transmite). Se puede cambiar al abrir el juego: CocinaTinTech.exe -fps 60
public class PerformanceSettings : MonoBehaviour
{
    public int targetFps = 30;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void AutoCreate()
    {
        if (FindFirstObjectByType<PerformanceSettings>() != null) return;
        var go = new GameObject("PerformanceSettings");
        DontDestroyOnLoad(go);
        go.AddComponent<PerformanceSettings>();
    }

    void Awake()
    {
        var args = System.Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "-fps" && int.TryParse(args[i + 1], out int v) && v >= 10 && v <= 144) targetFps = v;
        QualitySettings.vSyncCount = 0;
        Application.targetFrameRate = targetFps;
        Debug.Log("[Perf] targetFrameRate=" + Application.targetFrameRate + " vsync=" + QualitySettings.vSyncCount);
    }

    int frames; float t0;
    void Update()
    {
        frames++;
        if (Time.realtimeSinceStartup - t0 >= 5f)
        {
            Debug.Log("[Perf] fps=" + (frames / (Time.realtimeSinceStartup - t0)).ToString("F1") + " updateMs=" + (Time.unscaledDeltaTime * 1000f).ToString("F1"));
            frames = 0; t0 = Time.realtimeSinceStartup;
        }
    }
}
