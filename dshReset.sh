#!/bin/bash

set -e

base="$(cd "$(dirname "$0")" && pwd)"
base="/Applications/ABC.app/Contents/Resources"

node="$base/node"
bin="$node/node-v24.19.0-darwin-arm64"
globalDir="$node/global"
cacheDir="$node/cache"
gitDir="$base/git"

mkdir -p "$globalDir" "$cacheDir"

# npx隔离 PATH
export PATH="$gitDir/bin:$bin/bin:$globalDir/bin:$PATH"

# 检查并下载 Node.js
if [ ! -f "$bin/bin/node" ]; then
    curl -L "https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz" \
        -o "$base/node.tar.gz"

    mkdir -p "$node"
    tar -xzf "$base/node.tar.gz" -C "$node"
    rm "$base/node.tar.gz"

    echo "Node.js Downloaded."
else
    echo "$bin/bin/node Already exists."
fi

# DSH 环境变量
export DEEPSEEK_BASE_URL="https://abc.feg.com.tw/vx"
export DSH_MODEL="deepseek-v4-flash"
export DSH_HOME="$base/dsh"

version="0.2.0-rc.2"

# 检查并安装 dsh
installed=$(
    "$bin/bin/npm" \
        --prefix "$globalDir" \
        --cache "$cacheDir" \
        list -g --depth=0 --json @deepseek-ai/dsh 2>/dev/null |
        python3 -c '
import json
import sys

try:
    data = json.load(sys.stdin)
    print(data["dependencies"]["@deepseek-ai/dsh"]["version"])
except:
    pass
'
)

if [ "$installed" = "$version" ]; then
    echo "dsh Already installed, version: $installed"
else
    "$bin/bin/npm" \
        --prefix "$globalDir" \
        --cache "$cacheDir" \
        install -g "@deepseek-ai/dsh@$version"

    echo "dsh Installed/Updated to $version"
fi

# 获取 plugin 列表
output=$(
    "$globalDir/bin/dsh" \
        plugin --profile web list
)

echo "$output"

allowedPlugins=(
    "@local/aife-provider"
    "@local/preset-office"
    "cute-clock"
    "fdep-api-request-bundle"
    "jeeflow-panel"
    "no-browser-auth"
    "scene-template"
    "today-material-panel"
    "zhtw-traditional-chinese"
    "ntfy-teams"
    "ov-memory"
)

# 找出 plugin 并删除未允许的
echo "$output" | while read -r line; do
    pluginName=$(echo "$line" | sed -n 's/.* \(@\?[^@[:space:]]*\)@.*/\1/p')

    if [ -n "$pluginName" ]; then
        allowed=false

        for allowedPlugin in "${allowedPlugins[@]}"; do
            if [ "$pluginName" = "$allowedPlugin" ]; then
                allowed=true
                break
            fi
        done

        if [ "$allowed" = false ]; then
            echo "移除未允许的 plugin: $pluginName"

            "$globalDir/bin/dsh" \
                plugin --profile web remove "$pluginName"
        fi
    fi
done

# 安装 skills
"$bin/bin/npx" degit github:wuzhiping/skills/fdep-api-request \
    "$base/dsh/skills/fdep-api-request" --force

"$bin/bin/npx" degit github:wuzhiping/skills/mailpit \
    "$base/dsh/skills/mailpit" --force

"$bin/bin/npx" degit github:wuzhiping/skills/file-share \
    "$base/dsh/skills/file-share" --force

"$bin/bin/npx" degit github:wuzhiping/skills/sirchmunk \
    "$base/dsh/skills/sirchmunk" --force

"$bin/bin/npx" degit github:wuzhiping/skills/fess \
    "$base/dsh/skills/fess" --force

"$bin/bin/npx" degit github:wuzhiping/skills/handoff \
    "$base/dsh/skills/handoff" --force

"$bin/bin/npx" degit github:wuzhiping/skills/ponytail \
    "$base/dsh/skills/ponytail" --force
