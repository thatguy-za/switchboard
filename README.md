# Switchboard

Self-hosted SSH and RDP client that runs in Docker. See the MVP PRD for scope.

## Run

```
docker compose up -d
```

Then open `http://<server-ip>:3000` (or a DNS name that points at it, such as `http://switchboard.local:3000`).

## SSH

Add hosts (optionally in nested folders), sign in with a saved password or an SSH identity, and open
terminals in browser tabs. Press Ctrl+K to search hosts. Host keys are trusted on first use; if a
server's key later changes, the tab blocks with a warning until you explicitly accept the new key.
Dropped connections reconnect automatically. Credentials are decrypted on the server at connect
time and are never sent to the browser. Private keys leave only through an explicit, password-confirmed export.

### Jump hosts, forwards and split panes

A host can list jump hosts to connect through, in order. Each hop signs in with its own saved
credentials and has its own trusted host key, so a changed key on a bastion blocks the connection
just as it does for the target.

Port forwards belong to a host and last while a terminal for it is open. A *local* forward makes the
Switchboard container listen on the port you choose and reach the destination through the host.
To use one from your own machine, publish that port in `docker-compose.yml`, for example
`- "8443:8443"`. Anyone who can reach a published port can use the forward, so publish only what you
mean to share. A *remote* forward has the SSH server listen on its loopback and reach the
destination from the Switchboard container.

Each terminal tab can be split right or down into up to six panes, each its own session. Drag the dividers to resize.

When Switchboard sits behind a reverse proxy, pass the original `Host` header and WebSocket upgrades through,
and set `X-Forwarded-Proto: https` so cookies are marked Secure.

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
| `SWITCHBOARD_PORT` | `3000` | listen port inside the container |
| `SWITCHBOARD_SESSION_TIMEOUT` | `30m` | idle timeout |

## Images

Multi-arch (amd64, arm64) images are published to `ghcr.io/thatguy-za/switchboard` on every push to `main` (`edge`) and every `v*` tag (`latest`, version tags).
