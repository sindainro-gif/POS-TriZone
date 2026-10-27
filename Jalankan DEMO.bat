@echo off
rem Versi DEMO untuk latihan: data contoh di folder terpisah (%APPDATA%\POS Tri-Zone DEMO),
rem tidak mengirim email dan nota disimpan sebagai PDF. Data toko asli tidak tersentuh.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." --demo
