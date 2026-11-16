#!/usr/bin/env bash
# Studio's managed guardrails on the local WSL test worker, for the real-CLI smoke (Issue #134).
# NOT PART OF CI AND NEVER ON THE SERVER: there, deploy/setup-server.sh --only guardrails installs
# them. Run as root by the coordinator, before and after the smoke scripts, FROM A ROOT-OWNED COPY
# of the checkout (the same commit the smoke scripts were built from), never from the agent
# user's checkout:
#
#   sudo bash /usr/local/src/agentic-studio-smoke/apps/agent-worker/scripts/smoke-guardrails.sh install
#   sudo bash /usr/local/src/agentic-studio-smoke/apps/agent-worker/scripts/smoke-guardrails.sh status
#   sudo bash /usr/local/src/agentic-studio-smoke/apps/agent-worker/scripts/smoke-guardrails.sh remove
#
# It refuses to run unless this script, the guardrails folder, the manifest and every source file
# are root-owned and writable by nobody else, in directories up to / that only root can change,
# and no source is a symbolic link (review M1 of #136): a root process must not run or copy what
# the agent user can change. The worker compares the installed files with its own copies by
# SHA-256, so the agent user's built checkout and this copy must be the same commit; `status`
# compares against this copy, and the smoke scripts stop at "managed guardrails: FAILED" if the
# built checkout differs.
#
# `install` copies the files listed in apps/agent-worker/guardrails/managed-files.txt to their
# managed paths, root:root, files 0644, directories 0755, and Node.js to /usr/local/bin/node when
# it is not there (a copy of SMOKE_NODE_BIN, default: the `node` on root's PATH; root-owned,
# 0755; the source binary and its folders must be root-only, so not an nvm install). It refuses to replace a file that differs from Studio's copy, and refuses while a managed
# input the manifest lists as `absent` exists. Everything it created is listed in a root-only
# state file, written only once every check passed; `remove` deletes exactly that (a file, and the
# Node.js copy, only while it still hashes to what was installed) and the state file.
# It prints paths and yes/no lines only.
set -Eeuo pipefail
umask 022

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
GUARDRAILS="$(cd "$(dirname "$SCRIPT")/../guardrails" && pwd -P)"
MANIFEST="$GUARDRAILS/managed-files.txt"
STATE=/root/.agentic-studio-smoke-guardrails
NODE=/usr/local/bin/node
LAUNCHER=/usr/bin/env

