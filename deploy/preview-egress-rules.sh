#!/bin/bash
# The Previews' egress rules (ADR 0004; security.md section 5). Installed by deploy/setup-server.sh
# as /usr/local/lib/agentic-studio/preview-egress-rules (root-owned, 0755), @PREVIEW_DNS@ filled in.
#
# Keeps Preview containers (and their builds) off every private range, Studio's networks and the
# host's own addresses, except DNS to the resolver in the daemon's daemon.json. Outbound internet
# stays open. The rules live in the DOCKER-USER chain of the Preview user's rootless Docker
# daemon's own network namespace and match the output interface of its slirp4netns tap (tap0).
#
#   apply         Run as the Preview user outside the namespace (the docker.service drop-in does,
#                 after every daemon start): reads the host's global IPv4 addresses, notes them in
#                 $XDG_RUNTIME_DIR/preview-egress-hosts, then runs `apply-inside` in the namespace
#                 through nsenter.
#   apply-inside  Replaces the chain's rules in one step (iptables-restore), drops an IPv6 default
#                 route, and checks the result.
#   verify        Run inside the namespace (the controller runs it through nsenter before every
#                 build and up): exit 0 only when every expected rule is in place, in order, with
#                 no other rule, and the namespace has no IPv6 default route. Within 30 seconds.
#                 (`verify-inside` is its body.)
#
# The rules guard the containers, not the Preview user (who owns the namespace and the daemon).
set -euo pipefail
PATH=/usr/local/sbin:/usr/sbin:/usr/local/bin:/usr/bin:/sbin:/bin
export PATH

DNS_SERVER="@PREVIEW_DNS@"
# slirp4netns's own DNS forwarder address (the default resolver of rootless containers).
SLIRP_DNS="10.0.2.3"
RESERVED=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10)
CHAIN="DOCKER-USER"

RUN_DIR="${XDG_RUNTIME_DIR:-}"
HOSTS_FILE="${PREVIEW_EGRESS_HOSTS_FILE:-$RUN_DIR/preview-egress-hosts}"

die() {
  echo "preview-egress-rules: $*" >&2
  exit 1
}

# One rule per line: what follows `-A DOCKER-USER`.
rule_specs() {
  local resolver proto net host
  for resolver in $(printf '%s\n' "$DNS_SERVER" "$SLIRP_DNS" | sort -u); do
    for proto in udp tcp; do
      echo "-o tap0 -d $resolver/32 -p $proto --dport 53 -j RETURN"
    done
  done
  for net in "${RESERVED[@]}"; do
    echo "-o tap0 -d $net -j REJECT"
  done
  while read -r host; do
    [ -z "$host" ] || echo "-o tap0 -d $host/32 -j REJECT"
  done <"$HOSTS_FILE"
  echo "-j RETURN"
}

verify_inside() {
  [ -n "$RUN_DIR" ] || [ -n "${PREVIEW_EGRESS_HOSTS_FILE:-}" ] || return 1
  [ -r "$HOSTS_FILE" ] || return 1
  iptables -S "$CHAIN" >/dev/null 2>&1 || return 1
  local expected=() spec actual
  mapfile -t expected < <(rule_specs)
  actual="$(iptables -S "$CHAIN" | grep -c "^-A $CHAIN " || true)"
  [ "$actual" = "${#expected[@]}" ] || return 1
  for spec in "${expected[@]}"; do
    # shellcheck disable=SC2086 # the rule is a list of words
    iptables -C "$CHAIN" $spec 2>/dev/null || return 1
  done
  # Order: every DNS exception before the first reject, and the chain ends in RETURN.
  iptables -S "$CHAIN" | grep "^-A $CHAIN " | awk '
    /--dport 53/ { last_dns = NR }
    /-j REJECT/ { if (!first_reject) first_reject = NR }
    { last = $0 }
    END { exit !(first_reject > last_dns && last ~ /-j RETURN$/) }' || return 1
  [ -z "$(ip -6 route show default 2>/dev/null)" ] || return 1
}

apply_inside() {
  local _
  for _ in $(seq 1 30); do
    iptables -S "$CHAIN" >/dev/null 2>&1 && break
    sleep 1
  done
  iptables -S "$CHAIN" >/dev/null 2>&1 || die "the $CHAIN chain does not exist (is the daemon running?)"
  {
    echo "*filter"
    echo ":$CHAIN - [0:0]"
    rule_specs | sed "s/^/-A $CHAIN /"
    echo "COMMIT"
  } | iptables-restore --noflush
  # No IPv6 egress for Previews.
  ip -6 route flush default 2>/dev/null || true
  verify_inside || die "the rules are not in place after applying them"
}

apply_outside() {
  [ -n "$RUN_DIR" ] || die "XDG_RUNTIME_DIR is not set"
  local pid="" _ hosts
  for _ in $(seq 1 30); do
    pid="$(cat "$RUN_DIR/dockerd-rootless/child_pid" 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] && [ -d "/proc/$pid" ] && break
    sleep 1
  done
  [[ "$pid" =~ ^[0-9]+$ ]] || die "the rootless daemon's namespace is unknown (no $RUN_DIR/dockerd-rootless/child_pid)"
  # The host's global IPv4 addresses, read here: inside the namespace they are not visible.
  hosts="$(ip -4 -o addr show scope global | awk '{ split($4, a, "/"); print a[1] }' | sort -u)"
  [ -n "$hosts" ] || die "the host has no global IPv4 address to reject"
  (
    umask 077
    printf '%s\n' "$hosts" >"$HOSTS_FILE.new"
    mv -f "$HOSTS_FILE.new" "$HOSTS_FILE"
  )
  nsenter -U --preserve-credentials -n -t "$pid" "$(readlink -f "$0")" apply-inside
}

case "${1:-}" in
  apply) apply_outside ;;
  apply-inside) apply_inside ;;
  verify)
    # Within 30 seconds, whatever iptables does.
    timeout 30 "$(readlink -f "$0")" verify-inside || {
      echo "preview egress rules are missing" >&2
      exit 1
    }
    ;;
  verify-inside) verify_inside ;;
  *)
    echo "usage: $0 apply|apply-inside|verify" >&2
    exit 2
    ;;
esac
