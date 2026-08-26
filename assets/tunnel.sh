#!/usr/bin/env bash
# Cloudflare tunnel for the local stack; config from lma.js / lma.cjs
#
#   lma tunnel setup | start [app...] | quick [app] | stop | restart |
#              status | logs [-f]
#
#   -y, --yes       accept the exposure warning without a prompt
#   -n, --dry-run   print what would be published, start nothing
#
# setup and start ask for any missing hostname and save it to the config.
#
# start/quick publish local ports on the public internet. The backend origin
# also carries the Admin dashboard (/app), /auth and every store route. Never
# point a tunnel at production data or production credentials.
#
set -euo pipefail

has_config() { [ -f "$1/lma.js" ] || [ -f "$1/lma.cjs" ]; }
if [ -n "${LMA_ROOT:-}" ]; then
  ROOT_DIR="$LMA_ROOT"
else
  ROOT_DIR="$PWD"
  while ! has_config "$ROOT_DIR" && [ "$ROOT_DIR" != "/" ]; do ROOT_DIR="$(dirname "$ROOT_DIR")"; done
  has_config "$ROOT_DIR" || { echo "no lma.js or lma.cjs found; run 'lma init' first" >&2; exit 1; }
fi
_LIBDIR="${LMA_ASSETS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/../lib"

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; dim=$'\033[2m'; off=$'\033[0m'
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$green" "$off" "$*"; }
warn() { printf '%s!%s %s\n' "$yellow" "$off" "$*" >&2; }
die()  { printf '%s✖%s %s\n' "$red" "$off" "$*" >&2; exit 1; }
plan() { printf '%s[dry-run]%s %s\n' "$dim" "$off" "$*"; }

# one config read; re-run after a hostname is saved
read_config() {
    local err out
    err="$(mktemp)"
    if ! out="$(node -e '
(async () => {
  const root = process.argv[1];
  const cfg = require(process.argv[2]);
  const lib = require(process.argv[3]);
  const secrets = require(process.argv[4]);
  const c = cfg.load(root);
  const { ports } = await lib.resolve(root);
  const t = c.tunnel || {};
  const hosts = t.hostnames || {};
  const rows = [];
  for (const k of Object.keys(c.apps || {})) {
    if (ports[k]) rows.push([k, ports[k], hosts[k] || ""].join("\t"));
  }
  const sec = secrets.ensure(root);
  const admin = process.env.LMA_ADMIN_PASSWORD || (c.admin || {}).password || sec.values.LMA_ADMIN_PASSWORD;
  const q = (v) => "\x27" + String(v).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  process.stdout.write([
    `_T_STATE_DIR=${q(require("node:path").dirname(sec.file))}`,
    `_T_CFG_NAME=${q(require("node:path").basename(cfg.configPath(root)))}`,
    `_T_NAME=${q(t.name || cfg.project(root, c))}`,
    `_T_METRICS_PORT=${q(t.metricsPort || 20000 + (lib.projectId(root, c) % 10000))}`,
    `_T_BACKEND_PORT=${q(ports.backend || "")}`,
    `_T_ADMIN_WEAK=${q(secrets.isWeak(admin) ? 1 : 0)}`,
    `_T_APPS=${q(rows.join("\n"))}`,
  ].join("\n") + "\n");
})().catch((e) => { console.error(e.message); process.exit(1) })
' "$ROOT_DIR" "$_LIBDIR/config.js" "$_LIBDIR/ports.js" "$_LIBDIR/secrets.js" 2>"$err")"; then
        printf '%s✖%s failed to read the lma config in %s:\n' "$red" "$off" "$ROOT_DIR" >&2
        cat "$err" >&2
        rm -f "$err"
        exit 1
    fi
    rm -f "$err"
    # q() single-quotes every value above; an unquoted one would execute
    eval "$out"
}
read_config

TUNNEL_DIR="$_T_STATE_DIR/tunnel"
mkdir -p "$TUNNEL_DIR"
ENV_FILE="$TUNNEL_DIR/tunnel.env"
CONFIG_FILE="$TUNNEL_DIR/config.yml"
PID_FILE="$TUNNEL_DIR/cloudflared.pid"
LOG_FILE="$TUNNEL_DIR/cloudflared.log"
MODE_FILE="$TUNNEL_DIR/mode"
URL_FILE="$TUNNEL_DIR/quick.url"
ACTIVE_FILE="$TUNNEL_DIR/active"
ACK_FILE="$TUNNEL_DIR/exposure-ack"

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

