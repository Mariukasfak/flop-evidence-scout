@echo off
title TriAgent - prisijungimo patikra
cd /d "%~dp0"
echo.
echo Tikrinama, kurie agentai prisijunge prie TriAgent...
echo.
node "tools/check-connection.mjs"
echo.
echo Patikra baigta. Spauskite bet kuri klavisa, kad uzdarytumete langa.
pause >nul
