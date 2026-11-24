#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CONTEXT_HUD_REPO_URL:-https://github.com/piex-zgz/antigravity-context-hud.git}"
CONFIG_ROOT="${HOME}/.gemini/config"
PLUGIN_DIR="${CONFIG_ROOT}/plugins/context-hud"
CONFIG_JSON="${CONFIG_ROOT}/config.json"
PLUGIN_KEY="context-hud"
SIDECAR_KEY="context-hud/context_hud"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 20) is required." >&2
  exit 1
fi

update_config_json() {
  local action="$1"
  node - "$CONFIG_JSON" "$PLUGIN_KEY" "$SIDECAR_KEY" "$action" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [cfgPath, pluginKey, sidecarKey, action] = process.argv.slice(2);
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

let mode = 0o600;
let cfg = {};
if (fs.existsSync(cfgPath)) {
  mode = fs.statSync(cfgPath).mode & 0o777;
  const raw = fs.readFileSync(cfgPath, 'utf-8').trim();
  if (raw) cfg = JSON.parse(raw);
}

cfg.plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
cfg.sidecars = cfg.sidecars && typeof cfg.sidecars === 'object' ? cfg.sidecars : {};

if (action === 'enable') {
  cfg.plugins[pluginKey] = { ...(cfg.plugins[pluginKey] || {}), enabled: true };
  cfg.sidecars[sidecarKey] = { ...(cfg.sidecars[sidecarKey] || {}), enabled: true };
} else if (action === 'disable') {
  delete cfg.plugins[pluginKey];
  delete cfg.sidecars[sidecarKey];
}

const tmp = `${cfgPath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf-8', mode });
fs.chmodSync(tmp, mode);
fs.renameSync(tmp, cfgPath);
NODE
}

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$PLUGIN_DIR"
  update_config_json disable
  echo "Uninstalled Context HUD from ${PLUGIN_DIR} and cleaned config entries."
  exit 0
fi

mkdir -p "${CONFIG_ROOT}/plugins"

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [[ -n "$SCRIPT_DIR" && -f "${SCRIPT_DIR}/plugin.json" && -d "${SCRIPT_DIR}/sidecars/context_hud" ]]; then
  if [[ "$SCRIPT_DIR" != "$PLUGIN_DIR" ]]; then
    rm -rf "$PLUGIN_DIR"
    mkdir -p "$PLUGIN_DIR"
    cp -R "${SCRIPT_DIR}/plugin.json" "${SCRIPT_DIR}/README.md" "${SCRIPT_DIR}/LICENSE" "${SCRIPT_DIR}/assets" "${SCRIPT_DIR}/sidecars" "$PLUGIN_DIR/"
  fi
  echo "Installed Context HUD from local checkout -> ${PLUGIN_DIR}"
else
  if [[ -d "${PLUGIN_DIR}/.git" ]]; then
    git -C "$PLUGIN_DIR" pull --ff-only
  else
    rm -rf "$PLUGIN_DIR"
    git clone --depth 1 "$REPO_URL" "$PLUGIN_DIR"
  fi
  echo "Installed Context HUD from ${REPO_URL} -> ${PLUGIN_DIR}"
fi

update_config_json enable

cat <<'EOF'

Done! Context HUD is installed and enabled.

How to open in Antigravity:
  1. Antigravity usually hot-starts the sidecar automatically (if not visible yet, restart Antigravity once).
  2. In any conversation, click "+" in the right Auxiliary Pane and select "Context HUD".
EOF