TUNNEL_NAME="${TUNNEL_NAME:-$_T_NAME}"
CREDS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/local-medusa-app/tunnels"
CREDS_FILE="$CREDS_DIR/$TUNNEL_NAME.json"
# per project so tunnels can coexist
METRICS_ADDR="${METRICS_ADDR:-127.0.0.1:$_T_METRICS_PORT}"
READY_TIMEOUT="${READY_TIMEOUT:-30}"

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

# rows of "app<TAB>port<TAB>public"; public is empty until a hostname is configured
app_map() { [ -n "$_T_APPS" ] && printf '%s\n' "$_T_APPS"; return 0; }

# named publishes only what has a hostname; quick needs the port alone
named_map() { app_map | awk -F'\t' '$3 != ""'; }
mode_map() { if [ "$1" = "quick" ]; then app_map; else named_map; fi; }

app_port() { app_map | awk -F'\t' -v a="$1" '$1 == a { print $2; exit }'; }

# a name cloudflare can resolve: dotted, never a bare address
valid_host() {
    printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || return 1
    printf '%s' "$1" | grep -Eq '\.[0-9]+$' && return 1
    return 0
}

save_hostnames() { # $@ = app=hostname
    local err; err="$(mktemp)"
    if node -e '
      const edit = require(process.argv[2]);
      const map = {};
      for (const pair of process.argv.slice(3)) {
        const i = pair.indexOf("=");
        map[pair.slice(0, i)] = pair.slice(i + 1);
      }
      edit.setHostnames(process.argv[1], map);
    ' "$ROOT_DIR" "$_LIBDIR/confedit.js" "$@" 2>"$err"; then
        rm -f "$err"
        ok "Saved to $_T_CFG_NAME"
    else
        cat "$err" >&2
        rm -f "$err"
        die "could not save the hostnames; add tunnel.hostnames to $_T_CFG_NAME yourself"
    fi
}

# ask once, then keep the answers in the config
ensure_hostnames() { # $@ = selection
    local app port public missing=() pairs=() ans
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        selected_has "$app" "$@" || continue
        [ -n "$public" ] || missing+=("$app")
    done < <(app_map)
    [ "${#missing[@]}" -eq 0 ] && return 0

    if [ "$DRY_RUN" = "1" ]; then
        plan "ask for a public hostname for ${missing[*]}, and save it to $_T_CFG_NAME"
        return 0
    fi

    info ""
    info "${dim}A hostname in your Cloudflare zone, saved to $_T_CFG_NAME. Blank skips the app.${off}"
    for app in "${missing[@]}"; do
        while :; do
            printf '  %s hostname (e.g. %s.example.com): ' "$app" "$app" >&2
            # read trims the ends; an inner space survives to be refused below
            if [ -t 0 ]; then read -r ans || ans=""
            else read -r -t "${LMA_PROMPT_TIMEOUT:-10}" ans || ans=""; printf '\n' >&2; fi
            ans="${ans#http://}"; ans="${ans#https://}"; ans="${ans%%/*}"
            ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
            [ -n "$ans" ] || break
            if valid_host "$ans"; then pairs+=("$app=$ans"); break; fi
            warn "  '$ans' is not a domain name"
        done
    done
    [ "${#pairs[@]}" -eq 0 ] && return 0
    save_hostnames "${pairs[@]}"
    read_config
}

need_cloudflared() {
    command -v cloudflared >/dev/null 2>&1 \
        || die "cloudflared not found. Install it with: brew install cloudflared"
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

# pids get reused: it must still be a cloudflared on this project's metrics port
our_cloudflared() { # $1 = pid
    local cmd
    cmd="$(ps -p "$1" -o command= 2>/dev/null || true)"
    case "$cmd" in *cloudflared*) ;; *) return 1 ;; esac
    case "$cmd" in *"$METRICS_ADDR"*) return 0 ;; *) return 1 ;; esac
}

tunnel_pid() {
    [ -f "$PID_FILE" ] || return 1
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" >/dev/null 2>&1 || return 1
    our_cloudflared "$pid" || return 1
    printf '%s' "$pid"
}

