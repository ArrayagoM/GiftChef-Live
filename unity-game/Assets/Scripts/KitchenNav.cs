using System.Collections.Generic;
using UnityEngine;

// Rutas para que los personajes rodeen los muebles (la mesa de armado y la de reparto) en vez de atravesarlos.
// Grilla chica + A*; las rutas se simplifican para que caminen en línea recta cuando se puede.
public static class KitchenNav
{
    // Obstáculos en el piso (x, z, ancho, largo), ya con un margen para el cuerpo del personaje
    public static readonly Rect[] obstacles =
    {
        new Rect(-1.85f, 0.25f, 3.7f, 1.3f),   // mesa de armado
        new Rect(-3.45f, 0.00f, 1.5f, 1.2f),   // mesa de reparto
        new Rect(0.30f, -3.40f, 2.60f, 1.75f), // freidora y horno pizzero reales (contra la pared del fondo)
    };

    const float cell = 0.2f, x0 = -3.8f, z0 = -3.0f;
    const int nx = 38, nz = 52;

    static bool InObstacle(float x, float z)
    {
        foreach (var r in obstacles) if (x >= r.xMin && x <= r.xMax && z >= r.yMin && z <= r.yMax) return true;
        return false;
    }

    static bool Blocked(int ix, int iz) { return InObstacle(x0 + (ix + 0.5f) * cell, z0 + (iz + 0.5f) * cell); }

    static Vector2Int ToCell(Vector3 p)
    {
        return new Vector2Int(Mathf.Clamp(Mathf.FloorToInt((p.x - x0) / cell), 0, nx - 1), Mathf.Clamp(Mathf.FloorToInt((p.z - z0) / cell), 0, nz - 1));
    }

    static Vector3 ToWorld(Vector2Int c) { return new Vector3(x0 + (c.x + 0.5f) * cell, 0f, z0 + (c.y + 0.5f) * cell); }

    /// ¿Se puede ir en línea recta de a a b sin tocar un obstáculo?
    public static bool Clear(Vector3 a, Vector3 b)
    {
        float d = Vector2.Distance(new Vector2(a.x, a.z), new Vector2(b.x, b.z));
        int steps = Mathf.Max(2, Mathf.CeilToInt(d / 0.1f));
        for (int i = 0; i <= steps; i++)
        {
            float k = i / (float)steps;
            if (InObstacle(Mathf.Lerp(a.x, b.x, k), Mathf.Lerp(a.z, b.z, k))) return false;
        }
        return true;
    }

    static Vector2Int NearestFree(Vector2Int c)
    {
        if (!Blocked(c.x, c.y)) return c;
        for (int r = 1; r < 12; r++)
            for (int dx = -r; dx <= r; dx++)
                for (int dz = -r; dz <= r; dz++)
                {
                    int x = c.x + dx, z = c.y + dz;
                    if (x < 0 || z < 0 || x >= nx || z >= nz) continue;
                    if (!Blocked(x, z)) return new Vector2Int(x, z);
                }
        return c;
    }

    /// Puntos por los que hay que pasar para ir de a a b (el último es b).
    public static List<Vector3> Path(Vector3 a, Vector3 b)
    {
        var res = new List<Vector3>();
        if (Clear(a, b)) { res.Add(b); return res; }

        var s = NearestFree(ToCell(a)); var g = NearestFree(ToCell(b));
        var open = new List<Vector2Int> { s };
        var came = new Dictionary<Vector2Int, Vector2Int>();
        var cost = new Dictionary<Vector2Int, float> { { s, 0f } };
        var closed = new HashSet<Vector2Int>();
        int guard = 0;
        while (open.Count > 0 && guard++ < 4000)
        {
            int bi = 0; float bf = float.MaxValue;
            for (int i = 0; i < open.Count; i++)
            {
                var o = open[i]; float h = Mathf.Max(Mathf.Abs(o.x - g.x), Mathf.Abs(o.y - g.y));
                float f = cost[o] + h; if (f < bf) { bf = f; bi = i; }
            }
            var cur = open[bi]; open.RemoveAt(bi);
            if (cur == g) break;
            closed.Add(cur);
            for (int dx = -1; dx <= 1; dx++)
                for (int dz = -1; dz <= 1; dz++)
                {
                    if (dx == 0 && dz == 0) continue;
                    int x = cur.x + dx, z = cur.y + dz;
                    if (x < 0 || z < 0 || x >= nx || z >= nz || Blocked(x, z)) continue;
                    if (dx != 0 && dz != 0 && (Blocked(cur.x + dx, cur.y) || Blocked(cur.x, cur.y + dz))) continue;   // no cortar esquinas
                    var n = new Vector2Int(x, z); if (closed.Contains(n)) continue;
                    float nc = cost[cur] + ((dx != 0 && dz != 0) ? 1.414f : 1f);
                    if (!cost.ContainsKey(n) || nc < cost[n]) { cost[n] = nc; came[n] = cur; if (!open.Contains(n)) open.Add(n); }
                }
        }
        if (!came.ContainsKey(g) && g != s) { res.Add(b); return res; }   // sin ruta: va directo
        var cells = new List<Vector2Int> { g };
        var c2 = g; int safety = 0;
        while (c2 != s && came.ContainsKey(c2) && safety++ < 2000) { c2 = came[c2]; cells.Add(c2); }
        cells.Reverse();
        var pts = new List<Vector3> { a };
        foreach (var c in cells) pts.Add(ToWorld(c));
        pts.Add(b);
        // simplifica: se salta puntos mientras la línea recta esté libre
        int i0 = 0;
        while (i0 < pts.Count - 1)
        {
            int far = pts.Count - 1;
            while (far > i0 + 1 && !Clear(pts[i0], pts[far])) far--;
            res.Add(pts[far]); i0 = far;
        }
        return res;
    }
}