die() {
  printf 'smoke-guardrails: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || die "run as root (sudo)."
[ -f "$MANIFEST" ] || die "$MANIFEST not found."

# Root-owned and writable by nobody else: the path itself and every directory above it, none of
# them a symbolic link. Taken as an absolute path (without resolving links, so a link is seen);
# the walk ends at / and is bounded in any case.
root_only() {
  local path
  path="$(realpath -s -- "$1" 2>/dev/null)" || return 1
  [[ "$path" == /* ]] || return 1
  for _ in $(seq 1 64); do
    [ ! -L "$path" ] || return 1
    [ "$(stat -c %u "$path" 2>/dev/null)" = 0 ] || return 1
    [ $((8#$(stat -c %a "$path") & 8#022)) -eq 0 ] || return 1
    [ "$path" != / ] || return 0
    path="$(dirname "$path")"
  done
  return 1
}

for path in "$SCRIPT" "$GUARDRAILS" "$MANIFEST"; do
  root_only "$path" ||
    die "$path is not root-owned and closed to others (or is a symbolic link): run this from a root-owned copy of the checkout."
done

sha() { sha256sum <"$1" | cut -d' ' -f1; }

# The manifest's lines as "<source> <path>", sorted and unique; `absent` lines included.
manifest() {
  local provider source dest rest
  while read -r provider source dest rest; do
    case "$provider" in '' | '#'*) continue ;; esac
    if [ -n "$rest" ] || ! [[ "$source" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "$dest" != /* ]] || [[ "$dest" == *..* ]]; then
      die "malformed line in $MANIFEST."
    fi
    printf '%s %s\n' "$source" "$dest"
  done <"$MANIFEST" | sort -u
}
entries() { manifest | awk '$1 != "absent"'; }
absent_paths() { manifest | awk '$1 == "absent" { print $2 }'; }

# Every source file: a root-only regular file, never a symbolic link.
while read -r source _; do
  if ! root_only "$GUARDRAILS/$source" || [ ! -f "$GUARDRAILS/$source" ]; then
    die "$GUARDRAILS/$source is not a root-owned regular file closed to others."
  fi
done < <(entries)

record() { printf '%s\n' "$*" >>"$STATE"; }

install_files() {
  [ ! -e "$STATE" ] || die "$STATE exists: an earlier install was not removed; run remove first."
  local source dest dir missing node=""
  # Every check first; nothing is written (not even the state file) unless all pass.
  while read -r source dest; do
    if [ -L "$dest" ] || { [ -e "$dest" ] && ! cmp -s "$GUARDRAILS/$source" "$dest"; }; then
      die "$dest exists and is not Studio's copy; not replacing it."
    fi
  done < <(entries)
  while read -r dest; do
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      die "$dest exists: it would add to Studio's managed policy; remove it first."
    fi
  done < <(absent_paths)
  if [ ! -e "$NODE" ]; then
    node="${SMOKE_NODE_BIN:-$(command -v node || true)}"
    if [ -z "$node" ] || [ ! -x "$node" ]; then die "no Node.js to copy to $NODE (set SMOKE_NODE_BIN)."; fi
    # It becomes the hooks' interpreter: only a binary the agent user cannot have changed (review
    # N3 of #136), never one from an agent-writable folder such as nvm's.
    node="$(readlink -f "$node")"
    root_only "$node" ||
      die "$node is not a root-owned binary closed to others in root-only directories; supply one (SMOKE_NODE_BIN), e.g. the official Node.js tarball unpacked by root."
  fi
  install -m 0600 /dev/null "$STATE"
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
      record file "$dest" "$(sha "$dest")"
    fi
  done < <(entries)
  if [ -n "$node" ]; then
    install -o root -g root -m 0755 "$node" "$NODE"
    record node "$NODE" "$(sha "$NODE")"
  fi
  status
}

status() {
  local source dest ok=yes
  while read -r source dest; do
    if [ -f "$dest" ] && [ "$(stat -c '%U:%G %a' "$dest")" = "root:root 644" ] &&
      cmp -s "$GUARDRAILS/$source" "$dest" && root_only "$dest"; then
      printf '%s: in place (root:root 0644, Studio'"'"'s copy)\n' "$dest"
    else
      printf '%s: NOT in place\n' "$dest"
      ok=no
    fi
  done < <(entries)
  while read -r dest; do
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      printf '%s: PRESENT (must not exist)\n' "$dest"
      ok=no
    else
      printf '%s: absent\n' "$dest"
    fi
  done < <(absent_paths)
  for dest in "$LAUNCHER" "$NODE"; do
    if [ -f "$dest" ] && root_only "$dest"; then
      printf '%s: root-owned file\n' "$dest"
    else
      printf '%s: NOT a root-owned file only root can change\n' "$dest"
      ok=no
    fi
  done
  printf 'managed guardrails in place: %s\n' "$ok"
}

remove_files() {
  [ -f "$STATE" ] || die "nothing to remove ($STATE not found)."
  local kind path hash
  # Files first, then directories, deepest first. A file only while it is what was installed.
  while read -r kind path hash; do
    case "$kind" in
      file | node)
        if [ -f "$path" ] && [ ! -L "$path" ] && [ "$(sha "$path")" = "$hash" ]; then
          rm -f "$path"
          printf 'removed %s\n' "$path"
        else
          printf 'left %s (changed since the install)\n' "$path"
        fi
        ;;
    esac
  done <"$STATE"
  while read -r kind path _; do
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
