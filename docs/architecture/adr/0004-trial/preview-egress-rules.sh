#!/bin/bash
# Throwaway: run as the Preview user after its rootless daemon is up. Keeps Preview containers off
# private ranges (Studio's networks, the host's own addresses, other users' published ports),
# except DNS to the daemon's resolver. Rules live in the daemon's own network namespace.
set -euo pipefail
RUN=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
PID=$(cat "$RUN/dockerd-rootless/child_pid")
NS=(nsenter -U --preserve-credentials -n -t "$PID")
for _ in $(seq 1 30); do "${NS[@]}" iptables -S DOCKER-USER >/dev/null 2>&1 && break; sleep 1; done
"${NS[@]}" iptables -F DOCKER-USER
RESOLVERS=$(awk '/^nameserver/{print $2}' /etc/resolv.conf)
for r in $RESOLVERS 10.0.2.3; do
	for p in udp tcp; do "${NS[@]}" iptables -A DOCKER-USER -o tap0 -d "$r" -p $p --dport 53 -j RETURN; done
done
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
	"${NS[@]}" iptables -A DOCKER-USER -o tap0 -d "$net" -j REJECT
done
"${NS[@]}" iptables -A DOCKER-USER -j RETURN
