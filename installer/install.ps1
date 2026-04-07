# Article Study - Install Script
# PowerShell에서 실행: .\install.ps1

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Article Study - Install" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check Python
Write-Host "[1/5] Checking Python..." -ForegroundColor Yellow
$pyCmd = "python"
try {
    $pyVer = & py --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        $pyCmd = "py"
        Write-Host "       OK: $pyVer (using $pyCmd)" -ForegroundColor Green
    } else {
        throw "py not found"
    }
} catch {
    try {
        $pyVer = & python --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "       OK: $pyVer" -ForegroundColor Green
        } else {
            throw "python not found"
        }
    } catch {
        Write-Host "[ERROR] Python is not installed or not in PATH." -ForegroundColor Red
        Write-Host "        Download: https://www.python.org/downloads/" -ForegroundColor Red
        Write-Host "        Check 'Add Python to PATH' during install." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# Step 2: Check Ollama
Write-Host "[2/5] Checking Ollama..." -ForegroundColor Yellow
try {
    $olVer = ollama --version 2>&1
    Write-Host "       OK: Ollama found" -ForegroundColor Green
} catch {
    Write-Host "[WARNING] Ollama not found." -ForegroundColor DarkYellow
    Write-Host "          Download: https://ollama.com/download" -ForegroundColor DarkYellow
}

# Step 3: Pull Gemma model
Write-Host "[3/5] Downloading gemma3:1b model (first time only)..." -ForegroundColor Yellow
& ollama pull gemma3:1b
if ($LASTEXITCODE -eq 0) {
    Write-Host "       OK: gemma3:1b downloaded" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Model download failed. Is Ollama running?" -ForegroundColor DarkYellow
}

# Step 3.5: Pull embedding model
Write-Host "[3.5/5] Downloading nomic-embed-text model..." -ForegroundColor Yellow
& ollama pull nomic-embed-text
if ($LASTEXITCODE -eq 0) {
    Write-Host "       OK: nomic-embed-text downloaded" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Embedding model download failed." -ForegroundColor DarkYellow
}

# Step 4: Setup Python venv
Write-Host "[4/5] Setting up Python virtual environment..." -ForegroundColor Yellow
$serverDir = Join-Path $PSScriptRoot "..\server"
Set-Location $serverDir

if (-not (Test-Path "venv")) {
    & $pyCmd -m venv venv
    Write-Host "       OK: Virtual environment created" -ForegroundColor Green
} else {
    Write-Host "       OK: Virtual environment already exists" -ForegroundColor Green
}

# Activate venv and install
$venvPython = Join-Path (Get-Location) "venv\Scripts\python.exe"

# Step 5: Install dependencies
Write-Host "[5/5] Installing Python packages (this may take a few minutes)..." -ForegroundColor Yellow
& $venvPython -m pip install --upgrade pip 2>&1 | Out-Null
& $venvPython -m pip install -r requirements.txt
if ($LASTEXITCODE -eq 0) {
    Write-Host "       OK: All packages installed" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Package install failed." -ForegroundColor Red
    Write-Host "        Try running manually:" -ForegroundColor Red
    Write-Host "        cd server" -ForegroundColor Red
    Write-Host "        .\venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  INSTALLATION COMPLETE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "How to use:" -ForegroundColor White
Write-Host "  1. Run .\start_server.ps1 to start the server" -ForegroundColor White
Write-Host "  2. Open chrome://extensions in your browser" -ForegroundColor White
Write-Host "  3. Enable 'Developer mode'" -ForegroundColor White
Write-Host "  4. Click 'Load unpacked' -> select extension folder" -ForegroundColor White
Write-Host "  5. Open a PDF file to start studying" -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to finish"
