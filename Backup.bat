@echo off
setlocal
title Backup - Sistema de Autorizacion de Personal
cd /d "%~dp0"
echo Creando copia de seguridad de la base de datos y la documentacion...
echo.
node scripts\backup.mjs
echo.
pause
