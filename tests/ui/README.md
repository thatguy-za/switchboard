# UI tests

Drive the real app in headless Chromium and save screenshots to `tests/ui/out/`.

- `./run.sh` builds the image, starts it beside a throwaway SSH server, and walks through every screen
  (sign-in, setup, hosts, terminals, split panes, the command palette, identities, key push, settings, dark,
  light and phone sizes). It exits non-zero if a step fails or the page logs an error.
- `rdp.js` checks the remote desktop pane against a real xrdp desktop. It needs one on the same Docker network
  under the name `desktop`, for example `lscr.io/linuxserver/rdesktop:ubuntu-xfce` (user and password `abc`),
  plus a host for it already created in a running WebTerm. It is not part of `run.sh` because the image is large.
- `fakepve.js` stands in for a Proxmox server (an HTTPS API with a self-signed certificate, five VMs and containers, and
  the token `webterm@pve!power` with secret `fake-secret-1234`). `run.sh`, `a11y.sh` and `screenshots.sh` start it as
  `pve`, so the Proxmox screens can be tested and photographed. To try it by hand, run it next to a WebTerm on one Docker
  network: `openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/k.pem -out /tmp/c.pem -subj /CN=pve`, then
  `node fakepve.js`, and connect WebTerm to `https://pve:8006`.
