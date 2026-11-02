#!/usr/bin/env bash
# Rebuilds the brand assets in cmd/webterm/web from DESIGN.md's construction: the outlined wordmark
# (logo-light.svg, logo-dark.svg) and the PNG icons and favicon.ico from icon.svg and favicon.svg.
# Needs Docker. icon.svg and favicon.svg are the hand-written sources.
set -euo pipefail
cd "$(dirname "$0")/../.."
WEB="$PWD/cmd/webterm/web"
docker run --rm -v "$WEB":/web -v "$PWD/scripts/brand":/b python:3.12-slim sh -c \
  'pip install -q fonttools brotli >/dev/null 2>&1 && python /b/outline.py /web/fonts/jetbrains-mono-latin-wght-normal.woff2 /web'
docker run --rm -v "$WEB":/web -v "$PWD/scripts/brand":/b mcr.microsoft.com/playwright:v1.64.1-noble sh -c \
  'cd /tmp && npm i playwright@1.64.1 --silent >/dev/null 2>&1 && cp /b/render.js /tmp/ && node /tmp/render.js'
docker run --rm -v "$WEB":/web -v "$PWD/scripts/brand":/b python:3.12-slim python /b/ico.py /web