require_setup() {
    if [ ! -f "$CREDS_FILE" ] && [ -f "$TUNNEL_DIR/credentials.json" ]; then
        mkdir -p "$CREDS_DIR"
        cp "$TUNNEL_DIR/credentials.json" "$CREDS_FILE"
        chmod 600 "$CREDS_FILE" 2>/dev/null || true
        ok "Moved tunnel credentials to $CREDS_FILE"
    fi
    [ -f "$CREDS_FILE" ] || die "No named tunnel configured. Run 'lma tunnel setup', or 'lma tunnel quick' for a throwaway URL."
}

tunnel_mode() { if [ -f "$MODE_FILE" ]; then cat "$MODE_FILE"; else printf 'named'; fi; }

selected_has() { # $1 = app, $2... = selection (empty selection = all)
    local a="$1"; shift
    [ "$#" -eq 0 ] && return 0
    local s; for s in "$@"; do [ "$s" = "$a" ] && return 0; done
    return 1
}

# exposure gate: nothing goes public without showing exactly what goes with it

exposes_backend() { # $1 = mode, $2... = selection
    local mode="$1"; shift
    local app port public
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        selected_has "$app" "$@" || continue
        [ "$app" = "backend" ] && return 0
    done < <(mode_map "$mode")
    return 1
}

# what was agreed to, names and ports: either changing asks again
exposure_key() { # $1 = mode, $2... = selection
    local mode="$1"; shift
    local app port public out="$mode"
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        selected_has "$app" "$@" || continue
        out="$out|$app=$public:$port"
    done < <(mode_map "$mode")
    printf '%s' "$out"
}

exposure_banner() { # $1 = mode, $2... = selection
    local mode="$1"; shift
    local app port public
    info ""
    printf '%s%s╷ going public%s\n' "$bold" "$yellow" "$off"
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        selected_has "$app" "$@" || continue
        if [ "$mode" = "quick" ]; then
            printf '  %s → a temporary trycloudflare.com URL %s(anyone with the link)%s\n' "$app" "$dim" "$off"
        else
            printf '  https://%s → localhost:%s %s(%s)%s\n' "$public" "$port" "$dim" "$app" "$off"
        fi
        if [ "$app" = "backend" ]; then
            printf '    %sincludes the Admin dashboard at /app, /auth and every store route%s\n' "$yellow" "$off"
        fi
    done < <(mode_map "$mode")
    printf '  %sthe database and credentials behind them go too: development data only.%s\n' "$dim" "$off"
    info ""
}

exposure_gate() { # $1 = mode, $2... = selection
    local mode="$1"; shift
    exposure_banner "$mode" "$@"

    if [ "$_T_ADMIN_WEAK" = "1" ] && exposes_backend "$mode" "$@" && [ "${LMA_TUNNEL_ALLOW_WEAK_ADMIN:-0}" != "1" ]; then
        die "the admin password is guessable and this publishes the Admin dashboard.
  Drop admin.password for a generated one, re-run 'lma seed-admin', or set LMA_TUNNEL_ALLOW_WEAK_ADMIN=1."
    fi

    local key ans
    key="$(exposure_key "$mode" "$@")"
    if [ -f "$ACK_FILE" ] && [ "$(cat "$ACK_FILE" 2>/dev/null || true)" = "$key" ]; then
        return 0
    fi
    if [ "$ASSUME_YES" != "1" ]; then
        [ -t 0 ] || die "refusing to publish without a terminal to confirm on; pass --yes if you mean it"
        read -r -p "Publish the routes above? Type 'expose' to confirm: " ans || ans=""
        [ "$ans" = "expose" ] || die "aborted"
    fi
    printf '%s' "$key" > "$ACK_FILE"
}

preflight() { # $1 = mode, $2... = selected apps
    local mode="$1"; shift
    need_cloudflared
    local pid orphans
    if pid="$(tunnel_pid)"; then
        ok "Tunnel already running (pid $pid, $(tunnel_mode))"
        return 1
    fi
    orphans="$(project_tunnel_pids)"
    if [ -n "$orphans" ]; then
        warn "a cloudflared for this project is running but not recorded (pid $(printf '%s' "$orphans" | tr '\n' ' '))"
        die "it is serving whatever routes it started with. Clear it first: lma tunnel stop"
    fi
    local app port public any_up=0
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        selected_has "$app" "$@" || continue
        if port_up "$port"; then
            ok "$app reachable on http://localhost:$port"
            any_up=1
        else
            warn "$app is NOT listening on localhost:$port (start it: npm run dev)"
        fi
    done < <(mode_map "$mode")
    [ "$any_up" = "1" ] || die "None of the selected apps are running. Start the stack first: lma start && npm run dev"
    return 0
}

