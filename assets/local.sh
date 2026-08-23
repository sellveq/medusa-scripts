#!/usr/bin/env bash
# Local stack engine behind the lmca CLI. Config: lmca.js; env LMCA_* overrides win.
set -euo pipefail

ASSETS="${LMCA_ASSETS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
if [ -n "${LMCA_ROOT:-}" ]; then
  ROOT="$LMCA_ROOT"
else
  ROOT="$PWD"
  while [ ! -f "$ROOT/lmca.js" ] && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done
  [ -f "$ROOT/lmca.js" ] || { echo "no lmca.js found — run 'lmca init' first" >&2; exit 1; }
fi
COMPOSE_FILE="$ASSETS/docker-compose.yml"
CACHE_DIR="$ROOT/node_modules/.lmca-cache"
DUMP_DIR="$CACHE_DIR/dumps"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }

_cfg_err="$(mktemp)"
if ! _cfg="$(node -e '
const root = process.argv[1];
const lib = require(process.argv[2]);
const c = require(root + "/lmca.js");
const p = (c.services || {}).postgres || {};
const r = (c.services || {}).redis || {};
const x = c.proxy || {};
const a = c.apps || {};
const ad = c.admin || {};
const proj = c.project || "app";
const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
console.log([
  `_C_PROJECT=${q(proj)}`,
  `_C_PROJECT_ID=${q(lib.projectId(root, c))}`,
  `_C_PG_PORT=${q(p.port || 5432)}`,
  `_C_DB_USER=${q(p.user || "app")}`,
  `_C_DB_PASSWORD=${q(p.password || "app")}`,
  `_C_DB_NAME=${q(p.database || proj)}`,
  `_C_REDIS_PORT=${q(r.port || 6379)}`,
  `_C_HTTP_PORT=${q(x.port || 80)}`,
  `_C_DOMAIN=${q(x.domain || "localhost")}`,
  `_C_BACKEND_DIR=${q((a.backend || {}).dir || "apps/backend")}`,
  `_C_BACKEND_PORT=${q((a.backend || {}).port || 9000)}`,
  `_C_STOREFRONT_PORT=${q((a.storefront || {}).port || 8000)}`,
  `_C_STOREFRONT_DIR=${q((a.storefront || {}).dir || "apps/storefront")}`,
  `_C_ADMIN_EMAIL=${q(ad.email || "admin@" + proj + ".local")}`,
  `_C_ADMIN_PASSWORD=${q(ad.password || "medusa123")}`,
].join("\n"))
' "$ROOT" "$ASSETS/../lib/ports.js" 2>"$_cfg_err")"; then
  red "failed to read $ROOT/lmca.js:"
  cat "$_cfg_err" >&2
  rm -f "$_cfg_err"
  exit 1
fi
rm -f "$_cfg_err"
eval "$_cfg"

# closest-available ports (cached in node_modules/.lmca-cache)
_ports_err="$(mktemp)"
if _pmap="$(node -e '
(async () => {
  const { ports } = await require(process.argv[1]).resolve(process.argv[2])
  process.stdout.write(Object.entries(ports).map(([k, v]) => `_P_${k.toUpperCase()}=${v}`).join("\n") + "\n")
})().catch((e) => { console.error(e.message); process.exit(1) })
' "$ASSETS/../lib/ports.js" "$ROOT" 2>"$_ports_err")"; then
  eval "$_pmap"
else
  red "port allocation failed ($(cat "$_ports_err")) — using the preferred ports from lmca.js"
fi
rm -f "$_ports_err"

