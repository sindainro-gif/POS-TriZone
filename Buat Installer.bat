@echo off
rem Membuat installer POS Tri-Zone (dist\POS Tri-Zone Setup VERSI.exe). Jalankan di komputer pengembang.
cd /d "%~dp0"
echo Menjalankan tes...
call npm test
if errorlevel 1 (
  echo.
  echo TES GAGAL - installer tidak dibuat.
  pause
  exit /b 1
)
echo Membuat installer...
call npm run dist
if errorlevel 1 (
  echo.
  echo Pembuatan installer gagal.
  pause
  exit /b 1
)
start "" "%~dp0dist"
