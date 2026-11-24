#!/bin/sh
# Dash Forge backend: one command that runs an IPFS storage node your repositories push to.
#
#   curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh | sudo sh
#
# With a public https name for it (needs ports 80 and 443 reachable from the internet):
#
#   curl -fsSL https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh \
#     | sudo sh -s -- --domain ipfs.example.org
#
# What it runs, with Docker (host networking, so IPv4 and IPv6 both work):
#   kubo   an IPFS node (kubo 0.43.1). It keeps your packs, announces them to the IPFS network,
#          and gets a libp2p.direct certificate (AutoTLS) so browsers can dial it over WSS.
#          Its own API and gateway listen on loopback only.
#   caddy  the only HTTP way in. Port 5001 passes the six RPC calls Forge uses (add, pin add/ls/rm,
#          id, version) to kubo, which checks the token; every other path is 404. Port 8080 is
#          a read-only gateway for content this node stores. With --domain, Caddy also serves
#          both on https://<domain> with a Let's Encrypt certificate.
#
# What it writes, in one directory (default ~/forge-backend; under sudo, the invoking user's;
# /opt/forge-backend as plain root):
#   compose.yaml, Caddyfile, init.d/  generated from the settings below on every run
#   settings.env  the settings (no secrets), so a plain re-run keeps them
#   secrets.env   kubo's two tokens (mode 0600)
#   forge-auth    "Bearer <token>", the value Forge needs (mode 0600). It is never printed.
#   ipfs/ caddy/  the node's data and Caddy's certificates
#
# Commands:  up (default) | status | down | help
# Options for up (a re-run without them keeps the saved values):
#   --dir <path>            where everything lives
#   --domain <host>         also serve https://<host> (Let's Encrypt); "none" removes it
#   --email <addr>          contact address for Let's Encrypt (optional)
#   --origin <https://host> another Forge web app allowed to use the node (repeatable;
#                           forge.dashhq.org and testnet-forge.dashhq.org are always allowed;
#                           "none" forgets the extra ones)
#   --api-port <port>       push API port (default 5001)
#   --gateway-port <port>   read gateway port (default 8080)
#   --swarm-port <port>     IPFS TCP+UDP port (default 4001); forward it on your router
#   --listen all|local      who can reach the plain-http ports: clients on private networks
#                           (default; Caddy refuses public addresses, so the token never
#                           crosses the internet in clear), or this machine only
#   --rotate-token          replace the Forge token (connect dg and the web app again)
#   --no-start              write the files only
#
# Re-running is safe: tokens and data are kept, files are rewritten, and containers restart
# only when something changed. No third-party pinning service is involved.
#
# The whole script is one function called on the last line, so a download that is cut off
# part-way runs nothing.

set -eu

KUBO_IMAGE="ipfs/kubo:v0.43.1@sha256:b293923d66e490e70ced64df42ea7a6cf7eac2740e3fb29101df18070fa7be48"
CADDY_IMAGE="caddy:2.11.7@sha256:36c24ad91a7ff7bc4c87fe22bfa8df3c4b18da0773d73fc12ee2c52b98c0bb7e"
SCRIPT_URL="https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/master/backend.sh"
DOCS_URL="https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/guides/self-host-backend.md"
INSTALL_DG_URL="https://github.com/PastaPastaPasta/dash-forge/blob/master/docs/INSTALL.md"
DEFAULT_ORIGINS="https://forge.dashhq.org https://testnet-forge.dashhq.org"
RPC_PATHS="/api/v0/add /api/v0/pin/add /api/v0/pin/ls /api/v0/pin/rm /api/v0/id /api/v0/version"
PRIVATE_NETS="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 ::1/128 fc00::/7 fe80::/10"
PROBE="--connect-timeout 5 --max-time 30"
INTERNAL_API=5101
INTERNAL_GATEWAY=8180

say() { printf '%s\n' "$*"; }
warn() { printf 'backend.sh: warning: %s\n' "$*" >&2; }
die() {
    printf 'backend.sh: error: %s\n' "$*" >&2
    exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<EOF
Usage: backend.sh [up|status|down] [options]

  up (default)   set up or update the backend, start it, and print how to connect
  status         show what runs, its addresses and how to connect
  down           stop it (data, tokens and settings stay)

Options for up (a re-run without them keeps the saved values):
  --dir <path>             where everything lives (default ~/forge-backend; /opt/forge-backend as plain root)
  --domain <host>          also serve https://<host> with Let's Encrypt ("none" removes it)
  --email <addr>           contact address for Let's Encrypt
  --origin <https://host>  another Forge web app allowed to use the node (repeatable; "none" forgets them)
  --api-port <port>        push API port (default 5001)
  --gateway-port <port>    read gateway port (default 8080)
  --swarm-port <port>      IPFS TCP+UDP port (default 4001)
  --listen all|local       plain-http ports for private networks (default), or this machine only
  --rotate-token           replace the Forge token
  --no-start               write the files only

Docs: $DOCS_URL
EOF
}

