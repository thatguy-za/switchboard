# Switchboard

Self-hosted SSH and RDP client that runs in Docker: one container, one volume.

## Run

```
docker compose up -d
```

Then open `http://<server-ip>:3000` (or a DNS name that points at it, such as `http://switchboard.local:3000`).
The first visit sets up the owner account. Everything Switchboard stores lives in the `switchboard-data` volume.

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
which is built into the same container) and streams the desktop to your browser; the host's password is added on the
server and never reaches the browser.

- **Resolution** follows the pane, so resizing the window or a divider resizes the remote desktop.
- **Reconnect:** a dropped connection retries with backoff and returns to your Windows session.
- **Clipboard:** text copies both ways. Browsers only allow automatic clipboard access over HTTPS, so
  on plain `http://ip:3000` paste works with Ctrl+V and text copied on the desktop waits in the
  *Clipboard* panel. Put Switchboard behind a TLS reverse proxy for fully automatic sync.
- **Files:** the *Files* panel uploads to, and downloads from, a drive called "Switchboard" on the remote
  desktop. You can also drop files onto the desktop. They sit in a temporary folder inside the container
  (`/tmp/switchboard-transfer`) that is emptied when a session ends and whenever the container restarts.
  To keep them in memory instead of on disk, add `tmpfs: ["/tmp:size=512m"]` to the service.
- **Audio** from the remote machine plays in the browser. Your first click in the pane starts it.
- **Ctrl+Alt+Del** has its own button, since browsers can't send it.
- **Certificates:** Windows machines usually present self-signed certificates, so *Accept self-signed
  certificates* is on by default. Turn it off per host on networks you don't trust.
- `DOMAIN\user` works as a username. Set `SWITCHBOARD_MAX_RDP` (default 10) to limit concurrent desktops.

Not included yet: microphone, printing, multiple monitors, other keyboard layouts (US only), and a polished on-screen keyboard on phones (typing there is best effort).
The image is built on `guacamole/guacd:1.6.0`, which is published for both amd64 and arm64.

### Split panes

Each terminal tab can be split right or down into up to six panes, each its own session. Drag the dividers to resize.

xterm.js 5.5.0, its fit addon and guacamole-common-js 1.5.0 (Apache-2.0, license kept beside it) are vendored in `cmd/switchboard/web/vendor`, so the page loads nothing from a CDN.

## Accessibility

Switchboard aims for WCAG 2.2 level AA: every control works from the keyboard, text meets contrast
minimums in both themes, and dialogs and prompts are announced by screen readers. Inside a terminal or
remote desktop every key goes to the remote side, so press **Shift+Escape** to move focus back to the
pane's buttons. `tests/ui/a11y.sh` runs an automated axe-core check of every screen.

## Tailscale

Switchboard can join your tailnet itself, with nothing extra to run, and every user does it for themselves.
Open **Settings → Tailscale**, turn it on and either sign in with Tailscale or paste an auth key (create one in
the Tailscale admin console under Settings → Keys). Each user gets their own device on their own tailnet, so
one person can be on a tailnet while another is not, and a user's tailnet is only used for their own hosts.
The key is used once to join and is never stored; each device's identity is kept under `/data/tailscale`,
so it rejoins by itself after a restart. If you ran an earlier version with a single server-wide node, it
now belongs to the first admin.

- **Reaching hosts:** an SSH or RDP host whose address is a Tailscale IP (`100.x.y.z`) or a `*.ts.net` name
  is reached over the tailnet. Any other name is looked up with the container's normal DNS first, so LAN
  and public names work exactly as before; if that finds nothing, such as a MagicDNS short name like
  `nas`, the lookup is made on your tailnet. A name that resolves to a Tailscale address uses the tailnet too.
- **Devices:** while connected, the Tailscale page lists the other devices on your tailnet, with a button to
  add one as a host.
- **Opening Switchboard from the tailnet:** with *Open the web UI on the tailnet* on, the page is also
  served on port 3000 of your device name (`switchboard-<username>` unless you change it), from any
  device on your tailnet. Port 3000 on the host keeps working either way.
- **Removing it:** *Remove from tailnet* logs the device out and forgets it. If the device is offline when
  you do this, delete it in the Tailscale admin console too. Deleting a user removes their device the same way.

RDP goes through a small loopback relay inside the container, because guacd can't use the embedded node.
Network Level Authentication works with it, but not Kerberos. Tailscale SSH and exit nodes aren't supported.

## HTTPS and reverse proxies

Switchboard speaks plain HTTP on port 3000. To use it over HTTPS (needed to install it as an app and for
automatic clipboard sync), put a reverse proxy in front. Sample configs:

| Proxy | File |
|---|---|
| Caddy (certificates are automatic) | [`deploy/Caddyfile`](deploy/Caddyfile) |
| nginx | [`deploy/nginx.conf`](deploy/nginx.conf) |
| Traefik (Docker labels) | [`deploy/docker-compose.traefik.yml`](deploy/docker-compose.traefik.yml) |

Whatever you use, it has to:

- pass **WebSocket upgrades** through (terminals and desktops are WebSockets);
- pass the **`Host` header unchanged, including any port**: Switchboard checks it against the page's origin;
- send **`X-Forwarded-Proto: https`**, so cookies are marked Secure;
- not cut idle connections quickly. Switchboard pings each terminal every 25 seconds, so any idle timeout above
  that is fine.

Once a proxy handles TLS, stop publishing port 3000 to the network (the Traefik file shows how to bind it to
localhost).

## Install as an app

Over HTTPS (or on `localhost`), browsers offer to install Switchboard as an app with its own window and icon.
A service worker keeps the app's own files available if the server is briefly unreachable; it never stores
anything from the API. Over plain `http://<ip>:3000` the install option isn't offered, because browsers only allow
service workers on secure origins. Phones can still add the page to the home screen as a shortcut.

## Master key

On first start Switchboard generates a master key in `/data/keys`. Every stored secret is
encrypted with it as an outer layer. It cannot be supplied or replaced. Download a copy from
Settings, Server (it asks for your password) and keep it somewhere other than this server:
if the key is lost, no vault can be opened.

The key sits in the same volume as the database, so a copy of the whole volume contains both.
Your vault contents are still protected by each person's password. To keep the key apart, mount a
second volume and point `SWITCHBOARD_KEYS_DIR` at it. To restore an instance, restore the `/data` volume.

## Configuration

Everything has a working default. These are optional:

| Variable | Default | |
|---|---|---|
| `SWITCHBOARD_PORT` | `3000` | listen port inside the container |
| `SWITCHBOARD_SESSION_TIMEOUT` | `30m` | idle timeout |
| `SWITCHBOARD_TRUST_PROXY` | off | set to `true` behind a reverse proxy, so login rate limits count each visitor, not the proxy |
| `SWITCHBOARD_MAX_RDP` | `10` | most remote desktops open at once |
| `SWITCHBOARD_KEYS_DIR` | `/data/keys` | where the master key lives |
| `SWITCHBOARD_TRANSFER_DIR` | `/tmp/switchboard-transfer` | scratch space for desktop file transfer |
| `SWITCHBOARD_GUACD` | built in | `host:port` of a guacd elsewhere, instead of the bundled one |

## Design system

The interface is built from one set of tokens and components, enforced by tests. See
[`docs/design-system.md`](docs/design-system.md), and open `/design.html` on a running instance for the
living style guide.

## Images

Multi-arch (amd64, arm64) images are published to `ghcr.io/thatguy-za/switchboard` on every push to `main` (`edge`) and every `v*` tag (`latest`, version tags).
