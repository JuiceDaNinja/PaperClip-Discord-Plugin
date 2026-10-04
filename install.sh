#!/usr/bin/env bash
# Apply this patch set to an installed paperclip-plugin-discord 0.11.0.
#
# Usage:
#   bash install.sh                        # find the plugins directory automatically
#   bash install.sh --bootstrap            # also npm-install the plugin if it is missing
#   PLUGINS_ROOT=/path/to/plugins bash install.sh
#
# This repository does not vendor the upstream package. It carries the changes
# as diffs, applies them to the 0.11.0 files you already have, and checks the
# result against a published sha256 before writing anything into your install.
#
# Restart the plugin afterwards, through the lifecycle (see README.md).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REQUIRED_VERSION=0.11.0
PKG_NAME=paperclip-plugin-discord
PATCHED_FILES="worker.js commands.js manifest.js constants.js company-resolver.js"
ADDED_FILES="interaction-cards.js"
ALL_FILES="$PATCHED_FILES $ADDED_FILES"

BOOTSTRAP=0
for arg in "$@"; do
  case "$arg" in
    --bootstrap) BOOTSTRAP=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 64 ;;
  esac
done

for tool in patch sha256sum node; do
  command -v "$tool" >/dev/null 2>&1 \
    || { echo "Required tool not found: $tool" >&2; exit 1; }
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- 1. Find the Paperclip plugins directory -------------------------------
#
# The npm root the host installs plugins into: the directory that contains
# node_modules/paperclip-plugin-discord.

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
  cat >&2 <<'EOF'
Could not find your Paperclip plugins directory.

It is the directory holding node_modules/paperclip-plugin-discord — usually
~/.paperclip/plugins. Point at it explicitly:

  PLUGINS_ROOT=/path/to/.paperclip/plugins bash install.sh
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

These diffs are cut against the $REQUIRED_VERSION compiled dist output and will
not apply to a different build. Either pin to $REQUIRED_VERSION:

  cd "$PLUGINS_ROOT" && npm install $PKG_NAME@$REQUIRED_VERSION

or re-cut the patches from patches/ against your version. First check whether
upstream now ships these fixes natively — if it does, you do not need this.
EOF
  exit 2
fi

# --- 3. Collect pristine upstream files ------------------------------------
#
# Three sources, in order: the backup a previous run saved, the live files, and
# finally a fresh download from the npm registry. Whichever is used, all five
# must match checksums/upstream-0.11.0.sha256 before anything is patched.

collect_from() {
  local src=$1 suffix=${2:-}
  local f
  for f in $PATCHED_FILES; do
    [ -f "$src/$f$suffix" ] || return 1
    cp "$src/$f$suffix" "$WORK/upstream/$f"
  done
  ( cd "$WORK/upstream" && sha256sum -c "$HERE/checksums/upstream-0.11.0.sha256" --quiet ) 2>/dev/null
}

mkdir -p "$WORK/upstream"
UPSTREAM_SOURCE=""
if collect_from "$LIVE" ".pre-patch"; then
  UPSTREAM_SOURCE="the .pre-patch backup from an earlier run"
elif collect_from "$LIVE"; then
  UPSTREAM_SOURCE="your installed $PKG_NAME $VERSION"
else
  echo "Fetching a pristine $PKG_NAME $REQUIRED_VERSION from npm ..."
  mkdir -p "$WORK/npm"
  ( cd "$WORK/npm" && npm pack "$PKG_NAME@$REQUIRED_VERSION" --silent >/dev/null )
  TARBALL=$(find "$WORK/npm" -maxdepth 1 -name '*.tgz' -print -quit)
  [ -n "$TARBALL" ] || { echo "npm pack produced no tarball." >&2; exit 1; }
  tar -xzf "$TARBALL" -C "$WORK/npm"
  if ! collect_from "$WORK/npm/package/dist"; then
    cat >&2 <<EOF
The $REQUIRED_VERSION files do not match checksums/upstream-0.11.0.sha256.

Nothing has been changed. Either the published package differs from the one
these diffs were cut against, or this clone is incomplete. Do not force it.
EOF
    exit 1
  fi
  UPSTREAM_SOURCE="a fresh npm download"
fi
echo "Upstream source: $UPSTREAM_SOURCE (checksums verified)"

# --- 4. Apply the diffs and verify the result ------------------------------

mkdir -p "$WORK/patched"
for f in $PATCHED_FILES; do
  cp "$WORK/upstream/$f" "$WORK/patched/$f"
  patch -p1 --no-backup-if-mismatch -s "$WORK/patched/$f" < "$HERE/patches/$f.patch" \
    || { echo "patches/$f.patch did not apply. Nothing has been changed." >&2; exit 1; }
done
for f in $ADDED_FILES; do
  [ -f "$HERE/patched/$f" ] || { echo "Missing $HERE/patched/$f — incomplete clone?" >&2; exit 1; }
  cp "$HERE/patched/$f" "$WORK/patched/$f"
done

if ! ( cd "$WORK/patched" && sha256sum -c "$HERE/checksums/patched.sha256" --quiet ); then
  echo "The patched files do not match checksums/patched.sha256." >&2
  echo "Nothing has been changed." >&2
  exit 1
fi
echo "Patched files built and verified."

# --- 5. Back up what is there now, then install ----------------------------
#
# A one-time record, so uninstall.sh can restore whatever was in dist/ before
# this script first ran — even if that was not stock upstream.
#
# The marker, not the presence of each .pre-patch file, is what makes this
# once-only. interaction-cards.js does not exist upstream, so on the first run
# there is nothing to back up for it — and without the marker a second run
# would "back up" the copy this script itself installed, and uninstall would
# then restore it.

MARKER=$LIVE/.pcdp-backup-taken
if [ ! -f "$MARKER" ]; then
  for f in $ALL_FILES; do
    [ -f "$LIVE/$f" ] && cp "$LIVE/$f" "$LIVE/$f.pre-patch"
  done
  : > "$MARKER"
fi

for f in $ALL_FILES; do
  cp "$WORK/patched/$f" "$LIVE/$f"
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
