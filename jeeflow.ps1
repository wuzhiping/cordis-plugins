$ErrorActionPreference = "Stop"

# Base
$base = $PSScriptRoot
if (-not $base) {
    $base = $PWD.Path
}

# Versions
$gitVersion = "2.51.0"
$uvVersion = "0.8.17"

# Paths
$gitDir = "$base\git"
$gitExe = "$gitDir\cmd\git.exe"
$uvDir = "$base\uv"
$uvExe = "$uvDir\uv.exe"

# Git repository
$repoDir = "$base\jeeflow"
$repoUrl = "https://github.com/wuzhiping/jeeflow"
# $targetBranch = "main"
$targetBranch = "dev"

# Project files
$pyproject = "$repoDir\pyproject.toml"
$uvLock = "$repoDir\uv.lock"

# Download URLs
$gitZipName = "MinGit-$gitVersion-64-bit.zip"
$gitUrl = "https://github.com/git-for-windows/git/releases/download/v$gitVersion.windows.1/$gitZipName"
$uvUrl = "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip"

# Startup
Write-Host "Base: $base"

# Install portable Git
if (-not (Test-Path $gitExe)) {
    Write-Host "Installing Git $gitVersion"
    $gitZip = "$base\git.zip"

    try {
        Write-Host "Downloading: $gitUrl"
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitZip -UseBasicParsing -ErrorAction Stop
    }
    catch {
        Write-Error "Failed to download Git: $($_.Exception.Message)"
        exit 1
    }

    if (-not (Test-Path $gitZip)) {
        Write-Error "Git ZIP was not downloaded."
        exit 1
    }

    New-Item -ItemType Directory -Path $gitDir -Force | Out-Null

    try {
        Expand-Archive -Path $gitZip -DestinationPath $gitDir -Force -ErrorAction Stop
    }
    catch {
        Write-Error "Failed to extract Git: $($_.Exception.Message)"
        exit 1
    }

    Remove-Item $gitZip -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $gitExe)) {
        Write-Error "git.exe not found after extraction."
        exit 1
    }

    Write-Host "Git $gitVersion installed."
}
else {
    Write-Host "Git already exists."
}

# Install portable uv
if (-not (Test-Path $uvExe)) {
    Write-Host "Installing uv $uvVersion"
    $uvZip = "$base\uv.zip"

    New-Item -ItemType Directory -Path $uvDir -Force | Out-Null

    try {
        Write-Host "Downloading: $uvUrl"
        Invoke-WebRequest -Uri $uvUrl -OutFile $uvZip -UseBasicParsing -ErrorAction Stop
    }
    catch {
        Write-Error "Failed to download uv: $($_.Exception.Message)"
        exit 1
    }

    if (-not (Test-Path $uvZip)) {
        Write-Error "uv ZIP was not downloaded."
        exit 1
    }

    try {
        Expand-Archive -Path $uvZip -DestinationPath $uvDir -Force -ErrorAction Stop
    }
    catch {
        Write-Error "Failed to extract uv: $($_.Exception.Message)"
        exit 1
    }

    Remove-Item $uvZip -Force -ErrorAction SilentlyContinue

    # Move uv.exe from the official ZIP directory
    $nestedDir = "$uvDir\uv-x86_64-pc-windows-msvc"

    if (Test-Path "$nestedDir\uv.exe") {
        Move-Item "$nestedDir\uv.exe" "$uvExe" -Force

        if (Test-Path "$nestedDir\uvx.exe") {
            Move-Item "$nestedDir\uvx.exe" "$uvDir\uvx.exe" -Force
        }

        Remove-Item $nestedDir -Recurse -Force
    }

    if (-not (Test-Path $uvExe)) {
        Write-Error "uv.exe not found after extraction."
        exit 1
    }

    Write-Host "uv $uvVersion installed."
}
else {
    Write-Host "uv already exists."
}

# Add portable tools to PATH
$env:Path = "$gitDir\cmd;$gitDir\usr\bin;$uvDir;$env:Path"

# Verify Git and uv
if (-not (Test-Path $gitExe)) {
    Write-Error "Git executable not found: $gitExe"
    exit 1
}

if (-not (Test-Path $uvExe)) {
    Write-Error "uv executable not found: $uvExe"
    exit 1
}

# Clone or update jeeflow
if (-not (Test-Path "$repoDir\.git")) {
    # Remove existing invalid directory
    if (Test-Path $repoDir) {
        Write-Host "Removing invalid project directory..."
        Remove-Item $repoDir -Recurse -Force
    }

    # Clone target branch
    Write-Host "Cloning wuzhiping/jeeflow [$targetBranch]..."
    & $gitExe clone -b $targetBranch $repoUrl $repoDir

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Git clone failed."
        exit $LASTEXITCODE
    }

    Write-Host "jeeflow cloned."
}
else {
    # Check current branch
    $currentBranch = (& $gitExe -C $repoDir branch --show-current).Trim()

    Write-Host "Current branch: $currentBranch"
    Write-Host "Target branch: $targetBranch"

    Push-Location $repoDir

    try {
        # Fetch latest remote information
        Write-Host "Fetching latest remote changes..."
        & $gitExe fetch origin

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Git fetch failed."
            exit $LASTEXITCODE
        }

        # Switch to target branch
        if ($currentBranch -ne $targetBranch) {
            Write-Host "Switching from $currentBranch to $targetBranch..."

            & $gitExe checkout -B $targetBranch "origin/$targetBranch"

            if ($LASTEXITCODE -ne 0) {
                Write-Error "Failed to switch to $targetBranch."
                exit $LASTEXITCODE
            }

            Write-Host "Switched to $targetBranch."
        }
        else {
            Write-Host "Already on $targetBranch."
        }

        # Pull latest changes
        Write-Host "Updating $targetBranch..."
        & $gitExe pull --ff-only

        if ($LASTEXITCODE -ne 0) {
            Write-Error "Git pull failed."
            exit $LASTEXITCODE
        }

        Write-Host "jeeflow is up to date."
    }
    finally {
        Pop-Location
    }
}

# Check uv project
if (-not (Test-Path $repoDir)) {
    Write-Error "uv project directory not found: $repoDir"
    exit 1
}

if (-not (Test-Path $pyproject)) {
    Write-Error "pyproject.toml not found: $pyproject"
    exit 1
}

if (-not (Test-Path $uvLock)) {
    Write-Error "uv.lock not found: $uvLock"
    exit 1
}

# Sync dependencies using the existing uv.lock
Push-Location $repoDir

try {
    Write-Host "Syncing dependencies..."
    & $uvExe sync --locked

    if ($LASTEXITCODE -ne 0) {
        throw "uv sync failed"
    }

    Write-Host "Dependencies ready."

    # Start jeeflow
    Write-Host "Starting jeeflow ..."
    & $uvExe run main.py
}
finally {
    Pop-Location
}
