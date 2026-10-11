@echo off
setlocal
title Instalacion - Sistema de Autorizacion de Personal
cd /d "%~dp0"

echo ============================================================
echo   INSTALACION DEL SISTEMA DE AUTORIZACION DE PERSONAL
echo ============================================================
echo.

REM --- Verificar Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js.
  echo.
  echo Instalá Node.js version 20 o superior desde:
  echo     https://nodejs.org/es  ^(elegir la version "LTS"^)
  echo.
  echo Luego volvé a ejecutar este instalador.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do echo Node.js detectado: %%v
echo.

REM --- Crear .env si no existe ---
if not exist ".env" (
  echo Creando archivo de configuracion .env ...
  copy ".env.example" ".env" >nul
  echo   Se creo .env a partir de .env.example. Podés editarlo luego.
  echo.
)

echo Instalando dependencias ^(puede tardar varios minutos^)...
call npm install
if errorlevel 1 (
  echo [ERROR] Fallo la instalacion de dependencias.
  pause
  exit /b 1
)
echo.

echo Compilando la aplicacion...
call npm run build
if errorlevel 1 (
  echo [ERROR] Fallo la compilacion.
  pause
  exit /b 1
)
echo.

echo ============================================================
echo   INSTALACION COMPLETA
echo ============================================================
echo.
echo Para iniciar el sistema, hacé doble clic en:  Iniciar.bat
echo.
echo La primera vez te va a pedir crear el usuario administrador.
echo.
pause
