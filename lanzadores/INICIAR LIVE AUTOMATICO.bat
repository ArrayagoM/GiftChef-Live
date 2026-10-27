@echo off
title Cocina TinTech - LIVE AUTOMATICO
cd /d "%~dp0"
echo.
echo  COCINA TINTECH - LIVE AUTOMATICO
echo  ------------------------------------------
echo  Abre todo (servidor, bridge, panel de voz y juego) y lo vigila:
echo  si algo se cae, lo vuelve a abrir solo.
echo.
echo  Antes de empezar, el juego tiene que haber sido iniciado al menos una vez
echo  con tu usuario (tinchotech) y tu cocinero: arranca solo con los ultimos que usaste.
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0VIGILANTE.ps1"
echo  Listo. Podes cerrar esta ventana. Para detener todo usa DETENER COCINA.bat
timeout /t 8 /nobreak >nul