# containers/volumes scoped as <project>-<projectId>
export LMCA_COMPOSE_PROJECT="${LMCA_COMPOSE_PROJECT:-$_C_PROJECT${_C_PROJECT_ID:+-$_C_PROJECT_ID}}"
export LMCA_PG_PORT="${LMCA_PG_PORT:-${_P_POSTGRES:-$_C_PG_PORT}}"
export LMCA_DB_USER="${LMCA_DB_USER:-$_C_DB_USER}"
export LMCA_DB_PASSWORD="${LMCA_DB_PASSWORD:-$_C_DB_PASSWORD}"
export LMCA_DB_NAME="${LMCA_DB_NAME:-$_C_DB_NAME}"
export LMCA_REDIS_PORT="${LMCA_REDIS_PORT:-${_P_REDIS:-$_C_REDIS_PORT}}"
export LMCA_HTTP_PORT="${LMCA_HTTP_PORT:-${_P_HTTP:-$_C_HTTP_PORT}}"
export LMCA_BACKEND_PORT="${LMCA_BACKEND_PORT:-${_P_BACKEND:-$_C_BACKEND_PORT}}"
export LMCA_STOREFRONT_PORT="${LMCA_STOREFRONT_PORT:-${_P_STOREFRONT:-$_C_STOREFRONT_PORT}}"
LMCA_DOMAIN="${LMCA_DOMAIN:-$_C_DOMAIN}"
BACKEND_DIR="${LMCA_BACKEND_DIR:-$_C_BACKEND_DIR}"
LMCA_ADMIN_EMAIL="${LMCA_ADMIN_EMAIL:-$_C_ADMIN_EMAIL}"
LMCA_ADMIN_PASSWORD="${LMCA_ADMIN_PASSWORD:-$_C_ADMIN_PASSWORD}"
if [ "$LMCA_HTTP_PORT" = "80" ]; then LMCA_BASE_URL="http://$LMCA_DOMAIN"; else LMCA_BASE_URL="http://$LMCA_DOMAIN:$LMCA_HTTP_PORT"; fi
PG_CONTAINER="$LMCA_COMPOSE_PROJECT-postgres"
REDIS_CONTAINER="$LMCA_COMPOSE_PROJECT-redis"
STOREFRONT_DIR="${LMCA_STOREFRONT_DIR:-$_C_STOREFRONT_DIR}"
LOG_DIR="$CACHE_DIR/logs"
RUN_DIR="$CACHE_DIR/run"

COMPOSE=(docker compose -f "$COMPOSE_FILE")

need_docker() {
  command -v docker >/dev/null || { red "docker is not installed / not on PATH"; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    read -r -p "Docker is not running. Start Docker Desktop? [y/N] " ans
    case "$ans" in y|Y|yes|YES) ;; *) note "aborted — Docker stays off"; exit 1 ;; esac
    if [ "$(uname)" = "Darwin" ]; then
      note "starting Docker Desktop..."
      open -g -a Docker || { red "could not launch Docker Desktop"; exit 1; }
    else
      red "start the docker daemon first (e.g. systemctl start docker)"; exit 1
    fi
    # docker info can block while the daemon boots — bound by wall-clock
    local start_ts=$SECONDS
    while [ $((SECONDS - start_ts)) -lt 120 ]; do
      docker info >/dev/null 2>&1 && { green "docker is up"; return 0; }
      sleep 2
    done
    red "docker did not become ready in 120s — open Docker Desktop and check it manually"; exit 1
  fi
}

docker_running() { docker info >/dev/null 2>&1; }

wait_healthy() {
  note "waiting for containers to become healthy..."
  local containers=("$PG_CONTAINER" "$REDIS_CONTAINER" "$LMCA_COMPOSE_PROJECT-proxy")
  local c st all_ok
  for _ in $(seq 1 60); do
    all_ok=1
    for c in "${containers[@]}"; do
      st="$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || true)"
      [ "$st" = "healthy" ] || { all_ok=0; break; }
    done
    [ "$all_ok" = "1" ] && { green "all services healthy"; return 0; }
    sleep 1
  done
  red "services did not become healthy in 60s"; "${COMPOSE[@]}" ps; exit 1
}

pg_exec() { docker exec -i "$PG_CONTAINER" "$@"; }

rand_hex() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

ensure_secrets() {
  SECRETS_FILE="$CACHE_DIR/secrets.env"
  if [ ! -f "$SECRETS_FILE" ]; then
    mkdir -p "$CACHE_DIR"
    printf 'LMCA_JWT_SECRET=%s\nLMCA_COOKIE_SECRET=%s\n' "$(rand_hex)" "$(rand_hex)" > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
  fi
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
}

