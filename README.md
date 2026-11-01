# Switchboard

Self-hosted SSH and RDP client that runs in Docker. See the MVP PRD for scope.

## Run

```
docker compose up -d
```

Then open http://localhost:8080.

## Images

Multi-arch (amd64, arm64) images are published to `ghcr.io/thatguy-za/switchboard` on every push to `main` (`edge`) and every `v*` tag (`latest`, version tags).
