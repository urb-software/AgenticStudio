#!/usr/bin/env bash
# Runs in a non-Ubuntu container (CI job deploy:server): the setup script must refuse before it
# changes anything. Usage: docker run --rm -v "$PWD:/w:ro" debian:12 bash /w/deploy/tests/refuse-distro.sh
set -uo pipefail
REPO="${REPO:-/w}"

output="$(bash "$REPO/deploy/setup-server.sh" 2>&1)"
status=$?
printf '%s\n' "$output"
if [ "$status" -eq 0 ]; then
  echo "FAIL: the setup script did not refuse this distribution"
  exit 1
fi
if ! grep -q "only Ubuntu 24.04 LTS is supported" <<<"$output"; then
  echo "FAIL: the refusal does not name the supported distribution"
  exit 1
fi
if [ -e /etc/agentic-studio ] || id agent >/dev/null 2>&1; then
  echo "FAIL: the setup script changed the system before refusing"
  exit 1
fi
echo "PASS: refused with exit $status and changed nothing"
