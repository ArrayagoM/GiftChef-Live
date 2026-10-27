# Cierra el juego, el panel, el servidor y el bridge de la cocina. No toca nada mas.
$ErrorActionPreference = 'SilentlyContinue'
# Primero el vigilante (si no, reabriria todo)
# (el vigilante se reconoce por su mutex: se cierran los powershell ocultos sin ventana)
Get-Process powershell | Where-Object { $_.MainWindowHandle -eq 0 -and $_.Id -ne $PID } | ForEach-Object { Stop-Process -Id $_.Id -Force }
Get-Process 'CocinaTinTech' | Stop-Process -Force
foreach ($port in 8080, 8081) {
    Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
        if ($p.Name -eq 'node.exe') { Stop-Process -Id $p.ProcessId -Force }
    }
}
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -match 'CocinaTinTechPanel' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }