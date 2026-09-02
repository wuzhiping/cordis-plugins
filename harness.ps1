# ============================================================
# DSH Portable Launcher
# ============================================================

$ErrorActionPreference = "Stop"

# ============================================================
# Base paths
# ============================================================

$base = $PSScriptRoot

if (-not $base) {
    $base = $PWD.Path
}

$node      = Join-Path $base "node"
$bin       = Join-Path $node "node-v24.19.0-win-x64"
$globalDir = Join-Path $node "global"
$cacheDir  = Join-Path $node "cache"

$nodeExe   = Join-Path $bin "node.exe"
$npmCmd    = Join-Path $bin "npm.cmd"
$npxCmd    = Join-Path $bin "npx.cmd"
$dshCmd    = Join-Path $globalDir "dsh.cmd"

$dshHome   = Join-Path $base "dsh"

$nodeZip   = Join-Path $base "node.zip"

# ============================================================
# Configuration
# ============================================================

$nodeVersion = "node-v24.19.0-win-x64"

$nodeUrl = "https://abc.feg.com.tw/share/ehr/pages/dev/node-v24.19.0-win-x64.zip"

$dshVersion = "0.1.1-rc.2"

$dshBaseUrl = "https://abc.feg.com.tw/vx"

$dshModel = "deepseek-v4-flash"

$port = 3080

$hostAddress = "127.0.0.1"

$plugin = "github:wuzhiping/cordis-plugins#path:/zhtw-traditional-chinese"

# ============================================================
# Log helpers
# ============================================================

function Log($message) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $message"
}

function Fail($message) {
    Write-Host ""
    Write-Host "ERROR: $message" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# ============================================================
# Prepare directories
# ============================================================

New-Item -ItemType Directory -Force -Path $node | Out-Null
New-Item -ItemType Directory -Force -Path $globalDir | Out-Null
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
New-Item -ItemType Directory -Force -Path $dshHome | Out-Null

# ============================================================
# Environment
# ============================================================

$env:DEEPSEEK_BASE_URL = $dshBaseUrl
$env:DSH_MODEL = $dshModel
$env:DSH_HOME = $dshHome
$env:LITELLM_DROP_PARAMS = "true"

# Portable Node / npm global
$env:NPM_CONFIG_PREFIX = $globalDir
$env:NPM_CONFIG_CACHE = $cacheDir

# Put portable Node first
$env:Path = "$bin;$globalDir;$env:Path"


# ============================================================
# 0. Install Portable Git
# ============================================================

$gitVersion   = "2.51.0"
$gitZipName = "MinGit-$gitVersion-64-bit.zip"
$gitDir = "$base\git"
$gitExe = "$gitDir\cmd\git.exe"
$gitUrl = `
    "https://github.com/git-for-windows/git/releases/download/" +
    "v$gitVersion.windows.1/$gitZipName"

if (-not (Test-Path $gitExe)) {

    Log "Installing Git $gitVersion..."
    $gitZip = "$base\git.zip"

    try {

        Log "Downloading Git..."

        Invoke-WebRequest `
            -Uri $gitUrl `
            -OutFile $gitZip `
            -UseBasicParsing `
            -ErrorAction Stop

    }
    catch {

        Log "Failed to download Git:"
        Log $_.Exception.Message
        exit 1
    }

    if (-not (Test-Path $gitZip)) {

        Log "Git ZIP was not downloaded."
        exit 1
    }

    New-Item `
        -ItemType Directory `
        -Path $gitDir `
        -Force | Out-Null

    Log "Extracting Git..."

    try {

        Expand-Archive `
            -Path $gitZip `
            -DestinationPath $gitDir `
            -Force `
            -ErrorAction Stop

    }
    catch {

        Log "Failed to extract Git:"
        Log $_.Exception.Message
        exit 1
    }

    Remove-Item `
        $gitZip `
        -Force `
        -ErrorAction SilentlyContinue

    if (-not (Test-Path $gitExe)) {

        Log "git.exe not found after extraction."
        exit 1
    }

    Log "Git installed: $gitExe"

}
else {

    Log "Git already exists."
}

# git join in Path
$env:Path = "$gitDir\cmd;$gitDir\usr\bin;$env:Path"

# ============================================================
# 1. Node.js
# ============================================================

if (-not (Test-Path $nodeExe)) {

    Log "Node.js not found."
    Log "Downloading Node.js..."

    try {
        Invoke-WebRequest `
            -Uri $nodeUrl `
            -OutFile $nodeZip `
            -UseBasicParsing
    }
    catch {
        Fail "Node.js download failed: $($_.Exception.Message)"
    }

    Log "Extracting Node.js..."

    try {
        Expand-Archive `
            -Path $nodeZip `
            -DestinationPath $node `
            -Force
    }
    catch {
        Fail "Node.js extraction failed: $($_.Exception.Message)"
    }

    Remove-Item $nodeZip -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $nodeExe)) {
        Fail "Node.js installation failed. Missing: $nodeExe"
    }

    Log "Node.js installed."
}
else {
    Log "Node.js already exists."
}

# ============================================================
# 2. dsh
# ============================================================

$dshPackageJson = Join-Path `
    $globalDir `
    "node_modules\@deepseek-ai\dsh\package.json"

$needDshInstall = $true

if (Test-Path $dshPackageJson) {

    try {

        $dshPackage = Get-Content `
            $dshPackageJson `
            -Raw |
            ConvertFrom-Json

        if ($dshPackage.version -eq $dshVersion) {

            if (Test-Path $dshCmd) {
                $needDshInstall = $false
                Log "dsh already installed: $dshVersion"
            }
        }
    }
    catch {
        $needDshInstall = $true
    }
}

if ($needDshInstall) {

    Log "Installing dsh $dshVersion..."

    & $npmCmd `
        --prefix $globalDir `
        --cache $cacheDir `
        install -g "@deepseek-ai/dsh@$dshVersion" --registry http://registry.npmmirror.com

    if ($LASTEXITCODE -ne 0) {
        Fail "dsh installation failed."
    }

    if (-not (Test-Path $dshCmd)) {
        Fail "dsh installed but dsh.cmd was not found: $dshCmd"
    }

    Log "dsh installed: $dshVersion"
}

