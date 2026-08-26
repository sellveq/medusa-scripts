#!/usr/bin/env bash
# local stack engine behind the lma CLI; env LMA_* overrides win
set -euo pipefail

ASSETS="${LMA_ASSETS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
LIB="$ASSETS/../lib"
has_config() { [ -f "$1/lma.js" ] || [ -f "$1/lma.cjs" ]; }

usage() {
  cat <<EOF
Local stack for '${LMA_COMPOSE_PROJECT:-<project>}' (config: lma.js / lma.cjs; infra in Docker, apps on host)

  lma init [--scripts]   scaffold the config + the 'lma' npm alias here
                         (--scripts adds an alias per command, --no-scripts adds none)
  lma start              start Docker if needed, infra containers, then both dev servers
  lma stop               remove containers + network (data volumes kept)
  lma restart            recreate the containers
  lma destroy            remove containers AND volumes (asks confirmation)
  lma status             show container state
  lma logs [svc]         container logs, or: lma logs backend|storefront
  lma psql               psql shell into the database
  lma redis              redis-cli shell
  lma import-db <f>      drop DB, recreate, import .sql / .sql.gz / pg_dump file
  lma dump-db            dump the DB gzipped into .local-medusa-app/dumps/
  lma reset-db           drop + recreate an empty DB (asks confirmation)
  lma migrate            medusa db:migrate in ${BACKEND_DIR:-apps/backend}, then seed the admin
  lma seed-admin         create the configured admin if no admin exists (auto on start/migrate)
  lma admin              print the admin URL, email and password
  lma show-env           print DATABASE_URL/REDIS_URL lines for the backend .env
  lma ports [--reset]    show / reallocate the closest available port map
  lma tunnel             Cloudflare tunnel (setup/start/quick/stop/status/logs)
  lma --version          print the installed version

Flags on start/stop/restart/destroy/migrate/seed-admin and the db commands:
  -n, --dry-run          print what would happen, change nothing
  -y, --yes              skip the confirmation prompt (required when not on a tty)

  secrets, dumps and pids live in .local-medusa-app/; ports and logs in
  node_modules/.local-medusa-app-cache/ (regenerated after a clean install)
  run via npx lma, npm run lma <cmd>, or bare lma inside npm scripts
EOF
}

if [ -n "${LMA_ROOT:-}" ]; then
  ROOT="$LMA_ROOT"
else
  ROOT="$PWD"
  while ! has_config "$ROOT" && [ "$ROOT" != "/" ]; do ROOT="$(dirname "$ROOT")"; done
fi
if ! has_config "$ROOT"; then
  case "${1:-help}" in
    help|-h|--help) usage; exit 0 ;;
    *) echo "no lma.js or lma.cjs found; run 'lma init' first" >&2; exit 1 ;;
  esac
fi
COMPOSE_FILE="$ASSETS/docker-compose.yml"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '\033[36m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

# parsed only for commands that support them, so `lma psql -c` passes its own through
DRY_RUN=0
ASSUME_YES=0
ARGS=()
parse_flags() {
  ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -n|--dry-run) DRY_RUN=1 ;;
      -y|--yes|--force) ASSUME_YES=1 ;;
      --) shift; while [ "$#" -gt 0 ]; do ARGS+=("$1"); shift; done; break ;;
      *) ARGS+=("$1") ;;
    esac
    shift
  done
}

plan() { printf '\033[2m[dry-run]\033[0m %s\n' "$*"; }

# multi-command branches guard on DRY_RUN themselves
run() {
  if [ "$DRY_RUN" = "1" ]; then plan "$*"; return 0; fi
  "$@"
}

# $1 = word to type, $2 = what happens
confirm() {
  local word="$1" what="$2" ans
  red "$what"
  if [ "$DRY_RUN" = "1" ]; then plan "would ask for the word '$word' here"; return 0; fi
  if [ "$ASSUME_YES" = "1" ]; then note "confirmed by --yes"; return 0; fi
  if [ ! -t 0 ]; then
    red "refusing to continue without a terminal; pass --yes if you really mean it"
    return 1
  fi
  read -r -p "Type '$word' to confirm: " ans || ans=""
  [ "$ans" = "$word" ] || { note "aborted"; return 1; }
}

