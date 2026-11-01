# Switchboard

Self-hosted SSH and RDP client that runs in Docker. See the MVP PRD for scope.

## Run

```
docker compose up -d
```

Then open http://localhost:8080.

## SSH

Add hosts (optionally in nested folders), sign in with a saved password or an SSH identity, and open
terminals in browser tabs. Press Ctrl+K to search hosts. Host keys are trusted on first use; if a
server's key later changes, the tab blocks with a warning until you explicitly accept the new key.
Dropped connections reconnect automatically. Credentials are decrypted on the server at connect
time and are never sent to the browser. Private keys leave only through an explicit, password-confirmed export.

xterm.js 5.5.0 and its fit addon are vendored in `cmd/switchboard/web/vendor`, so the page loads nothing from a CDN.

## Master key

On first start Switchboard generates a master key in the `/keys` volume. Every stored
secret is encrypted with it as an outer layer, so a stolen database alone is unreadable.
It cannot be supplied or replaced. Download a copy from the admin panel (it asks for your
password) and store it away from the server: if the key is lost, no vault can be opened.
A full restore needs both the `/data` and `/keys` volumes.

## Configuration

| Variable | Default | |
|---|---|---|
| `SWITCHBOARD_PORT` | `8080` | listen port |
| `SWITCHBOARD_BASE_URL` | `http://localhost:8080` | use `https://` behind a proxy to set Secure cookies |
| `SWITCHBOARD_SESSION_TIMEOUT` | `30m` | idle timeout |

## Images

Multi-arch (amd64, arm64) images are published to `ghcr.io/thatguy-za/switchboard` on every push to `main` (`edge`) and every `v*` tag (`latest`, version tags).
