# WebTerm — Design Spec

> **WebTerm: the self-hosted web terminal.**
> A browser-based SSH and RDP client that runs in Docker, with one-click SSH identities and per-user encrypted vaults.

This document is the source of truth for WebTerm's look and feel. Build the UI from the tokens and rules here; don't introduce new colours, fonts, radii or spacing values without adding them to this file first.

---

## 1. Principles

1. **The terminal is the hero.** Chrome (sidebar, tabs, toolbars) stays quiet and compact so sessions get the space.
2. **Calm by default, loud only for danger.** Neutral greys everywhere; the green accent marks "live / on / primary"; red is reserved for destructive actions and host-key warnings.
3. **Keyboard first, touch friendly.** Every action reachable from the keyboard; every tap target ≥ 44 px on touch layouts.
4. **Secrets never look casual.** Anything involving keys, passwords or recovery codes gets deliberate, clearly-labelled UI with confirmation.
5. **Dark and light are equals.** Both themes are designed, not inverted. Default follows the OS.

---

## 2. Brand

### 2.1 Name and tagline

| Item | Value |
| --- | --- |
| Product name (prose) | **WebTerm** (capital W, capital T) |
| Wordmark (logo) | `webterm` — always lowercase, never in prose |
| Tagline | *the self-hosted web terminal* (sentence case, no trailing period) |
| Long description | WebTerm is a self-hosted web terminal for SSH and RDP. |

### 2.2 Logo — cursor wordmark (option A)

The logo is the word `webterm` set in **JetBrains Mono Bold (700)** followed by a solid **block cursor** in the accent colour. There is no separate symbol in the full logo.

**Construction** (all values relative to the font size, `em`):

| Property | Value |
| --- | --- |
| Typeface | JetBrains Mono, weight 700 |
| Case | lowercase `webterm` |
| Letter spacing | −0.04 em |
| Gap between text and cursor | 0.14 em |
| Cursor width | 0.50 em |
| Cursor height | 0.86 em (top at cap height, bottom 0.12 em below the baseline) |
| Cursor corner radius | 0.07 em |
| Cursor colour | `--wt-accent` in every theme |
| Text colour | `--wt-ink` on light, `--wt-paper` on dark |

**Reference SVG** (44 px font size). Convert the text to outlines before shipping the asset files so they don't depend on the font being installed:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 212 56" role="img" aria-label="webterm">
  <text x="0" y="44" font-family="'JetBrains Mono', monospace" font-weight="700"
        font-size="44" letter-spacing="-1.76" fill="#14181F">webterm</text>
  <rect x="180" y="11.4" width="22" height="37.8" rx="3" fill="#2FB383"/>
</svg>
```

Dark version: change the text `fill` to `#F3F1EA`. The cursor stays `#2FB383`.

**Lockup with tagline:** the tagline is set in Inter Regular at 0.32× the wordmark font size, in `--wt-text-secondary`, left-aligned under the wordmark with a 0.14 em gap.

**Clear space:** keep at least the cursor's width (0.5 em) clear on all sides.

**Minimum size:** 72 px wide on screen. Below that, use the app icon.

**Cursor animation:** in the app, the logo's cursor can blink: 1.06 s cycle, `steps(1)` on/off, *only* on the login and first-run screens. Static everywhere else. No blinking under `prefers-reduced-motion: reduce`.

**Don't:**
- Capitalise the wordmark, add a prompt (`>`, `$`) or change the font
- Recolour the cursor per theme, or make the text the accent colour
- Outline, shadow, gradient or stretch it
- Replace the block cursor with an underscore or a thin bar

### 2.3 App icon and favicon

| Asset | Construction |
| --- | --- |
| App / PWA icon | Rounded square, background `#14181F`, corner radius 22% of the size. A stroked lowercase **w** in `#F3F1EA` (stroke 6.25% of size, round caps and joins) followed by a tall block cursor in `#2FB383`. |
| Favicon (≤ 32 px) | The same rounded square with **only the block cursor**, centred: 25% wide, 50% tall. |
| Maskable icon | The app icon artwork scaled to fit the central 80% safe zone, on a full-bleed `#14181F` background. |

Reference SVGs (64-unit grid):

```svg
<!-- app-icon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#14181F"/>
  <path d="M15 23 L19 41 L24 30 L29 41 L33 23" fill="none" stroke="#F3F1EA"
        stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="38" y="21" width="11" height="22" rx="2" fill="#2FB383"/>
</svg>

<!-- favicon.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#14181F"/>
  <rect x="24" y="16" width="16" height="32" rx="3" fill="#2FB383"/>
</svg>
```

