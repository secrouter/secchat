#!/usr/bin/env bash
# SecChat — Mattermost lifecycle + SecAgent bot / pi-mattermost wiring.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root (compose.yaml + .env)

BOT_USER="secagent"
TEAM="secrouter"

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else echo "docker compose (plugin or standalone) not found" >&2; exit 1; fi
}
require_env() { [ -f .env ] || { echo "no .env — run: cp .env.example .env && \$EDITOR .env" >&2; exit 1; }; }
mmctl() { compose exec -T mattermost mmctl --local "$@"; }
site_url() { grep -E '^MM_SITE_URL=' .env | cut -d= -f2- | tr -d '"' | sed 's:/*$::'; }

wait_healthy() {
  echo "waiting for Mattermost…"
  for _ in $(seq 1 60); do
    if compose exec -T mattermost curl -sf http://localhost:8065/api/v4/system/ping >/dev/null 2>&1; then
      echo "  ✓ up"; return 0
    fi
    sleep 3
  done
  echo "  Mattermost did not become healthy in time" >&2; return 1
}

case "${1:-help}" in
  up)
    require_env
    compose up -d
    wait_healthy
    echo "  console: $(site_url)  — create the first admin account, then run: $0 bot"
    ;;
  status) require_env; compose ps ;;
  bot)
    require_env; wait_healthy
    echo "→ ensuring team '$TEAM'"
    mmctl team create --name "$TEAM" --display-name "SecRouter" --private 2>/dev/null || echo "  (team exists)"
    echo "→ creating bot '$BOT_USER'"
    mmctl bot create "$BOT_USER" --display-name "SecAgent" --description "SecAgent chat-ops bridge" 2>/dev/null || echo "  (bot exists)"
    mmctl team users add "$TEAM" "$BOT_USER" >/dev/null 2>&1 || true
    echo "→ generating an access token (copy the token value below):"
    mmctl token generate "$BOT_USER" "pi-mattermost bridge" || true
    echo ""
    echo "Save that token, then run:  $0 pi-config"
    ;;
  pi-config)
    require_env
    team_id="$(mmctl team search "$TEAM" 2>/dev/null | grep -oiE '[a-z0-9]{26}' | head -1 || echo '<team_id>')"
    cat <<EOF

# ~/.config/pi-mattermost/config.toml  (on the SecAgent host)
# install the bridge there with:  pi install npm:@whonixnetworks/pi-mattermost
[mattermost]
url = "$(site_url)"
bot_token = "<paste the token from '$0 bot'>"
team_id = "${team_id}"
http_port = 4000

[pi]
default_model = "balanced"    # a model served via SecRouter / SecLLM
subagent_model = "fast"
EOF
    ;;
  sso-config)
    require_env
    echo "Mattermost GitLab-OAuth (System Console → Authentication → GitLab), pointed at SecSSO:"
    grep -E '^MM_GITLAB_' .env | sed 's/^/  /'
    echo "  Create a GitLab-compatible provider for Mattermost in SecSSO — see docs/sso.md."
    ;;
  logs) require_env; shift; compose logs -f "$@" ;;
  down) require_env; shift; compose down "$@" ;;
  *)
    cat <<'EOF'
SecChat — Mattermost control helper
  ./bootstrap/secchat.sh up          bring Mattermost up + wait (then create the first admin in the browser)
  ./bootstrap/secchat.sh bot         create the SecAgent bot + team + access token (mmctl --local)
  ./bootstrap/secchat.sh pi-config   print ~/.config/pi-mattermost/config.toml for SecAgent
  ./bootstrap/secchat.sh sso-config  show the Mattermost ↔ SecSSO OAuth settings
  ./bootstrap/secchat.sh status      compose ps
  ./bootstrap/secchat.sh logs [svc]  follow logs
  ./bootstrap/secchat.sh down [-v]   stop (-v also wipes volumes)
EOF
    ;;
esac
