#!/bin/bash
# Throwaway: what can a Preview container (rootless daemon of user "preview") reach?
# usage: probe-network.sh HOSTADDR   (HOSTADDR: an address of the trial host that is not loopback)
H=$1
probe() { # label, url
	if asu preview docker run --rm alpine:3.22 wget -q -T4 -O /dev/null "$2" 2>/dev/null; then echo "$1: REACHED"; else echo "$1: blocked"; fi
}
probe "outbound HTTPS (example.com)           " https://example.com
probe "slirp gateway = host loopback (10.0.2.2:19999)" http://10.0.2.2:19999/
probe "host address, non-loopback ($H:19998)   " http://$H:19998/
probe "Studio stand-in service (172.31.250.10:8000)" http://172.31.250.10:8000/
probe "the proxy (172.31.250.2:8081)          " http://172.31.250.2:8081/
probe "agent's published port ($H:28080)      " http://$H:28080/
