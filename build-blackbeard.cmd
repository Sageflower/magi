@echo off
rem Builds blackbeard.exe from blackbeard.js. Run me whenever blackbeard.js changes.
cd /d "%~dp0"
call "C:\Program Files\nodejs\npx.cmd" --yes pkg blackbeard.js --targets node18-win-x64 --output blackbeard.exe
echo.
echo Done. blackbeard.exe is ready.
pause
