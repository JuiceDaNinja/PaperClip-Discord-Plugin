#!/usr/bin/env bash
# Fix `structuredContent: null` in the Paperclip host (@paperclipai/server).
#
# Usage:
#   bash host-patches/apply-structuredcontent-fix.sh              # find the host, patch it
#   bash host-patches/apply-structuredcontent-fix.sh --dry-run    # report, change nothing
#   bash host-patches/apply-structuredcontent-fix.sh --revert     # put the original back
#   NPX_CACHE=/path/to/.npm/_npx bash host-patches/apply-structuredcontent-fix.sh
#   SERVER_PKG=/path/to/@paperclipai/server bash host-patches/apply-structuredcontent-fix.sh
#
# This patches the HOST, not the Discord plugin. Nothing else in this repository
# touches @paperclipai/server. Without it every plugin MCP tool call — all six
# Discord tools and any other plugin's — fails client-side schema validation.
# See docs/README-host-structuredcontent-null.md.
#
# Re-run this after every Paperclip CLI update: the host runs out of an npx
# cache directory named after a hash of the CLI spec, so a version bump installs
# into a NEW directory and the fix silently disappears.
#
# Idempotent. Safe to run when the fix is already in place.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

TARGET_REL="dist/routes/tool-gateway.js"
BUILT_AGAINST=2026.1023.0
PATCH="$HERE/structuredcontent-null.patch"
SUM_UPSTREAM="$REPO/checksums/host-upstream-$BUILT_AGAINST.sha256"
SUM_PATCHED="$REPO/checksums/host-patched-$BUILT_AGAINST.sha256"
BUGGY_LINE='structuredContent: resultRecord?.data ?? null,'
MARKER='structuredContentField'
BACKUP_SUFFIX='.pre-structuredcontent-fix'

DRY_RUN=0
REVERT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --revert)  REVERT=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 64 ;;
  esac
done

for tool in patch sha256sum node; do
  command -v "$tool" >/dev/null 2>&1 \
    || { echo "Required tool not found: $tool" >&2; exit 1; }
done

sha_of()   { sha256sum "$1" | cut -d' ' -f1; }
want_sha() { cut -d' ' -f1 < "$1"; }

# --- 1. Find every installed @paperclipai/server ---------------------------
#
# Normally one, in the npx cache. An update leaves the old directory behind, so
# patch whichever copies are present and let the caller sort out which is live.

NPX_CACHE="${NPX_CACHE:-${HOME}/.npm/_npx}"

find_servers() {
  if [ -n "${SERVER_PKG:-}" ]; then
    printf '%s\n' "$SERVER_PKG"
    return
  fi
  find "$NPX_CACHE" -mindepth 3 -maxdepth 4 -type d \
       -path "*/node_modules/@paperclipai/server" 2>/dev/null || true
}

mapfile -t SERVERS < <(find_servers)
if [ "${#SERVERS[@]}" -eq 0 ]; then
  cat >&2 <<EOF
No @paperclipai/server install found under $NPX_CACHE.

The Paperclip host usually runs from the npx cache. If yours is elsewhere, or
\$HOME is remapped (sandboxes do this), point at it directly:

  NPX_CACHE=/path/to/.npm/_npx bash $0
  SERVER_PKG=/path/to/node_modules/@paperclipai/server bash $0
EOF
  exit 1
fi

# --- 2. Patch (or revert) each one -----------------------------------------

changed=0
skipped=0
failed=0