backend_cli() {
  (
    cd "$ROOT/$BACKEND_DIR" || exit 1
    if [ ! -f .env ]; then
      export DATABASE_URL="${DATABASE_URL:-postgres://$LMCA_DB_USER:$LMCA_DB_PASSWORD@localhost:$LMCA_PG_PORT/$LMCA_DB_NAME}"
      export REDIS_URL="${REDIS_URL:-redis://localhost:$LMCA_REDIS_PORT}"
    fi
    npx medusa "$@"
  )
}

seed_admin() {
  local count
  count="$(pg_exec psql -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" -tAc 'SELECT count(*) FROM "user" WHERE deleted_at IS NULL' 2>/dev/null || true)"
  if [ -z "$count" ]; then
    red "cannot check admin users — no user table yet. Run: lmca migrate"
    return 1
  fi
  if [ "$count" != "0" ]; then
    note "admin user already exists ($count) — seed skipped"
    return 0
  fi
  note "no admin users — creating $LMCA_ADMIN_EMAIL ..."
  backend_cli user -e "$LMCA_ADMIN_EMAIL" -p "$LMCA_ADMIN_PASSWORD"
  green "admin seeded: $LMCA_ADMIN_EMAIL / $LMCA_ADMIN_PASSWORD"
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

app_pid() {
  local f="$RUN_DIR/$1.pid" pid
  [ -f "$f" ] || return 1
  pid="$(cat "$f" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}

publishable_key() {
  pg_exec psql -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" -tAc \
    "SELECT token FROM api_key WHERE type='publishable' AND revoked_at IS NULL AND deleted_at IS NULL LIMIT 1" 2>/dev/null | tr -d '[:space:]'
}

start_apps() {
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  if [ -d "$ROOT/$BACKEND_DIR" ]; then
    if port_up "$LMCA_BACKEND_PORT"; then
      note "backend:    already running on :$LMCA_BACKEND_PORT"
    else
      note "backend:    starting dev server (log: lmca logs backend)"
      (
        cd "$ROOT/$BACKEND_DIR" || exit 1
        # inject dev defaults only when the app has no .env of its own
        if [ ! -f .env ]; then
          ensure_secrets
          export DATABASE_URL="${DATABASE_URL:-postgres://$LMCA_DB_USER:$LMCA_DB_PASSWORD@localhost:$LMCA_PG_PORT/$LMCA_DB_NAME}"
          export REDIS_URL="${REDIS_URL:-redis://localhost:$LMCA_REDIS_PORT}"
          export JWT_SECRET="${JWT_SECRET:-$LMCA_JWT_SECRET}" COOKIE_SECRET="${COOKIE_SECRET:-$LMCA_COOKIE_SECRET}"
          export STORE_CORS="${STORE_CORS:-$LMCA_BASE_URL,http://localhost:$LMCA_STOREFRONT_PORT}"
          export ADMIN_CORS="${ADMIN_CORS:-$LMCA_BASE_URL,http://localhost:$LMCA_BACKEND_PORT}"
          export AUTH_CORS="${AUTH_CORS:-$LMCA_BASE_URL,http://localhost:$LMCA_STOREFRONT_PORT,http://localhost:$LMCA_BACKEND_PORT}"
        fi
        nohup npm run dev >> "$LOG_DIR/backend.log" 2>&1 &
        echo $! > "$RUN_DIR/backend.pid"
      )
    fi
  fi
  if [ -d "$ROOT/$STOREFRONT_DIR" ]; then
    if port_up "$LMCA_STOREFRONT_PORT"; then
      note "storefront: already running on :$LMCA_STOREFRONT_PORT"
    else
      key=""
      if [ ! -f "$ROOT/$STOREFRONT_DIR/.env" ]; then
        key="$(publishable_key || true)"
        if [ -z "$key" ]; then
          red "storefront: skipped — no publishable API key in the DB yet."
          note "  create one in the admin: $LMCA_BASE_URL/app → Settings → Publishable API Keys, then run: lmca restart"
          return 0
        fi
      fi
      note "storefront: starting dev server (log: lmca logs storefront)"
      (
        cd "$ROOT/$STOREFRONT_DIR" || exit 1
        if [ ! -f .env ]; then
          export MEDUSA_BACKEND_URL="${MEDUSA_BACKEND_URL:-http://localhost:$LMCA_BACKEND_PORT}"
          export NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY="${NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY:-$key}"
          # serve at the domain root through the proxy
          export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH-}"
        fi
        nohup npm run dev >> "$LOG_DIR/storefront.log" 2>&1 &
        echo $! > "$RUN_DIR/storefront.pid"
      )
    fi
  fi
}

