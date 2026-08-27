#!/usr/bin/env bash
# Build the SecChat macOS .app CORRECTLY, in one step.
#
# The desktop build MUST carry the backend origin as a compile-time define. Without it,
# app/lib/app.dart's `_secchatOrigin` is empty, `backendOrigin` is null, and every API/SSO call
# resolves against `file://…` — so `/auth/status` fails, the login screen silently degrades to the
# dev form (NO "Sign in with SecSSO" button), and the assistant/agent pages 404. `flutter build
# macos` alone does NOT do this, which is exactly why this wrapper exists — never call the bare
# flutter build for a real deployment.
#
# Then it embeds the runner daemon (bundle-macos-runnerd.sh — required so the app can spawn a local
# coding-agent runner).
#
# Usage:  scripts/build-macos-app.sh
#   SECCHAT_ORIGIN=https://secchat.sec.internal  (default; override for a different deployment)
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGIN="${SECCHAT_ORIGIN:-https://secchat.sec.internal}"
APP="app/build/macos/Build/Products/Release/SecChat.app"

echo "▸ flutter build macos --release --dart-define=SECCHAT_ORIGIN=$ORIGIN"
( cd app && flutter build macos --release --dart-define=SECCHAT_ORIGIN="$ORIGIN" )

echo "▸ embedding the runner daemon"
scripts/bundle-macos-runnerd.sh "$APP"

echo "✓ built $APP  (origin: $ORIGIN)"
