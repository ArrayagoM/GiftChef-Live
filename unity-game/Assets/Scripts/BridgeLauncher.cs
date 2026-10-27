using System;
using System.Diagnostics;
using System.Net.Sockets;
using UnityEngine;

// Arranca el bridge de TikTok (Node) junto con el juego si todavía no está corriendo, y lo cierra al salir.
// Así el juego trae su conexión adentro: no hace falta abrir nada más.
public class BridgeLauncher : MonoBehaviour
{
    public string bridgeFolder = @"D:\Juego live TikTok\bridge";
    public string nodeExe = "node";
    public int port = 8080;
    public bool autoStart = true;

    Process proc;
    public string info = "";

    void Awake()
    {
        if (!autoStart) return;
        if (PortOpen())
        {
            info = "bridge ya estaba corriendo";
            return;
        }
        try
        {
            var psi = new ProcessStartInfo(nodeExe, "index.js")
            {
                WorkingDirectory = bridgeFolder,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            proc = Process.Start(psi);
            info = "bridge iniciado por el juego";
        }
        catch (Exception e) { info = "no se pudo iniciar el bridge: " + e.Message; }
    }

    bool PortOpen()
    {
        try
        {
            using (var c = new TcpClient())
            {
                var r = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = r.AsyncWaitHandle.WaitOne(300);
                if (ok && c.Connected) { c.EndConnect(r); return true; }
            }
        }
        catch (Exception) { }
        return false;
    }

    void OnApplicationQuit() { Stop(); }
    void OnDestroy() { Stop(); }

    void Stop()
    {
        try { if (proc != null && !proc.HasExited) proc.Kill(); } catch (Exception) { }
        proc = null;
    }
}
