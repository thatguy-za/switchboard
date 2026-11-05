#!/usr/bin/env bash
# Builds WebTerm and runs the axe-core accessibility check (WCAG 2.2 A and AA) over every screen.
# Needs Docker. Exits non-zero if any rule is violated.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=sbui-test
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.64.1-noble
cleanup() { docker rm -f sbui-test-app sbui-test-ssh sbui-test-pve >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker build -q -t webterm:ui-test .
docker network create "$NET" >/dev/null
docker run -d --name sbui-test-ssh --network "$NET" --network-alias sbui-ssh -e PUID=1000 -e PGID=1000 -e USER_NAME=tester \
  -e USER_PASSWORD=testpass-123 -e PASSWORD_ACCESS=true lscr.io/linuxserver/openssh-server:latest >/dev/null
docker run -d --name sbui-test-app --network "$NET" --network-alias webterm webterm:ui-test >/dev/null
docker run -d --name sbui-test-pve --network "$NET" --network-alias pve -v "$PWD/tests/ui":/work "$PLAYWRIGHT" \
  sh -c 'cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -subj /CN=pve -days 2 >/dev/null 2>&1 && node /work/fakepve.js' >/dev/null
sleep 8

docker run --rm --network "$NET" -v "$PWD/tests/ui":/work "$PLAYWRIGHT" \
  sh -c 'cd /tmp && npm i playwright@1.64.1 @axe-core/playwright@4.10.2 --silent >/dev/null 2>&1; cp /work/a11y.js /tmp/ && node /tmp/a11y.js'