_cfg_err="$(mktemp)"
if ! _cfg="$(node -e '
try {
const root = process.argv[1];
const lib = require(process.argv[2]);
const cfg = require(process.argv[3]);
const secrets = require(process.argv[4]);
const images = require(process.argv[5]);
const c = cfg.load(root);
const p = (c.services || {}).postgres || {};
const r = (c.services || {}).redis || {};
const x = c.proxy || {};
const a = c.apps || {};
const ad = c.admin || {};
const proj = cfg.project(root, c);
const img = images.all(c, (m) => console.error("image pin warning: " + m));
const sec = secrets.ensure(root);
const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
console.log([
  `_C_PROJECT=${q(proj)}`,
  `_C_PROJECT_ID=${q(lib.projectId(root, c))}`,
  `_C_STATE_DIR=${q(require("node:path").dirname(sec.file))}`,
  `_C_CACHE_DIR=${q(require(process.argv[6]).cacheDir(root))}`,
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
  `_C_ADMIN_PASSWORD=${q(ad.password || "")}`,
  `_C_POSTGRES_IMAGE=${q(img.postgres)}`,
  `_C_REDIS_IMAGE=${q(img.redis)}`,
  `_C_PROXY_IMAGE=${q(img.proxy)}`,
  `_S_ADMIN_PASSWORD=${q(sec.values.LMA_ADMIN_PASSWORD)}`,
  `_S_JWT_SECRET=${q(sec.values.LMA_JWT_SECRET)}`,
  `_S_COOKIE_SECRET=${q(sec.values.LMA_COOKIE_SECRET)}`,
].join("\n"))
} catch (e) { console.error(e.message); process.exit(1) }
' "$ROOT" "$LIB/ports.js" "$LIB/config.js" "$LIB/secrets.js" "$LIB/images.js" "$LIB/paths.js" 2>"$_cfg_err")"; then
  red "failed to read the lma config in $ROOT:"
  cat "$_cfg_err" >&2
  rm -f "$_cfg_err"
  exit 1
fi
[ -s "$_cfg_err" ] && cat "$_cfg_err" >&2
rm -f "$_cfg_err"
# q() single-quotes every value above; an unquoted one would execute
eval "$_cfg"

STATE_DIR="$_C_STATE_DIR"
CACHE_DIR="$_C_CACHE_DIR"
DUMP_DIR="$STATE_DIR/dumps"
RUN_DIR="$STATE_DIR/run"
LOCK_DIR="$STATE_DIR/lock"
LOG_DIR="$CACHE_DIR/logs"

# ports, plus the two values derived from them: allowed hosts and CORS origins
_C_ALLOWED_HOSTS=""
_CORS_STORE=""; _CORS_ADMIN=""; _CORS_AUTH=""
_ports_err="$(mktemp)"
if _pmap="$(node -e '
(async () => {
  const root = process.argv[2]
  const { ports } = await require(process.argv[1]).resolve(root)
  const cfg = require(process.argv[3])
  const hosts = require(process.argv[4])
  const cors = require(process.argv[5])
  const envfile = require(process.argv[6])
  const c = cfg.load(root)
  const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27"
  // app keys may hold chars that are invalid in a shell variable name (admin-ui)
  const shellName = (k) => k.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
  const out = Object.entries(ports).map(([k, v]) => `_P_${shellName(k)}=${v}`)
  const inherited = hosts.merge(process.env[hosts.ENV_VAR], hosts.adminAllowedHosts(c))
  out.push(`_C_ALLOWED_HOSTS=${q(inherited.join(","))}`)
  // merge with the backend .env so lma only ever adds origins
  const dir = ((c.apps || {}).backend || {}).dir || "apps/backend"
  const appEnv = envfile.read(require("node:path").join(root, dir, ".env"))
  const merged = cors.resolve(c, ports, { env: process.env, appEnv })
  out.push(`_CORS_STORE=${q(merged.STORE_CORS)}`)
  out.push(`_CORS_ADMIN=${q(merged.ADMIN_CORS)}`)
  out.push(`_CORS_AUTH=${q(merged.AUTH_CORS)}`)
  process.stdout.write(out.join("\n") + "\n")
})().catch((e) => { console.error(e.message); process.exit(1) })
' "$LIB/ports.js" "$ROOT" "$LIB/config.js" "$LIB/hosts.js" "$LIB/cors.js" "$LIB/envfile.js" 2>"$_ports_err")"; then
  eval "$_pmap"
