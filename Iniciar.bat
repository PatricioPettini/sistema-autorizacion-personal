@echo off
setlocal
title Sistema de Autorizacion de Personal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js. Ejecuta primero Instalar.bat
  pause
  exit /b 1
)

REM Compilar si todavia no existe la version compilada
if not exist "backend\dist\index.js" (
  echo Preparando la aplicacion por primera vez...
  call npm run build
)

echo.
echo ============================================================
echo   Sistema iniciado. Abriendo el navegador...
echo   Direccion:  http://127.0.0.1:4000
echo.
echo   Para DETENER el sistema, cerra esta ventana.
echo ============================================================
echo.

REM Abrir el navegador luego de unos segundos
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:4000"

REM Iniciar el servidor (queda corriendo en esta ventana)
call npm run start
pause
