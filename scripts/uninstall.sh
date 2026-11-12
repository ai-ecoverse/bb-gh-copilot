#!/usr/bin/env bash
set -euo pipefail

BB_DATA_DIR="${BB_DATA_DIR:-${HOME}/.bb}"
CONFIG_PATH="$BB_DATA_DIR/config.json"
AGENT_ID="${1:-copilot}"
LOGO_DST="$BB_DATA_DIR/copilot-logo.svg"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required (brew install jq)" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "no config at $CONFIG_PATH — nothing to do"
  exit 0
fi

CURRENT="$(<"$CONFIG_PATH")"
BEFORE="$(jq -r --arg id "$AGENT_ID" '[.customAcpAgents // [] | .[] | select(.id == $id)] | length' <<<"$CURRENT")"

if [[ "$BEFORE" -eq 0 ]]; then
  echo "no customAcpAgents entry with id=$AGENT_ID"
else
  NEXT="$(
    jq -c --arg id "$AGENT_ID" '
      .customAcpAgents = ((.customAcpAgents // []) | map(select(.id != $id)))
      | if (.customAcpAgents | length) == 0 then del(.customAcpAgents) else . end
    ' <<<"$CURRENT"
  )"
  umask 077
  TMP="$(mktemp "${BB_DATA_DIR}/.config.json.XXXXXX")"
  printf '%s\n' "$(jq '.' <<<"$NEXT")" >"$TMP"
  mv "$TMP" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  echo "removed customAcpAgents id=$AGENT_ID from $CONFIG_PATH"
fi

if [[ -f "$LOGO_DST" ]]; then
  rm -f "$LOGO_DST"
  echo "removed $LOGO_DST"
fi

echo "remaining custom agents: $(jq -r '[.customAcpAgents[]?.id] // [] | join(", ")' "$CONFIG_PATH" 2>/dev/null || echo '(none)')"
echo "restart bb or run: bb-app config refresh"