else
  red "port allocation failed ($(cat "$_ports_err")); using the preferred ports from the config"
fi
rm -f "$_ports_err"

export LMA_COMPOSE_PROJECT="${LMA_COMPOSE_PROJECT:-$_C_PROJECT${_C_PROJECT_ID:+-$_C_PROJECT_ID}}"
export LMA_PG_PORT="${LMA_PG_PORT:-${_P_POSTGRES:-$_C_PG_PORT}}"
export LMA_DB_USER="${LMA_DB_USER:-$_C_DB_USER}"
export LMA_DB_PASSWORD="${LMA_DB_PASSWORD:-$_C_DB_PASSWORD}"
export LMA_DB_NAME="${LMA_DB_NAME:-$_C_DB_NAME}"
export LMA_REDIS_PORT="${LMA_REDIS_PORT:-${_P_REDIS:-$_C_REDIS_PORT}}"
export LMA_HTTP_PORT="${LMA_HTTP_PORT:-${_P_HTTP:-$_C_HTTP_PORT}}"
export LMA_BACKEND_PORT="${LMA_BACKEND_PORT:-${_P_BACKEND:-$_C_BACKEND_PORT}}"
export LMA_STOREFRONT_PORT="${LMA_STOREFRONT_PORT:-${_P_STOREFRONT:-$_C_STOREFRONT_PORT}}"
export LMA_POSTGRES_IMAGE="${LMA_POSTGRES_IMAGE:-$_C_POSTGRES_IMAGE}"
export LMA_REDIS_IMAGE="${LMA_REDIS_IMAGE:-$_C_REDIS_IMAGE}"
export LMA_PROXY_IMAGE="${LMA_PROXY_IMAGE:-$_C_PROXY_IMAGE}"
LMA_DOMAIN="${LMA_DOMAIN:-$_C_DOMAIN}"
BACKEND_DIR="${LMA_BACKEND_DIR:-$_C_BACKEND_DIR}"
LMA_ALLOWED_HOSTS="$_C_ALLOWED_HOSTS"
LMA_ADMIN_EMAIL="${LMA_ADMIN_EMAIL:-$_C_ADMIN_EMAIL}"
# env > config > secrets.env
if [ -n "${LMA_ADMIN_PASSWORD:-}" ]; then ADMIN_PASSWORD_SOURCE="env LMA_ADMIN_PASSWORD"
elif [ -n "$_C_ADMIN_PASSWORD" ]; then ADMIN_PASSWORD_SOURCE="admin.password in the config"
else ADMIN_PASSWORD_SOURCE=".local-medusa-app/secrets.env"; fi
LMA_ADMIN_PASSWORD="${LMA_ADMIN_PASSWORD:-${_C_ADMIN_PASSWORD:-$_S_ADMIN_PASSWORD}}"
LMA_JWT_SECRET="$_S_JWT_SECRET"
LMA_COOKIE_SECRET="$_S_COOKIE_SECRET"
if [ "$LMA_HTTP_PORT" = "80" ]; then LMA_BASE_URL="http://$LMA_DOMAIN"; else LMA_BASE_URL="http://$LMA_DOMAIN:$LMA_HTTP_PORT"; fi
PG_CONTAINER="$LMA_COMPOSE_PROJECT-postgres"
REDIS_CONTAINER="$LMA_COMPOSE_PROJECT-redis"
STOREFRONT_DIR="${LMA_STOREFRONT_DIR:-$_C_STOREFRONT_DIR}"

COMPOSE=(docker compose -f "$COMPOSE_FILE")

weak_admin_password() {
  node -e 'process.exit(require(process.argv[1]).isWeak(process.argv[2]) ? 0 : 1)' \
    "$LIB/secrets.js" "$LMA_ADMIN_PASSWORD"
}

warn_weak_admin() {
  weak_admin_password || return 0
  red "the admin password from $ADMIN_PASSWORD_SOURCE is guessable."
  note "  fine while the stack is only on localhost; never expose it with 'lma tunnel'."
}

# one mutating lma per project; racing starts produce half-created containers
LOCK_HELD=0
release_lock() { [ "$LOCK_HELD" = "1" ] && rm -rf "$LOCK_DIR"; return 0; }

