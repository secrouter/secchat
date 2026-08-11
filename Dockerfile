# SecChat backend — zero-build Node 24 + TypeScript (native type-stripping; imports use
# explicit .ts extensions; no bundler, no compile step). Runtime deps are pg + jose only
# (package.json `dependencies`) — everything else (types, tsc) is dev-only and stays out of
# this image.
#
# Normally run via compose.yaml (adds Postgres) — see bootstrap/secchat.sh:
#   cp .env.example .env && edit
#   ./bootstrap/secchat.sh up

# ── Stage 1: build the Flutter web client ──────────────────────────────────────────────────
# Produces app/build/web, which src/index.ts serves in preference to clients/web-minimal (the
# fallback dev shell). The Flutter SDK/Dart toolchain lives ONLY in this stage; none of it
# reaches the runtime image below. Pinned to a specific Flutter release for reproducibility.
FROM ghcr.io/cirruslabs/flutter:3.35.1 AS flutter-web
WORKDIR /src/app
# pubspec first so `pub get` caches across source-only changes.
COPY app/pubspec.yaml app/pubspec.lock ./
RUN flutter pub get
COPY app/ ./
# Served at the origin root (https://secchat.sec.internal/), so the default base href "/" is
# correct — no --base-href override needed.
RUN flutter build web --release

# ── Stage 2: the lean Node runtime ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

WORKDIR /app

# Install ONLY runtime dependencies, deterministically from the committed lockfile.
# package.json + package-lock.json copied first so this layer stays cached across source-only
# changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source. Deliberately NOT copied: test/ (dev-only), node_modules (installed
# above), app/ (the Flutter client source — see the web-client note below).
COPY src ./src
COPY clients ./clients
COPY db ./db
COPY tsconfig.json ./

# Web client: the Flutter build from stage 1 is the primary client; clients/web-minimal (copied
# above) remains as the fallback dev shell. src/index.ts prefers app/build/web whenever its
# index.html exists, so no server code change is needed to switch between them.
COPY --from=flutter-web /src/app/build/web ./app/build/web

# Attachment uploads (content-addressed blobs) land in ./uploads. WORKDIR /app is root-owned, so
# create the dir up front and hand it to the runtime `node` user — otherwise the first upload's
# mkdir fails with EACCES and every attachment 500s. Mount a volume here (see compose.yaml) to
# persist across container recreates.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# Run as the image's built-in non-root user rather than root.
USER node

# Must bind all interfaces inside the container — compose/SecDeploy publish the port from the
# host side.
ENV SECCHAT_HOST=0.0.0.0

EXPOSE 47010

CMD ["node", "src/index.ts"]