**Files to generate** (`/public`):

| File | Size |
| --- | --- |
| `favicon.svg` | vector |
| `favicon.ico` | 16, 32, 48 |
| `apple-touch-icon.png` | 180 × 180 (no transparency) |
| `icon-192.png`, `icon-512.png` | PWA `any` |
| `icon-maskable-512.png` | PWA `maskable` |
| `logo-light.svg`, `logo-dark.svg` | wordmark, text outlined |

PWA manifest: `name: "WebTerm"`, `short_name: "WebTerm"`, `theme_color: "#14181F"`, `background_color: "#14181F"`, `display: "standalone"`.

---

## 3. Design tokens

Implement as CSS custom properties on `:root`, swapped by `[data-theme="dark"]` and by `prefers-color-scheme` when the user setting is "System". All component styles must reference tokens, never raw hex values.

### 3.1 Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--wt-bg` | `#F7F6F2` | `#0F1216` | App background |
| `--wt-surface` | `#FFFFFF` | `#161A20` | Panels, cards, dialogs |
| `--wt-surface-2` | `#F3F1EA` | `#1D222A` | Sidebar, inputs, hovered rows |
| `--wt-surface-3` | `#E9E6DC` | `#262C35` | Selected rows, pressed states |
| `--wt-border` | `#E2DFD6` | `#2B313B` | Dividers, input borders |
| `--wt-border-strong` | `#C9C5B9` | `#3A414D` | Focused-panel and hover borders |
| `--wt-text` | `#14181F` | `#F3F1EA` | Primary text |
| `--wt-text-secondary` | `#5A6170` | `#9AA0AC` | Secondary text, labels |
| `--wt-text-muted` | `#6E7480` | `#7E8592` | Placeholders, meta (min 4.5:1 on its surface) |
| `--wt-accent` | `#2FB383` | `#2FB383` | Cursor, live indicators, primary button fill, focus ring |
| `--wt-accent-hover` | `#279C72` | `#3CC793` | Primary button hover |
| `--wt-accent-text` | `#1E7D5B` | `#4FD3A1` | Accent-coloured **text** and links (passes 4.5:1) |
| `--wt-on-accent` | `#0B1F17` | `#0B1F17` | Text on accent fills |
| `--wt-accent-soft` | `rgba(47,179,131,.12)` | `rgba(47,179,131,.16)` | Selected tab underline area, success banners |
| `--wt-warning` | `#B7791F` | `#E8A33D` | Warnings (text and icons) |
| `--wt-warning-soft` | `rgba(232,163,61,.14)` | `rgba(232,163,61,.16)` | Warning banners |
| `--wt-danger` | `#C2412D` | `#F07A63` | Destructive actions, host-key alerts |
| `--wt-danger-soft` | `rgba(226,101,74,.12)` | `rgba(240,122,99,.16)` | Danger banners |
| `--wt-info` | `#2F6FD6` | `#6EA3F8` | Informational notes |
| `--wt-ink` | `#14181F` | `#14181F` | Brand dark (logo, icon background) |
| `--wt-paper` | `#F3F1EA` | `#F3F1EA` | Brand light |

**Rules**
- `--wt-accent` is a fill and indicator colour. Never use it for body text on light backgrounds; use `--wt-accent-text`.
- Status is never colour alone: always pair it with an icon or a label.
- Connection states: connected = accent dot · connecting = warning dot, pulsing · disconnected = muted hollow dot · error = danger dot.

### 3.2 Typography

| Role | Font | Fallback stack |
| --- | --- | --- |
| UI | **Inter** (400, 500, 600) | `system-ui, -apple-system, "Segoe UI", sans-serif` |
| Mono (logo, terminal, code, fingerprints, keys) | **JetBrains Mono** (400, 700) | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

Self-host both fonts (woff2) in the image. No external font CDN, because the app must work offline on a LAN.

| Token | Size / line height | Weight | Use |
| --- | --- | --- | --- |
| `--wt-text-xs` | 11 / 16 | 500 | Badges, status bar |
| `--wt-text-sm` | 13 / 20 | 400 | Default UI text: sidebar, tabs, tables |
| `--wt-text-md` | 14 / 22 | 400 | Forms, dialog body |
| `--wt-text-lg` | 16 / 24 | 600 | Section titles, dialog titles |
| `--wt-text-xl` | 20 / 28 | 600 | Page titles |
| `--wt-text-2xl` | 28 / 36 | 600 | First-run and login headings |