acquire_lock() {
  local what="$1" owner owner_cmd tries=0
  mkdir -p "$STATE_DIR"
  while [ "$tries" -lt 3 ]; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$LOCK_DIR/pid"
      printf '%s\n' "$what" > "$LOCK_DIR/cmd"
      proc_started "$$" > "$LOCK_DIR/id"
      LOCK_HELD=1
      trap release_lock EXIT
      trap 'release_lock; exit 130' INT TERM
      return 0
    fi
    owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    owner_cmd="$(cat "$LOCK_DIR/cmd" 2>/dev/null || true)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null && same_process "$owner" "$LOCK_DIR/id" '*local.sh*'; then
      red "'lma ${owner_cmd:-?}' (pid $owner) is already working on this project."
      note "  wait for it, or remove $LOCK_DIR if you are sure it is gone."
      exit 1
    fi
    rm -rf "$LOCK_DIR"
    tries=$((tries + 1))
  done
  red "could not take the project lock at $LOCK_DIR"; exit 1
}

need_docker() {
  command -v docker >/dev/null || { red "docker is not installed / not on PATH"; exit 1; }
  if ! docker info >/dev/null 2>&1; then
    if [ "$ASSUME_YES" != "1" ]; then
      [ -t 0 ] || { red "Docker is not running, and there is no terminal to ask on. Start it, or pass --yes."; exit 1; }
      read -r -p "Docker is not running. Start Docker Desktop? [y/N] " ans || ans=""
      case "$ans" in y|Y|yes|YES) ;; *) note "aborted"; exit 1 ;; esac
    fi
    if [ "$(uname)" = "Darwin" ]; then
      note "starting Docker Desktop..."
      open -g -a Docker || { red "could not launch Docker Desktop"; exit 1; }
    else
      red "start the docker daemon first (e.g. systemctl start docker)"; exit 1
    fi
    local start_ts=$SECONDS
    while [ $((SECONDS - start_ts)) -lt 120 ]; do
      docker info >/dev/null 2>&1 && { green "docker is up"; return 0; }
      sleep 2
    done
    red "docker did not become ready in 120s; open Docker Desktop and check it manually"; exit 1
  fi
}

docker_running() { docker info >/dev/null 2>&1; }

