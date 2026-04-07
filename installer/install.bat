@echo off
chcp 65001 >nul
title Article Study - Installation
echo.
echo ========================================
echo   Article Study - Install Script
echo ========================================
echo.

:: ── Step 1: Check Python ──
echo [1/5] Checking Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed.
    echo         Download from: https://www.python.org/downloads/
    echo         Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo        OK: %%i

:: ── Step 2: Check Ollama ──
echo [2/5] Checking Ollama...
ollama --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Ollama is not installed.
    echo           Download from: https://ollama.com/download
    echo.
    choice /C YN /M "Continue without Ollama? (Y/N)"
    if errorlevel 2 exit /b 1
) else (
    echo        OK: Ollama found
)

:: ── Step 3: Pull Gemma model ──
echo [3/5] Downloading gemma3:4b model... (about 3GB, first time only)
ollama pull gemma3:4b
if %errorlevel% equ 0 (
    echo        OK: gemma3:4b downloaded
) else (
    echo [WARNING] Model download failed. Make sure Ollama is running.
)

:: ── Step 3.5: Pull embedding model ──
echo [3.5/5] Downloading nomic-embed-text model...
ollama pull nomic-embed-text
if %errorlevel% equ 0 (
    echo        OK: nomic-embed-text downloaded
) else (
    echo [WARNING] Embedding model download failed.
)

:: ── Step 4: Setup Python venv ──
echo [4/5] Setting up Python virtual environment...
cd /d "%~dp0..\server"
if not exist "venv" (
    python -m venv venv
    echo        OK: Virtual environment created
) else (
    echo        OK: Virtual environment already exists
)
call venv\Scripts\activate.bat

:: ── Step 5: Install dependencies ──
echo [5/5] Installing Python packages...
pip install -r requirements.txt --quiet
if %errorlevel% neq 0 (
    echo [ERROR] Package installation failed.
    echo         Try: python -m pip install --upgrade pip
    pause
    exit /b 1
)
echo        OK: All packages installed

echo.
echo ========================================
echo   INSTALLATION COMPLETE!
echo ========================================
echo.
echo How to use:
echo   1. Run start_server.bat to start the server
echo   2. Open chrome://extensions in your browser
echo   3. Enable "Developer mode"
echo   4. Click "Load unpacked" and select the extension folder
echo   5. Open a PDF file to start studying
echo.
pause
