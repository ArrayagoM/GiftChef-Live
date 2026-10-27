@echo off
title Heroes vs Villanos - PREPARAR (sin conectar a TikTok)
cd /d "%~dp0"

echo.
echo  Cerrando restos de sesiones anteriores...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\detener.ps1"
timeout /t 1 /nobreak >nul

echo  Abriendo servidor del juego y bridge (PREPARAR (sin conectar a TikTok))...
start "SERVIDOR DEL JUEGO - no cerrar" /min cmd /k "cd /d %~dp0bridge && node web-server.js"
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
echo  La ventana esta abierta pero NO esta conectada a TikTok (Nova y la musica esperan).
echo  Agregala en LIVE Studio como Captura de ventana. Cuando ya estes EN VIVO,
echo  abri "CONECTAR AL LIVE.bat" para que empiece a recibir regalos y comentarios.
timeout /t 12 >nul