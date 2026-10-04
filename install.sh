#!/usr/bin/env bash
# Apply this patch set to an installed paperclip-plugin-discord 0.11.0.
#
# Usage:
#   ./install.sh                        # find the plugins directory automatically
#   ./install.sh --bootstrap            # also npm-install the plugin if it is missing
#   PLUGINS_ROOT=/path/to/plugins ./install.sh
#
# Restart the plugin afterwards, through the lifecycle (see README.md).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REQUIRED_VERSION=0.11.0
PKG_NAME=paperclip-plugin-discord
FILES="worker.js commands.js manifest.js constants.js company-resolver.js interaction-cards.js"

BOOTSTRAP=0
for arg in "$@"; do
  case "$arg" in
    --bootstrap) BOOTSTRAP=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 64 ;;
  esac
done

# --- 1. Find the Paperclip plugins directory -------------------------------
#
# This is the npm root the host installs plugins into. It is the directory that
# contains node_modules/paperclip-plugin-discord. Order: explicit, then
# PAPERCLIP_HOME, then the default location, then an already-installed package
# anywhere under ~/.paperclip.

find_plugins_root() {
  if [ -n "${PLUGINS_ROOT:-}" ]; then
    echo "$PLUGINS_ROOT"; return
  fi
  if [ -n "${PAPERCLIP_HOME:-}" ] && [ -d "$PAPERCLIP_HOME/plugins" ]; then
    echo "$PAPERCLIP_HOME/plugins"; return
  fi
  if [ -d "$HOME/.paperclip/plugins" ]; then
    echo "$HOME/.paperclip/plugins"; return
  fi
  if [ -d "$HOME/.paperclip" ]; then
    local hit
    hit=$(find "$HOME/.paperclip" -maxdepth 6 -type d \
            -path "*/node_modules/$PKG_NAME" -print -quit 2>/dev/null || true)
    if [ -n "$hit" ]; then
      echo "${hit%/node_modules/$PKG_NAME}"; return
    fi
  fi
  return 1
}

if ! PLUGINS_ROOT=$(find_plugins_root) || [ -z "$PLUGINS_ROOT" ]; then
  cat >&2 <<'EOF'
Could not find your Paperclip plugins directory.

It is the directory holding node_modules/paperclip-plugin-discord — usually
~/.paperclip/plugins. Point at it explicitly:

  PLUGINS_ROOT=/path/to/.paperclip/plugins ./install.sh
EOF
  exit 1
fi

PKG=$PLUGINS_ROOT/node_modules/$PKG_NAME
LIVE=$PKG/dist
echo "Plugins directory: $PLUGINS_ROOT"

# --- 2. Make sure the right upstream version is installed ------------------

if [ ! -d "$LIVE" ]; then
  if [ "$BOOTSTRAP" = "1" ]; then
    echo "$PKG_NAME is not installed. Installing $REQUIRED_VERSION ..."
    mkdir -p "$PLUGINS_ROOT"
    ( cd "$PLUGINS_ROOT" && npm install "$PKG_NAME@$REQUIRED_VERSION" )
  else
    cat >&2 <<EOF
No $PKG_NAME install at $LIVE.

Install the upstream plugin first:

  cd "$PLUGINS_ROOT" && npm install $PKG_NAME@$REQUIRED_VERSION

or re-run this script with --bootstrap to do that for you.
EOF
    exit 1
  fi
fi

VERSION=$(node -p "require('$PKG/package.json').version")
if [ "$VERSION" != "$REQUIRED_VERSION" ]; then
  cat >&2 <<EOF
Installed $PKG_NAME is $VERSION, not $REQUIRED_VERSION.

This patch set is built against the $REQUIRED_VERSION compiled dist output and
is NOT safe to copy onto a different build. Either pin to $REQUIRED_VERSION:

  cd "$PLUGINS_ROOT" && npm install $PKG_NAME@$REQUIRED_VERSION

or re-cut the patch from patches/ against your version. First check whether
upstream now ships these fixes natively — if it does, you do not need this.
EOF
  exit 2
fi

# --- 3. Check the clone is intact ------------------------------------------

for f in $FILES; do
  [ -f "$HERE/patched/$f" ] || { echo "Missing $HERE/patched/$f — incomplete clone?" >&2; exit 1; }
done

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$HERE" && sha256sum -c CHECKSUMS.sha256 --quiet ) \
    || { echo "Checksum mismatch — this clone does not match what was published." >&2; exit 1; }
fi

# --- 4. Back up what is there now, then apply ------------------------------
#
# A one-time record, so uninstall.sh can restore whatever was in dist/ before
# this script first ran — even if that was not stock upstream.

for f in $FILES; do
  if [ -f "$LIVE/$f" ] && [ ! -f "$LIVE/$f.pre-patch" ]; then
    cp "$LIVE/$f" "$LIVE/$f.pre-patch"
  fi
done

for f in $FILES; do
  cp "$HERE/patched/$f" "$LIVE/$f"
done

cat <<EOF

Applied the patch set to $PKG_NAME $VERSION at
  $LIVE

Now restart the plugin. Killing the worker process is not enough — toggle the
plugin off and on in the Paperclip board, or:

  curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/disable
  curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/enable

See README.md for how to find <PLUGIN_ID>.
EOF