wait_healthy() {
  note "waiting for containers to become healthy..."
  local containers=("$PG_CONTAINER" "$REDIS_CONTAINER" "$LMA_COMPOSE_PROJECT-proxy")
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

db_exists() {
  [ "$(pg_exec psql -U "$LMA_DB_USER" -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$LMA_DB_NAME'" 2>/dev/null || true)" = "1" ]
}

db_table_count() {
  pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null | tr -d '[:space:]'
}

backend_cli() {
  (
    cd "$ROOT/$BACKEND_DIR" || exit 1
    if [ ! -f .env ]; then
      export DATABASE_URL="${DATABASE_URL:-postgres://$LMA_DB_USER:$LMA_DB_PASSWORD@localhost:$LMA_PG_PORT/$LMA_DB_NAME}"
      export REDIS_URL="${REDIS_URL:-redis://localhost:$LMA_REDIS_PORT}"
    fi
    npx medusa "$@"
  )
}

# sql-quote: the email comes from the config
sql_str() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

admin_count() {
  pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -tAc \
    'SELECT count(*) FROM "user" WHERE deleted_at IS NULL' 2>/dev/null | tr -d '[:space:]'
}

admin_exists() {
  [ "$(pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -tAc \
    "SELECT count(*) FROM \"user\" WHERE deleted_at IS NULL AND lower(email) = lower($(sql_str "$LMA_ADMIN_EMAIL"))" \
    2>/dev/null | tr -d '[:space:]')" = "1" ]
}

other_admins() {
  pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -tAc \
    "SELECT email FROM \"user\" WHERE deleted_at IS NULL AND lower(email) <> lower($(sql_str "$LMA_ADMIN_EMAIL")) ORDER BY created_at LIMIT 5" \
    2>/dev/null | tr -d '\r' | tr '\n' ' '
}

SEEDED_FILE_NAME="seeded-admin"

# seed the configured account when missing, not merely when the table is empty
seed_admin() {
  local mode="${1:-manual}" count
  count="$(admin_count)"
  if [ -z "$count" ]; then
    [ "$mode" = "auto" ] && return 0   # DB not migrated yet; nothing to seed
    red "cannot check admin users; no user table yet. Run: lma migrate"
    return 1
  fi
  if admin_exists; then
    [ "$mode" = "auto" ] || note "$LMA_ADMIN_EMAIL already exists; seed skipped"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then plan "create admin $LMA_ADMIN_EMAIL"; return 0; fi
  if [ "$count" != "0" ]; then
    note "the database has $count admin(s), but not $LMA_ADMIN_EMAIL; creating it"
  else
    note "no admin users; creating $LMA_ADMIN_EMAIL ..."
  fi
  if ! backend_cli user -e "$LMA_ADMIN_EMAIL" -p "$LMA_ADMIN_PASSWORD"; then
    red "admin seed failed; run 'lma seed-admin' after fixing the backend install"
    [ "$mode" = "auto" ] && return 0
    return 1
  fi
  printf '%s\n' "$LMA_ADMIN_EMAIL" > "$STATE_DIR/$SEEDED_FILE_NAME"
  green "admin seeded: $LMA_ADMIN_EMAIL / $LMA_ADMIN_PASSWORD"
  dim  "  password from $ADMIN_PASSWORD_SOURCE; print it again with: lma admin"
  warn_weak_admin
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

# pids get reused: the start time is what makes a recorded pid ours
proc_started() { ps -p "$1" -o lstart= 2>/dev/null | tr -s ' '; }

record_pid() { # $1 = name, $2 = pid; fails when it is already gone
  local started
  started="$(proc_started "$2")"
  [ -n "$started" ] || { rm -f "$RUN_DIR/$1.pid" "$RUN_DIR/$1.id"; return 1; }
  printf '%s\n' "$2" > "$RUN_DIR/$1.pid"
  printf '%s\n' "$started" > "$RUN_DIR/$1.id"
}

same_process() { # $1 = pid, $2 = recorded start time file, $3 = command pattern when nothing was recorded
  if [ -s "$2" ]; then
    [ "$(cat "$2" 2>/dev/null)" = "$(proc_started "$1")" ]
  else
    # shellcheck disable=SC2254
    case "$(ps -p "$1" -o command= 2>/dev/null)" in $3) return 0 ;; *) return 1 ;; esac
  fi
}

app_pid() {
  local f="$RUN_DIR/$1.pid" pid
  [ -f "$f" ] || return 1
  pid="$(cat "$f" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  same_process "$pid" "$RUN_DIR/$1.id" '*npm*run*dev*' || return 1
  printf '%s' "$pid"
}

# only ever call this with a pid app_pid vouched for
kill_tree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}

publishable_key() {
  pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -tAc \
    "SELECT token FROM api_key WHERE type='publishable' AND revoked_at IS NULL AND deleted_at IS NULL LIMIT 1" 2>/dev/null | tr -d '[:space:]'
}

