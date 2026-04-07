# Article Study - Server Start Script
# PowerShell에서 실행: .\start_server.ps1

Write-Host ""
Write-Host "Starting Article Study Server..." -ForegroundColor Cyan
Write-Host ""

$serverDir = Join-Path $PSScriptRoot "..\server"
Set-Location $serverDir

$venvPython = Join-Path (Get-Location) "venv\Scripts\python.exe"
& $venvPython main.py