wait_apps() {
  local app port up pid
  for app in backend storefront; do
    case "$app" in backend) port="$LMCA_BACKEND_PORT" ;; *) port="$LMCA_STOREFRONT_PORT" ;; esac
    [ -f "$RUN_DIR/$app.pid" ] || continue
    port_up "$port" && continue
    note "waiting for $app on :$port ..."
    up=0
    for _ in $(seq 1 150); do
      port_up "$port" && { up=1; break; }
      pid="$(cat "$RUN_DIR/$app.pid" 2>/dev/null)"
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if [ "$up" = "1" ]; then green "$app up on :$port"
    else red "$app did not come up — check: lmca logs $app"; fi
  done
}

stop_apps() {
  local app pid
  for app in backend storefront; do
    if pid="$(app_pid "$app")"; then
      note "stopping $app (pid $pid)"
      kill_tree "$pid"
    fi
    rm -f "$RUN_DIR/$app.pid"
  done
}

drop_and_recreate_db() {
  note "dropping and recreating database '$LMCA_DB_NAME'..."
  pg_exec psql -U "$LMCA_DB_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$LMCA_DB_NAME' AND pid <> pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS \"$LMCA_DB_NAME\";" \
    -c "CREATE DATABASE \"$LMCA_DB_NAME\" OWNER \"$LMCA_DB_USER\";"
}

cmd="${1:-help}"; shift || true
case "$cmd" in
  start|up)
    need_docker
    "${COMPOSE[@]}" up -d
    wait_healthy
    note "postgres:   postgres://$LMCA_DB_USER:$LMCA_DB_PASSWORD@localhost:$LMCA_PG_PORT/$LMCA_DB_NAME"
    note "redis:      redis://localhost:$LMCA_REDIS_PORT"
    note "storefront: $LMCA_BASE_URL            (proxy → storefront)"
    note "admin:      $LMCA_BASE_URL/app        (proxy → backend)"
    if [ "$LMCA_DOMAIN" != "localhost" ] && ! grep -q "$LMCA_DOMAIN" /etc/hosts 2>/dev/null; then
      red "missing hosts entry — run once:  echo '127.0.0.1 $LMCA_DOMAIN' | sudo tee -a /etc/hosts"
    fi
    start_apps
    wait_apps
    ;;
  stop|down)
    stop_apps
    docker_running || { note "docker is not running — nothing to stop"; exit 0; }
    "${COMPOSE[@]}" down
    note "containers and network removed (data volumes kept; Docker itself stays running)"
    ;;
  restart)
    need_docker
    stop_apps
    "${COMPOSE[@]}" down
    "${COMPOSE[@]}" up -d
    wait_healthy
    start_apps
    wait_apps
    ;;
  destroy)
    red "This DELETES the local database and redis volumes permanently."
    read -r -p "Type 'destroy' to confirm: " ans
    [ "$ans" = "destroy" ] || { note "aborted"; exit 1; }
    "${COMPOSE[@]}" down -v
    ;;
  status|ps)
    "${COMPOSE[@]}" ps
    for app in backend storefront; do
      case "$app" in backend) port="$LMCA_BACKEND_PORT" ;; *) port="$LMCA_STOREFRONT_PORT" ;; esac
      if port_up "$port"; then
        green "$app up on :$port"
      else
        note "$app down (:$port)"
      fi
    done
    ;;
  logs)
    case "${1:-}" in
      backend|storefront)
        [ -f "$LOG_DIR/$1.log" ] || { red "no log yet at $LOG_DIR/$1.log"; exit 1; }
        tail -f "$LOG_DIR/$1.log"
        ;;
      *)
        "${COMPOSE[@]}" logs -f "$@"
        ;;
    esac
    ;;
  psql)
    tty_flags=(-i); [ -t 0 ] && [ -t 1 ] && tty_flags=(-it)
    docker exec "${tty_flags[@]}" "$PG_CONTAINER" psql -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" "$@"
    ;;
  redis-cli)
    tty_flags=(-i); [ -t 0 ] && [ -t 1 ] && tty_flags=(-it)
    docker exec "${tty_flags[@]}" "$REDIS_CONTAINER" redis-cli "$@"
    ;;
  db:import)
    file="${1:-}"
    [ -n "$file" ] && [ -f "$file" ] || { red "usage: lmca import-db <dump.sql|dump.sql.gz|dump.pgcustom>"; exit 1; }
    drop_and_recreate_db
    note "importing $file ..."
    case "$file" in
      *.sql.gz) gunzip -c "$file" | pg_exec psql -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" -v ON_ERROR_STOP=0 -q ;;
      *.sql)    pg_exec psql -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" -v ON_ERROR_STOP=0 -q < "$file" ;;
      *)        pg_exec pg_restore -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" --no-owner --no-privileges < "$file" ;;
    esac
    green "import finished"
    ;;
  db:dump)
    mkdir -p "$DUMP_DIR"
    out="${1:-$DUMP_DIR/$LMCA_DB_NAME-$(date +%Y%m%d-%H%M%S).sql.gz}"
    note "dumping to $out ..."
    pg_exec pg_dump -U "$LMCA_DB_USER" -d "$LMCA_DB_NAME" | gzip > "$out"
    green "dump written: $out"
    ;;
  db:reset)
    red "This drops the '$LMCA_DB_NAME' database (containers/volumes stay)."
    read -r -p "Type 'reset' to confirm: " ans
    [ "$ans" = "reset" ] || { note "aborted"; exit 1; }
    drop_and_recreate_db
    green "empty database recreated — run 'lmca migrate' next"
    ;;
  migrate)
    note "running Medusa migrations in $BACKEND_DIR (needs npm install done at repo root)..."
    backend_cli db:migrate
    seed_admin
    ;;
  seed-admin)
    seed_admin
    ;;
  show-env)
    cat <<EOF
