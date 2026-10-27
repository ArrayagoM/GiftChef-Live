@echo off
title Cocina TinTech - DETENER
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\detener-cocina.ps1"
echo  Todo cerrado.
timeout /t 3 >nul