#!/usr/bin/env bash
# Remove this patch set from an installed paperclip-plugin-discord 0.11.0.
#
# Restores the .pre-patch copies install.sh saved, so you get back exactly what
# was in dist/ before the patch was first applied. If those are gone, falls
# back to the untouched upstream 0.11.0 files in upstream-0.11.0/.
#
# Usage:
#   ./uninstall.sh
#   PLUGINS_ROOT=/path/to/plugins ./uninstall.sh
#
# Restart the plugin afterwards, through the lifecycle (see README.md).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_NAME=paperclip-plugin-discord
UPSTREAM_FILES="worker.js commands.js manifest.js constants.js company-resolver.js"

find_plugins_root() {
  if [ -n "${PLUGINS_ROOT:-}" ]; then echo "$PLUGINS_ROOT"; return; fi
  if [ -n "${PAPERCLIP_HOME:-}" ] && [ -d "$PAPERCLIP_HOME/plugins" ]; then
    echo "$PAPERCLIP_HOME/plugins"; return
  fi
  if [ -d "$HOME/.paperclip/plugins" ]; then echo "$HOME/.paperclip/plugins"; return; fi
  if [ -d "$HOME/.paperclip" ]; then
    local hit
    hit=$(find "$HOME/.paperclip" -maxdepth 6 -type d \
            -path "*/node_modules/$PKG_NAME" -print -quit 2>/dev/null || true)
    if [ -n "$hit" ]; then echo "${hit%/node_modules/$PKG_NAME}"; return; fi
  fi
  return 1
}

if ! PLUGINS_ROOT=$(find_plugins_root) || [ -z "$PLUGINS_ROOT" ]; then
  echo "Could not find your Paperclip plugins directory. Set PLUGINS_ROOT." >&2
  exit 1
fi

LIVE=$PLUGINS_ROOT/node_modules/$PKG_NAME/dist
[ -d "$LIVE" ] || { echo "No plugin install at $LIVE" >&2; exit 1; }

restored_from_backup=0
for f in $UPSTREAM_FILES; do
  if [ -f "$LIVE/$f.pre-patch" ]; then
    mv "$LIVE/$f.pre-patch" "$LIVE/$f"
    restored_from_backup=1
  fi
done

if [ "$restored_from_backup" = "1" ]; then
  echo "Restored the pre-patch files at $LIVE."
else
  for f in $UPSTREAM_FILES; do
    cp "$HERE/upstream-0.11.0/$f" "$LIVE/$f"
  done
  echo "No .pre-patch backups found. Restored upstream 0.11.0 files at $LIVE."
fi

# interaction-cards.js does not exist upstream. Put back a pre-patch copy if
# there was one, otherwise remove the file the patch added.
if [ -f "$LIVE/interaction-cards.js.pre-patch" ]; then
  mv "$LIVE/interaction-cards.js.pre-patch" "$LIVE/interaction-cards.js"
else
  rm -f "$LIVE/interaction-cards.js"
fi

cat <<'EOF'

Restart the plugin to apply. Without the patch, expect slash commands to fail
again with:

  "the worker referenced a missing, expired, or unknown invocation scope"

and no approval or question cards in Discord.
EOF
