# SecChat backend — zero-build Node 24 + TypeScript (native type-stripping; imports use
# explicit .ts extensions; no bundler, no compile step). Runtime deps are pg + jose only
# (package.json `dependencies`) — everything else (types, tsc) is dev-only and stays out of
# this image.
#
# Normally run via compose.yaml (adds Postgres) — see bootstrap/secchat.sh:
#   cp .env.example .env && edit
#   ./bootstrap/secchat.sh up

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

# ---------------------------------------------------------------------------------------------
# Web client: this image serves clients/web-minimal — a dependency-free HTML/CSS/JS client,
# copied above, that always exists in the repo. It does NOT build the Flutter client (../app);
# that toolchain (Flutter SDK, Dart, platform build dependencies) doesn't belong in this lean
# runtime image.
#
# To add a Flutter-web build later, add a build stage ahead of this one and copy its output in,
# e.g.:
#
#   FROM ghcr.io/cirruslabs/flutter:stable AS flutter-web
#   WORKDIR /src
#   COPY app ./app
#   RUN cd app && flutter build web --release
#
#   FROM node:24-bookworm-slim
#   ...(this file, unchanged)...
#   COPY --from=flutter-web /src/app/build/web ./app/build/web
#
# No server code change is needed: src/index.ts already prefers app/build/web over
# clients/web-minimal whenever app/build/web/index.html exists.
# ---------------------------------------------------------------------------------------------

# Run as the image's built-in non-root user rather than root.
USER node

# Must bind all interfaces inside the container — compose/SecDeploy publish the port from the
# host side.
ENV SECCHAT_HOST=0.0.0.0

EXPOSE 47010

CMD ["node", "src/index.ts"]
