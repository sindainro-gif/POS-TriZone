@echo off
rem HOMEBASE: pusat data yang menyimpan paket data dari semua toko (%APPDATA%\POS Tri-Zone HOMEBASE).
rem Bisa dijalankan di PC mana pun (rumah / kantor) dan tidak memakai database toko.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --homebase
