#!/usr/bin/env bash
# Starts a throwaway WebTerm at http://localhost:3001 next to a fake Proxmox server (pve) and a test SSH
# server (sbui-ssh), so the Proxmox screens can be tried by hand. It starts empty: create an account on
# the first page. Stop it again with `tests/ui/preview.sh down`. Needs Docker.
#
# In WebTerm, connect Proxmox with:  address https://pve:8006, token ID webterm@pve!power, secret fake-secret-1234.
# A host to link to a VM:            address sbui-ssh, port 2222, user tester, password testpass-123 (name it nas).
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=webterm-preview
PLAYWRIGHT=mcr.microsoft.com/playwright:v1.64.1-noble
down() { docker rm -f webterm-preview webterm-preview-pve webterm-preview-ssh >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
if [ "${1:-up}" = down ]; then down; echo "preview stopped"; exit 0; fi
down

docker build -q -t webterm:preview .
docker network create "$NET" >/dev/null
docker run -d --name webterm-preview-ssh --hostname homelab --network "$NET" --network-alias sbui-ssh -e PUID=1000 -e PGID=1000 -e USER_NAME=tester \
  -e USER_PASSWORD=testpass-123 -e PASSWORD_ACCESS=true lscr.io/linuxserver/openssh-server:latest >/dev/null
docker run -d --name webterm-preview-pve --network "$NET" --network-alias pve -v "$PWD/tests/ui":/work "$PLAYWRIGHT" \
  sh -c 'cd /tmp && openssl req -x509 -newkey rsa:2048 -nodes -keyout k.pem -out c.pem -subj /CN=pve -days 2 >/dev/null 2>&1 && node /work/fakepve.js' >/dev/null
docker run -d --name webterm-preview --network "$NET" -p 3001:3000 webterm:preview >/dev/null
sleep 8
echo "WebTerm preview: http://localhost:3001"
