#!/bin/bash
# Throwaway helper (installed as /usr/local/bin/asu): run a command as USER with that user's rootless Docker socket.
u=$1; shift; uid=$(id -u "$u")
exec sudo -u "$u" env XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus DOCKER_HOST=unix:///run/user/$uid/docker.sock HOME=/home/"$u" bash -c 'cd ~; exec "$@"' _ "$@"
