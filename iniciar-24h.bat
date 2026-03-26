@echo off
title 24H NORTE - Sistema Comercial
cls

echo ============================================
echo   24H NORTE - Sistema Comercial
echo ============================================
echo.
echo [1/3] Verificando Chrome...

REM Fechar Chrome existente (necessario para abrir com debug port)
taskkill /F /IM chrome.exe /T > nul 2>&1
timeout /t 2 /nobreak > nul

echo [2/3] Abrindo PACTO no Chrome com debug automatico...

REM Abre Chrome com porta de debug + inicia no PACTO
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --new-window --start-maximized "https://lgn.pactosolucoes.com.br"

echo     Chrome aberto. Faca login no PACTO se solicitado.
echo.
timeout /t 5 /nobreak > nul

echo [3/3] Iniciando servidor local...
echo.
cd /d "%~dp0"

echo  Dashboard: https://24h-nine.vercel.app
echo  API local: http://localhost:3001
echo.
echo  O sistema sincroniza automaticamente a cada 5 minutos.
echo  Mantenha esta janela aberta enquanto trabalha.
echo.

node server.js

pause
