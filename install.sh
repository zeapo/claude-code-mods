#!/usr/bin/env bash
# Declares this repository's mods/ folder in Claude Code's user settings
# (env.CLAUDE_CODE_PLUGIN_DIRS), so every new session loads each mod in it.
#
#   ./install.sh              declare mods/
#   ./install.sh --uninstall  remove the declaration
#
# Run once per machine. A mod added to mods/ later needs no new run: the
# folder is declared, not its children. Other folders already listed in
# CLAUDE_CODE_PLUGIN_DIRS are kept.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
mods="$repo/mods"
settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

case "${1-}" in
  '') action=install ;;
  --uninstall) action=uninstall ;;
  *)
    echo "usage: ./install.sh [--uninstall]" >&2
    exit 2
    ;;
esac

if ! command -v jq >/dev/null; then
  echo "install.sh: jq is required" >&2
  exit 1
fi

if [[ ! -f "$settings" ]]; then
  mkdir -p "$(dirname "$settings")"
  echo '{}' >"$settings"
fi

updated=$(mktemp)
trap 'rm -f "$updated"' EXIT

# The list is rebuilt without this repository's entry, then the entry goes
# back last on install. An emptied list takes its key, and an emptied env
# block, out of the file.
jq --arg mods "$mods" --arg action "$action" '
  ((.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":") | map(select(. != "" and . != $mods))) as $others
  | ($others + (if $action == "install" then [$mods] else [] end) | join(":")) as $dirs
  | if $dirs != "" then
      .env.CLAUDE_CODE_PLUGIN_DIRS = $dirs
    elif .env == null then
      .
    else
      del(.env.CLAUDE_CODE_PLUGIN_DIRS) | if .env == {} then del(.env) else . end
    end
' "$settings" >"$updated"

if cmp -s "$updated" "$settings"; then
  echo "Nothing to change in $settings"
else
  cp "$settings" "$settings.bak"
  # Written in place, so a settings file that is a link stays one.
  cat "$updated" >"$settings"
  echo "Updated $settings (previous version in $settings.bak)"
fi

if [[ "$action" == install ]]; then
  echo "Declared $mods"
  for manifest in "$mods"/*/.claude-plugin/plugin.json; do
    [[ -f "$manifest" ]] && echo "  $(basename "${manifest%/.claude-plugin/plugin.json}")"
  done
else
  echo "Removed $mods"
fi

echo "New Claude Code sessions pick this up; a running one needs a restart."
