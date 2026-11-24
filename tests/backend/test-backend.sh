#!/bin/sh
# shellcheck disable=SC2016,SC2034 # checks are single-quoted strings that check() evals
# Tests for backend.sh's generated files, settings and token handling (Linux; no containers
# start: every run uses --no-start). With Docker available, the Caddyfile is also validated.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCRIPT="$ROOT/backend.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
D="$WORK/backend"
fails=0

ok() { printf 'ok   %s\n' "$1"; }
bad() {
    printf 'FAIL %s\n' "$1"
    fails=$((fails + 1))
}
check() {
    if eval "$2"; then ok "$1"; else bad "$1"; fi
}
run() { sh "$SCRIPT" --no-start --dir "$D" "$@" >"$WORK/out" 2>"$WORK/err"; }
mode() { stat -c %a "$1"; }
token() { sed -n "s/^$1=//p" "$D/secrets.env"; }

run
check "first run writes every file" '[ -f "$D/compose.yaml" ] && [ -f "$D/Caddyfile" ] && [ -x "$D/init.d/001-forge.sh" ] && [ -f "$D/settings.env" ]'
check "secrets.env is 0600" '[ "$(mode "$D/secrets.env")" = 600 ]'
check "forge-auth is 0600" '[ "$(mode "$D/forge-auth")" = 600 ]'
check "directory is 0700" '[ "$(mode "$D")" = 700 ]'
owner1=$(token OWNER_TOKEN)
forge1=$(token FORGE_TOKEN)
check "tokens are 48 hex characters" 'printf "%s\n%s\n" "$owner1" "$forge1" | grep -cE "^[0-9a-f]{48}$" | grep -qx 2'
check "forge-auth holds the bearer header value" '[ "$(cat "$D/forge-auth")" = "Bearer $forge1" ]'
check "no token in the output" '! grep -qF "$forge1" "$WORK/out" "$WORK/err" && ! grep -qF "$owner1" "$WORK/out" "$WORK/err"'
check "no token in the generated config" '! grep -qrF "$forge1" "$D/compose.yaml" "$D/Caddyfile" "$D/init.d"'
check "init script is valid sh" 'sh -n "$D/init.d/001-forge.sh"'
check "both default web apps are allowed" 'grep -q "header Origin https://forge.dashhq.org" "$D/Caddyfile" && grep -q "header Origin https://testnet-forge.dashhq.org" "$D/Caddyfile"'
check "only the six Forge RPC calls pass" 'grep -q "path /api/v0/add /api/v0/pin/add /api/v0/pin/ls /api/v0/pin/rm /api/v0/id /api/v0/version" "$D/Caddyfile"'
check "kubo listens on loopback only" 'grep -q "Addresses.API /ip4/127.0.0.1/tcp/5101" "$D/init.d/001-forge.sh" && grep -q "Addresses.Gateway /ip4/127.0.0.1/tcp/8180" "$D/init.d/001-forge.sh"'
check "swarm is dual stack with WSS" 'grep -q "/ip6/::/tcp/4001/tls/sni/\*.libp2p.direct/ws" "$D/init.d/001-forge.sh" && grep -q "/ip4/0.0.0.0/udp/4001/quic-v1" "$D/init.d/001-forge.sh"'
check "gateway serves only local content" 'grep -q "Gateway.NoFetch true" "$D/init.d/001-forge.sh"'
check "plain-http ports refuse public clients" '[ "$(grep -c "@outside not remote_ip 127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 ::1/128 fc00::/7 fe80::/10" "$D/Caddyfile")" = 2 ]'
check "images are pinned by digest" '[ "$(grep -c "image: .*@sha256:" "$D/compose.yaml")" = 2 ]'

run
check "a re-run keeps both tokens" '[ "$(token OWNER_TOKEN)" = "$owner1" ] && [ "$(token FORGE_TOKEN)" = "$forge1" ]'

run --rotate-token
check "--rotate-token replaces only the Forge token" '[ "$(token OWNER_TOKEN)" = "$owner1" ] && [ "$(token FORGE_TOKEN)" != "$forge1" ]'
check "rotated forge-auth matches" '[ "$(cat "$D/forge-auth")" = "Bearer $(token FORGE_TOKEN)" ]'

run --domain ipfs.forge-test.net --email ops@forge-test.net --origin https://forge.example.org --api-port 5002 --swarm-port 4002 --listen local
check "domain gets its own site block" 'grep -q "^ipfs.forge-test.net {" "$D/Caddyfile"'
check "email reaches Caddy" 'grep -q "email ops@forge-test.net" "$D/Caddyfile"'
check "extra origin is allowed by Caddy and kubo" 'grep -q "header Origin https://forge.example.org" "$D/Caddyfile" && grep -q "https://forge.example.org" "$D/init.d/001-forge.sh"'
check "--listen local binds loopback" 'grep -q "bind 127.0.0.1 \[::1\]" "$D/Caddyfile" && ! grep -q "remote_ip" "$D/Caddyfile"'
check "new ports are used" 'grep -q "^http://:5002 {" "$D/Caddyfile" && grep -q "/tcp/4002" "$D/init.d/001-forge.sh"'

run
check "a re-run without options keeps the saved settings" 'grep -q "^ipfs.forge-test.net {" "$D/Caddyfile" && grep -q "^http://:5002 {" "$D/Caddyfile" && grep -q "^LISTEN=local$" "$D/settings.env"'

run --domain none --listen all --origin none
check "--domain none removes the site" '! grep -q "forge-test.net {" "$D/Caddyfile"'
check "--listen all drops the bind" '! grep -q "bind 127.0.0.1" "$D/Caddyfile"'
check "--origin none forgets the extra origins" '! grep -q "forge.example.org" "$D/Caddyfile" && grep -q "^ORIGINS=$" "$D/settings.env" && grep -q "header Origin https://forge.dashhq.org" "$D/Caddyfile"'

mkdir -p "$WORK/shared" && : >"$WORK/shared/unrelated"
if sh "$SCRIPT" --no-start --dir "$WORK/shared" >/dev/null 2>&1; then bad "refuses a directory with other files"; else ok "refuses a directory with other files"; fi
mkdir -p "$WORK/linked" && ln -s /etc/passwd "$WORK/linked/forge-auth" && : >"$WORK/linked/settings.env"
if sh "$SCRIPT" --no-start --dir "$WORK/linked" >/dev/null 2>&1; then bad "refuses to write through a symlink"; else ok "refuses to write through a symlink"; fi

refused() {
    if sh "$SCRIPT" --no-start --dir "$WORK/refused" "$@" >/dev/null 2>&1; then bad "refuses $*"; else ok "refuses $*"; fi
}
refused --origin http://forge.example.org
refused --origin https://forge.example.org/path
refused --domain 'bad name'
refused --api-port 0
refused --api-port 05001
refused --swarm-port 443
refused --domain ipfs.example.org
refused --api-port 8080
refused --api-port 5101
refused --email 'x; rm'
refused --listen everywhere
refused --bogus

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    run --domain ipfs.forge-test.net
    image=$(sed -n 's/^ *image: \(caddy:.*\)$/\1/p' "$D/compose.yaml")
    check "Caddy accepts the generated Caddyfile" 'docker run --rm -v "$D/Caddyfile:/etc/caddy/Caddyfile:ro" "$image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1'
else
    printf 'skip Caddyfile validation (no Docker)\n'
fi

[ "$fails" -eq 0 ] || {
    printf '%s test(s) failed\n' "$fails"
    exit 1
}
printf 'all backend.sh tests passed\n'
