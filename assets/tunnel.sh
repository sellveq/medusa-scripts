#!/usr/bin/env bash
#
# Cloudflare tunnel for the local stack. Config: lmca.js (tunnel.name,
# tunnel.hostnames keyed like apps.*; ports via the port cache).
#
#   lmca tunnel setup | start [app...] | quick [app] | stop | restart |
#              status | logs [-f]
#
set -euo pipefail

if [ -n "${LMCA_ROOT:-}" ]; then
  ROOT_DIR="$LMCA_ROOT"
else
  ROOT_DIR="$PWD"
  while [ ! -f "$ROOT_DIR/lmca.js" ] && [ "$ROOT_DIR" != "/" ]; do ROOT_DIR="$(dirname "$ROOT_DIR")"; done
  [ -f "$ROOT_DIR/lmca.js" ] || { echo "no lmca.js found — run 'lmca init' first" >&2; exit 1; }
fi
TUNNEL_DIR="$ROOT_DIR/node_modules/.lmca-cache/tunnel"
mkdir -p "$TUNNEL_DIR"
LIB="${LMCA_ASSETS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/../lib/ports.js"
ENV_FILE="$TUNNEL_DIR/tunnel.env"
CONFIG_FILE="$TUNNEL_DIR/config.yml"
PID_FILE="$TUNNEL_DIR/cloudflared.pid"
LOG_FILE="$TUNNEL_DIR/cloudflared.log"
MODE_FILE="$TUNNEL_DIR/mode"
URL_FILE="$TUNNEL_DIR/quick.url"
ACTIVE_FILE="$TUNNEL_DIR/active"
SELF="lmca tunnel"

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

PROJECT_NAME="$( (cd "$ROOT_DIR" && node -e 'process.stdout.write(require("./lmca.js").project || "")' 2>/dev/null) || true)"
PROJECT_NAME="${PROJECT_NAME:-$(basename "$ROOT_DIR")}"
TUNNEL_NAME="${TUNNEL_NAME:-$( (cd "$ROOT_DIR" && node -e 'process.stdout.write((require("./lmca.js").tunnel || {}).name || "")' 2>/dev/null) || true)}"
TUNNEL_NAME="${TUNNEL_NAME:-$PROJECT_NAME}"
CREDS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/lmca/tunnels"
CREDS_FILE="$CREDS_DIR/$TUNNEL_NAME.json"
# per-project metrics port so tunnels can coexist
_METRICS_PORT="$( (cd "$ROOT_DIR" && node -e '
const lib = require(process.argv[1]);
const c = require("./lmca.js");
process.stdout.write(String((c.tunnel || {}).metricsPort || 20000 + (lib.projectId(process.cwd(), c) % 10000)));
' "$LIB" 2>/dev/null) || true)"
METRICS_ADDR="${METRICS_ADDR:-127.0.0.1:${_METRICS_PORT:-20251}}"
READY_TIMEOUT="${READY_TIMEOUT:-30}"