launch() {
    mkdir -p "$TUNNEL_DIR"
    : > "$LOG_FILE"
    nohup cloudflared "$@" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
}

abort_if_dead() {
    tunnel_pid >/dev/null && return 0
    warn "cloudflared exited during startup. Last lines:"
    tail -n 15 "$LOG_FILE" >&2
    rm -f "$PID_FILE" "$MODE_FILE" "$URL_FILE"
    exit 1
}

wait_ready() {
    local i=0
    while [ "$i" -lt "$READY_TIMEOUT" ]; do
        abort_if_dead
        curl -fsS -m 2 "http://$METRICS_ADDR/ready" >/dev/null 2>&1 && return 0
        sleep 1
        i=$((i + 1))
    done
    return 1
}

tunnel_uuid() {
    cloudflared tunnel list 2>/dev/null | awk -v n="$1" '$2 == n { print $1; exit }'
}

write_config() {
    local uuid="$1" creds="$2"; shift 2
    local ingress="" app port public
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        selected_has "$app" "$@" || continue
        ingress="$ingress  - hostname: $public
    service: http://localhost:$port
"
    done < <(named_map)
    [ -n "$ingress" ] || die "No public hostname for the selected apps."

    mkdir -p "$TUNNEL_DIR"
    cat > "$CONFIG_FILE" <<EOF
# Generated by tunnel.sh on every 'start'; do not edit.
tunnel: $uuid
credentials-file: $creds

originRequest:
  connectTimeout: 30s
  keepAliveTimeout: 90s
  noHappyEyeballs: true

ingress:
$ingress  - service: http_status:404
EOF
}

# vite answers 403 to any Host it was not told about
admin_host_blocked() { # $1 = public hostname, $2 = local port
    local code
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' \
        -H "Host: $1" "http://127.0.0.1:$2/app" 2>/dev/null || true)"
    [ "$code" = "403" ]
}

check_admin_hosts() { # $1 = public hostname, $2 = local port; 1 when refused
    admin_host_blocked "$1" "$2" || return 0
    warn "the admin dev server refuses Host: $1 (Vite allowedHosts)"
    return 1
}

# medusa echoes an allowed origin back and omits the header otherwise
cors_allowed() { # $1 = origin, $2 = backend port, $3 = route group
    curl -s -m 3 -o /dev/null -D - -X OPTIONS \
        -H "Origin: $1" -H 'Access-Control-Request-Method: GET' \
        "http://127.0.0.1:$2$3" 2>/dev/null \
        | grep -qi '^access-control-allow-origin:'
}

cors_check() { # $@ = selection
    local sf_pub be_pub stale=0
    [ -n "$_T_BACKEND_PORT" ] || return 0
    port_up "$_T_BACKEND_PORT" || return 0
    sf_pub="$(app_map | awk -F'\t' '$1 == "storefront" { print $3 }')"
    be_pub="$(app_map | awk -F'\t' '$1 == "backend" { print $3 }')"
    if [ -n "$sf_pub" ] && selected_has "storefront" "$@" &&
        ! cors_allowed "https://$sf_pub" "$_T_BACKEND_PORT" /store/regions; then
        warn "the backend rejects Origin https://$sf_pub (STORE_CORS)"
        stale=1
    fi
    if [ -n "$be_pub" ] && selected_has "backend" "$@" &&
        ! cors_allowed "https://$be_pub" "$_T_BACKEND_PORT" /admin/users; then
        warn "the backend rejects Origin https://$be_pub (ADMIN_CORS)"
        stale=1
    fi
    [ "$stale" = "1" ] &&
        warn "  the backend started before that hostname was in the config; pick it up with: lma restart"
    return 0
}