# ============================================================
# 3. pnpm
# ============================================================

$pnpmCmd = Join-Path $globalDir "pnpm.cmd"

if (-not (Test-Path $pnpmCmd)) {

    Log "pnpm not found. Installing..."

    & $npmCmd `
        --prefix $globalDir `
        --cache $cacheDir `
        install -g pnpm --registry http://registry.npmmirror.com

    if ($LASTEXITCODE -ne 0) {
        Fail "pnpm installation failed."
    }

    Log "pnpm installed."
}
else {
    Log "pnpm already exists."
}

# ============================================================
# 4. Plugins
# ============================================================

$plugins = @(
    @{
        Name    = "zhtw-traditional-chinese"
        Version = "0.1.4"
        Source  = "github:wuzhiping/cordis-plugins#path:/zhtw-traditional-chinese"
        Profile = "web"
    }

    # 以后继续增加：
    #
    # @{
    #     Name    = "plugin-2"
    #     Version = "1.2.0"
    #     Source  = "github:xxx/xxx#path:/plugin-2"
    #     Profile = "web"
    # }
)

foreach ($pluginItem in $plugins) {

    $pluginName    = $pluginItem.Name
    $pluginVersion = $pluginItem.Version
    $pluginSource  = $pluginItem.Source
    $pluginProfile = $pluginItem.Profile

    Log "Checking plugin: $pluginName"

    # --------------------------------------------------------
    # Get installed plugins
    # --------------------------------------------------------

    $pluginList = cmd /c "`"$dshCmd`" plugin --profile `"$pluginProfile`" list 2>&1" |
    Out-String

    # --------------------------------------------------------
    # Parse:
    #
    # zhtw-traditional-chinese@0.1.4
    #
    # --------------------------------------------------------

    $pattern = '(?m)(?:^|\s)' +
               [regex]::Escape($pluginName) +
               '@([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)'

    $match = [regex]::Match($pluginList, $pattern)

    if ($match.Success) {

        $installedVersion = $match.Groups[1].Value

        if ($installedVersion -eq $pluginVersion) {

            Log "Plugin OK: $pluginName@$installedVersion"

            continue
        }

        Log "Plugin version mismatch:"
        Log "  Installed: $installedVersion"
        Log "  Required : $pluginVersion"

    }
    else {

        Log "Plugin not installed: $pluginName"
    }

    # --------------------------------------------------------
    # Install / Update
    # --------------------------------------------------------

    Log "Installing/updating plugin: $pluginName@$pluginVersion"

    & $npxCmd `
        --prefix $globalDir `
        --cache $cacheDir `
        @deepseek-ai/dsh `
        plugin `
        --profile $pluginProfile `
        add `
        $pluginSource

    if ($LASTEXITCODE -ne 0) {
        Fail "Plugin installation/update failed: $pluginName"
    }

    Log "Plugin installed/updated: $pluginName@$pluginVersion"
}

# ============================================================
# 5. Check port 3080
# ============================================================

$listener = Get-NetTCPConnection `
    -LocalPort $port `
    -ErrorAction SilentlyContinue |
    Select-Object -First 1

if ($listener) {

    $processId = $listener.OwningProcess

    Log "dsh web is already running."
    Log "PID: $processId"
    Log "URL: http://$hostAddress`:$port"

    exit 0
}

# ============================================================
# 6. Final validation
# ============================================================

if (-not (Test-Path $nodeExe)) {
    Fail "node.exe not found: $nodeExe"
}

if (-not (Test-Path $dshCmd)) {
    Fail "dsh.cmd not found: $dshCmd"
}

# ============================================================
# 7. Start DSH
# ============================================================

Log "Starting dsh web..."
Log "Model : $dshModel"
Log "Host  : $hostAddress"
Log "Port  : $port"
Log "URL   : http://$hostAddress`:$port"
Log ""

# IMPORTANT:
# Do NOT use npx here.
#
# npm global installation creates:
#
#   $globalDir\dsh.cmd
#
# Directly execute it for faster startup.

# 后台启动，获取进程对象
$dsh = Start-Process $dshCmd `
    -ArgumentList "web","--host",$hostAddress,"--port",$port,"--no-open" `
    -PassThru -NoNewWindow

# 轮询等端口就绪
$wait = 30
while ($wait-- -gt 0 -and -not (Get-NetTCPConnection -LocalPort $port -EA SilentlyContinue)) {
    Start-Sleep 1
}

if ($wait -le 0) {
    $dsh | Stop-Process -Force
    Fail "dsh start timeout"
}

# 成功后写入时间
Get-Date -Format "yyyy-MM-dd HH:mm:ss" | Out-File harness.txt -Encoding utf8
Log "dsh web ready."

# 挂住脚本，保持 dsh 运行（按 Ctrl+C 退出；用 taskkill、关闭终端、或者让 dsh 一直后台跑 不需要）
# $dsh.WaitForExit()

# # 停止 dsh
# taskkill /F /IM node.exe 2>$null; Remove-Item -Path "$PSScriptRootdsh.log" -Force -ErrorAction SilentlyContinue; Write-Output "STOPPED"

