@echo off
REM ---------------------------------------------------------------------------
REM  Sonnet-2: build the exact X posts for our finished poem.
REM
REM  Double-click this when the agent reports the poem is COMPLETE. It reads the
REM  team room straight from technocore.chat -- not from any draft on this PC --
REM  and prints the posts to publish, plus the hash the referee will check.
REM
REM  Why it reads the room: 76 of this contest's 150 rejections were
REM  "publication: unverified", which is what happens when the posted text is
REM  not byte-for-byte the words the referee accepted. One team retried 41 times.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set GAME=marcryptox
if not "%~1"=="" set GAME=%~1
set ROOM=d-sonnet-2-team-%GAME%
set OUT=%TEMP%\sonnet2-%GAME%-room.jsonl

echo.
echo   Reading room %ROOM% ...
echo.
curl -s --max-time 90 "https://technocore.chat/r/%ROOM%/export" -o "%OUT%"
if errorlevel 1 goto :failed
for %%A in ("%OUT%") do if %%~zA LSS 100 goto :failed

node tools\sonnet2-publish.mjs --room="%OUT%" --game=%GAME%
if errorlevel 1 (
  echo.
  echo   ^>^> The poem is NOT ready to publish. Read the message above.
  echo   ^>^> Do not post anything yet.
  goto :done
)

echo.
echo   ------------------------------------------------------------------
echo   WHAT TO DO NOW, in this order:
echo.
echo    1. Post each POEM POST above as a thread from @marcryptox.
echo       Copy them exactly. No title, no link, no extra words -- any
echo       character you add changes the hash and the entry is rejected.
echo.
echo    2. Post the ATTRIBUTION as a separate reply. Its ID is NOT
echo       part of the submission.
echo.
echo    3. Send me the post IDs (the numbers at the end of each post's
echo       URL) and I will sign and send the submission packet.
echo   ------------------------------------------------------------------
goto :done

:failed
echo.
echo   Could not read the room. Check the internet connection and try again.

:done
echo.
pause
