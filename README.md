# SecChat — team chat & chat-ops for the SecRouter suite

**Mattermost, wired into the suite.** SecChat is a Community-Edition (Team Edition) Mattermost
deployment that logs in through **SecSSO** and turns a channel into a control surface for
**SecAgent** via the [`@whonixnetworks/pi-mattermost`](https://pi.dev/packages/@whonixnetworks/pi-mattermost)
bridge — type `/pi-connect` and drive an agent from chat.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

## What you get

- Mattermost Team Edition + Postgres via Compose, built **natively** from Mattermost's official
  release binary (arm64 + amd64 — native on Apple Silicon, no emulation; see [`Dockerfile`](Dockerfile)).
- A control helper that stands it up and provisions the **SecAgent bot** + token (`mmctl --local`).
- The exact **`pi-mattermost` config** to drop on the SecAgent host.
- SSO through **SecSSO** (Mattermost's GitLab connector → Authentik).

## Quickstart

```bash
cp .env.example .env      # set POSTGRES_PASSWORD (+ SSO if desired)
./bootstrap/secchat.sh up
```

Open `http://localhost:8065`, create the first admin account, then provision the agent bot:

```bash
./bootstrap/secchat.sh bot          # creates the 'secagent' bot + 'secrouter' team + a token
./bootstrap/secchat.sh pi-config    # prints ~/.config/pi-mattermost/config.toml for SecAgent
```

## Connect SecAgent (chat-ops)

On the **SecAgent** host, install the bridge and point it at SecChat:

```bash
pi install npm:@whonixnetworks/pi-mattermost
mkdir -p ~/.config/pi-mattermost
$EDITOR ~/.config/pi-mattermost/config.toml   # paste what `secchat.sh pi-config` printed
pi-mattermost install                          # runs the bridge as a user service
```

Then, from a Mattermost channel:

```
/pi-connect /path/to/your/project
```

…starts a SecAgent session bound to that channel — the same engines as SecAgent's use cases
(this is SecAgent **UC101 — Mattermost interaction**), with results streamed back in-thread.
See [docs/connect-secagent.md](docs/connect-secagent.md).

## SSO via SecSSO

Mattermost Team Edition authenticates SSO through its **GitLab** connector; SecSSO (Authentik)
presents GitLab-compatible OAuth endpoints. Set the `MM_GITLAB_*` values in `.env` and create
the provider in SecSSO — see [docs/sso.md](docs/sso.md). Already have an IdP? Point the
GitLab connector at it (or use Mattermost's native SAML/OIDC if you run Enterprise).

## Configuration (`.env`)

| Variable | Meaning |
|---|---|
| `MATTERMOST_VERSION` | Mattermost release (full x.y.z) — built natively from the official binary |
| `POSTGRES_PASSWORD` | Postgres password (required) |
| `MM_SITE_URL` | site URL clients use; must match the SSO redirect |
| `SECCHAT_HTTP_PORT` | published port (8065) |
| `MM_GITLAB_*` | SSO connector settings (point at SecSSO) |

## Backup

The control helper exposes self-contained `backup`/`restore` verbs — the suite orchestrator
(`secdeploy backup`) calls these and encrypts the result, but they also work standalone:

```bash
./bootstrap/secchat.sh backup  ./snap   # → mattermost.sql + /mattermost files + .env into ./snap
./bootstrap/secchat.sh restore ./snap   # reinitialize the stack from ./snap (REPLACES state)
```

`backup` needs the stack up (it dumps the live Postgres). `restore` reinitializes Postgres from
a clean volume and restores the dumped `.env` (its `POSTGRES_PASSWORD` must match the dump) plus
the `/mattermost/{data,config}` files — so Mattermost's own at-rest keys line up. For the
encrypted, whole-suite backup see [secdeploy](https://github.com/secrouter/secdeploy)'s runbooks.

## Notes

- **Native on both arches.** Mattermost's published Docker image is amd64-only, so on Apple
  Silicon it would run emulated. Instead the [`Dockerfile`](Dockerfile) builds a native image from
  Mattermost's **official release binary** (published for arm64 *and* amd64) — arm64 on Apple
  Silicon, amd64 on Fedora, no emulation. Mattermost itself is not vendored here; the binary is
  fetched at build time over HTTPS under its own license (see [NOTICE](NOTICE)).
- **Container-based** on every target (Colima on macOS, Podman on Fedora).
- Run behind a TLS-terminating proxy in production and set `MM_SITE_URL` to the `https://` URL.

## License

[Apache 2.0](LICENSE) — Copyright 2026 Austin Probe.
