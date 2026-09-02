$ErrorActionPreference = "Stop"

# ============================================================
# Base
# ============================================================

$base = $PSScriptRoot

if (-not $base) {
    $base = $PWD.Path
}

# ============================================================
# Versions
# ============================================================

$gitVersion   = "2.51.0"
$uvVersion    = "0.8.17"
$winswVersion = "v2.12.0"

# ============================================================
# Paths
# ============================================================

$gitDir = "$base\git"
$gitExe = "$gitDir\cmd\git.exe"

$uvDir = "$base\uv"
$uvExe = "$uvDir\uv.exe"

# Git repository
$repoDir = "$base\project"
$repoUrl = "https://github.com/wuzhiping/cattle.git"

# Actual uv project
$projectDir = "$repoDir\agents"

# WinSW
$serviceDir = "$repoDir\service"
$winswExe   = "$serviceDir\cattle-agents.exe"
$winswXml   = "$serviceDir\cattle-agents.xml"

# Dependency sync marker
$syncMarker = "$projectDir\.uv-sync"

# ============================================================
# Download URLs
# ============================================================

$gitZipName = "MinGit-$gitVersion-64-bit.zip"

$gitUrl = `
    "https://github.com/git-for-windows/git/releases/download/" +
    "v$gitVersion.windows.1/$gitZipName"

$uvUrl = `
    "https://github.com/astral-sh/uv/releases/download/" +
    "$uvVersion/uv-x86_64-pc-windows-msvc.zip"

