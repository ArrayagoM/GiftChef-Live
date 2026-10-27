# Vigilante de Cocina TinTech: deja todo andando solo. Cada 15 segundos revisa que esten abiertos
# el servidor del panel, el bridge (conexion a TikTok), el juego y el panel de voz, y reabre lo que se haya caido.
# (Sin WMI/CIM: en esta PC esas consultas tardan minutos.)
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Juego live TikTok'
$exe  = 'D:\JuegoLive\CocinaTinTech\CocinaTinTech.exe'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir 'vigilante.log'
function Log($m) { Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) }

# Una sola copia del vigilante (mutex con nombre)
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Global\CocinaTinTechVigilante', [ref]$created)
if (-not $created) { Log 'Ya hay otro vigilante corriendo; este se cierra.'; exit }

function Listening($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { $edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }

Log 'Vigilante iniciado.'
$lastGame = [datetime]::MinValue
$lastPanel = [datetime]::MinValue
while ($true) {
    if (-not (Listening 8081)) {
        Log 'Servidor del panel (8081) caido: lo reabro.'
        Start-Process node -ArgumentList 'web-server.js' -WorkingDirectory (Join-Path $root 'bridge') -WindowStyle Hidden
        Start-Sleep 3
    }
    if (-not (Listening 8080)) {
        Log 'Bridge (8080) caido: lo reabro.'
        Start-Process node -ArgumentList 'index.js' -WorkingDirectory (Join-Path $root 'bridge') -WindowStyle Hidden
        Start-Sleep 5
    }
    # Panel de voz: ventana de Edge cuyo titulo contiene "Panel"
    $panel = Get-Process msedge | Where-Object { $_.MainWindowTitle -match 'Panel' }
    if (-not $panel -and (Test-Path $edge) -and ((Get-Date) - $lastPanel).TotalSeconds -gt 45) {
        Log 'Panel de voz cerrado: lo reabro.'
        $lastPanel = Get-Date
        Start-Process $edge -ArgumentList @("--user-data-dir=$env:LOCALAPPDATA\CocinaTinTechPanel", '--app=http://localhost:8081/panel.html', '--window-size=430,900', '--window-position=1000,20', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check')
        Start-Sleep 3
    }
    if (-not (Get-Process CocinaTinTech) -and ((Get-Date) - $lastGame).TotalSeconds -gt 30) {
        Log 'Juego cerrado: lo reabro (arranque automatico).'
        $lastGame = Get-Date
        Start-Process $exe -ArgumentList @('-screen-fullscreen', '0', '-screen-width', '540', '-screen-height', '960', '-autostart')
    }
    Start-Sleep 15
}
