@echo off
title Cocina TinTech - INICIAR
cd /d "%~dp0"
echo.
echo  COCINA TINTECH
echo  ------------------------------------------
echo  1/3 Servidor del panel...
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue)) { Start-Process node -ArgumentList 'web-server.js' -WorkingDirectory '%~dp0bridge' -WindowStyle Hidden }"
timeout /t 3 /nobreak >nul

set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
echo  2/3 Panel de control (ventana APARTE, no la captures en el live)...
start "" "%BROWSER%" --user-data-dir="%LOCALAPPDATA%\CocinaTinTechPanel" "--app=http://localhost:8081/panel.html" --window-size=430,900 --window-position=1000,20 --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check

echo  3/3 Juego...
start "" "D:\JuegoLive\CocinaTinTech\CocinaTinTech.exe" -screen-fullscreen 0 -screen-width 540 -screen-height 960
echo.
echo  LISTO. En el juego: escribi el @usuario del live, elegi el cocinero y toca COMENZAR.
echo  En LIVE Studio / OBS capturar SOLO la ventana "Cocina TinTech" (el panel queda afuera).
timeout /t 10 >nul