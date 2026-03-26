@echo off
title 24H NORTE - Sistema Comercial

echo Iniciando 24H NORTE...

REM Abre o Chrome com porta de debug para extracao automatica de JWT do PACTO
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --new-window ^
  "https://lgn.pactosolucoes.com.br"

REM Aguarda o Chrome inicializar
timeout /t 3 /nobreak > nul

REM Inicia o servidor Node.js
cd /d "%~dp0"
echo Servidor rodando em http://localhost:3001
echo Dashboard: https://24h-nine.vercel.app
echo.
node server.js
