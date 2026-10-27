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