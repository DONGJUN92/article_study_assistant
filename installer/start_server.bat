@echo off
chcp 65001 >nul
title Article Study - Server
echo.
echo Article Study Server Starting...
echo.
cd /d "%~dp0..\server"
call venv\Scripts\activate.bat
python main.py
pause