valid_port() {
    case "$1" in '' | 0* | *[!0-9]*) return 1 ;; esac
    [ "${#1}" -le 5 ] && [ "$1" -le 65535 ]
}

valid_host() {
    case "$1" in
        '' | *[!A-Za-z0-9.-]* | .* | *. | *..*) return 1 ;;
        *.*) return 0 ;;
        *) return 1 ;;
    esac
}

valid_origin() {
    case "$1" in
        https://*) ;;
        *) return 1 ;;
    esac
    rest=${1#https://}
    host=${rest%%:*}
    case "$rest" in */* | *'?'* | *'#'*) return 1 ;; esac
    valid_host "$host" || return 1
    if [ "$host" != "$rest" ]; then valid_port "${rest#*:}" || return 1; fi
}

new_token() {
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

# write_file <path> <mode>: stdin to a new temporary file beside <path>, then rename it into place.
write_file() {
    tmp=$(mktemp "$1.XXXXXX")
    cat >"$tmp"
    chmod "$2" "$tmp"
    mv -f "$tmp" "$1"
}

# The address this machine uses to reach the internet, per family (empty if none).
route_src() {
    if have ip; then
        ip "-$1" route get "$2" 2>/dev/null | sed -n 's/.* src \([^ ]*\).*/\1/p' | head -n 1
    fi
}

# port_busy <tcp|udp> <port>: something on this machine already listens there (read from
# /proc/net, which every Linux has, so no ss or netstat is needed).
port_busy() {
    hex=$(printf '%04X' "$2")
    if [ "$1" = udp ]; then files="/proc/net/udp /proc/net/udp6"; else files="/proc/net/tcp /proc/net/tcp6"; fi
    # shellcheck disable=SC2086 # two file names
    cat $files 2>/dev/null | awk -v hex=":$hex" -v proto="$1" '
        NR > 1 && substr($2, length($2) - 4) == hex && (proto == "udp" || $4 == "0A") { found = 1 }
        END { exit found ? 0 : 1 }'
}

compose() {
    (cd "$DIR" && docker compose -p forge-backend -f compose.yaml "$@")
}

# Docker installed and usable by this user, or a clear way to get there.
need_docker() {
    if ! have docker; then
        if [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = Linux ] && [ "${FORGE_BACKEND_INSTALL_DOCKER:-1}" = 1 ]; then
            say "Docker is not installed. Installing it with Docker's script (get.docker.com)…"
            have curl || die "curl is needed to install Docker"
            curl -fsSL https://get.docker.com | sh || die "Docker did not install; install it yourself (https://docs.docker.com/engine/install/) and run this again"
        else
            die "Docker is not installed. Install Docker Engine with the compose plugin (https://docs.docker.com/engine/install/), or run this script as root to have it install Docker, then run it again"
        fi
    fi
    if ! docker info >/dev/null 2>&1; then
        if [ "$(id -u)" -ne 0 ]; then
            die "this user cannot use Docker. Run the same command with sudo (… | sudo sh), or add yourself to the docker group"
        fi
        die "the Docker daemon is not running. Start it (systemctl start docker) and run this again"
    fi
    docker compose version >/dev/null 2>&1 || die "Docker Compose is missing. Install the Docker Compose plugin (https://docs.docker.com/compose/install/linux/) and run this again"
}

load_settings() {
    DOMAIN="" EMAIL="" ORIGINS="" API_PORT=5001 GATEWAY_PORT=8080 SWARM_PORT=4001 LISTEN=
    if [ -f "$DIR/settings.env" ]; then
        # Our own file, but parse it rather than source it.
        while IFS='=' read -r key value; do
            case "$key" in
                DOMAIN) DOMAIN=$value ;;
                EMAIL) EMAIL=$value ;;
                ORIGINS) ORIGINS=$value ;;
                API_PORT) API_PORT=$value ;;
                GATEWAY_PORT) GATEWAY_PORT=$value ;;
                SWARM_PORT) SWARM_PORT=$value ;;
                LISTEN) LISTEN=$value ;;
            esac
        done <"$DIR/settings.env"
    fi
}

