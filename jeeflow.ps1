$ErrorActionPreference = "Stop"

# Base

$base = $PSScriptRoot

if (-not $base) {
    $base = $PWD.Path
}

# Versions

$gitVersion   = "2.51.0"
$uvVersion    = "0.8.17"

# Paths

$gitDir = "$base\git"
$gitExe = "$gitDir\cmd\git.exe"
$uvDir = "$base\uv"
$uvExe = "$uvDir\uv.exe"

# Git repository
$repoDir = "$base\jeeflow"
$repoUrl = "https://github.com/wuzhiping/jeeflow"

# Dependency sync marker
$syncMarker = "$repoDir\.uv-sync"

# Download URLs

$gitZipName = "MinGit-$gitVersion-64-bit.zip"

$gitUrl = `
    "https://github.com/git-for-windows/git/releases/download/" +
    "v$gitVersion.windows.1/$gitZipName"

$uvUrl = `
    "https://github.com/astral-sh/uv/releases/download/" +
    "$uvVersion/uv-x86_64-pc-windows-msvc.zip"

# Startup

Write-Host "Base: $base"

# Install Portable Git

if (-not (Test-Path $gitExe)) {

    Write-Host "Installing Git $gitVersion"

    $gitZip = "$base\git.zip"

    try {

        Write-Host "Downloading: $gitUrl"
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitZip -UseBasicParsing -ErrorAction Stop
    }
    catch {
        
        Write-Error "Failed to download Git:  $_.Exception.Message"
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

        Write-Error "Failed to extract Git: $_.Exception.Message"
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

# Install Portable uv

if (-not (Test-Path $uvExe)) {

    Write-Host "Installing uv $uvVersion"

    $uvZip = "$base\uv.zip"

    New-Item -ItemType Directory -Path $uvDir -Force | Out-Null

    try {

        Write-Host "Downloading: $uvUrl"

        Invoke-WebRequest -Uri $uvUrl -OutFile $uvZip -UseBasicParsing -ErrorAction Stop

    }
    catch {

        Write-Error "Failed to download uv: $_.Exception.Message"
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

        Write-Error "Failed to extract uv: $_.Exception.Message"
        exit 1
    }

    Remove-Item $uvZip -Force -ErrorAction SilentlyContinue

    # Official ZIP:
    #
    # uv-x86_64-pc-windows-msvc\
    # ├── uv.exe
    # └── uvx.exe

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

# Portable PATH

$env:Path = `
    "$gitDir\cmd;" +
    "$gitDir\usr\bin;" +
    "$uvDir;" +
    "$env:Path"

# Verify Git / uv

if (-not (Test-Path $gitExe)) {

    Write-Error "Git executable not found: $gitExe"
    exit 1
}

if (-not (Test-Path $uvExe)) {

    Write-Error "uv executable not found: $uvExe"
    exit 1
}

# Clone / Update jeeflow

if (-not (Test-Path "$repoDir\.git")) {

    if (Test-Path $repoDir) {

        Write-Host "Removing invalid project directory..."
        Remove-Item $repoDir -Recurse -Force
    }

    Write-Host "Cloning wuzhiping/jeeflow..."

    & $gitExe clone $repoUrl $repoDir

    if ($LASTEXITCODE -ne 0) {

        Write-Error "Git clone failed."
        exit $LASTEXITCODE
    }

    Write-Host "jeeflow cloned."

}
else {

    Push-Location $repoDir

    try {

        # Check remote jeflow updates

        Write-Host "Checking jeflow updates..."

        & $gitExe fetch origin --quiet

        if ($LASTEXITCODE -ne 0) {

            Write-Warning "Git fetch failed. Continue with local version."

        }
        else {

            $localCommit = (& $gitExe rev-parse HEAD).Trim()

            $remoteCommit = (& $gitExe rev-parse '@{u}').Trim()

            if ($localCommit -ne $remoteCommit) {

                Write-Host "Remote update detected."

                Write-Host "Updating jeflow..."

                & $gitExe pull --ff-only

                if ($LASTEXITCODE -ne 0) {

                    Write-Error "Git pull failed."
                    exit $LASTEXITCODE
                }

                Write-Host "jeflow updated."

            }
            else {

                Write-Host "jeflow is up to date."
            }
        }

    }
    finally {

        Pop-Location
    }
}

# Check uv Project

if (-not (Test-Path $repoDir)) {

    Write-Error "uv project directory not found:"
    Write-Error $repoDir
    exit 1
}

$pyproject = "$repoDir\pyproject.toml"
$uvLock    = "$repoDir\uv.lock"

if (-not (Test-Path $pyproject)) {

    Write-Error "pyproject.toml not found:"
    Write-Error $pyproject
    exit 1
}

# Python Environment

Push-Location $repoDir

try {

    $needSync = $false

    # First run

    if (-not (Test-Path $syncMarker)) {

        Write-Host "Dependency marker not found."
        $needSync = $true
    }

    # uv.lock missing

    if (-not (Test-Path $uvLock)) {

        Write-Host "uv.lock not found."
        $needSync = $true
    }

    # Check dependency file changes

    if (-not $needSync -and (Test-Path $syncMarker)) {

        $markerTime = `
            (Get-Item $syncMarker).LastWriteTimeUtc

        $pyprojectTime = `
            (Get-Item $pyproject).LastWriteTimeUtc

        $lockTime = `
            (Get-Item $uvLock).LastWriteTimeUtc

        if ($pyprojectTime -gt $markerTime) {

            Write-Host "pyproject.toml changed."

            $needSync = $true
        }

        if ($lockTime -gt $markerTime) {

            Write-Host "uv.lock changed."

            $needSync = $true
        }
    }

    # Sync dependencies

    if ($needSync) {

        Write-Host "Updating lockfile..."

        & $uvExe lock
        if ($LASTEXITCODE -ne 0) {
            throw "uv lock failed"
        }

        Write-Host "Syncing dependencies..."

        & $uvExe sync --locked
        if ($LASTEXITCODE -ne 0) {
            throw "uv sync failed"
        }

        New-Item -ItemType File -Path $syncMarker -Force | Out-Null

        Write-Host "Dependencies ready."

    }
    else {

        Write-Host "Dependencies are up to date."
    }

    # Start jeeflow

    Write-Host "Starting jeeflow ..."

    & $uvExe run main.py

}
finally {

    Pop-Location
}
