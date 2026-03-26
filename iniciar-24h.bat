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

echo [2/3] Abrindo PACTO no Chrome com modo automatico...

REM Abre Chrome com porta de debug + inicia no PACTO lgn
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --new-window --start-maximized "https://lgn.pactosolucoes.com.br"

echo     Chrome aberto com modo de debug ativo.
echo     - Se ja estiver logado: dados financeiros extraidos automaticamente
echo     - Se pedir login: o sistema preenche as credenciais e tenta login
echo       automatico (reCAPTCHA valida sozinho no Chrome real)
echo.
timeout /t 8 /nobreak > nul

echo [3/3] Iniciando servidor local...
echo.
cd /d "%~dp0"

echo  Dashboard: https://24h-nine.vercel.app
echo  API local: http://localhost:3001
echo.
echo  O sistema sincroniza automaticamente a cada 5 minutos.
echo  Dados financeiros chegam no Vercel dentro de 5-10 minutos.
echo  Mantenha esta janela aberta enquanto trabalha.
echo.

node server.js

pause