report_up() {
    local mode app port public
    mode="$(tunnel_mode)"
    info ""
    ok "Tunnel up (pid $(tunnel_pid || true), $mode)"
    if [ "$mode" = "quick" ]; then
        info "  ${bold}$(cat "$URL_FILE" 2>/dev/null)${off} ${dim}($(cat "$ACTIVE_FILE" 2>/dev/null))${off}"
        info "  ${yellow}temporary URL; it changes every restart${off}"
    else
        local selection=()
        [ -f "$ACTIVE_FILE" ] && read -r -a selection < "$ACTIVE_FILE" || true
        while IFS=$'\t' read -r app port public; do
            [ -n "$app" ] || continue
            selected_has "$app" ${selection[@]+"${selection[@]}"} || continue
            info "  ${bold}https://$public${off} ${dim}($app → localhost:$port)${off}"
        done < <(named_map)
    fi
    info "  ${dim}stop it with: lma tunnel stop${off}"
}

cmd_setup() {
    need_cloudflared
    [ -n "$(app_map)" ] || die "The config defines no apps to publish. Check it with: lma ports"
    ensure_hostnames "$@"

    if [ "$DRY_RUN" = "1" ]; then
        plan "cloudflare login (if ~/.cloudflared/cert.pem is missing)"
        plan "create or reuse tunnel '$TUNNEL_NAME', credentials at $CREDS_FILE"
        named_map | cut -f3 | sort -u | while read -r d; do plan "route DNS $d → $TUNNEL_NAME"; done
        return 0
    fi

    [ -n "$(named_map)" ] || die "No public hostname given; there is nothing to route."
    info "Public hostnames:"
    named_map | awk -F'\t' '{ printf "  %s → %s (localhost:%s)\n", $3, $1, $2 }'

    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
        info "${bold}Cloudflare login required${off}: a browser will open; pick the zone that owns these domains."
        cloudflared tunnel login || die "Login failed."
    fi
    [ -f "$HOME/.cloudflared/cert.pem" ] || die "Login did not produce ~/.cloudflared/cert.pem."
    ok "Authenticated with Cloudflare"

    local creds="$CREDS_FILE"
    mkdir -p "$CREDS_DIR"
    local uuid
    uuid="$(tunnel_uuid "$TUNNEL_NAME")"
    if [ -n "$uuid" ]; then
        ok "Reusing existing tunnel '$TUNNEL_NAME' ($uuid)"
        if [ ! -f "$creds" ]; then
            if [ -f "$TUNNEL_DIR/credentials.json" ]; then
                cp "$TUNNEL_DIR/credentials.json" "$creds"
                ok "Moved credentials out of the install cache to $creds"
            elif [ -f "$HOME/.cloudflared/$uuid.json" ]; then
                cp "$HOME/.cloudflared/$uuid.json" "$creds"
                ok "Adopted credentials from ~/.cloudflared/$uuid.json"
            else
                die "No credentials for '$TUNNEL_NAME', and the secret cannot be recovered. Run 'cloudflared tunnel delete $TUNNEL_NAME', then setup again."
            fi
        fi
    else
        info "Creating tunnel '$TUNNEL_NAME'..."
        cloudflared tunnel create --credentials-file "$creds" "$TUNNEL_NAME" \
            || die "Could not create tunnel '$TUNNEL_NAME'."
        uuid="$(tunnel_uuid "$TUNNEL_NAME")"
        [ -n "$uuid" ] || die "Tunnel created but its UUID could not be read back."
        ok "Created tunnel '$TUNNEL_NAME' ($uuid)"
    fi
    chmod 600 "$creds" 2>/dev/null || true

    local d
    for d in $(named_map | cut -f3 | sort -u); do
        info "Routing DNS ${d} → ${TUNNEL_NAME}..."
        if cloudflared tunnel route dns "$TUNNEL_NAME" "$d" 2>&1 | sed 's/^/  /'; then
            ok "DNS routed"
        else
            warn "could not create the DNS record for $d; ensure it is a CNAME to $uuid.cfargotunnel.com"
        fi
    done

    cat > "$ENV_FILE" <<EOF
# Generated by tunnel.sh. Safe to edit.
TUNNEL_NAME="$TUNNEL_NAME"
METRICS_ADDR="$METRICS_ADDR"
EOF
    ok "Wrote $(basename "$ENV_FILE")"
    ok "Setup complete; nothing is public yet. Publish with: ${bold}lma tunnel start${off}"
}

