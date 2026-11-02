#!/usr/bin/env bash
# Rebuilds the README screenshots in docs/screenshots from a throwaway server with demo data.
# Needs Docker. Run it after UI changes you want reflected in the README.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=sbui-test
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.64.1-noble
cleanup() { docker rm -f sbui-test-app sbui-test-ssh >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker build -q -t webterm:ui-test --build-arg VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo dev)" .
docker network create "$NET" >/dev/null
docker run -d --name sbui-test-ssh --hostname homelab --network "$NET" --network-alias sbui-ssh -e PUID=1000 -e PGID=1000 -e USER_NAME=tester \
  -e USER_PASSWORD=testpass-123 -e PASSWORD_ACCESS=true lscr.io/linuxserver/openssh-server:latest >/dev/null
docker run -d --name sbui-test-app --network "$NET" --network-alias webterm webterm:ui-test >/dev/null
sleep 8

mkdir -p docs/screenshots
docker run --rm --network "$NET" -e OUT=/work/shots -v "$PWD/tests/ui":/work -v "$PWD/docs/screenshots":/work/shots "$PLAYWRIGHT" \
  sh -c 'cd /tmp && npm i playwright@1.64.1 --silent >/dev/null 2>&1; cp /work/screenshots.js /tmp/ && node /tmp/screenshots.js'