start_apps() {
  if [ "$DRY_RUN" = "1" ]; then
    [ -n "$LMA_ALLOWED_HOSTS" ] && plan "__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS=$LMA_ALLOWED_HOSTS"
    plan "STORE_CORS=$_CORS_STORE"
    plan "ADMIN_CORS=$_CORS_ADMIN"
    plan "AUTH_CORS=$_CORS_AUTH"
    [ -d "$ROOT/$BACKEND_DIR" ] && plan "cd $BACKEND_DIR && npm run dev (PORT=$LMA_BACKEND_PORT)"
    [ -d "$ROOT/$STOREFRONT_DIR" ] && plan "cd $STOREFRONT_DIR && npm run dev (PORT=$LMA_STOREFRONT_PORT)"
    return 0
  fi
  mkdir -p "$LOG_DIR" "$RUN_DIR"
  if [ -d "$ROOT/$BACKEND_DIR" ]; then
    if port_up "$LMA_BACKEND_PORT"; then
      note "backend:    already running on :$LMA_BACKEND_PORT"
    else
      note "backend:    starting dev server"
      (
        cd "$ROOT/$BACKEND_DIR" || exit 1
        export PORT="${PORT:-$LMA_BACKEND_PORT}"
        # set even when the app has a .env: dotenv does not override an export
        [ -n "$LMA_ALLOWED_HOSTS" ] && export __MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS="$LMA_ALLOWED_HOSTS"
        # merged with the app's .env, never replacing it
        export STORE_CORS="$_CORS_STORE" ADMIN_CORS="$_CORS_ADMIN" AUTH_CORS="$_CORS_AUTH"
        # inject dev defaults only when the app has no .env of its own
        if [ ! -f .env ]; then
          export DATABASE_URL="${DATABASE_URL:-postgres://$LMA_DB_USER:$LMA_DB_PASSWORD@localhost:$LMA_PG_PORT/$LMA_DB_NAME}"
          export REDIS_URL="${REDIS_URL:-redis://localhost:$LMA_REDIS_PORT}"
          export JWT_SECRET="${JWT_SECRET:-$LMA_JWT_SECRET}" COOKIE_SECRET="${COOKIE_SECRET:-$LMA_COOKIE_SECRET}"
        fi
        nohup npm run dev >> "$LOG_DIR/backend.log" 2>&1 &
        record_pid backend "$!" || red "backend: exited immediately; check: lma logs backend"
      )
    fi
  fi
  if [ -d "$ROOT/$STOREFRONT_DIR" ]; then
    if port_up "$LMA_STOREFRONT_PORT"; then
      note "storefront: already running on :$LMA_STOREFRONT_PORT"
    else
      key=""
      if [ ! -f "$ROOT/$STOREFRONT_DIR/.env" ]; then
        key="$(publishable_key || true)"
        if [ -z "$key" ]; then
          red "storefront: skipped; no publishable API key; create one at $LMA_BASE_URL/app → Settings → Publishable API Keys, then: lma restart"
          return 0
        fi
      fi
      note "storefront: starting dev server"
      (
        cd "$ROOT/$STOREFRONT_DIR" || exit 1
        export PORT="${PORT:-$LMA_STOREFRONT_PORT}"
        if [ ! -f .env ]; then
          export MEDUSA_BACKEND_URL="${MEDUSA_BACKEND_URL:-http://localhost:$LMA_BACKEND_PORT}"
          export NEXT_PUBLIC_MEDUSA_BACKEND_URL="${NEXT_PUBLIC_MEDUSA_BACKEND_URL:-http://localhost:$LMA_BACKEND_PORT}"
          export NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY="${NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY:-$key}"
          export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH-}"
        fi
        nohup npm run dev >> "$LOG_DIR/storefront.log" 2>&1 &
        record_pid storefront "$!" || red "storefront: exited immediately; check: lma logs storefront"
      )
    fi
  fi
}

wait_apps() {
  [ "$DRY_RUN" = "1" ] && return 0
  local app port up pid
  for app in backend storefront; do
    case "$app" in backend) port="$LMA_BACKEND_PORT" ;; *) port="$LMA_STOREFRONT_PORT" ;; esac
    [ -f "$RUN_DIR/$app.pid" ] || continue
    port_up "$port" && continue
    note "waiting for $app on :$port ..."
    up=0
    for _ in $(seq 1 150); do
      port_up "$port" && { up=1; break; }
      app_pid "$app" >/dev/null || break
      sleep 1
    done
    if [ "$up" = "1" ]; then green "$app up on :$port"
    else red "$app did not come up; check: lma logs $app"; fi
  done
}

stop_apps() {
  local app pid stale
  for app in backend storefront; do
    if pid="$(app_pid "$app")"; then
      if [ "$DRY_RUN" = "1" ]; then plan "kill $app (pid $pid) and its children"; continue; fi
      note "stopping $app (pid $pid)"
      kill_tree "$pid"
    else
      stale="$(cat "$RUN_DIR/$app.pid" 2>/dev/null || true)"
      if [ -n "$stale" ] && kill -0 "$stale" 2>/dev/null; then
        red "pid $stale is not the $app we started; leaving it alone"
      fi
    fi
    [ "$DRY_RUN" = "1" ] || rm -f "$RUN_DIR/$app.pid" "$RUN_DIR/$app.id"
  done
}

drop_and_recreate_db() {
  if [ "$DRY_RUN" = "1" ]; then
    plan "DROP DATABASE \"$LMA_DB_NAME\" and recreate it empty (owner $LMA_DB_USER)"
    return 0
  fi
  note "dropping and recreating database '$LMA_DB_NAME'..."
  pg_exec psql -U "$LMA_DB_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$LMA_DB_NAME' AND pid <> pg_backend_pid();" \
    -c "DROP DATABASE IF EXISTS \"$LMA_DB_NAME\";" \
    -c "CREATE DATABASE \"$LMA_DB_NAME\" OWNER \"$LMA_DB_USER\";"
}

