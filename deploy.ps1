# Oracle Status Dashboard - Cloudron Deploy Script
# Run this as Administrator (right-click > Run as Administrator)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Oracle Status Dashboard - Cloudron Deploy" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Docker
$dockerPath = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
$dockerDesktopPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"

if (-not (Test-Path $dockerPath)) {
    Write-Host "Docker not found. Installing via winget..." -ForegroundColor Yellow
    winget install Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
}

# Start Docker Desktop
Write-Host "Starting Docker Desktop..." -ForegroundColor Yellow
Start-Process $dockerDesktopPath -WindowStyle Minimized

# Wait for Docker daemon
Write-Host "Waiting for Docker daemon to start (this may take 2-3 minutes)..." -ForegroundColor Yellow
$maxAttempts = 30
for ($i = 1; $i -le $maxAttempts; $i++) {
    Start-Sleep -Seconds 10
    $result = & $dockerPath info 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Docker is ready!" -ForegroundColor Green
        break
    }
    Write-Host "  Attempt $i/$maxAttempts - waiting for daemon..."
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker daemon failed to start. Please start Docker Desktop manually and run this script again." -ForegroundColor Red
    exit 1
}

# Login to Cloudron
Write-Host ""
Write-Host "Logging into Cloudron..." -ForegroundColor Yellow
cloudron login my.enjoytech.co.uk

# Build the image
Write-Host ""
Write-Host "Building Docker image..." -ForegroundColor Yellow
Push-Location "$PSScriptRoot"
& $dockerPath build -t oracle-status-dashboard .

# Tag for Cloudron's registry
$tag = "cloudron/oracle-status-dashboard.cloudronapp:latest"
& $dockerPath tag oracle-status-dashboard $tag

# Install on Cloudron
Write-Host ""
Write-Host "Installing on Cloudron..." -ForegroundColor Yellow
cloudron install --image $tag --location oracle-dashboard

Pop-Location
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Deploy complete!" -ForegroundColor Green
Write-Host " Access at: https://oracle-dashboard.my.enjoytech.co.uk" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
