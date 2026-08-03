# Connecting SecAgent (chat-ops)

SecChat turns a Mattermost channel into a front end for **SecAgent** — this is SecAgent's
**UC101 (Mattermost interaction)**. The bridge is [`@whonixnetworks/pi-mattermost`](https://pi.dev/packages/@whonixnetworks/pi-mattermost);
it runs on the SecAgent host and connects to Mattermost with a **bot token**.

## 1. Provision the bot (on the SecChat host)

```bash
./bootstrap/secchat.sh bot          # creates the 'secagent' bot + 'secrouter' team + a token
./bootstrap/secchat.sh pi-config    # prints the config.toml (fill in the token)
```

`secchat.sh bot` uses `mmctl --local` (enabled in compose) so no admin login is needed. Copy
the printed **token** — it's shown once.

## 2. Install the bridge (on the SecAgent host)

```bash
pi install npm:@whonixnetworks/pi-mattermost
mkdir -p ~/.config/pi-mattermost
```

Write `~/.config/pi-mattermost/config.toml` from `secchat.sh pi-config`:

```toml
[mattermost]
url = "http://secchat.internal:8065"
bot_token = "<the token from secchat.sh bot>"
team_id = "<26-char team id>"
http_port = 4000

[pi]
default_model = "balanced"     # a model served via SecRouter / SecLLM
subagent_model = "fast"
```

Point `pi`'s model at **SecRouter** (so chat-driven agents are governed, budgeted, and
audited like everything else) or directly at **SecLLM**. Then run the bridge as a service:

```bash
pi-mattermost install
```

## 3. Use it

From any Mattermost channel the bot is in:

```
/pi-connect /path/to/your/project
```

This starts a SecAgent session bound to that channel; the agent replies in-thread with
streaming output. In the pi TUI on the host you can `/connect` and `/disconnect` the current
project to a channel as well.

## Security notes

- The bot token is a credential — treat it like one; rotate it via `secchat.sh bot` (generates
  a fresh token) and update the bridge config.
- Restrict which channels/teams the bot joins; a `/pi-connect` gives that channel control of an
  agent session on the SecAgent host, so scope the agent's project roots and network policy
  accordingly (SecAgent enforces its own affordance/netpolicy controls).
- Keep the SecAgent host's model traffic pointed at SecRouter so chat-triggered inference is
  governed and audited.
