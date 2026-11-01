# UI tests

Drive the real app in headless Chromium and save screenshots to `tests/ui/out/`.

- `./run.sh` builds the image, starts it beside a throwaway SSH server, and walks through every screen
  (sign-in, setup, hosts, terminals, split panes, the command palette, identities, key push, settings, dark,
  light and phone sizes). It exits non-zero if a step fails or the page logs an error.
- `rdp.js` checks the remote desktop pane against a real xrdp desktop. It needs one on the same Docker network
  under the name `desktop`, for example `lscr.io/linuxserver/rdesktop:ubuntu-xfce` (user and password `abc`),
  plus a host for it already created in a running Switchboard. It is not part of `run.sh` because the image is large.
