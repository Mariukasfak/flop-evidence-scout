@echo off
title TriAgent - testu suvestine
cd /d "%~dp0"
echo.
echo Paleidziami visi TriAgent testai. Tai gali uztrukti kelias minutes.
node "tools/testu-suvestine.mjs"
echo Spauskite bet kuri klavisa, kad uzdarytumete langa.
pause >nul