load_secrets() {
    OWNER_TOKEN="" FORGE_TOKEN=""
    if [ -f "$DIR/secrets.env" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                OWNER_TOKEN) OWNER_TOKEN=$value ;;
                FORGE_TOKEN) FORGE_TOKEN=$value ;;
            esac
        done <"$DIR/secrets.env"
    fi
}

unique_words() {
    printf '%s\n' "$@" | awk 'NF && !seen[$0]++' | tr '\n' ' ' | sed 's/ $//'
}

json_list() {
    out=
    for item in "$@"; do out="$out${out:+, }\"$item\""; done
    printf '[%s]' "$out"
}

write_compose() {
    write_file "$DIR/compose.yaml" 644 <<EOF
# Generated by backend.sh; re-run it to change settings ($DOCS_URL).
name: forge-backend
services:
  kubo:
    image: $KUBO_IMAGE
    restart: unless-stopped
    network_mode: host          # dual-stack swarm and AutoTLS need the host's own addresses
    env_file: secrets.env       # the init script turns these into kubo's API tokens
    volumes:
      - ./ipfs:/data/ipfs
      - ./init.d:/container-init.d:ro
    command: ["daemon", "--migrate=true"]
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:$INTERNAL_GATEWAY/ipfs/bafkqaaa || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 8
      start_period: 20s
  caddy:
    image: $CADDY_IMAGE
    restart: unless-stopped
    network_mode: host
    depends_on:
      - kubo
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./caddy/data:/data
      - ./caddy/config:/config
EOF
}

