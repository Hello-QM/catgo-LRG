# PowerShell build script for CatGo backend server (Windows)
# Build PyInstaller bundle for Windows

param(
    [string]$Target = "native"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerDir = Join-Path $ProjectDir "server"
$BinariesDir = Join-Path $ProjectDir "src-tauri\binaries"

Write-Host "Building CatGo backend server..."
Write-Host "Target: $Target"
Write-Host "Server directory: $ServerDir"
Write-Host "Output directory: $BinariesDir"

# Create binaries directory if it doesn't exist
if (-not (Test-Path $BinariesDir)) {
    New-Item -ItemType Directory -Path $BinariesDir -Force | Out-Null
}

Set-Location $ServerDir

# Output name for Windows
$OutputName = "catgo-server-x86_64-pc-windows-msvc.exe"

Write-Host "Output filename: $OutputName"

# Check for Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Error "Error: python is required"
    exit 1
}

# Check/install PyInstaller
try {
    python -c "import PyInstaller" 2>$null
} catch {
    Write-Host "Installing PyInstaller..."
    python -m pip install pyinstaller
}

# Build with PyInstaller
Write-Host "Running PyInstaller..."
python -m PyInstaller catgo_server.spec --noconfirm

# Move output to binaries directory
$DistExe = Join-Path $ServerDir "dist\catgo-server.exe"
$DistDirExe = Join-Path $ServerDir "dist\catgo-server\catgo-server.exe"

if (Test-Path $DistExe) {
    Copy-Item $DistExe -Destination (Join-Path $BinariesDir $OutputName) -Force
} elseif (Test-Path $DistDirExe) {
    Copy-Item $DistDirExe -Destination (Join-Path $BinariesDir $OutputName) -Force
} else {
    Write-Error "Could not find built executable"
    exit 1
}

Write-Host "Backend built successfully: $BinariesDir\$OutputName"
Get-ChildItem $BinariesDir
