#!/usr/bin/env bash
# ============================================================
# DSH Portable Launcher for macOS
# Converted from harness.ps1
# ============================================================

set -Eeuo pipefail

# ---------------------------
# Base paths
# ---------------------------
BASE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE_DIR="$BASE/node"
GLOBAL_DIR="$NODE_DIR/global"
CACHE_DIR="$NODE_DIR/cache"
DSH_HOME="$BASE/dsh"
NODE_VERSION="v24.19.0"
DSH_VERSION="0.2.0-rc.2"
DSH_BASE_URL="https://abc.feg.com.tw/vx"
DSH_MODEL="deepseek-v4-flash"
PORT=3080
HOST_ADDRESS="127.0.0.1"
NODE_URL_BASE="https://nodejs.org/dist/${NODE_VERSION}"
NODE_ARCHIVE=""
NODE_BIN_DIR=""
NODE_EXE=""
NPM_CMD=""
DSH_CMD=""
PNPM_CMD=""
DSH_URL=""

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

fail() {
  printf '\nERROR: %s\n\n' "$*" >&2
  exit 1
}

on_error() {
  local code=$?
  printf '\nERROR: command failed (exit %s) at line %s: %s\n' \
    "$code" "${BASH_LINENO[0]:-unknown}" "${BASH_COMMAND:-unknown}" >&2
  exit "$code"
}
trap on_error ERR

command_exists() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------
# macOS architecture / paths
# ---------------------------
case "$(uname -m)" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64|amd64)  NODE_ARCH="x64" ;;
  *) fail "Unsupported macOS CPU architecture: $(uname -m)" ;;
esac

NODE_ARCHIVE="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
NODE_BIN_DIR="$NODE_DIR/node-${NODE_VERSION}-darwin-${NODE_ARCH}/bin"
NODE_EXE="$NODE_BIN_DIR/node"
NPM_CMD="$NODE_BIN_DIR/npm"
DSH_CMD="$GLOBAL_DIR/bin/dsh"
PNPM_CMD="$GLOBAL_DIR/bin/pnpm"
DSH_PACKAGE_JSON="$GLOBAL_DIR/lib/node_modules/@deepseek-ai/dsh/package.json"

# ---------------------------
# Prepare directories
# ---------------------------
mkdir -p "$NODE_DIR" "$GLOBAL_DIR" "$CACHE_DIR" "$DSH_HOME"

# ---------------------------
# Environment
# ---------------------------
export DEEPSEEK_BASE_URL="$DSH_BASE_URL"
export DSH_MODEL="$DSH_MODEL"
export DSH_HOME
export LITELLM_DROP_PARAMS="true"
export NPM_CONFIG_PREFIX="$GLOBAL_DIR"
export NPM_CONFIG_CACHE="$CACHE_DIR"
export PATH="$NODE_BIN_DIR:$GLOBAL_DIR/bin:$BASE/uv:$PATH"

# ---------------------------
# 0. Git
# macOS uses system Git / Xcode Command Line Tools rather than MinGit.
# ---------------------------
if command_exists git; then
  log "Git already available: $(command -v git)"
else
  log "Git not found. Requesting installation of Xcode Command Line Tools..."
  if command_exists xcode-select; then
    xcode-select --install || true
    fail "Install Xcode Command Line Tools, then rerun harness.sh."
  else
    fail "Git is required. Install Git (for example with Homebrew: brew install git), then rerun."
  fi
fi

# ---------------------------
# 1. Node.js
# ---------------------------
if [[ ! -x "$NODE_EXE" ]]; then
  log "Node.js not found."
  log "Downloading Node.js ${NODE_VERSION} for macOS ${NODE_ARCH}..."
  TMP_ARCHIVE="$BASE/node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  curl --fail --location --retry 3 --output "$TMP_ARCHIVE" \
    "${NODE_URL_BASE}/${NODE_ARCHIVE}" ||
    fail "Node.js download failed."
  log "Extracting Node.js..."
  tar -xzf "$TMP_ARCHIVE" -C "$NODE_DIR" ||
    fail "Node.js extraction failed."
  rm -f "$TMP_ARCHIVE"
  [[ -x "$NODE_EXE" ]] || fail "Node.js installation failed. Missing: $NODE_EXE"
  log "Node.js installed."
else
  log "Node.js already exists."
fi

# Ensure npm scripts use this portable Node first.
export PATH="$NODE_BIN_DIR:$GLOBAL_DIR/bin:$BASE/uv:$PATH"

# ---------------------------
# 2. dsh
# ---------------------------
need_dsh_install=true
if [[ -f "$DSH_PACKAGE_JSON" && -x "$DSH_CMD" ]]; then
  installed_version="$("$NODE_EXE" -e '
    try { console.log(require(process.argv[1]).version || "") }
    catch (_) { console.log("") }
  ' "$DSH_PACKAGE_JSON")"
  if [[ "$installed_version" == "$DSH_VERSION" ]]; then
    need_dsh_install=false
    log "dsh already installed: $DSH_VERSION"
  fi
fi

if [[ "$need_dsh_install" == true ]]; then
  log "Installing dsh $DSH_VERSION..."
  "$NPM_CMD" --prefix "$GLOBAL_DIR" --cache "$CACHE_DIR" \
    install -g "@deepseek-ai/dsh@$DSH_VERSION" --registry "https://registry.npmmirror.com" ||
    fail "dsh installation failed."
  [[ -x "$DSH_CMD" ]] || fail "dsh installed but executable was not found: $DSH_CMD"
  log "dsh installed: $DSH_VERSION"
