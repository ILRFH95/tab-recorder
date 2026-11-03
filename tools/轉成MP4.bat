@echo off
rem Double-click: convert webm recordings older than 1 hour in Downloads\ScreenRecorder to MP4
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert-to-mp4.ps1" %*
echo.
pause
