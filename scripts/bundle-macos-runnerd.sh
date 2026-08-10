#!/usr/bin/env bash
# Embed the runner daemon into a built macOS .app so the desktop app can spawn a local runner.
#
# Places, under <App>/Contents/Resources/runnerd/:
#   - the dependency-free daemon sources (npm run bundle:runnerd → dist/runnerd/), and
#   - a self-contained `node` (the official arm64 build — Homebrew's node isn't copy-safe, it needs
#     its Cellar dylibs), which runs the .ts entry directly.
# Then ad-hoc re-signs the embedded node + the whole app: the App Sandbox only lets the app exec a
# binary that lives inside the bundle and carries a valid signature (see the supervisor's
# _bundledRunner in lib/platform/daemon_supervisor_io.dart). No signature ⇒ the OS refuses to launch it.
#
# Usage:  scripts/bundle-macos-runnerd.sh [path/to/App.app]
#   default: build/macos/Build/Products/Release/secchat_app.app
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

APP="${1:-build/macos/Build/Products/Release/secchat_app.app}"
[ -d "$APP" ] || { echo "no .app at $APP — run 'flutter build macos --release' first" >&2; exit 1; }

RES="$APP/Contents/Resources/runnerd"
CACHE=".cache/node-macos-arm64"
mkdir -p "$RES" "$CACHE"

echo "▸ bundling runnerd sources"
npm run --silent bundle:runnerd
rm -rf "$RES"/agent "$RES"/daemon "$RES"/*.ts 2>/dev/null || true
cp -R dist/runnerd/. "$RES/"

# Fetch a pinned-major, self-contained official node (latest v24) once; cache it across runs.
if [ ! -x "$CACHE/node" ]; then
  VER="$(curl -sL https://nodejs.org/dist/index.json | grep -o '"version":"v24[^"]*"' | head -1 | sed 's/.*"v/v/;s/"//')"
  [ -n "$VER" ] || { echo "couldn't resolve latest node v24 from nodejs.org" >&2; exit 1; }
  TARBALL="node-$VER-darwin-arm64.tar.gz"
  echo "▸ downloading node $VER (official, self-contained)"
  curl -sL "https://nodejs.org/dist/$VER/$TARBALL" -o "$CACHE/$TARBALL"
  tar -xzf "$CACHE/$TARBALL" -C "$CACHE" --strip-components=2 "node-$VER-darwin-arm64/bin/node"
  rm -f "$CACHE/$TARBALL"
fi
cp "$CACHE/node" "$RES/node"
chmod +x "$RES/node"

# The suite CA (SecCert root), so pi can verify the gateway's TLS (see the supervisor's
# _bundledCaPath / NODE_EXTRA_CA_CERTS). Point SECCHAT_CA_PEM at your deployment's root; defaults
# to secdeploy's out/seccert-root.pem.
CA_SRC="${SECCHAT_CA_PEM:-../../out/seccert-root.pem}"
if [ -f "$CA_SRC" ]; then
  cp "$CA_SRC" "$APP/Contents/Resources/seccert-root.pem"
  echo "▸ bundled suite CA → Resources/seccert-root.pem"
else
  echo "⚠ no CA at $CA_SRC — pi model calls to an internal-CA gateway will fail TLS. Set SECCHAT_CA_PEM." >&2
fi

echo "▸ ad-hoc signing embedded node + app"
codesign --force --sign - "$RES/node"
codesign --force --deep --sign - "$APP"

echo "✓ embedded runnerd → $RES  (node $("$RES/node" --version))"
