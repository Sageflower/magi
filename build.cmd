@echo off
rem Builds magi.exe from magi.js. Run me whenever magi.js changes.
cd /d "%~dp0"
call "C:\Program Files\nodejs\npx.cmd" --yes pkg magi.js --targets node18-win-x64 --output magi.exe
echo.
echo Done. magi.exe is ready.
pause
