# secchat-mediad — server-side WebRTC media relay + recorder (docs/plans/voice-calls-plan.md
# §2.3/§3.2). Two-stage build: a Go builder produces a static binary; the runtime image adds
# ONLY ffmpeg (the sole shell invocation mediad makes, at finalize — §2.3) and runs as a
# non-root user with the recordings volume as its only write mount (hardening, §3.2).
#
# TODO(voice): this Dockerfile has not been `docker build`-verified in this environment (no
# docker daemon available in the sandbox this was written in) — the Go binary it packages HAS
# been built and tested directly on the host (go build ./... / go test ./... both green). Verify
# the image build + non-root ffmpeg invocation + volume permissions on a real Docker host before
# wiring this into secdeploy's [[builds]] (out of this component's scope — see §2.5/§3.5).

# ── Stage 1: build a static Go binary ───────────────────────────────────────────────────────
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/mediad .

# ── Stage 2: lean runtime + ffmpeg ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# ffmpeg (+ ffprobe, used by the crash-recovery remix path in internal/session/finalize.go) is
# the ONLY shell-adjacent tool mediad ever invokes, and only at session finalize
# (docs/plans/voice-calls-plan.md §2.3: "the only optional component and the only shell
# invocation").
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Non-root: a dedicated system user/group, no shell, no home directory needed.
RUN groupadd --system mediad && useradd --system --gid mediad --no-create-home --shell /usr/sbin/nologin mediad

# The recordings volume is mediad's ONLY write mount (hardening, §3.2) — created and chowned
# BEFORE dropping to the non-root user, same reasoning as secchat's own uploads dir (a named
# volume initializes from the image's directory ownership, so without this the mount would be
# root-owned and every recording write would EACCES).
RUN mkdir -p /var/lib/mediad/recordings && chown mediad:mediad /var/lib/mediad/recordings

COPY --from=build /out/mediad /usr/local/bin/mediad

USER mediad
WORKDIR /var/lib/mediad

ENV MEDIAD_RECORDINGS_DIR=/var/lib/mediad/recordings \
    MEDIAD_CONTROL_ADDR=:47021 \
    MEDIAD_MEDIA_ADDR=:47020 \
    MEDIAD_FFMPEG_PATH=ffmpeg

# Control API (compose-internal only, never published to clients — docs/plans/voice-
# contracts.md §2) + the single well-known media port for ALL sessions (UDP + ICE-TCP fallback
# on the SAME port number, §3).
EXPOSE 47021/tcp 47020/udp 47020/tcp

# docs/plans/voice-contracts.md §2.5: GET /health is unauthenticated by design — usable directly
# as the compose healthcheck without needing MEDIAD_TOKEN baked into the image/healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
    CMD ["/usr/local/bin/mediad", "-healthcheck"]

ENTRYPOINT ["/usr/local/bin/mediad"]