# only prompt when there is data to lose
confirm_db_loss() {
  local word="$1" tables
  [ "$DRY_RUN" = "1" ] && return 0
  docker_running || return 0
  db_exists || return 0
  tables="$(db_table_count)"
  [ -n "$tables" ] && [ "$tables" != "0" ] || return 0
  confirm "$word" "This destroys the '$LMA_DB_NAME' database ($tables tables) on localhost:$LMA_PG_PORT."
}

cmd="${1:-help}"; shift || true

case "$cmd" in
  start|up|stop|down|restart|destroy|db:import|db:dump|db:reset|migrate|seed-admin)
    parse_flags "$@"
    set -- ${ARGS[@]+"${ARGS[@]}"}
    ;;
esac

case "$cmd" in
  start|up|stop|down|restart|destroy|db:import|db:dump|db:reset|migrate|seed-admin)
    [ "$DRY_RUN" = "1" ] || acquire_lock "$cmd"
    ;;
esac

case "$cmd" in
  start|up)
    [ "$DRY_RUN" = "1" ] || need_docker
    run "${COMPOSE[@]}" up -d
    [ "$DRY_RUN" = "1" ] || wait_healthy
    note "postgres:   localhost:$LMA_PG_PORT/$LMA_DB_NAME  (url: lma show-env)"
    note "redis:      redis://localhost:$LMA_REDIS_PORT"
    note "storefront: $LMA_BASE_URL"
    note "admin:      $LMA_BASE_URL/app  ($LMA_ADMIN_EMAIL — password: lma admin)"
    if [ "$LMA_DOMAIN" != "localhost" ] && ! grep -q "$LMA_DOMAIN" /etc/hosts 2>/dev/null; then
      red "missing hosts entry; run once:  echo '127.0.0.1 $LMA_DOMAIN' | sudo tee -a /etc/hosts"
    fi
    [ "$DRY_RUN" = "1" ] || seed_admin auto
    start_apps
    wait_apps
    ;;
  stop|down)
    stop_apps
    if [ "$DRY_RUN" != "1" ] && ! docker_running; then
      note "docker is not running; nothing to stop"; exit 0
    fi
    run "${COMPOSE[@]}" down
    note "containers and network removed (volumes kept)"
    ;;
  restart)
    [ "$DRY_RUN" = "1" ] || need_docker
    stop_apps
    run "${COMPOSE[@]}" down
    run "${COMPOSE[@]}" up -d
    [ "$DRY_RUN" = "1" ] || wait_healthy
    start_apps
    wait_apps
    ;;
  destroy)
    confirm destroy "This DELETES the local database and redis volumes of '$LMA_COMPOSE_PROJECT' permanently." || exit 1
    stop_apps
    run "${COMPOSE[@]}" down -v
    [ "$DRY_RUN" = "1" ] || green "containers, network and volumes removed"
    ;;
  status|ps)
    "${COMPOSE[@]}" ps
    for app in backend storefront; do
      case "$app" in backend) port="$LMA_BACKEND_PORT" ;; *) port="$LMA_STOREFRONT_PORT" ;; esac
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
    docker exec "${tty_flags[@]}" "$PG_CONTAINER" psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" "$@"
    ;;
  redis-cli)
    tty_flags=(-i); [ -t 0 ] && [ -t 1 ] && tty_flags=(-it)
    docker exec "${tty_flags[@]}" "$REDIS_CONTAINER" redis-cli "$@"
    ;;
  db:import)
    file="${1:-}"
    [ -n "$file" ] && [ -f "$file" ] || { red "usage: lma import-db <dump.sql|dump.sql.gz|dump.pgcustom> [--yes]"; exit 1; }
    confirm_db_loss import || exit 1
    if [ "$DRY_RUN" = "1" ]; then
      drop_and_recreate_db
      plan "import $file into '$LMA_DB_NAME'"
      exit 0
    fi
    drop_and_recreate_db
    note "importing $file ..."
    # ON_ERROR_STOP=0: one bad statement must not abandon the restore
    mkdir -p "$STATE_DIR"
    import_log="$STATE_DIR/last-import.log"
    import_rc=0
    case "$file" in
      *.sql.gz) gunzip -c "$file" | pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -v ON_ERROR_STOP=0 -q 2>"$import_log" || import_rc=$? ;;
      *.sql)    pg_exec psql -U "$LMA_DB_USER" -d "$LMA_DB_NAME" -v ON_ERROR_STOP=0 -q < "$file" 2>"$import_log" || import_rc=$? ;;
      *)        pg_exec pg_restore -U "$LMA_DB_USER" -d "$LMA_DB_NAME" --no-owner --no-privileges < "$file" 2>"$import_log" || import_rc=$? ;;
    esac
    import_errors="$(grep -cE 'ERROR:|error:' "$import_log" 2>/dev/null || true)"
    import_errors="${import_errors:-0}"
    if [ "$import_rc" != "0" ] || [ "$import_errors" != "0" ]; then
      red "import completed with $import_errors error(s); the database may be incomplete"
      grep -E 'ERROR:|error:' "$import_log" 2>/dev/null | head -5 | sed 's/^/    /' >&2 || true
      if [ "$import_errors" -gt 5 ]; then note "    ... and $((import_errors - 5)) more; full log: $import_log"
      else note "    log: $import_log"; fi
      exit 1
    fi
    rm -f "$import_log"
    green "import finished cleanly"
    ;;
  db:dump)
    out="${1:-$DUMP_DIR/$LMA_DB_NAME-$(date +%Y%m%d-%H%M%S).sql.gz}"
    if [ "$DRY_RUN" = "1" ]; then plan "pg_dump '$LMA_DB_NAME' | gzip > $out"; exit 0; fi
    mkdir -p "$DUMP_DIR"
    note "dumping to $out ..."
    pg_exec pg_dump -U "$LMA_DB_USER" -d "$LMA_DB_NAME" | gzip > "$out"
    green "dump written: $out"
    ;;
  db:reset)
    confirm_db_loss reset || exit 1
    drop_and_recreate_db
    [ "$DRY_RUN" = "1" ] || green "empty database recreated"
    ;;
  migrate)
    if [ "$DRY_RUN" = "1" ]; then
      plan "cd $BACKEND_DIR && npx medusa db:migrate"
      plan "seed the admin if the DB has none"
      exit 0
    fi
    note "running Medusa migrations in $BACKEND_DIR..."
    backend_cli db:migrate
    seed_admin
    ;;
  seed-admin)
    seed_admin manual
    ;;
  admin)
    note "admin:    $LMA_BASE_URL/app"
    note "email:    $LMA_ADMIN_EMAIL"
    note "password: $LMA_ADMIN_PASSWORD"
    dim  "          from $ADMIN_PASSWORD_SOURCE"
    # these are the credentials lma would seed; check they exist before saying so
    if ! docker_running || [ -z "$(admin_count)" ]; then
      dim  "          (database not reachable; not verified)"
    elif admin_exists; then
      if [ "$(cat "$STATE_DIR/$SEEDED_FILE_NAME" 2>/dev/null || true)" = "$LMA_ADMIN_EMAIL" ]; then
        green "this account exists and lma created it with this password"
      else
        note "this account exists, but lma did not create it;"
        note "  the password above is only right if it was set with it"
      fi
    else
      red "no user '$LMA_ADMIN_EMAIL' in the database, so this password logs in nowhere."
      note "  create it with:  lma seed-admin"
      admins="$(other_admins)"
      [ -n "$admins" ] && note "  existing admin accounts: $admins"
    fi
    warn_weak_admin
    ;;
  show-env)
    cat <<EOF
# add to $BACKEND_DIR/.env
DATABASE_URL=postgres://$LMA_DB_USER:$LMA_DB_PASSWORD@localhost:$LMA_PG_PORT/$LMA_DB_NAME
REDIS_URL=redis://localhost:$LMA_REDIS_PORT

# set on every 'lma start'; CORS is merged with your .env, so copying is not needed.
EOF
    [ -n "$LMA_ALLOWED_HOSTS" ] && printf '__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS=%s\n' "$LMA_ALLOWED_HOSTS"
    cat <<EOF
STORE_CORS=$_CORS_STORE
ADMIN_CORS=$_CORS_ADMIN
AUTH_CORS=$_CORS_AUTH
EOF
    ;;
  help|*)
    usage
    ;;
esac