- Mono for anything copyable and exact: hostnames, IPs, ports, usernames, fingerprints, key comments.
- Use tabular numbers (`font-variant-numeric: tabular-nums`) in tables and the status bar.

### 3.3 Spacing, radius, elevation, motion

| Token | Value |
| --- | --- |
| Spacing scale (`--wt-space-*`) | 2, 4, 8, 12, 16, 20, 24, 32, 40, 48 px |
| `--wt-radius-sm` | 6 px — inputs, buttons, tabs |
| `--wt-radius-md` | 10 px — cards, menus, popovers |
| `--wt-radius-lg` | 14 px — dialogs, the login card |
| `--wt-radius-full` | 999 px — dots, pills |
| `--wt-shadow-pop` | `0 8px 24px rgba(15,18,22,.16)` (dark: `rgba(0,0,0,.5)`) — menus, popovers, dialogs only |
| `--wt-focus-ring` | `0 0 0 2px var(--wt-bg), 0 0 0 4px var(--wt-accent)` |
| `--wt-ease` | `cubic-bezier(.2,.0,.0,1)` |
| `--wt-dur-fast` / `--wt-dur` | 120 ms / 200 ms |

No gradients, glassmorphism or decorative shadows. Panels are separated by 1 px `--wt-border` lines, not shadows.

---

## 4. Terminal theme

The default terminal theme is **"WebTerm Dark"**, used in both app themes (terminals stay dark by default; users can pick "WebTerm Light" per host or globally).

### 4.1 xterm.js theme objects

```ts
export const webtermDark = {
  background: '#0F1216',
  foreground: '#E6E3DA',
  cursor: '#2FB383',
  cursorAccent: '#0F1216',
  selectionBackground: 'rgba(47,179,131,0.28)',
  black: '#1D222A',   brightBlack: '#5A6170',
  red: '#F07A63',     brightRed: '#FF9C87',
  green: '#2FB383',   brightGreen: '#4FD3A1',
  yellow: '#E8A33D',  brightYellow: '#F5C26B',
  blue: '#6EA3F8',    brightBlue: '#94BCFF',
  magenta: '#C792EA', brightMagenta: '#DDB3F5',
  cyan: '#4FC1D6',    brightCyan: '#7FDCEB',
  white: '#C9C5B9',   brightWhite: '#F7F6F2',
};

export const webtermLight = {
  background: '#FBFAF7',
  foreground: '#1D222A',
  cursor: '#1E7D5B',
  cursorAccent: '#FBFAF7',
  selectionBackground: 'rgba(47,179,131,0.22)',
  black: '#14181F',   brightBlack: '#6E7480',
  red: '#C2412D',     brightRed: '#D9593F',
  green: '#1E7D5B',   brightGreen: '#279C72',
  yellow: '#9A6412',  brightYellow: '#B7791F',
  blue: '#2F6FD6',    brightBlue: '#4C8DF6',
  magenta: '#8E4EC6', brightMagenta: '#A56BD8',
  cyan: '#167E91',    brightCyan: '#2397AB',
  white: '#C9C5B9',   brightWhite: '#F7F6F2',
};
```

### 4.2 Terminal defaults

| Setting | Default | User-configurable |
| --- | --- | --- |
| Font | JetBrains Mono 400 | Yes: JetBrains Mono, Fira Code, Cascadia Code, system mono |
| Font size | 14 px (13 px on mobile) | 10–24 px |
| Line height | 1.2 | 1.0–1.6 |
| Cursor | Block, blinking | Block / bar / underline; blink on/off |
| Padding inside the pane | 12 px | No |
| Scrollback | 5,000 lines | 1,000–50,000 |
| Ligatures | Off | On/off |

Bundled colour schemes: WebTerm Dark, WebTerm Light, Solarized Dark/Light, Dracula, Nord, Gruvbox Dark. Users can paste a custom scheme as JSON in the same shape as above.

---

## 5. Layout