# add to $BACKEND_DIR/.env (create it from .env.template if missing):
DATABASE_URL=postgres://$LMCA_DB_USER:$LMCA_DB_PASSWORD@localhost:$LMCA_PG_PORT/$LMCA_DB_NAME
REDIS_URL=redis://localhost:$LMCA_REDIS_PORT
# and add $LMCA_BASE_URL to STORE_CORS, ADMIN_CORS and AUTH_CORS
# so the proxied domain ($LMCA_BASE_URL + /app) can talk to the backend
EOF
    ;;
  help|*)
    cat <<EOF
Local stack for '$LMCA_COMPOSE_PROJECT' (config: lmca.js — infra in Docker, apps on host)

  lmca init [--scripts]   scaffold lmca.js here (--scripts adds npm run aliases)
  lmca start              start Docker if needed, infra containers, then both dev servers
  lmca stop               remove containers + network (data volumes kept)
  lmca restart            recreate the containers
  lmca destroy            remove containers AND volumes (asks confirmation)
  lmca status             show container state
  lmca logs [svc]         container logs, or: lmca logs backend|storefront
  lmca psql               psql shell into the database
  lmca redis              redis-cli shell
  lmca import-db <f>      drop DB, recreate, import .sql / .sql.gz / pg_dump file
  lmca dump-db            gzip-dump the DB into node_modules/.lmca-cache/dumps/
  lmca reset-db           drop + recreate an empty DB (asks confirmation)
  lmca migrate            medusa db:migrate in $BACKEND_DIR, then seed the admin
  lmca seed-admin         create the lmca.js admin user if no admin exists yet
  lmca show-env           print DATABASE_URL/REDIS_URL lines for the backend .env
  lmca ports [--reset]    show / reallocate the closest-available port map
  lmca tunnel             Cloudflare tunnel (setup/start/quick/stop/status/logs)

  run via npx lmca, npm run lmca <cmd>, or bare lmca inside npm scripts
EOF
    ;;
esac