bold=$'\033[1m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; dim=$'\033[2m'; off=$'\033[0m'
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$green" "$off" "$*"; }
warn() { printf '%s!%s %s\n' "$yellow" "$off" "$*" >&2; }
die()  { printf '%s✖%s %s\n' "$red" "$off" "$*" >&2; exit 1; }

# Rows of "app<TAB>port<TAB>public". The trailing newline is load-bearing.
app_map() {
    (cd "$ROOT_DIR" && node -e '
(async () => {
    const { ports } = await require(process.argv[1]).resolve(process.cwd());
    const c = require("./lmca.js");
    const P = (c.tunnel || {}).hostnames || {};
    const rows = [];
    for (const k of Object.keys(c.apps || {})) {
        if (P[k] && ports[k]) rows.push([k, ports[k], P[k]]);
    }
    process.stdout.write(rows.map((r) => r.join("\t")).join("\n") + (rows.length ? "\n" : ""));
})().catch(() => process.exit(1))
' "$LIB" 2>/dev/null) || true
}

app_port() { app_map | awk -F'\t' -v a="$1" '$1 == a { print $2; exit }'; }

need_cloudflared() {
    command -v cloudflared >/dev/null 2>&1 \
        || die "cloudflared not found. Install it with: brew install cloudflared"
}

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

tunnel_pid() {
    [ -f "$PID_FILE" ] || return 1
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    [ -n "$pid" ] || return 1
    kill -0 "$pid" >/dev/null 2>&1 || return 1
    printf '%s' "$pid"
}

require_setup() {
    # migrate credentials from the old in-cache location if they are still there
    if [ ! -f "$CREDS_FILE" ] && [ -f "$TUNNEL_DIR/credentials.json" ]; then
        mkdir -p "$CREDS_DIR"
        cp "$TUNNEL_DIR/credentials.json" "$CREDS_FILE"
        chmod 600 "$CREDS_FILE" 2>/dev/null || true
        ok "Moved tunnel credentials to $CREDS_FILE (survives clean installs)"
    fi
    [ -f "$CREDS_FILE" ] || die "No named tunnel configured. Run 'lmca tunnel setup', or 'lmca tunnel quick' for a throwaway URL."
}

tunnel_mode() { if [ -f "$MODE_FILE" ]; then cat "$MODE_FILE"; else printf 'named'; fi; }

selected_has() { # $1 = app, $2... = selection (empty selection = all)
    local a="$1"; shift
    [ "$#" -eq 0 ] && return 0
    local s; for s in "$@"; do [ "$s" = "$a" ] && return 0; done
    return 1
}

preflight() { # $@ = selected apps
    need_cloudflared
    local pid
    if pid="$(tunnel_pid)"; then
        ok "Tunnel already running (pid $pid, $(tunnel_mode))"
        info "  ${dim}Restart it with: lmca tunnel stop && lmca tunnel start${off}"
        return 1
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
    done < <(app_map)
    [ "$any_up" = "1" ] || die "None of the selected apps are running. Start the stack first: lmca start && npm run dev"
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
    done < <(app_map)
    [ -n "$ingress" ] || die "No tunnel.hostnames defined in lmca.js."

    mkdir -p "$TUNNEL_DIR"
    cat > "$CONFIG_FILE" <<EOF
# Generated by tunnel.sh on every 'start' — do not edit.
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

cors_note() { # $@ = selection
    local sf_pub be_pub
    sf_pub="$(app_map | awk -F'\t' '$1 == "storefront" { print $3 }')"
    be_pub="$(app_map | awk -F'\t' '$1 == "backend" { print $3 }')"
    info ""
    info "  ${yellow}Reminder (not applied automatically):${off}"
    if [ -n "$sf_pub" ] && selected_has "storefront" "$@"; then
        info "  ${dim}apps/backend/.env → add https://$sf_pub to STORE_CORS and AUTH_CORS, then restart the backend${off}"
    fi
    if [ -n "$be_pub" ] && selected_has "backend" "$@"; then
        info "  ${dim}apps/backend/.env → add https://$be_pub to ADMIN_CORS/AUTH_CORS if you use the public admin${off}"
        info "  ${dim}point external webhooks (SP/Benulino) at https://$be_pub${off}"
    fi
}

report_up() {
    local mode app port public
    mode="$(tunnel_mode)"
    info ""
    ok "Tunnel up (pid $(tunnel_pid || true), $mode)"
    if [ "$mode" = "quick" ]; then
        info "  ${bold}$(cat "$URL_FILE" 2>/dev/null)${off} ${dim}($(cat "$ACTIVE_FILE" 2>/dev/null))${off}"
        info "  ${yellow}temporary URL — it changes every restart${off}"
    else
        local selection=()
        [ -f "$ACTIVE_FILE" ] && read -r -a selection < "$ACTIVE_FILE" || true
        while IFS=$'\t' read -r app port public; do
            [ -n "$app" ] || continue
            selected_has "$app" ${selection[@]+"${selection[@]}"} || continue
            info "  ${bold}https://$public${off} ${dim}($app → localhost:$port)${off}"
        done < <(app_map)
    fi
    info ""
    info "  ${dim}Stop:    lmca tunnel stop${off}"
}

cmd_setup() {
    need_cloudflared
    [ -n "$(app_map)" ] || die "lmca.js needs apps.* ports plus a tunnel.hostnames map (same keys as apps)."
    info "Public hostnames:"
    app_map | awk -F'\t' '{ printf "  %s -> %s (localhost:%s)\n", $3, $1, $2 }'

    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
        info "${bold}Cloudflare login required.${off}"
        info "A browser will open — pick the zone that owns these domains."
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
    for d in $(app_map | cut -f3 | sort -u); do
        info "Routing DNS ${d} -> ${TUNNEL_NAME}..."
        if cloudflared tunnel route dns "$TUNNEL_NAME" "$d" 2>&1 | sed 's/^/  /'; then
            ok "DNS routed"
        else
            warn "Could not create the DNS record for $d automatically."
            warn "If it already exists, confirm it is a CNAME to $uuid.cfargotunnel.com"
        fi
    done

    cat > "$ENV_FILE" <<EOF
# Generated by tunnel.sh. Safe to edit.
TUNNEL_NAME="$TUNNEL_NAME"
METRICS_ADDR="$METRICS_ADDR"
EOF
    ok "Wrote $(basename "$ENV_FILE")"
    info ""
    ok "Setup complete. Start with: ${bold}lmca tunnel start${off} (all) or ${bold}lmca tunnel start storefront${off}"
}

cmd_start() {
    require_setup
    local apps app
    apps="$(app_map | cut -f1)"
    for app in "$@"; do
        printf '%s\n' "$apps" | grep -qx "$app" \
            || die "Unknown app '$app'. Defined: $(printf '%s' "$apps" | tr '\n' ' ')"
    done

    preflight "$@" || return 0

    local uuid
    uuid="$(tunnel_uuid "$TUNNEL_NAME")"
    [ -n "$uuid" ] || die "Tunnel '$TUNNEL_NAME' not found. Run: lmca tunnel setup"
    write_config "$uuid" "$CREDS_FILE" "$@"

    launch tunnel \
        --config "$CONFIG_FILE" \
        --metrics "$METRICS_ADDR" \
        --no-autoupdate \
        run
    printf 'named' > "$MODE_FILE"
    printf '%s\n' "$*" > "$ACTIVE_FILE"

    if ! wait_ready; then
        warn "Tunnel started but did not report ready within ${READY_TIMEOUT}s."
        warn "It may still be connecting — check lmca tunnel logs"
    fi
    report_up
    cors_note "$@"
}

# throwaway trycloudflare URL, no account needed
cmd_quick() {
    local app="${1:-storefront}" port
    port="$(app_port "$app")"
    [ -n "$port" ] || die "Unknown app '$app'. Defined: $(app_map | cut -f1 | tr '\n' ' ')"

    preflight "$app" || return 0

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
    [ "$app" = "storefront" ] && warn "storefront over quick URL: backend CORS does not include it — API calls from the browser may fail. Prefer 'lmca tunnel start' with named hostnames."
}

cmd_stop() {
    local pid stopped=0
    if pid="$(tunnel_pid)"; then
        kill "$pid" 2>/dev/null || true
        local i=0
        while [ "$i" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
            sleep 1; i=$((i + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "Did not stop gracefully; sending SIGKILL."
            kill -9 "$pid" 2>/dev/null || true
        fi
        stopped=1
    fi
    rm -f "$PID_FILE" "$MODE_FILE" "$URL_FILE" "$ACTIVE_FILE"

    # Catch an instance orphaned by a crashed shell — scoped to this project.
    if pkill -f "cloudflared.*$CONFIG_FILE" 2>/dev/null; then stopped=1; fi
    if pkill -f "cloudflared tunnel --url http://localhost:.*--metrics $METRICS_ADDR" 2>/dev/null; then stopped=1; fi

    if [ "$stopped" = "1" ]; then ok "Tunnel stopped"; else info "Tunnel is not running."; fi
    return 0
}

cmd_status() {
    local pid mode running=0 app port public
    mode="$(tunnel_mode)"
    if pid="$(tunnel_pid)"; then
        ok "Running (pid $pid, $mode)"
        running=1
        [ "$mode" = "quick" ] && info "  ${bold}$(cat "$URL_FILE" 2>/dev/null)${off} ${dim}($(cat "$ACTIVE_FILE" 2>/dev/null))${off}"
    else
        info "${dim}Not running${off}"
    fi
    local selection=()
    [ "$running" = "1" ] && [ -f "$ACTIVE_FILE" ] && read -r -a selection < "$ACTIVE_FILE" || true
    while IFS=$'\t' read -r app port public; do
        [ -n "$app" ] || continue
        if [ "$running" = "1" ] && [ "$mode" = "named" ] && selected_has "$app" ${selection[@]+"${selection[@]}"}; then
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

case "${1:-}" in
    setup)   shift; cmd_setup "$@" ;;
    quick)   shift; cmd_quick "$@" ;;
    start)   shift; cmd_start "$@" ;;
    stop)    shift; cmd_stop "$@" ;;
    restart) shift
             restart_mode="$(tunnel_mode)"
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
    status)  shift; cmd_status "$@" ;;
    logs)    shift; cmd_logs "$@" ;;
    ""|-h|--help|help)
        awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
        ;;
    *) die "Unknown command '$1'. Try: npm run tunnel" ;;
esac
