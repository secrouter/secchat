# The SecChat runner daemon

The runner daemon runs coding agents (pi) on **a machine of your choosing** and attaches **out** to a
SecChat instance. A user on one machine can drive a coding agent whose runner lives on another — their
laptop (via the bundled desktop app), a dev box, or a server / container — all mediated through
SecChat.

The daemon **does not** decide what a coding agent may execute. It relays each tool request to SecChat;
SecChat's control plane runs the **execute-gate** and returns the verdict. So *only the agent's owner
can authorize execution*, even when the runner is on a different machine (decision #2). A daemon can
drive only its own owner's sessions.

```
your machine ── secchat-runnerd ──WS /runner──►  SecChat
                │ spawns pi                       │ execute-gate (owner-only)
                │ relays tool_request ────────────► allow / deny
                ◄── owner grants execute ──────────┘
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `SECCHAT_URL` | `http://127.0.0.1:47010` | The SecChat base URL (http/https → the daemon dials `ws(s)://…/runner`). |
| `SECCHAT_RUNNER_TOKEN` | — (**required**) | The owner's token the daemon authenticates with (an OIDC token, or a `dev.<sub>.<groups>` token in dev). Also accepted as `SECCHAT_TOKEN`. |
| `SECCHAT_RUNNER_STUB` | unset | `1` → use the interactive echo runner instead of pi (dev / smoke tests without pi installed). |
| `PI_BIN` | `pi` | Path to the pi CLI when it isn't on `PATH`. |
| `SECCHAT_RUNNER_HEARTBEAT_MS` | `20000` | Lease heartbeat interval (keeps live sessions from being reaped). |
| `SECCHAT_RUNNER_RECONNECT_MS` | `2000` | Delay before reconnecting after the socket drops. |

## Run mode 1 — standalone (server / container)

From a checkout:

```bash
SECCHAT_URL=https://chat.example.mil \
SECCHAT_RUNNER_TOKEN=<oidc-or-dev-token> \
npm run daemon
```

As a container (`Dockerfile.runnerd`):

```bash
docker build -f Dockerfile.runnerd -t secchat-runnerd .
docker run --rm \
  -e SECCHAT_URL=https://chat.example.mil \
  -e SECCHAT_RUNNER_TOKEN=<oidc-or-dev-token> \
  secchat-runnerd
```

The daemon dials out — there is **no inbound port**. In an air-gapped/private registry, pre-stage the
pi CLI and set `PI_BIN` (or build with `--build-arg INSTALL_PI=0` and smoke-test with
`SECCHAT_RUNNER_STUB=1`).

## Run mode 2 — bundled in the desktop app

The Flutter desktop app supervises a **bundled** copy of the daemon: on login it spawns it wired to
the signed-in user's SecChat + token, shows its status in the top bar (`Runner on/off/…`), restarts
it if it exits, and stops it on logout. A desktop user therefore gets a local runner automatically —
no separate process to manage.

**Packaging the bundle.** The daemon's import graph is dependency-free (only Node builtins + local
`.ts`), so it bundles to a self-contained tree:

```bash
npm run bundle:runnerd    # → dist/runnerd/  (run standalone with: node dist/runnerd/daemon/main.ts)
```

The desktop release then places, inside the app bundle (e.g. macOS `…app/Contents/Resources/`):

- `dist/runnerd/` (the daemon sources), and
- a Node runtime for the target OS/arch (Node runs the `.ts` directly), and
- a small `secchat-runnerd` launcher that execs `node <resources>/runnerd/daemon/main.ts`.

The supervisor spawns `secchat-runnerd`; override the command with `SECCHAT_RUNNER_CMD` (e.g. point it
at `node` + the bundle during development).

> Cookie-session note: when the desktop app authenticates by session cookie it has no bearer token to
> hand the daemon, so the daemon stays off. A short-lived, owner-scoped **runner token** minted by
> SecChat for the daemon is the planned follow-on.

## Security model

- **The gate never leaves the server.** The daemon relays `tool_request`s; SecChat evaluates the
  owner grant and returns `tool_answer`. Read-only tools run in plan mode; a mutating tool needs the
  owner's explicit grant.
- **One daemon per owner.** A daemon authenticates as its owner; it registers by that sub and may
  drive only that owner's sessions. A reconnect supersedes the previous daemon.
- **Liveness.** The daemon heartbeats its live sessions; if it dies, the orphan reaper marks its
  sessions dead rather than leaving them hung.

## Deploying a standalone daemon with SecDeploy

Registering `secchat-runnerd` as a first-class SecDeploy component (image build + env wiring for
`SECCHAT_URL` / `SECCHAT_RUNNER_TOKEN`, alongside the secchat stack) is the cross-repo follow-on,
tracked with the cutover work.
