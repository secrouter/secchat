# SecChat — a NATIVE Mattermost Team Edition image, built from Mattermost's OFFICIAL release
# binary. Mattermost publishes `mattermost-team-<version>-linux-{amd64,arm64}.tar.gz` for BOTH
# architectures, even though its published Docker image (mattermost/mattermost-team-edition) is
# amd64-only. Building here therefore gives a native image on both arches — arm64 on Apple Silicon
# (no QEMU/Rosetta emulation), amd64 on Fedora — while keeping the suite's supply chain intact:
# the official Mattermost binary over HTTPS plus this minimal Dockerfile, never a third-party image.
#
# The arch is detected at build time with `dpkg --print-architecture` (which returns exactly
# Mattermost's tarball suffix — `arm64` / `amd64`), so a plain `docker build` on the host works
# without buildx: the build runs on the host arch and pulls the matching binary.
FROM debian:bookworm-slim

# Full x.y.z release (the tarball URL needs the patch version, unlike the image's x.y tag).
ARG MM_VERSION=10.5.9
# Optional integrity pin: set to the arch-specific tarball's SHA-256 to hard-fail on a mismatch.
# Per-arch (the arm64 and amd64 tarballs differ), so left empty by default — releases.mattermost.com
# over HTTPS is the trust anchor either way, the same trust the official image places in its download.
ARG MM_SHA256=

# curl: the compose/bootstrap health check + `mmctl` are run via `compose exec`. The doc-processing
# tools (poppler-utils/unrtf/wv/tidy) match the official image so attachment text extraction for
# search behaves the same. tzdata + ca-certificates are standard runtime needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl tzdata poppler-utils unrtf wv tidy \
    && rm -rf /var/lib/apt/lists/*

# Same uid/gid (2000) the official image uses, so a config/data volume created by one is readable
# by the other (a host migrating off the amd64 image keeps its volumes).
RUN groupadd -g 2000 mattermost \
    && useradd -u 2000 -g 2000 -M -d /mattermost -s /usr/sbin/nologin mattermost

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    url="https://releases.mattermost.com/${MM_VERSION}/mattermost-team-${MM_VERSION}-linux-${arch}.tar.gz"; \
    curl -fSL "$url" -o /tmp/mm.tar.gz; \
    if [ -n "$MM_SHA256" ]; then echo "${MM_SHA256}  /tmp/mm.tar.gz" | sha256sum -c -; fi; \
    tar -xzf /tmp/mm.tar.gz -C /; \
    rm /tmp/mm.tar.gz; \
    mkdir -p /mattermost/data /mattermost/logs /mattermost/config \
             /mattermost/plugins /mattermost/client/plugins /mattermost/bleve-indexes; \
    chown -R mattermost:mattermost /mattermost

WORKDIR /mattermost
USER mattermost

# /mattermost/bin on PATH so `mmctl` resolves for `compose exec mattermost mmctl --local` (the
# bootstrap's bot/team provisioning). MM_INSTALL_TYPE matches the official image.
ENV PATH=/mattermost/bin:$PATH \
    MM_INSTALL_TYPE=docker

EXPOSE 8065 8067 8074
VOLUME ["/mattermost/data", "/mattermost/logs", "/mattermost/config", \
        "/mattermost/plugins", "/mattermost/client/plugins", "/mattermost/bleve-indexes"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=6 \
    CMD curl -sf http://localhost:8065/api/v4/system/ping || exit 1

# No custom entrypoint: the Mattermost binary reads MM_* env vars directly (compose sets the DB /
# site-URL / SSO settings) and generates config on first run — identical to the official image.
CMD ["/mattermost/bin/mattermost"]