write_init() {
    mkdir -p "$DIR/init.d"
    # shellcheck disable=SC2086 # word lists by design
    origins_json=$(json_list $ALL_ORIGINS)
    # shellcheck disable=SC2086
    paths_json=$(json_list $RPC_PATHS)
    s=$SWARM_PORT
    write_file "$DIR/init.d/001-forge.sh" 755 <<EOF
#!/bin/sh
# Generated by backend.sh. Runs inside the kubo container before every start.
set -eu
: "\${OWNER_TOKEN:?}" "\${FORGE_TOKEN:?}"
ipfs config Addresses.API /ip4/127.0.0.1/tcp/$INTERNAL_API
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/$INTERNAL_GATEWAY
ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/$s", "/ip6/::/tcp/$s", "/ip4/0.0.0.0/tcp/$s/tls/sni/*.libp2p.direct/ws", "/ip6/::/tcp/$s/tls/sni/*.libp2p.direct/ws", "/ip4/0.0.0.0/udp/$s/quic-v1", "/ip4/0.0.0.0/udp/$s/quic-v1/webtransport", "/ip4/0.0.0.0/udp/$s/webrtc-direct", "/ip6/::/udp/$s/quic-v1", "/ip6/::/udp/$s/quic-v1/webtransport", "/ip6/::/udp/$s/webrtc-direct"]'
ipfs config --json AutoTLS.Enabled true
ipfs config --json Gateway.NoFetch true
ipfs config --json Gateway.DeserializedResponses true
ipfs config --json Gateway.HTTPHeaders '{"X-Content-Type-Options": ["nosniff"], "Content-Security-Policy": ["sandbox; default-src '"'"'none'"'"'"]}'
ipfs config --json API.HTTPHeaders '{"Access-Control-Allow-Origin": $origins_json, "Access-Control-Allow-Methods": ["POST"], "Access-Control-Allow-Headers": ["Authorization", "Content-Type"]}'
ipfs config --json API.Authorizations "{\"owner\": {\"AuthSecret\": \"bearer:\$OWNER_TOKEN\", \"AllowedPaths\": [\"/api/v0\"]}, \"dash-forge\": {\"AuthSecret\": \"bearer:\$FORGE_TOKEN\", \"AllowedPaths\": $(printf '%s' "$paths_json" | sed 's/"/\\"/g')}}"
EOF
}

write_caddyfile() {
    if [ "$LISTEN" = local ]; then
        bind="	bind 127.0.0.1 [::1]"
    else
        bind="	@outside not remote_ip $PRIVATE_NETS
	handle @outside {
		respond \"only private networks may use plain http here; use https\" 403
	}"
    fi
    if [ -n "$EMAIL" ]; then email_line="	email $EMAIL"; else email_line=; fi
    origin_lines=$(for o in $ALL_ORIGINS; do printf "\t\theader Origin %s\n" "$o"; done)
    domain_block=
    if [ -n "$DOMAIN" ]; then
        domain_block="
$DOMAIN {
	import rpc
	import gateway
	respond 404
}"
    fi
    write_file "$DIR/Caddyfile" 644 <<EOF
# Generated by backend.sh; re-run it to change settings ($DOCS_URL).
{
	admin off
$email_line
}

(rpc) {
	@preflight {
		method OPTIONS
		path /api/v0/*
$origin_lines
	}
	handle @preflight {
		header Access-Control-Allow-Origin {http.request.header.Origin}
		header Access-Control-Allow-Methods POST
		header Access-Control-Allow-Headers "Authorization, Content-Type"
		header Access-Control-Allow-Private-Network true
		header Access-Control-Max-Age 600
		header Vary Origin
		respond 204
	}
	@call {
		method POST
		path $RPC_PATHS
	}
	handle @call {
		reverse_proxy 127.0.0.1:$INTERNAL_API {
			header_up Host 127.0.0.1:$INTERNAL_API
			flush_interval -1
		}
	}
}

(gateway) {
	@read {
		method GET HEAD OPTIONS
		path /ipfs/*
	}
	handle @read {
		reverse_proxy 127.0.0.1:$INTERNAL_GATEWAY {
			header_up Host 127.0.0.1:$INTERNAL_GATEWAY
		}
	}
}

http://:$API_PORT {
$bind
	import rpc
	respond 404
}

http://:$GATEWAY_PORT {
$bind
	import gateway
	respond 404
}
$domain_block
EOF
}

host_addresses() {
    V4=$(route_src 4 1.1.1.1)
    V6=$(route_src 6 2606:4700:4700::1111)
    if [ -z "$V4" ] && have hostname; then
        V4=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -n 1 || true)
    fi
}

# The address dg and the web app should use for the plain-http ports.
lan_host() {
    if [ "$LISTEN" = local ]; then
        printf '127.0.0.1'
    elif [ -n "$V4" ]; then
        printf '%s' "$V4"
    elif [ -n "$V6" ]; then
        printf '[%s]' "$V6"
    else
        printf '127.0.0.1'
    fi
}

# curl_auth <url> [curl args…]: a POST with the Forge token, kept off the command line.
curl_auth() {
    url=$1
    shift
    # shellcheck disable=SC2086 # PROBE is a list of options
    printf 'header = "Authorization: Bearer %s"\n' "$FORGE_TOKEN" | curl $PROBE -sS -K - -X POST "$@" "$url"
}

wait_ready() {
    i=0
    while [ $i -lt 90 ]; do
        # shellcheck disable=SC2086
        code=$(curl $PROBE -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$API_PORT/api/v0/version" 2>/dev/null || true)
        case "$code" in 401 | 403) return 0 ;; esac
        i=$((i + 1))
        sleep 2
    done
    compose logs --tail 40 >&2 || true
    die "the node did not answer within 3 minutes (logs above; also: docker compose -p forge-backend logs)"
}

# The same checks as `dg storage test`, through the public ports.
self_test() {
    api="http://127.0.0.1:$API_PORT"
    gw="http://127.0.0.1:$GATEWAY_PORT"
    # shellcheck disable=SC2086
    code=$(curl $PROBE -s -o /dev/null -w '%{http_code}' -X POST "$api/api/v0/version" || true)
    case "$code" in 401 | 403) ;; *) die "the API answered $code without a token; expected a refusal" ;; esac
    code=$(curl_auth "$api/api/v0/config/show" -o /dev/null -w '%{http_code}' || true)
    [ "$code" = 404 ] || die "the API let a non-Forge call through ($code)"
    want="forge-backend self test $(new_token)"
    printf '%s\n' "$want" | write_file "$DIR/.self-test" 600
    cid=$(curl_auth "$api/api/v0/add?cid-version=1&raw-leaves=true&pin=true&quieter=true" -F "file=@$DIR/.self-test" | sed -n 's/.*"Hash":"\([^"]*\)".*/\1/p')
    rm -f -- "$DIR/.self-test"
    [ -n "$cid" ] || die "adding a test file through the API failed"
    # shellcheck disable=SC2086
    got=$(curl $PROBE -fsS "$gw/ipfs/$cid" || true)
    [ "$got" = "$want" ] || die "the gateway did not return the test file"
    https_ok=
    if [ -n "$DOMAIN" ]; then
        # Caddy gets the certificate on first start; give it two minutes.
        i=0
        while [ $i -lt 24 ]; do
            # shellcheck disable=SC2086
            got=$(curl $PROBE -fsS "https://$DOMAIN/ipfs/$cid" 2>/dev/null || true)
            if [ "$got" = "$want" ]; then https_ok=1; break; fi
            i=$((i + 1))
            sleep 5
        done
    fi
    curl_auth "$api/api/v0/pin/rm?arg=$cid" -o /dev/null -f || warn "could not unpin the test file $cid"
    say "  [ OK ] token required, Forge calls only, add + pin, gateway read, unpin"
    if [ -n "$https_ok" ]; then
        say "  [ OK ] https://$DOMAIN serves it with a valid certificate"
    elif [ -n "$DOMAIN" ]; then
        warn "https://$DOMAIN did not answer from this machine. Check that its DNS points here and ports 80 and 443 reach it (docker compose -p forge-backend logs caddy)"
    fi
}

kubo_owner() {
    # shellcheck disable=SC2016 # expanded inside the container
    compose exec -T kubo sh -c 'ipfs --api-auth "bearer:$OWNER_TOKEN" "$@"' sh "$@"
}

print_reachability() {
    addrs=$(kubo_owner id -f '<addrs>' 2>/dev/null || true)
    peer=$(kubo_owner id -f '<id>' 2>/dev/null || true)
    [ -n "$peer" ] && say "  Peer id          $peer"
    if printf '%s\n' "$addrs" | grep -q 'libp2p\.direct/tcp/.*/tls/ws'; then
        say "  Browser dialing  WSS with a libp2p.direct certificate (AutoTLS)"
    else
        say "  Browser dialing  not yet: AutoTLS needs the swarm port reachable from the internet"
    fi
    public=$(printf '%s\n' "$addrs" | grep -vE '/ip4/(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)|/ip6/(::1|f[cd]|fe80)|/p2p-circuit' | grep -E '^/ip[46]/' || true)
    if [ -n "$public" ]; then
        say "  Public addresses $(printf '%s\n' "$public" | sed -n 's#^/\(ip[46]\)/\([^/]*\)/.*#\1 \2#p' | sort -u | tr '\n' ' ')"
    else
        say "  Public addresses none yet. Forward TCP+UDP $SWARM_PORT to this machine so other nodes can fetch from it"
    fi
}

print_next() {
    host=$(lan_host)
    api="http://$host:$API_PORT"
    gw="http://$host:$GATEWAY_PORT"
    public_flag=
    if [ -n "$DOMAIN" ]; then
        api="https://$DOMAIN"
        gw="https://$DOMAIN"
        public_flag=" --public-gateway https://$DOMAIN"
    fi
    me=${OWNER_USER:-$(id -un 2>/dev/null || echo you)}
    where=$(lan_host | tr -d '[]')
    [ "$where" = 127.0.0.1 ] && where="<this machine>"
    say ""
    say "Next, on the computer you push from (needs dg: $INSTALL_DG_URL):"
    say ""
    say "  export FORGE_BACKEND_AUTH=\"\$(ssh $me@$where cat $DIR/forge-auth)\""
    say "  dg storage add forge-backend --kind ipfs-kubo --api $api --gateway $gw$public_flag --api-auth env:FORGE_BACKEND_AUTH"
    say "  dg storage test forge-backend && dg storage use forge-backend --global"
    say ""
    say "  FORGE_BACKEND_AUTH must be set wherever you push."
    if [ "$LISTEN" = local ] && [ -z "$DOMAIN" ]; then
        say "  The API listens on this machine only. From elsewhere, first: ssh -N -L $API_PORT:127.0.0.1:$API_PORT -L $GATEWAY_PORT:127.0.0.1:$GATEWAY_PORT $me@<this machine>"
    fi
    say ""
    if [ -n "$DOMAIN" ]; then
        say "In the web app: Settings → Storage → IPFS (kubo) → Set it up by hand:"
        say "  kubo RPC API $api · Gateway $gw · Public gateway https://$DOMAIN"
        say "  API Authorization header: the contents of $DIR/forge-auth"
    else
        say "The web app needs an https address for the node: re-run with --domain <name> to get one."
    fi
    say ""
    say "Status: curl -fsSL $SCRIPT_URL | sh -s -- status${ARG_DIR:+ --dir $DIR}"
    say "Docs:   $DOCS_URL"
}

cmd_up() {
    case "$(uname -s)" in
        Linux) ;;
        Darwin) die "on a Mac, run \`dg ipfs up\` instead: it sets up the same node for your user ($DOCS_URL)" ;;
        *) die "this script needs Linux with Docker; on other systems see $DOCS_URL" ;;
    esac
    have curl || die "curl is needed"
    [ -n "$ARG_NO_START" ] || need_docker

    if [ -d "$DIR" ] && [ ! -f "$DIR/settings.env" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
        die "$DIR already holds other files; choose an empty or new directory with --dir"
    fi
    for f in "$DIR" "$DIR/init.d" "$DIR/settings.env" "$DIR/secrets.env" "$DIR/forge-auth" "$DIR/compose.yaml" "$DIR/Caddyfile"; do
        [ ! -L "$f" ] || die "$f is a symbolic link; refusing to write through it"
    done
    mkdir -p "$DIR"
    chmod 700 "$DIR"
    load_settings
    load_secrets
    OLD_API_PORT=$API_PORT OLD_GATEWAY_PORT=$GATEWAY_PORT OLD_SWARM_PORT=$SWARM_PORT OLD_DOMAIN=$DOMAIN
    case " $ARG_ORIGINS " in
        *" none "*)
            ORIGINS=
            # shellcheck disable=SC2086 # word list by design
            ARG_ORIGINS=$(printf '%s\n' $ARG_ORIGINS | grep -vx none | tr '\n' ' ' || true)
            ;;
    esac
    [ -n "$ARG_DOMAIN" ] && DOMAIN=$ARG_DOMAIN
    [ "$DOMAIN" = none ] && DOMAIN=
    [ -n "$ARG_EMAIL" ] && EMAIL=$ARG_EMAIL
    # shellcheck disable=SC2086 # word lists by design
    [ -n "$ARG_ORIGINS" ] && ORIGINS=$(unique_words $ORIGINS $ARG_ORIGINS)
    [ -n "$ARG_API_PORT" ] && API_PORT=$ARG_API_PORT
    [ -n "$ARG_GATEWAY_PORT" ] && GATEWAY_PORT=$ARG_GATEWAY_PORT
    [ -n "$ARG_SWARM_PORT" ] && SWARM_PORT=$ARG_SWARM_PORT
    [ -n "$ARG_LISTEN" ] && LISTEN=$ARG_LISTEN

    [ -z "$DOMAIN" ] || valid_host "$DOMAIN" || die "--domain must be a host name such as ipfs.example.org"
    case "$DOMAIN" in example.org | *.example.org | example.com | *.example.com) die "replace $DOMAIN with a name whose DNS points at this machine" ;; esac
    case "$EMAIL" in '' | *@*.*) ;; *) die "--email must be an email address" ;; esac
    case "$EMAIL" in *[!A-Za-z0-9@._+-]*) die "--email must be an email address" ;; esac
    for p in "$API_PORT" "$GATEWAY_PORT" "$SWARM_PORT"; do valid_port "$p" || die "bad port: $p"; done
    for o in $ORIGINS; do valid_origin "$o" || die "--origin must be https://host or https://host:port, not $o"; done
    if [ "$API_PORT" = "$GATEWAY_PORT" ] || [ "$API_PORT" = "$SWARM_PORT" ] || [ "$GATEWAY_PORT" = "$SWARM_PORT" ]; then
        die "the API, gateway and swarm ports must differ"
    fi
    for p in "$API_PORT" "$GATEWAY_PORT" "$SWARM_PORT"; do
        case "$p" in "$INTERNAL_API" | "$INTERNAL_GATEWAY" | 80 | 443) die "port $p is used inside the stack; choose another" ;; esac
    done

    host_addresses
    [ -n "$LISTEN" ] || LISTEN=all
    case "$LISTEN" in all | local) ;; *) die "--listen must be all or local" ;; esac

    # shellcheck disable=SC2086
    ALL_ORIGINS=$(unique_words $DEFAULT_ORIGINS $ORIGINS)

    # Ports: refuse a clash with something that isn't this stack. While it runs, only the
    # ports it doesn't hold yet are checked.
    running=
    if [ -z "$ARG_NO_START" ]; then
        [ -z "$(compose ps -q 2>/dev/null || true)" ] || running=1
        tcp_ports="$API_PORT $GATEWAY_PORT $SWARM_PORT $INTERNAL_API $INTERNAL_GATEWAY"
        udp_port=$SWARM_PORT
        web_ports="80 443"
        if [ -n "$running" ]; then
            tcp_ports=
            [ "$API_PORT" = "$OLD_API_PORT" ] || tcp_ports="$tcp_ports $API_PORT"
            [ "$GATEWAY_PORT" = "$OLD_GATEWAY_PORT" ] || tcp_ports="$tcp_ports $GATEWAY_PORT"
            [ "$SWARM_PORT" = "$OLD_SWARM_PORT" ] || tcp_ports="$tcp_ports $SWARM_PORT"
            [ "$SWARM_PORT" = "$OLD_SWARM_PORT" ] && udp_port=
            [ -z "$OLD_DOMAIN" ] || web_ports=
        fi
        for p in $tcp_ports; do
            ! port_busy tcp "$p" || die "TCP port $p is already in use. Stop what uses it, or pick other ports (--api-port, --gateway-port, --swarm-port)"
        done
        [ -z "$udp_port" ] || ! port_busy udp "$udp_port" || die "UDP port $udp_port is already in use; pick another with --swarm-port"
        if [ -n "$DOMAIN" ]; then
            for p in $web_ports; do
                ! port_busy tcp "$p" || die "--domain needs ports 80 and 443, and $p is in use. Free them, or run without --domain"
            done
        fi
    fi

    rotated=
    [ -n "$OWNER_TOKEN" ] || OWNER_TOKEN=$(new_token)
    if [ -z "$FORGE_TOKEN" ] || [ -n "$ARG_ROTATE" ]; then
        [ -z "$FORGE_TOKEN" ] || rotated=1
        FORGE_TOKEN=$(new_token)
    fi
    printf 'OWNER_TOKEN=%s\nFORGE_TOKEN=%s\n' "$OWNER_TOKEN" "$FORGE_TOKEN" | write_file "$DIR/secrets.env" 600
    printf 'Bearer %s\n' "$FORGE_TOKEN" | write_file "$DIR/forge-auth" 600
    {
        say "# backend.sh settings (no secrets). Edit with backend.sh options, not by hand."
        say "DOMAIN=$DOMAIN"
        say "EMAIL=$EMAIL"
        say "ORIGINS=$ORIGINS"
        say "API_PORT=$API_PORT"
        say "GATEWAY_PORT=$GATEWAY_PORT"
        say "SWARM_PORT=$SWARM_PORT"
        say "LISTEN=$LISTEN"
    } | write_file "$DIR/settings.env" 644
    mkdir -p "$DIR/ipfs" "$DIR/caddy/data" "$DIR/caddy/config"
    write_compose
    write_init
    write_caddyfile
    [ -z "$OWNER_USER" ] || chown -h "$OWNER_USER" "$DIR" "$DIR/forge-auth"

    if [ -n "$ARG_NO_START" ]; then
        say "Wrote the backend files to $DIR (not started)."
        return 0
    fi

    say "Starting the Forge backend in $DIR …"
    compose pull -q
    stamp=$(cat "$DIR/compose.yaml" "$DIR/Caddyfile" "$DIR/init.d/001-forge.sh" "$DIR/secrets.env" | cksum | awk '{ print $1 }')
    old_stamp=$(cat "$DIR/.applied" 2>/dev/null || true)
    if [ -n "$running" ] && [ "$stamp" != "$old_stamp" ]; then
        compose up -d --remove-orphans --force-recreate
    else
        compose up -d --remove-orphans
    fi
    printf '%s\n' "$stamp" | write_file "$DIR/.applied" 600

    open_firewall
    wait_ready
    self_test
    [ -z "$rotated" ] || warn "the Forge token changed: update FORGE_BACKEND_AUTH where you push, and the web app profile"
    say ""
    say "Forge backend is running (IPv4 + IPv6)."
    print_status_lines
    print_next
}

# ufw on a server blocks the swarm (and the LAN API) under host networking. As root, open what
# the backend needs; otherwise say which rules to add.
open_firewall() {
    have ufw || return 0
    if [ "$(id -u)" -eq 0 ]; then
        ufw status 2>/dev/null | grep -q '^Status: active' || return 0
    fi
    rules="$SWARM_PORT/tcp $SWARM_PORT/udp"
    [ -z "$DOMAIN" ] || rules="$rules 80/tcp 443/tcp"
    lan=
    if [ "$LISTEN" = all ]; then
        for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10; do
            for p in "$API_PORT" "$GATEWAY_PORT"; do lan="$lan $net,$p"; done
        done
    fi
    if [ "$(id -u)" -ne 0 ]; then
        say "  If ufw is active, also allow: $rules${lan:+ (and ports $API_PORT, $GATEWAY_PORT/tcp from your LAN)}; run this script with sudo to have it add them"
        return 0
    fi
    for r in $rules; do ufw allow "$r" comment forge-backend >/dev/null; done
    for r in $lan; do ufw allow from "${r%,*}" to any port "${r#*,}" proto tcp comment forge-backend >/dev/null; done
    say "  [ OK ] ufw: allowed $rules${lan:+, and $API_PORT and $GATEWAY_PORT/tcp from private networks}"
}

print_status_lines() {
    host=$(lan_host)
    say "  Push API         http://$host:$API_PORT (token required; add, pin, unpin, id, version only)"
    say "  Read gateway     http://$host:$GATEWAY_PORT (serves only what this node stores)"
    [ -z "$DOMAIN" ] || say "  Public https     https://$DOMAIN (API and gateway)"
    say "  IPFS swarm       TCP+UDP $SWARM_PORT"
    say "  Token            $DIR/forge-auth (mode 0600, never printed)"
    print_reachability
}

cmd_status() {
    [ -f "$DIR/settings.env" ] || die "no backend in $DIR (use --dir, or run without arguments to set one up)"
    need_docker
    load_settings
    load_secrets
    host_addresses
    compose ps
    say ""
    print_status_lines
    stored=$(kubo_owner repo stat -s 2>/dev/null | sed -n 's/^RepoSize:[[:space:]]*//p' || true)
    [ -z "$stored" ] || say "  Stored           $stored bytes"
    print_next
}

cmd_down() {
    [ -f "$DIR/compose.yaml" ] || die "no backend in $DIR"
    need_docker
    compose down
    say "Stopped. Your data, tokens and settings stay in $DIR; run this script again to start it."
}

main() {
    CMD=up
    ARG_DIR="" ARG_DOMAIN="" ARG_EMAIL="" ARG_ORIGINS="" ARG_API_PORT="" ARG_GATEWAY_PORT="" ARG_SWARM_PORT=""
    ARG_LISTEN="" ARG_ROTATE="" ARG_NO_START=""
    while [ $# -gt 0 ]; do
        case "$1" in
            up | status | down) CMD=$1 ;;
            help | -h | --help) usage; return 0 ;;
            --dir | --domain | --email | --origin | --api-port | --gateway-port | --swarm-port | --listen)
                [ $# -ge 2 ] || die "$1 needs a value"
                case "$1" in
                    --dir) ARG_DIR=$2 ;;
                    --domain) ARG_DOMAIN=$2 ;;
                    --email) ARG_EMAIL=$2 ;;
                    --origin) ARG_ORIGINS="$ARG_ORIGINS $2" ;;
                    --api-port) ARG_API_PORT=$2 ;;
                    --gateway-port) ARG_GATEWAY_PORT=$2 ;;
                    --swarm-port) ARG_SWARM_PORT=$2 ;;
                    --listen) ARG_LISTEN=$2 ;;
                esac
                shift
                ;;
            --rotate-token) ARG_ROTATE=1 ;;
            --no-start) ARG_NO_START=1 ;;
            *) die "unknown argument: $1 (see --help)" ;;
        esac
        shift
    done
    # Under sudo, the files belong to the user who ran it, so they can read forge-auth.
    OWNER_USER=
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
        OWNER_USER=$SUDO_USER
    fi
    if [ -n "$ARG_DIR" ]; then
        DIR=$ARG_DIR
    elif [ -n "${FORGE_BACKEND_DIR:-}" ]; then
        DIR=$FORGE_BACKEND_DIR
    elif [ -n "$OWNER_USER" ]; then
        home=$(getent passwd "$OWNER_USER" 2>/dev/null | cut -d: -f6)
        DIR="${home:-/home/$OWNER_USER}/forge-backend"
    elif [ "$(id -u)" -eq 0 ]; then
        DIR=/opt/forge-backend
    else
        DIR="${HOME:?HOME is not set}/forge-backend"
    fi
    case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac
    # sudo's secure_path may lack /usr/local/bin, where some systems keep docker.
    PATH="$PATH:/usr/local/bin"
    case "$CMD" in
        up) cmd_up ;;
        status) cmd_status ;;
        down) cmd_down ;;
    esac
}

main "$@"
