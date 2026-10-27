# Cierra el servidor del juego, el bridge y la ventana del juego. No toca nada más.
$ErrorActionPreference = 'SilentlyContinue'

foreach ($port in 8080, 8081) {
    Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
        if ($p.Name -eq 'node.exe') { Stop-Process -Id $p.ProcessId -Force }
    }
}

# Ventana del juego (Edge o Chrome abiertos con el perfil propio del juego).
Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in 'msedge.exe', 'chrome.exe' -and $_.CommandLine -match 'HeroesVillanosEdge|HeroesVillanosGame'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Consolas que quedaron abiertas con el título del juego.
Get-Process cmd | Where-Object { $_.MainWindowTitle -match 'BRIDGE TIKTOK|SERVIDOR DEL JUEGO' } | ForEach-Object { Stop-Process -Id $_.Id -Force }
