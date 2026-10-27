@echo off
title Detener Heroes vs Villanos
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\detener.ps1"
echo.
echo  Todo cerrado (servidor, bridge y ventana del juego).
timeout /t 3 >nul