fi

# ---------------------------
# 3. pnpm
# ---------------------------
if [[ ! -x "$PNPM_CMD" ]]; then
  log "pnpm not found. Installing..."
  "$NPM_CMD" --prefix "$GLOBAL_DIR" --cache "$CACHE_DIR" \
    install -g pnpm --registry "https://registry.npmmirror.com" ||
    fail "pnpm installation failed."
  [[ -x "$PNPM_CMD" ]] || fail "pnpm installation finished but pnpm executable was not found."
  log "pnpm installed."
else
  log "pnpm already exists."
fi

# ---------------------------
# 4. Plugins
# Keep the same plugin names, versions, sources and profile as harness.ps1.
# ---------------------------
PLUGIN_NAMES=(
  "zhtw-traditional-chinese"
  "no-browser-auth"
  "scene-template"
  "fdep-api-request-bundle"
  "@local/aife-provider"
  "cute-clock"
  "ntfy-teams"
)
PLUGIN_VERSIONS=(
  "0.1.4"
  "0.1.0"
  "0.1.0"
  "0.1.0"
  "1.0.0"
  "0.2.0"
  "0.2.0"
)
PLUGIN_SOURCES=(
  "github:wuzhiping/cordis-plugins#path:/zhtw-traditional-chinese"
  "github:wuzhiping/cordis-plugins#path:/no-browser-auth"
  "github:wuzhiping/cordis-plugins#path:/scene-template"
  "github:wuzhiping/cordis-plugins#path:/fdep-api-request"
  "github:wuzhiping/cordis-plugins#path:/aife-provider"
  "github:wuzhiping/cordis-plugins#path:/cute-clock"
  "github:wuzhiping/cordis-plugins#path:/ntfy-teams"
)

for i in "${!PLUGIN_NAMES[@]}"; do
  plugin_name="${PLUGIN_NAMES[$i]}"
  plugin_version="${PLUGIN_VERSIONS[$i]}"
  plugin_source="${PLUGIN_SOURCES[$i]}"
  plugin_profile="web"

  log "Checking plugin: $plugin_name"

  plugin_list="$("$DSH_CMD" plugin --profile "$plugin_profile" list 2>&1 || true)"
  # Escape the plugin name for extended regular expressions, including @ and /.
  escaped_name="$(printf '%s' "$plugin_name" | sed -E 's/[][(){}.^$*+?|\\]/\\&/g')"
  installed_version="$(
    printf '%s\n' "$plugin_list" |
      grep -Eo "(^|[[:space:]])${escaped_name}@[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?" |
      head -n 1 | sed -E 's/^[[:space:]]*//' | sed 's/^[^@]*@//' || true
  )"

  if [[ -n "$installed_version" && "$installed_version" == "$plugin_version" ]]; then
    log "Plugin OK: $plugin_name@$installed_version"
    continue
  elif [[ -n "$installed_version" ]]; then
    log "Plugin version mismatch:"
    log "  Installed: $installed_version"
    log "  Required : $plugin_version"
  else
    log "Plugin not installed: $plugin_name"
  fi

  log "Installing/updating plugin: $plugin_name@$plugin_version"
  "$DSH_CMD" plugin --profile "$plugin_profile" add "$plugin_source" ||
    fail "Plugin installation/update failed: $plugin_name"

  log "Plugin installed/updated: $plugin_name@$plugin_version"
done

# ---------------------------
# 5. Check port
# ---------------------------
if command_exists lsof; then
  listener_pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [[ -n "$listener_pid" ]]; then
    log "A process is already listening on port $PORT."
    log "PID: $listener_pid"
    log "URL: http://${HOST_ADDRESS}:${PORT}"
    exit 0
  fi
fi

# ---------------------------
# 6. Final validation
# ---------------------------
[[ -x "$NODE_EXE" ]] || fail "Node executable not found: $NODE_EXE"
[[ -x "$DSH_CMD" ]] || fail "dsh executable not found: $DSH_CMD"

# ---------------------------
# 7. Process output
# ---------------------------
process_output() {
  local line="$1"
  local clean_line url
  [[ -n "$line" ]] || return 0

  log "[original] $line"
  # Strip ANSI escape sequences.
  clean_line="$(printf '%s' "$line" | sed -E $'s/\033\\[[0-9;?]*[ -/]*[@-~]//g')"

  while IFS= read -r url; do
    # Remove common trailing punctuation from URLs.
    url="${url%[.,;:)]}"
    url="${url%]}"
    url="${url%>}"
    url="${url%\"}"
    url="${url%\'}"
    [[ -n "$url" ]] || continue
    [[ "$DSH_URL" == "$url" ]] && continue

    DSH_URL="$url"
    printf '%s\n' "$url" > "$BASE/harness.txt"
    log "<<<<$url>>>>"
  done < <(printf '%s\n' "$clean_line" | grep -Eo 'https?://[^[:space:]]+' || true)
}

# ---------------------------
# 8. Start DSH
# ---------------------------
log "Starting dsh web..."
log "URL: http://${HOST_ADDRESS}:${PORT}"

# Keep the process in the foreground so Ctrl+C stops it cleanly.
"$DSH_CMD" web --host "$HOST_ADDRESS" --port "$PORT" --no-open 2>&1 |
while IFS= read -r line || [[ -n "$line" ]]; do
  process_output "$line"
done
