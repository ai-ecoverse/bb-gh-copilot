#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_JSON="$ROOT/config/custom-acp-agent.json"
LOGO_SRC="$ROOT/assets/logo.svg"

BB_DATA_DIR="${BB_DATA_DIR:-${HOME}/.bb}"
CONFIG_PATH="$BB_DATA_DIR/config.json"
LOGO_NAME="copilot-logo.svg"
LOGO_DST="$BB_DATA_DIR/$LOGO_NAME"
CLI_NAME="copilot"

if [[ ! -f "$AGENT_JSON" ]]; then
  echo "error: missing agent definition: $AGENT_JSON" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (brew install jq)" >&2
  exit 1
fi

COPILOT_CMD="$CLI_NAME"
if ! command -v "$CLI_NAME" >/dev/null 2>&1; then
  echo "warning: copilot not on PATH — install with: brew install --cask copilot-cli" >&2
  echo "warning: bb's host daemon may not share your shell PATH; install will keep command as \"copilot\"" >&2
else
  COPILOT_CMD="$(command -v "$CLI_NAME")"
  echo "copilot: $COPILOT_CMD ($("$COPILOT_CMD" --version 2>/dev/null | head -1))"
fi

mkdir -p "$BB_DATA_DIR"
cp "$LOGO_SRC" "$LOGO_DST"
chmod 644 "$LOGO_DST"

AGENT="$(jq --arg logo "$LOGO_NAME" --arg cmd "$COPILOT_CMD" '. + {logo: $logo, command: $cmd}' "$AGENT_JSON")"
AGENT_ID="$(jq -r '.id' <<<"$AGENT")"

if [[ -f "$CONFIG_PATH" ]]; then
  CURRENT="$(<"$CONFIG_PATH")"
else
  CURRENT='{}'
fi

if ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$CURRENT"; then
  echo "error: $CONFIG_PATH is not a JSON object" >&2
  exit 1
fi

NEXT="$(
  jq -c --argjson agent "$AGENT" --arg id "$AGENT_ID" '
    .customAcpAgents = (
      ((.customAcpAgents // []) | map(select(.id != $id))) + [$agent]
    )
  ' <<<"$CURRENT"
)"

umask 077
TMP="$(mktemp "${BB_DATA_DIR}/.config.json.XXXXXX")"
printf '%s\n' "$(jq '.' <<<"$NEXT")" >"$TMP"
mv "$TMP" "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"

echo "wrote $CONFIG_PATH (customAcpAgents id=$AGENT_ID → provider acp-$AGENT_ID)"
echo "logo: $LOGO_DST"
echo "custom agents: $(jq -r '[.customAcpAgents[]?.id] | join(", ")' "$CONFIG_PATH")"

refreshed=0
refresh_candidates=(
  "bb-app"
  "/Applications/bb.app/Contents/MacOS/bb-app"
  "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb-app.js"
)
for cmd in "${refresh_candidates[@]}"; do
  if [[ "$cmd" == *.js ]]; then
    if [[ -f "$cmd" ]] && node "$cmd" config refresh 2>/dev/null; then
      echo "refreshed managed config via: node $cmd config refresh"
      refreshed=1
      break
    fi
  elif command -v "$cmd" >/dev/null 2>&1 || [[ -x "$cmd" ]]; then
    if "$cmd" config refresh 2>/dev/null; then
      echo "refreshed managed config via: $cmd config refresh"
      refreshed=1
      break
    fi
  fi
done

if [[ "$refreshed" -eq 0 ]]; then
  echo "note: restart bb or run: bb-app config refresh"
fi

echo
echo "verify:"
echo "  bb provider list"
echo "  bb provider models acp-$AGENT_ID"
