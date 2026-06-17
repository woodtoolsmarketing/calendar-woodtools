@echo off
rem Abre el Calendario WoodTools con doble clic
cd /d "%~dp0"
start "Calendario WoodTools" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit
