#!/usr/bin/env bash
# dashhq's forge-gateways on one Docker + Caddy host, behind the Cloudflare proxy.
# Idempotent: run any step again at any time. See README.md next to this file.
#
#   deploy.sh up <mainnet|testnet>       start or update the gateway (no sudo: docker group)
#   deploy.sh caddy <mainnet|testnet>... serve those hostnames through Caddy (sudo; only after
#                                        their DNS points at this host, so ACME can succeed)
#   deploy.sh verify <mainnet|testnet>   readyz + a plain git clone on loopback, and over the
#                                        host's public IPv4 and IPv6 once Caddy serves it
#   deploy.sh down <mainnet|testnet>     stop it (keeps the mirror volume; its Caddy site
#                                        then answers 502 until it is up again)
set -euo pipefail

REV=${FORGE_REV:-master}
RAW="https://raw.githubusercontent.com/PastaPastaPasta/dash-forge/$REV/services/forge-gateway"
BASE=${FORGE_GATEWAY_HOME:-$HOME/forge-gateway}
CADDY_INCLUDE=/etc/caddy/forge-gateway.caddy
CADDYFILE=/etc/caddy/Caddyfile

die() { echo "deploy.sh: $*" >&2; exit 1; }
net_ok() { [[ ${1:-} == mainnet || ${1:-} == testnet ]] || die "network must be mainnet or testnet"; }
host_of() { [[ $1 == mainnet ]] && echo git-forge.dashhq.org || echo testnet-git-forge.dashhq.org; }
snippet_of() { [[ $1 == mainnet ]] && echo forge_gateway_mainnet || echo forge_gateway; }
port_of() { [[ $1 == mainnet ]] && echo 18081 || echo 18082; }
sample_of() { [[ $1 == mainnet ]] && echo "${FORGE_SAMPLE_REPO:-forg3/dash-forge}" || echo "${FORGE_SAMPLE_REPO:-AyvEsSQfK5qBotCsi2gZpePa7DcniqWzZ281TaNsJGv7/forge-v2-demo}"; }

fetch() {
  if ! curl -fsSL --retry 3 "$RAW/$1" -o "$2.tmp"; then rm -f "$2.tmp"; die "could not fetch $1 at $REV"; fi
  mv "$2.tmp" "$2"
}

up() {
  local net=$1 dir=$BASE/$1 port; port=$(port_of "$net")
  mkdir -p "$dir/deny"
  fetch docker-compose.yml "$dir/docker-compose.yml"
  fetch deploy/dashhq/docker-compose.override.yml "$dir/docker-compose.override.yml"
  fetch "deploy/dashhq/$net.env" "$dir/.env"
  [[ -f $dir/deny/deny.txt ]] || : > "$dir/deny/deny.txt"
  chmod 0644 "$dir/deny/deny.txt"
  if ! docker compose --project-directory "$dir" ps --status running -q 2>/dev/null | grep -q .; then
    ! ss -Hltn "sport = :$port" | grep -q . || die "127.0.0.1:$port is taken by something else"
  fi
  df -h "$(docker info -f '{{.DockerRootDir}}')" | tail -1 | awk '{print "docker disk free: "$4}'
  free -h | awk '/Mem:/{print "memory available: "$7" (the gateway is capped at 2g)"}'
  docker compose --project-directory "$dir" pull -q
  docker compose --project-directory "$dir" up -d --remove-orphans
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$port/readyz" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -fsS "http://127.0.0.1:$port/readyz"; echo
}

caddy_step() {
  local tmp added_import=0; tmp=$(mktemp)
  fetch deploy/dashhq/forge-gateway.caddy "$tmp"
  for net in "$@"; do
    net_ok "$net"
    printf '\n%s {\n\timport %s %s\n}\n' "$(host_of "$net")" "$(snippet_of "$net")" "$(port_of "$net")" >> "$tmp"
  done
  # Keep the sites enabled earlier.
  if sudo test -f "$CADDY_INCLUDE"; then
    for net in mainnet testnet; do
      local h; h=$(host_of "$net")
      if sudo grep -q "^$h {" "$CADDY_INCLUDE" && ! grep -q "^$h {" "$tmp"; then
        printf '\n%s {\n\timport %s %s\n}\n' "$h" "$(snippet_of "$net")" "$(port_of "$net")" >> "$tmp"
      fi
    done
  fi
  if ! sudo test -f "$CADDYFILE.bak-pre-forge-gateway"; then sudo cp "$CADDYFILE" "$CADDYFILE.bak-pre-forge-gateway"; fi
  sudo rm -f "$CADDY_INCLUDE.prev"
  if sudo test -f "$CADDY_INCLUDE"; then sudo cp "$CADDY_INCLUDE" "$CADDY_INCLUDE.prev"; fi
  # The include goes in place before the Caddyfile imports it.
  sudo install -m 0644 "$tmp" "$CADDY_INCLUDE.new"
  sudo mv "$CADDY_INCLUDE.new" "$CADDY_INCLUDE"
  rm -f "$tmp"
  if ! sudo grep -qxF "import $CADDY_INCLUDE" "$CADDYFILE"; then
    sudo cp "$CADDYFILE" "$CADDYFILE.prev"
    printf '\nimport %s\n' "$CADDY_INCLUDE" | sudo tee -a "$CADDYFILE" >/dev/null
    added_import=1
  fi
  restore() {
    if sudo test -f "$CADDY_INCLUDE.prev"; then sudo mv "$CADDY_INCLUDE.prev" "$CADDY_INCLUDE"; else sudo rm -f "$CADDY_INCLUDE"; fi
    if [[ $added_import == 1 ]]; then sudo mv "$CADDYFILE.prev" "$CADDYFILE"; fi
  }
  if ! sudo caddy validate --adapter caddyfile --config "$CADDYFILE" >/dev/null; then
    sudo caddy validate --adapter caddyfile --config "$CADDYFILE" || true
    restore
    die "Caddy rejected the config; restored the previous one, nothing reloaded"
  fi
  if ! sudo systemctl reload caddy; then
    restore
    sudo systemctl reload caddy || true
    die "Caddy failed to reload; restored the previous config and reloaded it"
  fi
  echo "Caddy reloaded; serving: $(sudo grep -E '^[a-z0-9.-]+ \{' "$CADDY_INCLUDE" | tr -d '{' | xargs)"
}

clone_check() {
  local label=$1 url=$2; shift 2
  local d; d=$(mktemp -d)
  if git "$@" clone -q --depth 1 "$url" "$d/r" 2>"$d/err"; then
    echo "PASS $label: $(git -C "$d/r" rev-parse HEAD)"
  else
    echo "FAIL $label: $(tail -2 "$d/err")"; rm -rf "$d"; return 1
  fi
  rm -rf "$d"
}

retry() {
  local n=$1; shift
  for i in $(seq 1 "$n"); do
    "$@" && return 0
    [[ $i == "$n" ]] || { echo "  retrying in 20 s"; sleep 20; }
  done
  return 1
}

verify() {
  local net=$1 host port repo rc=0 v4 v6
  host=$(host_of "$net"); port=$(port_of "$net"); repo=$(sample_of "$net")
  local ready; ready=$(curl -fsS "http://127.0.0.1:$port/readyz") || die "readyz unreachable on 127.0.0.1:$port"
  echo "readyz: $ready"
  grep -q "\"network\":\"$net\"" <<<"$ready" || { echo "FAIL readyz network is not $net"; rc=1; }
  [[ -n $repo ]] || { echo "set FORGE_SAMPLE_REPO=<owner>/<name> (a public $net repository) for the clone checks"; return $rc; }
  clone_check "loopback http://127.0.0.1:$port/$repo.git" "http://127.0.0.1:$port/$repo.git" || rc=1
  if grep -qs "^$host {" "$CADDY_INCLUDE"; then
    # http.curloptResolve (pinning the address) needs git 2.37; older git ignores it silently.
    if ! printf '2.37\n%s\n' "$(git --version | awk '{print $3}')" | sort -V -C; then
      echo "FAIL origin checks need git 2.37 or later (have $(git --version))"; return 1
    fi
    v4=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Ev '^(10|127)\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.168\.' | head -1 || true)
    v6=$(ip -6 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | grep -Evi '^f[cd]' | head -1 || true)
    # Caddy gets the certificate in the background after a reload: give it a minute.
    if [[ -n $v4 ]]; then
      retry 4 clone_check "origin IPv4 $v4" "https://$host/$repo.git" -c "http.curloptResolve=$host:443:$v4" || rc=1
    else
      echo "FAIL origin IPv4: this host has no public IPv4 address"; rc=1
    fi
    if [[ -n $v6 ]]; then
      retry 4 clone_check "origin IPv6 $v6" "https://$host/$repo.git" -c "http.curloptResolve=$host:443:[$v6]" || rc=1
    else
      echo "FAIL origin IPv6: this host has no public IPv6 address"; rc=1
    fi
  else
    echo "skip origin checks: Caddy does not serve $host yet (deploy.sh caddy $net)"
  fi
  return $rc
}

cmd=${1:-}; shift || true
case $cmd in
  up) net_ok "${1:-}"; up "$1" ;;
  caddy) [[ $# -ge 1 ]] || die "name at least one network"; caddy_step "$@" ;;
  verify) net_ok "${1:-}"; verify "$1" ;;
  down) net_ok "${1:-}"; docker compose --project-directory "$BASE/$1" down ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
