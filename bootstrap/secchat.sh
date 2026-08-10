#!/usr/bin/env bash
# SecChat — backend lifecycle + the SecSSO/SecRouter wiring readout.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root (compose.yaml + .env live here)

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@"
  else echo "docker compose (plugin or standalone) not found" >&2; exit 1; fi
}

require_env() {
  [ -f .env ] || { echo "no .env — run: cp .env.example .env && \$EDITOR .env" >&2; exit 1; }
}

# env_val KEY — read KEY from .env (last match wins, quotes stripped). Always exits 0 (a
# commented-out/absent KEY is the normal "use the default" case, not an error) — callers do
# `x="$(env_val KEY)"; x="${x:-default}"`. Under `set -e`, a bare assignment takes the exit
# status of its command substitution, so without the trailing `|| true` an absent optional key
# (grep finds no match → non-zero) would kill the script.
env_val() { grep -E "^${1}=" .env 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '"' || true; }

wiring() {
  local issuer audience secrouter port
  issuer="$(env_val SECCHAT_OIDC_ISSUER)"
  audience="$(env_val SECCHAT_OIDC_AUDIENCE)"
  secrouter="$(env_val SECROUTER_URL)"; secrouter="${secrouter:-http://127.0.0.1:47002}"
  port="$(env_val SECCHAT_HTTP_PORT)"; port="${port:-47010}"
  cat <<EOF

SecChat is wired to two things you provision elsewhere:

1) SecSSO — every session IS a SecSSO session, validated via this issuer's JWKS
   (src/auth/jwks.ts) — there is no local password store:
     issuer:    ${issuer}
     audience:  ${audience}   (SecChat's OIDC client id; tokens for any other audience are rejected)
     JWKS:      ${issuer%/}/.well-known/jwks.json   (derived; override with SECCHAT_JWKS_URL)

2) SecRouter — the assistant path (spawned agents) routes model calls here, governed,
   budgeted, and audited as the owning user (src/secrouter/client.ts):
     SECROUTER_URL: ${secrouter}

   UI: http://localhost:${port}
EOF
}

case "${1:-help}" in
  up)
    require_env
    compose up -d --build
    echo "waiting for SecChat to answer…"
    port="$(env_val SECCHAT_HTTP_PORT)"; port="${port:-47010}"
    for _ in $(seq 1 30); do
      if curl -sf "http://localhost:${port}/healthz" 2>/dev/null | grep -q '"status":"ok"'; then
        echo "  ✓ up"
        break
      fi
      sleep 2
    done
    wiring
    ;;
  status) require_env; compose ps ;;
  wiring) require_env; wiring ;;
  backup)
    # State SecDeploy's encrypted-backup flow collects for this stack. Stack must be UP.
    # secchat keeps ALL state in Postgres (no separate uploads volume — see db/migrations/), so
    # the SQL dump + .env is the complete state.
    require_env; shift
    dir="${1:?usage: $0 backup <dir>}"; mkdir -p "$dir"
    echo "→ pg_dump secchat → $dir/secchat.sql"
    compose exec -T postgres pg_dump -U secchat -d secchat > "$dir/secchat.sql"
    cp .env "$dir/.env"   # needed to reconstruct DATABASE_URL/PG_PASSWORD on restore
    echo "  ✓ secchat backup → $dir (secchat.sql, .env)"
    ;;
  restore)
    # Reinitialize this stack from a backup dir. REPLACES state — this wipes the Postgres
    # volume and reloads it from the dump rather than merging.
    require_env; shift
    dir="${1:?usage: $0 restore <dir>}"
    [ -f "$dir/secchat.sql" ] || { echo "no secchat.sql in $dir" >&2; exit 1; }
    [ -f "$dir/.env" ] && { cp "$dir/.env" .env; echo "→ restored .env (PG_PASSWORD to match the dump)"; }
    echo "→ reinitializing Postgres from a clean volume"
    compose down -v 2>/dev/null || true
    compose up -d postgres
    for _ in $(seq 1 30); do compose exec -T postgres pg_isready -U secchat >/dev/null 2>&1 && break; sleep 2; done
    echo "→ loading secchat.sql"
    compose exec -T postgres psql -U secchat -d secchat < "$dir/secchat.sql"
    echo "→ starting SecChat"
    compose up -d --build
    echo "  ✓ secchat restore complete"
    ;;
  logs) require_env; shift; compose logs -f "$@" ;;
  down) require_env; shift; compose down "$@" ;;
  *)
    cat <<'EOF'
SecChat — auditable team + agentic chat backend control helper
  ./bootstrap/secchat.shup             build + start, wait, print the SSO/gateway wiring
  ./bootstrap/secchat.shstatus         compose ps
  ./bootstrap/secchat.shwiring         reprint the SecSSO + SecRouter wiring readout
  ./bootstrap/secchat.shbackup <dir>   pg_dump + .env → <dir>
  ./bootstrap/secchat.shrestore <dir>  reinitialize the stack from <dir> (REPLACES state)
  ./bootstrap/secchat.shlogs [svc]     follow logs (secchat | postgres)
  ./bootstrap/secchat.shdown [-v]      stop (-v also wipes volumes/state)
EOF
    ;;
esac
