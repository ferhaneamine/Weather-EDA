@echo off
title Weather EDA Dashboard
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment not found.
    echo Create it with: python -m venv .venv
    pause
    exit /b 1
)

rem Open the dashboard in the browser a couple of seconds after the server starts.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5000'"

rem Run the Flask server in this window. Close the window or press Ctrl+C to stop it.
".venv\Scripts\python.exe" app.py

echo.
echo Dashboard stopped.
pause
