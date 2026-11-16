#!/usr/bin/env bash
# Studio's managed guardrails on the local WSL test worker, for the real-CLI smoke (Issue #134).
# NOT PART OF CI AND NEVER ON THE SERVER: there, deploy/setup-server.sh --only guardrails installs
# them. Run as root by the coordinator, before and after the smoke scripts:
#
#   sudo bash apps/agent-worker/scripts/smoke-guardrails.sh install   # before the smoke
#   sudo bash apps/agent-worker/scripts/smoke-guardrails.sh status
#   sudo bash apps/agent-worker/scripts/smoke-guardrails.sh remove    # afterwards
#
# `install` copies the files listed in apps/agent-worker/guardrails/managed-files.txt from this
# checkout (the copies the built worker compares them with) to their managed paths, root:root,
# files 0644, directories 0755, and Node.js to /usr/local/bin/node when it is not there (a copy of
# SMOKE_NODE_BIN, default: the `node` on PATH; root-owned, 0755). It refuses to replace a file that
# differs from Studio's copy. Everything it created is listed in a root-only state file; `remove`
# deletes exactly that (a file only while it is still Studio's copy) and the state file.
# It prints paths and yes/no lines only.
set -Eeuo pipefail
umask 022

GUARDRAILS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../guardrails" && pwd)"
MANIFEST="$GUARDRAILS/managed-files.txt"
STATE=/root/.agentic-studio-smoke-guardrails
NODE=/usr/local/bin/node

die() {
  printf 'smoke-guardrails: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "run as root (sudo)."
[ -f "$MANIFEST" ] || die "$MANIFEST not found."

# The manifest's entries as "<source> <installed path>" lines.
entries() {
  local provider source dest rest
  while read -r provider source dest rest; do
    case "$provider" in '' | '#'*) continue ;; esac
    if [ -n "$rest" ] || ! [[ "$source" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "$dest" != /* ]] || [[ "$dest" == *..* ]]; then
      die "malformed line in $MANIFEST."
    fi
    printf '%s %s\n' "$source" "$dest"
  done <"$MANIFEST" | sort -u
}

record() { printf '%s %s\n' "$1" "$2" >>"$STATE"; }

install_files() {
  [ ! -e "$STATE" ] || die "$STATE exists: an earlier install was not removed; run remove first."
  install -m 0600 /dev/null "$STATE"
  local source dest dir missing
  while read -r source dest; do
    if [ -L "$dest" ] || { [ -e "$dest" ] && ! cmp -s "$GUARDRAILS/$source" "$dest"; }; then
      die "$dest exists and is not Studio's copy; not replacing it."
    fi
  done < <(entries)
  while read -r source dest; do
    dir="$(dirname "$dest")"
    missing=()
    while [ ! -d "$dir" ]; do
      missing=("$dir" "${missing[@]}")
      dir="$(dirname "$dir")"
    done
    for dir in "${missing[@]}"; do
      install -d -o root -g root -m 0755 "$dir"
      record dir "$dir"
    done
    if [ ! -e "$dest" ]; then
      install -o root -g root -m 0644 "$GUARDRAILS/$source" "$dest"
      record file "$dest"
    fi
  done < <(entries)
  if [ ! -e "$NODE" ]; then
    local node="${SMOKE_NODE_BIN:-$(command -v node || true)}"
    if [ -z "$node" ] || [ ! -x "$node" ]; then die "no Node.js to copy to $NODE (set SMOKE_NODE_BIN)."; fi
    install -o root -g root -m 0755 "$(readlink -f "$node")" "$NODE"
    record node "$NODE"
  fi
  status
}

status() {
  local source dest ok=yes
  while read -r source dest; do
    if [ -f "$dest" ] && [ ! -L "$dest" ] && [ "$(stat -c '%U:%G %a' "$dest")" = "root:root 644" ] &&
      cmp -s "$GUARDRAILS/$source" "$dest"; then
      printf '%s: in place (root:root 0644, Studio'"'"'s copy)\n' "$dest"
    else
      printf '%s: NOT in place\n' "$dest"
      ok=no
    fi
  done < <(entries)
  if [ -f "$NODE" ] && [ ! -L "$NODE" ] && [ "$(stat -c %U "$NODE")" = root ]; then
    printf '%s: root-owned file (%s)\n' "$NODE" "$("$NODE" --version)"
  else
    printf '%s: NOT a root-owned file\n' "$NODE"
    ok=no
  fi
  printf 'managed guardrails in place: %s\n' "$ok"
}

remove_files() {
  [ -f "$STATE" ] || die "nothing to remove ($STATE not found)."
  local kind path
  # Files first, then directories, deepest first.
  while read -r kind path; do
    case "$kind" in
      file)
        local source
        source="$(entries | awk -v dest="$path" '$2 == dest { print $1 }')"
        if [ -n "$source" ] && [ -f "$path" ] && cmp -s "$GUARDRAILS/$source" "$path"; then
          rm -f "$path"
          printf 'removed %s\n' "$path"
        else
          printf 'left %s (changed since the install)\n' "$path"
        fi
        ;;
      node)
        rm -f "$path"
        printf 'removed %s\n' "$path"
        ;;
    esac
  done <"$STATE"
  while read -r kind path; do
    [ "$kind" = dir ] || continue
    if rmdir "$path" 2>/dev/null; then printf 'removed %s/\n' "$path"; else printf 'left %s/ (not empty)\n' "$path"; fi
  done < <(tac "$STATE")
  rm -f "$STATE"
}

case "${1:-}" in
  install) install_files ;;
  status) status ;;
  remove) remove_files ;;
  *) die "usage: $0 install|status|remove" ;;
esac
