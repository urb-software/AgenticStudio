#!/bin/bash
# Throwaway: who can reach a Preview service at HOST:PORT (plain HTTP, the echo server answers "hello-plain").
# usage: probe-routing.sh HOST PORT
H=$1; P=$2
try() { # label, command...
	local l=$1; shift
	if out=$("$@" 2>&1) && [ -n "$out" ]; then echo "$l: REACHED ($(echo "$out" | head -1 | cut -c1-40))"; else echo "$l: blocked"; fi
}
try "host root           " curl -s -m4 "http://$H:$P/"
for u in agent other; do try "host user $u (not the proxy)" asu $u curl -s -m4 "http://$H:$P/"; done
try "agent's rootless container" asu agent docker run --rm alpine:3.22 sh -c "printf 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' | nc -w3 $H $P | tail -1"
try "studio network, other container" sudo docker run --rm --network studio-trial alpine:3.22 sh -c "printf 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' | nc -w3 $H $P | tail -1"
try "proxy container (Caddy)" sudo docker exec caddy wget -q -T3 -O- --header 'Host: x' "http://$H:$P/"
