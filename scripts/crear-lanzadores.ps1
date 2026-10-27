# Genera los .bat con saltos de linea Windows (CRLF) y solo ASCII, para que cmd los lea bien.
$root = Split-Path -Parent $PSScriptRoot

function Save-Bat($name, $text) {
    $crlf = ($text -replace "`r?`n", "`r`n")
    [System.IO.File]::WriteAllText((Join-Path $root $name), $crlf, (New-Object System.Text.ASCIIEncoding))
}

$launcher = @'
@echo off
title Heroes vs Villanos - %MODE_TITLE%
cd /d "%~dp0"

echo.
echo  Cerrando restos de sesiones anteriores...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\detener.ps1"
timeout /t 1 /nobreak >nul

echo  Abriendo servidor del juego y bridge (%MODE_TITLE%)...
start "SERVIDOR DEL JUEGO - no cerrar" /min cmd /k "cd /d %~dp0bridge && node web-server.js"
start "BRIDGE TIKTOK - no cerrar" cmd /k "cd /d %~dp0bridge && node index.js%BRIDGE_ARGS%"
timeout /t 4 /nobreak >nul

set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"

echo  Abriendo la ventana del juego...
start "" "%BROWSER%" --user-data-dir="%LOCALAPPDATA%\HeroesVillanosEdge" "--app=http://localhost:8081/?auto=1&fps=30&demo=1" --window-size=540,960 --window-position=40,20 --force_high_performance_gpu --enable-gpu-rasterization --ignore-gpu-blocklist --disable-features=CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-first-run --no-default-browser-check

echo.
echo  LISTO. Ahora:
echo    1. El juego arranca solo (sonido y voz de Nova incluidos): no hace falta tocar nada.
echo    2. Mira arriba a la izquierda: tiene que decir el estado de TikTok.
echo    3. En LIVE Studio: Captura de ventana ^> "Heroes vs Villanos" (si todavia no esta).
echo.
echo  NO cierres las ventanas negras "BRIDGE TIKTOK" ni "SERVIDOR DEL JUEGO".
timeout /t 12 >nul
'@

Save-Bat 'INICIAR EN VIVO.bat' (($launcher -replace '%MODE_TITLE%', 'EN VIVO') -replace '%BRIDGE_ARGS%', '')
Save-Bat 'PROBAR SIN LIVE.bat' (($launcher -replace '%MODE_TITLE%', 'PRUEBA con eventos falsos') -replace '%BRIDGE_ARGS%', ' --mock')

# PREPARAR: abre el servidor y la ventana del juego SIN conectarse a TikTok. Sirve para armar la
# captura en LIVE Studio sin consultas a TikTok. Nova y la música esperan a que haya un live conectado.
$prepLines = ($launcher -split "`r?`n") | Where-Object { $_ -notmatch 'BRIDGE TIKTOK' }
$prep = ($prepLines -join "`n") -replace '%MODE_TITLE%', 'PREPARAR (sin conectar a TikTok)'
$prep = $prep -replace 'timeout /t 12 >nul', @'
echo  La ventana esta abierta pero NO esta conectada a TikTok (Nova y la musica esperan).
echo  Agregala en LIVE Studio como Captura de ventana. Cuando ya estes EN VIVO,
echo  abri "CONECTAR AL LIVE.bat" para que empiece a recibir regalos y comentarios.
timeout /t 12 >nul
'@
Save-Bat 'PREPARAR (sin TikTok).bat' $prep

# CONECTAR: arranca solo el bridge; la ventana del juego (ya abierta) se engancha sola en segundos.
$connect = @'
@echo off
title Heroes vs Villanos - CONECTAR AL LIVE
cd /d "%~dp0"
echo.
echo  Conectando el bridge a tu live de TikTok...
echo  (La ventana del juego tiene que estar abierta: usa "PREPARAR (sin TikTok).bat" si no lo esta.)
start "BRIDGE TIKTOK - no cerrar" cmd /k "cd /d %~dp0bridge && node index.js"
echo.
echo  NO cierres la ventana negra "BRIDGE TIKTOK". Arriba a la izquierda del juego tiene que decir "TikTok".
timeout /t 8 >nul
'@
Save-Bat 'CONECTAR AL LIVE.bat' $connect

$stop = @'
@echo off
title Detener Heroes vs Villanos
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\detener.ps1"
echo.
echo  Todo cerrado (servidor, bridge y ventana del juego).
timeout /t 3 >nul
'@
Save-Bat 'DETENER TODO.bat' $stop
Write-Output 'lanzadores creados'