cmd_start() {
    local apps app
    apps="$(app_map | cut -f1)"
    for app in "$@"; do
        printf '%s\n' "$apps" | grep -qx "$app" \
            || die "Unknown app '$app'. Defined: $(printf '%s' "$apps" | tr '\n' ' ')"
    done

    [ -n "$apps" ] || die "The config defines no apps to publish. Check it with: lma ports"
    ensure_hostnames "$@"

    if [ "$DRY_RUN" = "1" ]; then
        [ -n "$(named_map)" ] && exposure_banner named "$@"
        [ -f "$CREDS_FILE" ] || info "${dim}not set up yet; run: lma tunnel setup${off}"
        plan "cloudflared tunnel --config $CONFIG_FILE run"
        return 0
    fi

    [ -n "$(named_map)" ] || die "No public hostname given; there is nothing to publish."
    require_setup
    preflight named "$@" || return 0
    exposure_gate named "$@"

    local uuid
    uuid="$(tunnel_uuid "$TUNNEL_NAME")"
    [ -n "$uuid" ] || die "Tunnel '$TUNNEL_NAME' not found. Run: lma tunnel setup"
    write_config "$uuid" "$CREDS_FILE" "$@"

    launch tunnel \
        --config "$CONFIG_FILE" \
        --metrics "$METRICS_ADDR" \
        --no-autoupdate \
        run
    printf 'named' > "$MODE_FILE"
    printf '%s\n' "$*" > "$ACTIVE_FILE"

    if ! wait_ready; then
        warn "not ready after ${READY_TIMEOUT}s; may still be connecting; check: lma tunnel logs"
    fi
    report_up
    cors_check "$@"

    local port public
    while IFS=$'\t' read -r app port public; do
        [ "$app" = "backend" ] || continue
        selected_has "$app" "$@" || continue
        check_admin_hosts "$public" "$port" ||
            warn "  the backend started before that hostname was in the config; pick it up with: lma restart"
    done < <(named_map)
}

# throwaway trycloudflare URL, no account needed
cmd_quick() {
    local app="${1:-storefront}" port
    port="$(app_port "$app")"
    [ -n "$port" ] || die "Unknown app '$app'. Defined: $(app_map | cut -f1 | tr '\n' ' ')"

    if [ "$DRY_RUN" = "1" ]; then
        exposure_banner quick "$app"
        plan "cloudflared tunnel --url http://localhost:$port"
        return 0
    fi

    preflight quick "$app" || return 0
    exposure_gate quick "$app"

    launch tunnel \
        --url "http://localhost:$port" \
        --metrics "$METRICS_ADDR" \
        --no-autoupdate
    printf 'quick' > "$MODE_FILE"
    printf '%s\n' "$app" > "$ACTIVE_FILE"
    rm -f "$URL_FILE"

    info "Waiting for Cloudflare to assign a hostname..."
    local i=0 url=""
    while [ "$i" -lt "$READY_TIMEOUT" ]; do
        abort_if_dead
        url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | head -1 || true)"
        [ -n "$url" ] && break
        sleep 1
        i=$((i + 1))
    done

    if [ -z "$url" ]; then
        warn "No URL appeared in the log within ${READY_TIMEOUT}s. Last lines:"
        tail -n 20 "$LOG_FILE" >&2
        cmd_stop >/dev/null 2>&1 || true
        die "Quick tunnel failed to start."
    fi
    printf '%s' "$url" > "$URL_FILE"

    wait_ready || warn "URL assigned, but edge connections are still registering."
    report_up
    if [ "$app" = "storefront" ]; then
        warn "quick URL is not in backend CORS; browser API calls may fail; prefer: lma tunnel start"
    fi
    if [ "$app" = "backend" ]; then
        check_admin_hosts "${url#https://}" "$port" ||
            warn "  a throwaway hostname cannot be allowed in advance; for the admin use: lma tunnel start backend"
    fi
}

# every cloudflared for this project: a stale pid file must not hide a live one
project_tunnel_pids() {
    local uuid pid cmd
    uuid="$(tunnel_uuid "$TUNNEL_NAME" 2>/dev/null || true)"
    for pid in $(pgrep -f cloudflared 2>/dev/null || true); do
        cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        case "$cmd" in *cloudflared*) ;; *) continue ;; esac
        case "$cmd" in
            *"$CONFIG_FILE"*|*"$METRICS_ADDR"*|*"$TUNNEL_DIR"*) printf '%s\n' "$pid"; continue ;;
        esac
        [ -n "$uuid" ] || continue
        case "$cmd" in *"$uuid"*) printf '%s\n' "$pid" ;; esac
    done
}

