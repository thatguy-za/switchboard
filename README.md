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

### Pushing keys

On the Identities tab, **Push to hosts…** puts an identity's public key on any number of hosts
(generating a new identity offers this straight away). For each host, Switchboard signs in with its
current credentials, creates `~/.ssh` (700) and `authorized_keys` (600) if needed, adds the key unless
it is already there, then signs in again with only the new key. Only if that works does the host switch
to the identity. Each host reports its own result: added, already there, authentication failed,
permission denied, unreachable, host key not trusted, or key added but login with it failed.

- A pushed host's saved password is kept, so you can switch back; use *Forget the saved password* in
  the host editor to remove it.
- Pushes never prompt about host keys. Open a host in a terminal once and trust its key first.
- Targets need a POSIX shell. Windows OpenSSH and network gear report that they aren't supported.
- Removing a pushed key from servers isn't built yet: the key stays in `authorized_keys` until you remove it.

### Remote desktops (RDP)

Add a host with type *Remote desktop (RDP)* and open it like any other: it appears in a tab or in a
split pane beside terminals. Switchboard hands the connection to `guacd` (the Apache Guacamole proxy,
run as a second container) and streams the desktop to your browser; the host's password is added on the
server and never reaches the browser.

- **Resolution** follows the pane, so resizing the window or a divider resizes the remote desktop.
- **Reconnect:** a dropped connection retries with backoff and returns to your Windows session.
- **Clipboard:** text copies both ways. Browsers only allow automatic clipboard access over HTTPS, so
  on plain `http://ip:3000` paste works with Ctrl+V and text copied on the desktop waits in the
  *Clipboard* panel. Put Switchboard behind a TLS reverse proxy for fully automatic sync.
- **Files:** the *Files* panel uploads to, and downloads from, a drive called "Switchboard" on the remote
  desktop. You can also drop files onto the desktop. Files live on a RAM-backed volume capped at 512 MB
  that is emptied when a session ends and whenever the containers restart.
- **Audio** from the remote machine plays in the browser. Your first click in the pane starts it.
- **Ctrl+Alt+Del** has its own button, since browsers can't send it.
- **Certificates:** Windows machines usually present self-signed certificates, so *Accept self-signed
  certificates* is on by default. Turn it off per host on networks you don't trust.
- `DOMAIN\user` works as a username. Set `SWITCHBOARD_MAX_RDP` (default 10) to limit concurrent desktops.

Not included yet: microphone, printing, multiple monitors, other keyboard layouts (US only), RDP through
jump hosts, and a polished on-screen keyboard on phones (typing there is best effort).
`guacamole/guacd:1.6.0` is used because it is published for both amd64 and arm64.

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

xterm.js 5.5.0, its fit addon and guacamole-common-js 1.5.0 (Apache-2.0, license kept beside it) are vendored in `cmd/switchboard/web/vendor`, so the page loads nothing from a CDN.

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
