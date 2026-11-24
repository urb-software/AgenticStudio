#!/bin/bash
# Throwaway: isolation checks between users "agent" and "preview" (needs the asu helper).
P=$(id -u preview); A=$(id -u agent)
echo "# setup: one container and one volume per user"
asu agent docker run -d --name agent-box -v agent-vol:/data alpine:3.22 sh -c 'echo agent-secret > /data/s; sleep 3600'
asu preview docker run -d --name preview-box -v preview-vol:/data alpine:3.22 sh -c 'echo preview-secret > /data/s; sleep 3600'
echo "# own view"
asu agent docker ps --format '{{.Names}}'; asu agent docker volume ls --format '{{.Name}}'
asu preview docker ps --format '{{.Names}}'; asu preview docker volume ls --format '{{.Name}}'
echo "# sockets"
ls -l /run/user/$A/docker.sock /run/user/$P/docker.sock; ls -ld /run/user/$A /run/user/$P
echo "# agent -> preview socket"
asu agent env DOCKER_HOST=unix:///run/user/$P/docker.sock docker ps
asu agent curl -s --unix-socket /run/user/$P/docker.sock http://localhost/containers/json; echo "curl exit $?"
echo "# preview -> agent socket"
asu preview env DOCKER_HOST=unix:///run/user/$A/docker.sock docker ps
echo "# other -> both sockets"
asu other env DOCKER_HOST=unix:///run/user/$P/docker.sock docker ps
asu other env DOCKER_HOST=unix:///run/user/$A/docker.sock docker ps
echo "# data-root"
ls -ld /home/agent /home/preview /home/agent/.local/share/docker /home/preview/.local/share/docker
asu agent ls /home/preview/.local/share/docker/volumes
asu agent cat /home/preview/.local/share/docker/volumes/preview-vol/_data/s
asu preview ls /home/agent/.local/share/docker/volumes
asu other ls /home/preview/.local/share/docker
echo "# not in docker group, no sudo"
id agent; id preview; getent group docker
asu agent sudo -n true; asu preview sudo -n true
echo "# system docker socket"
ls -l /var/run/docker.sock
asu agent docker -H unix:///var/run/docker.sock ps
asu preview docker -H unix:///var/run/docker.sock ps
echo "# rootlesskit proc view"
asu agent ps -eo user,pid,args | grep -E "rootlesskit|dockerd" | grep -v grep | cut -c1-150
echo "# agent cannot see preview's process environment"
PP=$(pgrep -u preview dockerd | head -1); asu agent cat /proc/$PP/environ | head -c 50; echo "exit=$?"