$winswUrl = `
    "https://github.com/winsw/winsw/releases/download/" +
    "$winswVersion/WinSW-x64.exe"

# ============================================================
# Startup
# ============================================================

Write-Host ""
Write-Host "========================================"
Write-Host "Cattle Agents"
Write-Host "========================================"

Write-Host "Base:"
Write-Host $base

# ============================================================
# Install Portable Git
# ============================================================

if (-not (Test-Path $gitExe)) {

    Write-Host ""
    Write-Host "========================================"
    Write-Host "Installing Git $gitVersion"
    Write-Host "========================================"

    $gitZip = "$base\git.zip"

    try {

        Write-Host "Downloading:"
        Write-Host $gitUrl

        Invoke-WebRequest `
            -Uri $gitUrl `
            -OutFile $gitZip `
            -UseBasicParsing `
            -ErrorAction Stop

    }
    catch {

        Write-Error "Failed to download Git:"
        Write-Error $_.Exception.Message
        exit 1
    }

    if (-not (Test-Path $gitZip)) {

        Write-Error "Git ZIP was not downloaded."
        exit 1
    }

    New-Item `
        -ItemType Directory `
        -Path $gitDir `
        -Force | Out-Null

    try {

        Expand-Archive `
            -Path $gitZip `
            -DestinationPath $gitDir `
            -Force `
            -ErrorAction Stop

    }
    catch {

        Write-Error "Failed to extract Git:"
        Write-Error $_.Exception.Message
        exit 1
    }

    Remove-Item `
        $gitZip `
        -Force `
        -ErrorAction SilentlyContinue

    if (-not (Test-Path $gitExe)) {

        Write-Error "git.exe not found after extraction."
        exit 1
    }

    Write-Host "Git $gitVersion installed."

}
else {

    Write-Host "Git already exists."
}

# ============================================================
# Install Portable uv
# ============================================================

if (-not (Test-Path $uvExe)) {

    Write-Host ""
    Write-Host "========================================"
    Write-Host "Installing uv $uvVersion"
    Write-Host "========================================"

    $uvZip = "$base\uv.zip"

    New-Item `
        -ItemType Directory `
        -Path $uvDir `
        -Force | Out-Null

    try {

        Write-Host "Downloading:"
        Write-Host $uvUrl

        Invoke-WebRequest `
            -Uri $uvUrl `
            -OutFile $uvZip `
            -UseBasicParsing `
            -ErrorAction Stop

    }
    catch {

        Write-Error "Failed to download uv:"
        Write-Error $_.Exception.Message
        exit 1
    }

    if (-not (Test-Path $uvZip)) {

        Write-Error "uv ZIP was not downloaded."
        exit 1
    }

    try {

        Expand-Archive `
            -Path $uvZip `
            -DestinationPath $uvDir `
            -Force `
            -ErrorAction Stop

    }
    catch {

        Write-Error "Failed to extract uv:"
        Write-Error $_.Exception.Message
        exit 1
    }

    Remove-Item `
        $uvZip `
        -Force `
        -ErrorAction SilentlyContinue

    # Official ZIP:
    #
    # uv-x86_64-pc-windows-msvc\
    # ├── uv.exe
    # └── uvx.exe

    $nestedDir = "$uvDir\uv-x86_64-pc-windows-msvc"

    if (Test-Path "$nestedDir\uv.exe") {

        Move-Item `
            "$nestedDir\uv.exe" `
            "$uvExe" `
            -Force

        if (Test-Path "$nestedDir\uvx.exe") {

            Move-Item `
                "$nestedDir\uvx.exe" `
                "$uvDir\uvx.exe" `
                -Force
        }

        Remove-Item `
            $nestedDir `
            -Recurse `
            -Force
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

# ============================================================
# Portable PATH
# ============================================================

$env:Path = `
    "$gitDir\cmd;" +
    "$gitDir\usr\bin;" +
    "$uvDir;" +
    "$env:Path"

# ============================================================
# Verify Git / uv
# ============================================================

if (-not (Test-Path $gitExe)) {

    Write-Error "Git executable not found:"
    Write-Error $gitExe
    exit 1
}

if (-not (Test-Path $uvExe)) {

    Write-Error "uv executable not found:"
    Write-Error $uvExe
    exit 1
}

# ============================================================
# Clone / Update cattle
# ============================================================

Write-Host ""
Write-Host "========================================"
Write-Host "cattle"
Write-Host "========================================"

if (-not (Test-Path "$repoDir\.git")) {

    # --------------------------------------------------------
    # Clone
    # --------------------------------------------------------

    if (Test-Path $repoDir) {

        Write-Host "Removing invalid project directory..."

        Remove-Item `
            $repoDir `
            -Recurse `
            -Force
    }

    Write-Host "Cloning wuzhiping/cattle..."

    & $gitExe clone `
        $repoUrl `
        $repoDir

    if ($LASTEXITCODE -ne 0) {

        Write-Error "Git clone failed."
        exit $LASTEXITCODE
    }

    Write-Host "cattle cloned."

}
else {

    Push-Location $repoDir

    try {

        # ----------------------------------------------------
        # Check remote update
        # ----------------------------------------------------

        Write-Host "Checking cattle updates..."

        & $gitExe fetch origin --quiet

        if ($LASTEXITCODE -ne 0) {

            Write-Warning "Git fetch failed. Continue with local version."

        }
        else {

            $localCommit = `
                (& $gitExe rev-parse HEAD).Trim()

            $remoteCommit = `
                (& $gitExe rev-parse '@{u}').Trim()

            if ($localCommit -ne $remoteCommit) {

                Write-Host "Remote update detected."

                Write-Host "Updating cattle..."

                & $gitExe pull --ff-only

                if ($LASTEXITCODE -ne 0) {

                    Write-Error "Git pull failed."
                    exit $LASTEXITCODE
                }

                Write-Host "cattle updated."

            }
            else {

                Write-Host "cattle is up to date."
            }
        }

    }
    finally {

        Pop-Location
    }
}

# ============================================================
# Check uv Project
# ============================================================

if (-not (Test-Path $projectDir)) {

    Write-Error "uv project directory not found:"
    Write-Error $projectDir
    exit 1
}

$pyproject = "$projectDir\pyproject.toml"
$uvLock    = "$projectDir\uv.lock"

if (-not (Test-Path $pyproject)) {

    Write-Error "pyproject.toml not found:"
    Write-Error $pyproject
    exit 1
}

# ============================================================
# Install Portable WinSW
# ============================================================

