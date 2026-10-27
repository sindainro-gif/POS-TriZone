@echo off
rem Menjalankan POS Tri-Zone tanpa perlu npm di PATH
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