### 5.1 App shell (≥ 1024 px)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Top bar 44px: [webterm▍]  [⌘K Search hosts…]          [+ New] [👤]   │
├──────────────┬───────────────────────────────────────────────────────┤
│ Sidebar      │ Tab bar 36px: [● prod-api ×] [● nas ×] [◌ win-desk ×] │
│ 260px        ├───────────────────────────────────────────────────────┤
│ (resizable   │                                                       │
│ 200–400,     │   Workspace: one or more panes (split H/V)            │
│ collapsible) │   each pane = SSH terminal or RDP canvas              │
│              │                                                       │
│ Hosts        │                                                       │
│  ▸ Home lab  │                                                       │
│  ▾ Work      │                                                       │
│    ● api-01  │                                                       │
│ Identities   │                                                       │
│ ─────────    │                                                       │
│ Settings     ├───────────────────────────────────────────────────────┤
│ Admin        │ Status bar 24px: user@host · SSH · 120×40 · 12ms · 🔒 │
└──────────────┴───────────────────────────────────────────────────────┘
```

- **Top bar (44 px):** the logo at a 20 px font size (static cursor), the search trigger (opens the command palette), a **New** menu (New host, New identity, New folder) and the account menu (profile, theme, 2FA, sign out, sign out everywhere).
- **Sidebar (260 px):** sections are Hosts (folder tree), Identities, then Settings and Admin pinned at the bottom (Admin only for admins). Collapse with `⌘B` / `Ctrl+B` to a 52 px icon rail.
- **Tab bar (36 px):** one tab per session; a status dot + host name + close button; middle-click closes; drag to reorder or drag into a pane edge to split. The active tab gets a 2 px accent underline.
- **Workspace:** panes separated by a 1 px divider with a 6 px drag handle. The focused pane gets a 1 px `--wt-border-strong` outline. Shortcuts: split right `⌘D`, split down `⌘⇧D`, move focus `⌘⌥←/→/↑/↓`, close pane `⌘W`.
- **Status bar (24 px):** for the focused session, shows the connection target, protocol, size (cols × rows or resolution), latency, and a lock icon when host-key verified.

### 5.2 Tablet (640–1023 px)

The sidebar becomes an overlay drawer (hamburger in the top bar). Splits are limited to two panes.

### 5.3 Mobile (< 640 px)

- One session visible at a time; tabs become a horizontally scrollable strip, or a session switcher sheet.
- The host list is the home screen; tapping a host connects.
- **Terminal key bar** pinned above the on-screen keyboard: `Esc` `Tab` `Ctrl` `Alt` `↑` `↓` `←` `→` `|` `~` `/` `-`, with sticky `Ctrl` / `Alt` (tap once = next key, double-tap = lock). Keys 44 × 40 px, horizontally scrollable.
- RDP on mobile: pinch to zoom, two-finger drag to pan, long-press = right click, plus a floating button to show the keyboard.
- Respect `env(safe-area-inset-*)`.

---

## 6. Screens

Each screen lists its purpose, key content and states. Copy shown in quotes is final unless marked [placeholder].

### 6.1 First-run setup (one time, owner)

A centred card, 440 px wide, on `--wt-bg` with the logo (blinking cursor) above it. Four steps with a step indicator (1–4):

1. **Create your account:** name, username, password (with a strength meter; minimum 12 characters), confirm password.
2. **Save your recovery key:** shows the recovery key in mono, in groups of 4 characters, in a bordered box, with **Copy** and **Download .txt** buttons. A required checkbox: "I've saved my recovery key. Without it, a forgotten password means my vault can't be recovered." **Continue** stays disabled until it's ticked.
3. **Set up two-factor authentication:** QR code (200 px) plus the secret in mono with a copy button, then a 6-digit code input (six boxes, auto-advance, paste-friendly). Then the 10 backup codes in a 2-column mono grid with **Download** and **Copy**. The admin can skip this step unless 2FA will be enforced.
4. **You're all set:** primary button "Add your first host", secondary "Generate an SSH identity".

### 6.2 Sign in

- Same card layout. Fields: username, password, then **Sign in**.
- If 2FA is on, a second step: a 6-digit code input with the link "Use a backup code instead".
- Errors: inline, generic ("Incorrect username or password"). Lockout message shows the remaining wait time.
- The "Session expired" variant keeps the username pre-filled.

### 6.3 Hosts

- **Sidebar tree:** folders (chevron + folder icon) and hosts (protocol icon + name + status dot). Right-click / `…` menu: Connect, Connect in split, Edit, Duplicate, Move to…, Delete.
- **Command palette (`⌘K`):** a 560 px wide modal; fuzzy search across hosts, folders and actions; shows the host name (sans) plus `user@address:port` (mono, secondary); `Enter` connects, `⌘Enter` opens in a split.
- **Host editor:** a right-hand side panel, 420 px wide (a full-screen sheet on mobile), with sections:
  - *General:* name, folder, protocol (SSH / RDP segmented control), address, port (22 / 3389 default)
  - *Authentication (SSH):* username; method = identity (picker) / password / agent; jump host (host picker, chainable)
  - *Authentication (RDP):* username, password, domain
  - *Port forwarding (SSH):* a table of rules (local / remote, bind port, destination host:port) with add/remove
  - *Display (RDP):* resolution = fit window (default) / fixed; audio toggle; clipboard toggle
  - *Appearance (SSH):* terminal theme, font size override
- **Empty state:** "No hosts yet" with a **New host** button.

### 6.4 Session panes

- **SSH pane:** xterm.js, full bleed in the pane with 12 px padding. On hover, a pane toolbar appears in the top-right (24 px icon buttons): split right, split down, reconnect, search in terminal, close.
- **RDP pane:** a Guacamole canvas, scaled to fit, with the same toolbar plus clipboard, file transfer (upload / download panel) and send Ctrl+Alt+Del.
- **Connecting:** a centred spinner plus "Connecting to `user@host`…" in mono, with a Cancel link.
- **Dropped connection:** a dimmed overlay over the last frame with "Connection lost. Reconnecting in 3s…", plus **Reconnect now** and **Close** buttons. Back-off: 1, 3, 5, 10 s, then manual.
- **Errors:** a bordered card in the pane with the error title, plain-English cause and fix, and a details disclosure showing the raw error in mono.

### 6.5 Host key dialogs

- **First connection (TOFU):** a modal titled "Verify host key" showing the host, key type and SHA256 fingerprint (mono, selectable). Buttons: **Trust and connect** (primary), **Cancel**.
- **Key changed:** a blocking modal with a danger header strip and the title "Host key has changed". Body: "The key for `host` doesn't match the one you trusted. This can mean the server was reinstalled, or that someone is intercepting the connection." It shows the old and new fingerprints side by side. Buttons: **Cancel** (default, focused, secondary style) and **Accept new key** (danger style). Accepting requires typing the host name.

### 6.6 Identities

- **List view:** a table with columns name, type (Ed25519 / RSA-4096 badge), fingerprint (mono, truncated, copy on click), "Deployed to" (count + avatars of host icons, which expands to a list), created date.
- **New identity:** one click on **New identity** generates immediately, with no form first. A toast-like inline panel then shows the editable name and comment (pre-filled `username@webterm-YYYY-MM`), the fingerprint, and buttons **Push to servers** (primary) and **Done**. An "Advanced" disclosure offers RSA-4096 and an optional passphrase.
- **Import:** a dialog with a drop zone or paste area for the private key, and a passphrase field if needed.
- **Export:** in the `…` menu as "Export private key…". A danger-styled dialog warns that anyone with the file can access every server it's deployed to, then asks for password re-entry before downloading.
- **Push to servers flow (modal, 560 px):**
  1. *Select hosts:* a searchable checklist of SSH hosts, grouped by folder.
  2. *Authenticate once:* for each host without a working credential, a one-time password field. A "Use the same password for all" toggle. Shows "Your password is used once to install the key and is not saved."
  3. *Progress:* one row per host with a live status: queued → connecting → installing → verifying → result. Results are ✓ "Installed" (accent), ✓ "Already present" (secondary), and ✕ errors in plain English ("Authentication failed", "Permission denied writing ~/.ssh", "Host unreachable") with **Retry**.
  4. *Done:* a summary ("Installed on 3 of 4 hosts"), with a checkbox "Use this identity for these hosts" checked by default. A dismissible tip: "Password login is still enabled on these servers. Consider disabling it." with a "How?" link.

### 6.7 Admin › Users (admins only)

- A table with columns name, username, role (Admin / Member badge), 2FA (enabled / not set up), last sign-in, active sessions.
- **Create user:** a dialog for name, username, role, and a temporary password (auto-generated, with copy) that must be changed at first sign-in.
- Row `…` menu: Reset 2FA, Sign out all sessions, Delete user.
- **Delete user:** a danger dialog: "This permanently deletes `name`'s account and their personal vault, including all of their SSH identities. This can't be undone." Requires typing the username.
- **Security settings:** a "Require two-factor authentication for all users" toggle; session idle timeout (15 min / 1 h / 8 h / 24 h).

### 6.8 Settings (per user)

Sections: **Appearance** (theme: System / Light / Dark; density: Comfortable / Compact), **Terminal** (the defaults from §4.2, with a live preview pane), **Security** (change password, 2FA setup or regenerate backup codes, recovery key reminder, active sessions list with "Sign out everywhere"), **Keyboard shortcuts** (read-only list for the MVP).

---

## 7. Components

| Component | Spec |
| --- | --- |
| **Button** | Height 32 px (36 px on touch), padding 0 12 px, `--wt-radius-sm`, `--wt-text-sm` weight 500. Variants: *primary* (accent fill, `--wt-on-accent` text), *secondary* (surface-2 fill, border), *ghost* (no fill), *danger* (danger fill, white text). Icon-only buttons are 32 × 32 with an `aria-label`. |
| **Input** | Height 32 px, `--wt-surface-2` fill, 1 px `--wt-border`, `--wt-radius-sm`; on focus, the border is accent plus the focus ring. Labels above the field, `--wt-text-sm` 500. Error text below in `--wt-danger`. |
| **Code input (2FA)** | Six 44 × 52 boxes, mono 24 px, auto-advance, backspace goes back, accepts a 6-digit paste. |
| **Secret field** | Mono, masked by default, with show/hide and copy buttons. Copy confirms with "Copied" for 1.5 s. |
| **Tabs** | 36 px tall, `--wt-text-sm`, max width 220 px, truncated with an ellipsis; close button appears on hover or when active. |
| **Tree item** | 28 px row (32 px in comfortable density), 16 px indent per level, 16 px icons. |
| **Status dot** | 8 px circle, with colour from §3.1 connection states plus a text label for screen readers. |
| **Badge** | `--wt-text-xs` 500, 2 px × 6 px padding, `--wt-radius-full`, soft background with a solid text colour. |
| **Dialog** | Width 440 / 560 / 720 px, `--wt-radius-lg`, `--wt-shadow-pop`, 24 px padding, title `--wt-text-lg`, actions right-aligned (primary on the right). `Esc` closes unless destructive work is in progress. |
| **Toast** | Bottom-right (bottom-centre on mobile), 360 px max, auto-dismiss after 4 s (errors stay until dismissed). |
| **Menu** | `--wt-radius-md`, `--wt-shadow-pop`, 4 px padding, 28 px items, with shortcuts right-aligned in muted mono. |
| **Empty state** | A 48 px line icon, a `--wt-text-lg` title, one sentence of `--wt-text-secondary`, then one primary action. |

**Icons:** [Lucide](https://lucide.dev) at 16 px (20 px in the mobile key bar and nav), stroke width 1.75. No emoji in the UI.

---

## 8. Accessibility

- WCAG 2.1 AA: text contrast ≥ 4.5:1 (3:1 for 18 px+ or bold 14 px+); the tokens above are chosen to pass on their intended surfaces.
- Visible focus ring (`--wt-focus-ring`) on every interactive element; never remove outlines without a replacement.
- Full keyboard operation, including the tree (arrow keys), tabs (`⌘1–9`, `⌃Tab`), dialogs (focus trap, return focus on close) and the push flow.
- Terminal panes: expose xterm.js's screen reader mode as a setting; announce connection state changes via an `aria-live="polite"` region.
- Honour `prefers-reduced-motion` (no blinking logo cursor, no pulsing dots: use static states) and `prefers-color-scheme`.
- Never convey status with colour alone (§3.1).

---

## 9. Voice and copy

- Plain, short, calm. Sentence case everywhere ("New identity", not "New Identity").
- Say what happened and what to do: "Couldn't reach 10.0.0.12 on port 22. Check the host is on and the port is open."
- Name things consistently: **host** (not server/machine in UI), **identity** (an SSH key pair), **vault**, **session**, **recovery key**, **backup codes**.
- Security copy is explicit about consequences, especially for recovery keys, exports and deletion. No jokes in security or error copy.

---

## 10. Implementation notes for the build

- Put tokens in `src/styles/tokens.css` (sections 3.1–3.3) and import them first. If using Tailwind, map the tokens in `tailwind.config` (`colors.bg: 'var(--wt-bg)'`, and so on) rather than using Tailwind's palette.
- Theme switching sets `data-theme="light" | "dark"` on `<html>`; "System" removes the attribute and relies on `prefers-color-scheme`. Persist the choice per user on the server, with `localStorage` as a fast first paint.
- Put the terminal themes in `src/terminal/themes.ts` (§4.1).
- Logo component: `<Logo size={20} blink={false} tagline={false} />`, rendered as inline SVG (outlined paths) so it's crisp and themeable.
- Ship fonts locally in `/public/fonts` with `font-display: swap`.
- Lay out with flex and grid using the spacing tokens, never magic numbers.
