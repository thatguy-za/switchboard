#!/usr/bin/env bash
# Builds WebTerm, starts it next to a throwaway SSH server, and walks through every screen
# in headless Chromium (dark, light and phone size). Screenshots land in tests/ui/out.
# Needs Docker. Exits non-zero if a step fails or the page logs an error.
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

mkdir -p tests/ui/out && rm -f tests/ui/out/*.png
docker run --rm --network "$NET" -e OUT=/work/out -v "$PWD/tests/ui":/work "$PLAYWRIGHT" \
  sh -c 'cd /tmp && npm i playwright@1.64.1 --silent >/dev/null 2>&1; cp /work/walkthrough.js /tmp/ && node /tmp/walkthrough.js'