stop_pid() {     local pid="$1" i=0
    kill "$pid" 2>/dev/null || true
    while [ "$i" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 1; i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
        warn "pid $pid did not stop gracefully; sending SIGKILL."
        kill -9 "$pid" 2>/dev/null || true
    fi
}

cmd_stop() {
    local pid stopped=0 recorded="" stale
    recorded="$(tunnel_pid || true)"
    if [ -n "$recorded" ]; then
        stop_pid "$recorded"
        stopped=1
    else
        stale="$(cat "$PID_FILE" 2>/dev/null || true)"
        if [ -n "$stale" ] && kill -0 "$stale" 2>/dev/null; then
            warn "pid $stale is not this project's tunnel; leaving it alone"
        fi
    fi
    rm -f "$PID_FILE" "$MODE_FILE" "$URL_FILE" "$ACTIVE_FILE"

    for pid in $(project_tunnel_pids); do
        [ "$pid" = "$recorded" ] && continue
        [ "$pid" = "$$" ] && continue
        warn "found an unrecorded cloudflared for this project (pid $pid); stopping it too"
        stop_pid "$pid"
        stopped=1
    done

    if [ "$stopped" = "1" ]; then ok "Tunnel stopped"; else info "Tunnel is not running."; fi
    return 0
}

cmd_status() {
    local pid mode running=0 app port public
    mode="$(tunnel_mode)"
    if pid="$(tunnel_pid)"; then
        ok "Running (pid $pid, $mode) — ${yellow}published to the internet${off}"
        running=1
        [ "$mode" = "quick" ] && info "  ${bold}$(cat "$URL_FILE" 2>/dev/null)${off} ${dim}($(cat "$ACTIVE_FILE" 2>/dev/null))${off}"
    else
        local orphans
        orphans="$(project_tunnel_pids)"
        if [ -n "$orphans" ]; then
            warn "unrecorded cloudflared running for this project (pid $(printf '%s' "$orphans" | tr '\n' ' '))"
            warn "  it is publishing the routes it started with; stop it with: lma tunnel stop"
        else
            info "${dim}Not running (nothing published)${off}"
        fi
    fi
    local selection=()
    [ "$running" = "1" ] && [ -f "$ACTIVE_FILE" ] && read -r -a selection < "$ACTIVE_FILE" || true
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        if [ "$running" = "1" ] && [ "$mode" = "named" ] && [ -n "$public" ] && selected_has "$app" ${selection[@]+"${selection[@]}"}; then
            info "  $app: ${green}https://$public${off} ${dim}(published)${off}"
        else
            info "  $app: http://localhost:$port"
        fi
        if port_up "$port"; then
            info "         ${green}up${off} on localhost:$port"
        else
            info "         ${red}down${off} on localhost:$port"
        fi
    done < <(app_map)
}

cmd_logs() {
    [ -f "$LOG_FILE" ] || die "No log yet at $LOG_FILE"
    if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
        tail -f "$LOG_FILE"
    else
        tail -n "${1:-50}" "$LOG_FILE"
    fi
}

sub="${1:-}"; shift || true
case "$sub" in
    setup|quick|start|restart)
        parse_flags "$@"
        set -- ${ARGS[@]+"${ARGS[@]}"}
        ;;
esac

case "$sub" in
    setup)   cmd_setup "$@" ;;
    quick)   cmd_quick "$@" ;;
    start)   cmd_start "$@" ;;
    stop)    cmd_stop "$@" ;;
    restart) restart_mode="$(tunnel_mode)"
             restart_selection=""
             [ -f "$ACTIVE_FILE" ] && restart_selection="$(cat "$ACTIVE_FILE")"
             cmd_stop
             if [ "$restart_mode" = "quick" ]; then
                 # shellcheck disable=SC2086
                 cmd_quick $restart_selection
             else
                 # shellcheck disable=SC2086
                 cmd_start $restart_selection
             fi ;;
    status)  cmd_status "$@" ;;
    logs)    cmd_logs "$@" ;;
    ""|-h|--help|help)
        awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
        ;;
    *) die "Unknown command '$sub'; see: lma tunnel help" ;;
esac
