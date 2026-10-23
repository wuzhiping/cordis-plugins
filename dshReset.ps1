
$base = $PSScriptRoot; if (-not $base) { $base = $PWD.Path }
$node = "$base\node"
$bin  = "$node\node-v24.19.0-win-x64"
$globalDir = "$node\global"
$cacheDir  = "$node\cache"
$gitDir = "$base\git"

$mcDir = "$base\mc"

if (-not (Test-Path $mcDir)) {
    New-Item -ItemType Directory -Path $mcDir | Out-Null
}

if (-not (Test-Path "$mcDir\mc.exe")) {
    Write-Host "mc.exe not found Downloading..."
    iwr "https://abc.feg.com.tw/share/ehr/pages/dev/mc.exe" -OutFile "$mcDir\mc.exe"
    Write-Host "mc.exe Downloaded."
} else {
    Write-Host "$mcDir\mc.exe Already exists."
}

$env:MC_CONFIG_DIR = "$mcDir\.mc"
$env:NPM_CONFIG_USERCONFIG = "$base\.npmrc"

# npx隔离 PATH
$env:Path = "$mcDir;$gitDir\cmd;$bin;$globalDir;$env:Path"

mc --version

# 检查并下载 Node.js
if (-not (Test-Path "$bin\node.exe")) {
    iwr "https://abc.feg.com.tw/share/ehr/pages/dev/node-v24.19.0-win-x64.zip" -OutFile "$base\node.zip" -UseBasicParsing
    Expand-Archive "$base\node.zip" $node -Force
    Remove-Item "$base\node.zip"
    Write-Host "Node.js Downloaded."
} else {
    Write-Host "$bin\node.exe Already exists."
}

# DSH 环境变量
$env:DEEPSEEK_BASE_URL = "https://abc.feg.com.tw/vx"; 
$env:DSH_MODEL = "deepseek-v4-flash"
$env:DSH_HOME = "$base\dsh"

#registry https://registry.feg.cn
$npmCmd    = Join-Path $bin "npm.cmd"

& "$bin\npm.cmd"  config set registry https://registry.feg.cn
& "$bin\npm.cmd"  config get registry

# pnpm install
$pnpmCmd = Join-Path $globalDir "pnpm.cmd"

if (-not (Test-Path $pnpmCmd)) {

    Write-Host "pnpm not found. Installing..."

    & $npmCmd `
        --prefix $globalDir `
        --cache $cacheDir `
        install -g pnpm

    if ($LASTEXITCODE -ne 0) {
        Write-Host "pnpm installation failed."
    }

    Write-Host "pnpm installed."
}
else {
    Write-Host "pnpm already exists."
}

#
& "$globalDir\pnpm.cmd" config set registry https://registry.feg.cn
& "$globalDir\pnpm.cmd" config get registry

& "$bin\npm.cmd" view @deepseek-ai/dsh dist.tarball

$version = "0.2.1-rc.2"
# 检查并安装 dsh
$installed = try {
    (& "$bin\npm.cmd" --prefix $globalDir --cache $cacheDir list -g --depth=0 --json @deepseek-ai/dsh 2>$null | ConvertFrom-Json).dependencies.'@deepseek-ai/dsh'.version
} catch { $null }

if ($installed -eq $version) {
    Write-Host "dsh Already installed, version: $installed"
} else {
    & "$bin\npm.cmd" --prefix $globalDir --cache $cacheDir install -g "@deepseek-ai/dsh@$version"
    Write-Host "dsh Installed/Updated to $version"
}

# # 停止 dsh
# taskkill /F /IM node.exe 2>$null; Remove-Item -Path "$PSScriptRootdsh.log" -Force -ErrorAction SilentlyContinue; Write-Output "STOPPED"

& "$globalDir\dsh.cmd" plugin --profile web list

#& "$bin\npx.cmd" --prefix (Join-Path $PWD "node\global") --cache (Join-Path $PWD "node\cache") -y github:wuzhiping/dsh-im install
#& "$bin\npx.cmd" --prefix (Join-Path $PWD "node\global") --cache (Join-Path $PWD "node\cache") -y git+https://git.feg.cn/shawoo/dsh-im install

#& "$bin\npx.cmd" --prefix (Join-Path $PWD "node\global") --cache (Join-Path $PWD "node\cache")  --no @deepseek-ai/dsh plugin --profile web list

#& "$bin\npx.cmd" --prefix (Join-Path $PWD "node\global") --cache (Join-Path $PWD "node\cache")  --no @deepseek-ai/dsh plugin --profile web add github:wuzhiping/cordis-plugins#path:/ov-memory

#& "$bin\npx.cmd" --prefix (Join-Path $PWD "node\global") --cache (Join-Path $PWD "node\cache")  --no @deepseek-ai/dsh plugin --profile web add "git+https://git.feg.cn/shawoo/cordis-plugins#path:/preset-office"


$output = & "$bin\npx.cmd" `
    --prefix (Join-Path $PWD "node\global") `
    --cache (Join-Path $PWD "node\cache") `
    --no @deepseek-ai/dsh plugin --profile web list

$plugins = $output |
    ForEach-Object {
        if ($_ -match '.*\s((?:@[^/\s]+/[^@\s]+|[^@\s]+))@') {
            $matches[1]
        }
    }

$plugins


$allowedPlugins = @(
    '@local/aife-provider'
    'rm-deepseek-provider',
    '@local/preset-office'
    'cute-clock'
    'fdep-api-request-bundle'
    'jeeflow-panel'
    'no-browser-auth'
    'scene-template'
    'today-material-panel'
    'zhtw-traditional-chinese',
    'ntfy-teams',
    'ov-memory',
    'kaneo-web',
    'sidebar-plugins-toggle',
    'dsh-minio-s3',
    'vi-VN',

    'dsh-im'
)

$plugins = $output |
    ForEach-Object {
        if ($_ -match '.*\s((?:@[^/\s]+/[^@\s]+|[^@\s]+))@') {
            $matches[1]
        }
    }

$plugins |
    Where-Object { $_ -notin $allowedPlugins } |
    ForEach-Object {
        $pluginName = $_
        Write-Host "移除未允许的 plugin: $pluginName"

        & "$bin\npx.cmd" `
            --prefix (Join-Path $PWD "node\global") `
            --cache (Join-Path $PWD "node\cache") `
            --no @deepseek-ai/dsh plugin --profile web remove $pluginName
    }

#& "$bin\npx.cmd" degit github:wuzhiping/skills/fdep-api-request  dsh\skills\fdep-api-request --force
#& "$bin\npx.cmd" degit github:wuzhiping/skills/mailpit           dsh\skills\mailpit --force
#& "$bin\npx.cmd" degit github:wuzhiping/skills/file-share        dsh\skills\file-share --force
#& "$bin\npx.cmd" degit github:wuzhiping/skills/sirchmunk         dsh\skills\sirchmunk --force
#& "$bin\npx.cmd" degit github:wuzhiping/skills/fess              dsh\skills\fess --force
#& "$bin\npx.cmd" degit github:wuzhiping/skills/handoff           dsh\skills\handoff --force
#& "$bin\npx.cmd" degit github:wuzhiping/skills/ponytail          dsh\skills\ponytail --force


cmd.exe /d /c 'mc.exe alias set public http://oss.feg.cn "" "" '

mc ls public/aife

mc mirror public/aife/skills/ .\dsh\skills