for pkg in "${SERVERS[@]}"; do
  f="$pkg/$TARGET_REL"
  [ -f "$f" ] || { echo "skip: no $TARGET_REL under $pkg"; continue; }

  version=$(node -p "require('$pkg/package.json').version" 2>/dev/null || echo unknown)
  echo
  echo "Host: $pkg (@paperclipai/server $version)"

  if [ "$REVERT" = "1" ]; then
    if ! grep -q "$MARKER" "$f"; then
      echo "  not patched, nothing to revert"
      skipped=$((skipped+1))
      continue
    fi
    if [ -f "$f$BACKUP_SUFFIX" ]; then
      [ "$DRY_RUN" = "1" ] && { echo "  would restore from $(basename "$f$BACKUP_SUFFIX")"; skipped=$((skipped+1)); continue; }
      cp "$f$BACKUP_SUFFIX" "$f"
      node --check "$f"
      echo "  restored from backup"
      changed=$((changed+1))
    else
      [ "$DRY_RUN" = "1" ] && { echo "  would reverse-apply the patch (no backup present)"; skipped=$((skipped+1)); continue; }
      ( cd "$pkg" && patch -p1 -R --no-backup-if-mismatch -s < "$PATCH" ) \
        || { echo "  reverse-apply failed — restore this file from npm" >&2; failed=$((failed+1)); continue; }
      node --check "$f"
      echo "  reverse-applied the patch"
      changed=$((changed+1))
    fi
    continue
  fi

  if grep -q "$MARKER" "$f"; then
    if [ "$(sha_of "$f")" = "$(want_sha "$SUM_PATCHED")" ]; then
      echo "  already patched (sha256 matches checksums/host-patched-$BUILT_AGAINST.sha256)"
    else
      echo "  already patched (different build, so no checksum to compare against)"
    fi
    skipped=$((skipped+1))
    continue
  fi

  if ! grep -qF "$BUGGY_LINE" "$f"; then
    cat >&2 <<EOF
  The buggy line is not in this file:
    $BUGGY_LINE
  Upstream may have fixed or restructured it. Nothing has been changed here.
  Check before forcing anything — see docs/README-host-structuredcontent-null.md.
EOF
    skipped=$((skipped+1))
    continue
  fi

  known_stock=0
  if [ "$(sha_of "$f")" = "$(want_sha "$SUM_UPSTREAM")" ]; then
    known_stock=1
    echo "  pristine $BUILT_AGAINST (sha256 verified)"
  else
    echo "  warning: this file does not match checksums/host-upstream-$BUILT_AGAINST.sha256,"
    echo "           so it is a different build or has already been modified. Falling"
    echo "           back to a patch dry-run; the result gets node --check but there"
    echo "           is no sha256 to verify it against."
  fi

  if ! ( cd "$pkg" && patch -p1 --dry-run -s < "$PATCH" >/dev/null 2>&1 ); then
    echo "  the patch does not apply to this build. Nothing has been changed." >&2
    echo "  Re-cut it from $TARGET_REL, or check whether upstream has fixed this." >&2
    failed=$((failed+1))
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "  would patch (dry-run clean)"
    skipped=$((skipped+1))
    continue
  fi

  # Only ever back up the original. A second run must not overwrite it with a
  # copy this script produced.
  [ -f "$f$BACKUP_SUFFIX" ] || cp "$f" "$f$BACKUP_SUFFIX"

  ( cd "$pkg" && patch -p1 --no-backup-if-mismatch -s < "$PATCH" )
  node --check "$f"

  if [ "$known_stock" = "1" ]; then
    if [ "$(sha_of "$f")" != "$(want_sha "$SUM_PATCHED")" ]; then
      cp "$f$BACKUP_SUFFIX" "$f"
      echo "  patched output did not match checksums/host-patched-$BUILT_AGAINST.sha256." >&2
      echo "  Reverted. Nothing has been changed." >&2
      failed=$((failed+1))
      continue
    fi
    echo "  patched (sha256 verified against checksums/host-patched-$BUILT_AGAINST.sha256)"
  else
    echo "  patched (node --check passed; backup at $(basename "$f$BACKUP_SUFFIX"))"
  fi
  changed=$((changed+1))
done

echo
if [ "$failed" -gt 0 ]; then
  echo "Finished with $failed failure(s), $changed changed, $skipped unchanged." >&2
  exit 1
fi

if [ "$changed" -gt 0 ] && [ "$DRY_RUN" != "1" ]; then
  cat <<'EOF'
Restart the Paperclip host for this to take effect. Node already holds the old
module in memory, so the running server keeps serving structuredContent: null
until it is restarted.

The Discord plugin worker is a child of the host process, so this also recycles
the plugin worker and its Discord gateway connection. It reconnects on its own.
EOF
else
  echo "Nothing to do ($skipped unchanged)."
fi