if (-not (Test-Path $winswExe)) {

    Write-Host ""
    Write-Host "========================================"
    Write-Host "Installing WinSW $winswVersion"
    Write-Host "========================================"

    New-Item `
        -ItemType Directory `
        -Path $serviceDir `
        -Force | Out-Null

    $winswDownload = "$base\WinSW-x64.exe"

    try {

        Write-Host "Downloading:"
        Write-Host $winswUrl

        Invoke-WebRequest `
            -Uri $winswUrl `
            -OutFile $winswDownload `
            -UseBasicParsing `
            -ErrorAction Stop

    }
    catch {

        Write-Error "Failed to download WinSW:"
        Write-Error $_.Exception.Message
        exit 1
    }

    if (-not (Test-Path $winswDownload)) {

        Write-Error "WinSW executable was not downloaded."
        exit 1
    }

    Move-Item `
        $winswDownload `
        $winswExe `
        -Force

    Write-Host "WinSW installed:"
    Write-Host $winswExe

}
else {

    Write-Host "WinSW already exists."
}

# ============================================================
# Check WinSW configuration
# ============================================================

if (-not (Test-Path $winswXml)) {

    Write-Error "WinSW configuration not found:"
    Write-Error $winswXml
    exit 1
}

# ============================================================
# Stop Existing cattle-agents
# ============================================================

Write-Host ""
Write-Host "Stopping existing cattle-agents..."

$uvProcesses = @(
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "uv.exe" -and
            $_.CommandLine -like "*$projectDir*"
        }
)

foreach ($proc in $uvProcesses) {

    Write-Host "Stopping uv PID: $($proc.ProcessId)"

    & taskkill.exe `
        /PID $proc.ProcessId `
        /T `
        /F `
        2>$null
}

if ($uvProcesses.Count -gt 0) {

    Start-Sleep -Milliseconds 300
}

# ============================================================
# Python Environment
# ============================================================

Push-Location $projectDir

try {

    Write-Host ""
    Write-Host "========================================"
    Write-Host "Python Environment"
    Write-Host "========================================"

    $needSync = $false

    # --------------------------------------------------------
    # First run
    # --------------------------------------------------------

    if (-not (Test-Path $syncMarker)) {

        Write-Host "Dependency marker not found."

        $needSync = $true
    }

    # --------------------------------------------------------
    # uv.lock missing
    # --------------------------------------------------------

    if (-not (Test-Path $uvLock)) {

        Write-Host "uv.lock not found."

        $needSync = $true
    }

    # --------------------------------------------------------
    # Check dependency file changes
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # Sync dependencies
    # --------------------------------------------------------

    if ($needSync) {

        Write-Host ""
        Write-Host "Updating lockfile..."

        & $uvExe lock
        if ($LASTEXITCODE -ne 0) {
            throw "uv lock failed"
        }

        Write-Host ""
        Write-Host "Syncing dependencies..."

        & $uvExe sync --locked
        if ($LASTEXITCODE -ne 0) {
            throw "uv sync failed"
        }

        New-Item `
            -ItemType File `
            -Path $syncMarker `
            -Force | Out-Null

        Write-Host "Dependencies ready."

    }
    else {

        Write-Host "Dependencies are up to date."
    }

    # ========================================================
    # Start Jupyter
    # ========================================================

    Write-Host ""
    Write-Host "========================================"
    Write-Host "Starting agents"
    Write-Host "========================================"

    Write-Host "Jupyter:"
    Write-Host "http://127.0.0.1:3088/lab"

    Write-Host ""

    & $uvExe run `
        --no-sync `
        jupyter lab `
        --no-browser `
        --ip=127.0.0.1 `
        --port=3088 `
        --IdentityProvider.token="" `
        --PasswordIdentityProvider.hashed_password="" `
        --ServerApp.root_dir=".\demo" `
        --ServerApp.websocket_allow_origin="*" `
        --ServerApp.allow_origin="*" `
        --ServerApp.allow_remote_access=True `
        --ServerApp.disable_check_xsrf=True `
        --ServerApp.tornado_settings="{'headers': {'Content-Security-Policy': 'frame-ancestors *'}}"

}
finally {

    Pop-Location
}
