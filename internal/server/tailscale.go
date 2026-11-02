package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/thatguy-za/webterm/internal/store"
	"github.com/thatguy-za/webterm/internal/tailnet"
)

// tailnetBackend is the embedded Tailscale node; tests swap in a fake.
type tailnetBackend interface {
	Start(tailnet.Options)
	Stop()
	Remove() error
	Status() tailnet.Status
	Peers(ctx context.Context) []tailnet.Peer
	Connected() bool
	HasState() bool
	Dial(ctx context.Context, addr string, timeout time.Duration) (net.Conn, error)
}

var tsHostnameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

// Each user has their own Tailscale node, with its own state folder and
// settings, so one person can be on a tailnet while another is not.

func defaultTSHostname(username string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(username) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		return "webterm"
	}
	if len(name) > 50 {
		name = strings.Trim(name[:50], "-")
	}
	return "webterm-" + name
}

type tailscaleView struct {
	Enabled  bool   `json:"enabled"`
	Hostname string `json:"hostname"`
	ServeUI  bool   `json:"serve_ui"`
	Port     int    `json:"port"`
	tailnet.Status
	HasState bool `json:"has_state"`
	// Peers are the other devices on the tailnet, listed while connected.
	Peers []tailnet.Peer `json:"peers"`
}

func tsKey(name, uid string) string { return "tailscale_" + name + ":" + uid }

// tsFor returns the user's node, creating it on first use.
func (s *Server) tsFor(uid string) tailnetBackend {
	s.tsMu.Lock()
	defer s.tsMu.Unlock()
	if b, ok := s.ts[uid]; ok {
		return b
	}
	b := s.tsNew(filepath.Join(s.cfg.DataDir, "tailscale", uid))
	s.ts[uid] = b
	return b
}

func (s *Server) tailscaleSettings(uid string) (enabled bool, hostname string, serveUI bool) {
	v, _ := s.db.Setting(tsKey("enabled", uid))
	hostname, _ = s.db.Setting(tsKey("hostname", uid))
	if hostname == "" {
		name := ""
		if u, err := s.db.UserByID(uid); err == nil {
			name = u.Username
		}
		hostname = defaultTSHostname(name)
	}
	ui, _ := s.db.Setting(tsKey("serve_ui", uid))
	return v == "1", hostname, ui != "0"
}

func (s *Server) tailscaleView(ctx context.Context, uid string) tailscaleView {
	enabled, hostname, serveUI := s.tailscaleSettings(uid)
	port := s.cfg.Port
	if port == 0 {
		port = 3000
	}
	ts := s.tsFor(uid)
	return tailscaleView{Enabled: enabled, Hostname: hostname, ServeUI: serveUI, Port: port,
		Status: ts.Status(), HasState: ts.HasState(), Peers: ts.Peers(ctx)}
}

// applyTailscale starts or stops the user's node to match their saved settings.
// authKey is used for the first join only and is never stored.
func (s *Server) applyTailscale(uid, authKey string, signIn bool) {
	enabled, hostname, serveUI := s.tailscaleSettings(uid)
	ts := s.tsFor(uid)
	if !enabled {
		ts.Stop()
		return
	}
	ts.Start(tailnet.Options{Hostname: hostname, AuthKey: authKey, SignIn: signIn, ServeUI: serveUI,
		Port: s.cfg.Port, Handler: s.Handler()})
}

// startTailscale brings up every user's node that is switched on, after a start.
func (s *Server) startTailscale() {
	s.migrateTailscale()
	users, err := s.db.ListUsers()
	if err != nil {
		return
	}
	for _, u := range users {
		if on, _ := s.db.Setting(tsKey("enabled", u.ID)); on == "1" {
			s.applyTailscale(u.ID, "", false)
		}
	}
}

func (s *Server) stopTailscale() {
	s.tsMu.Lock()
	defer s.tsMu.Unlock()
	for _, b := range s.ts {
		b.Stop()
	}
}

// migrateTailscale gives the single node that earlier versions kept for the
// whole server to the first admin, along with its settings.
func (s *Server) migrateTailscale() {
	if done, _ := s.db.Setting("tailscale_per_user"); done == "1" {
		return
	}
	defer s.db.SetSetting("tailscale_per_user", "1")
	root := filepath.Join(s.cfg.DataDir, "tailscale")
	if _, err := os.Stat(filepath.Join(root, "tailscaled.state")); err != nil {
		return
	}
	users, err := s.db.ListUsers()
	if err != nil {
		return
	}
	var owner *store.User
	for _, u := range users {
		if u.Role == "admin" {
			owner = u
			break
		}
	}
	if owner == nil {
		return
	}
	dir := filepath.Join(root, owner.ID)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if !e.IsDir() {
			os.Rename(filepath.Join(root, e.Name()), filepath.Join(dir, e.Name()))
		}
	}
	for _, k := range []string{"enabled", "hostname", "serve_ui"} {
		if v, _ := s.db.Setting("tailscale_" + k); v != "" {
			s.db.SetSetting(tsKey(k, owner.ID), v)
		}
	}
}

// forgetTailscale removes a deleted user's node and settings.
func (s *Server) forgetTailscale(uid string) {
	s.tsFor(uid).Remove()
	s.tsMu.Lock()
	delete(s.ts, uid)
	s.tsMu.Unlock()
	for _, k := range []string{"enabled", "hostname", "serve_ui"} {
		s.db.SetSetting(tsKey(k, uid), "")
	}
}

func (s *Server) handleGetTailscale(w http.ResponseWriter, r *http.Request, a *authed) {
	writeJSON(w, http.StatusOK, s.tailscaleView(r.Context(), a.user.ID))
}

func (s *Server) handleSetTailscale(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Enabled  bool   `json:"enabled"`
		Hostname string `json:"hostname"`
		ServeUI  bool   `json:"serve_ui"`
		AuthKey  string `json:"auth_key"`
		SignIn   bool   `json:"sign_in"`
	}
	if !decode(w, r, &in) {
		return
	}
	uid := a.user.ID
	in.Hostname = strings.ToLower(strings.TrimSpace(in.Hostname))
	if in.Hostname == "" {
		in.Hostname = defaultTSHostname(a.user.Username)
	}
	in.AuthKey = strings.TrimSpace(in.AuthKey)
	if !tsHostnameRe.MatchString(in.Hostname) || len(in.AuthKey) > 300 || strings.ContainsAny(in.AuthKey, " \t\r\n") {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if in.Enabled && in.AuthKey == "" && !in.SignIn && !s.tsFor(uid).HasState() {
		apiErr(w, http.StatusBadRequest, "auth_key_required")
		return
	}
	flag := func(b bool) string {
		if b {
			return "1"
		}
		return "0"
	}
	for k, v := range map[string]string{
		tsKey("enabled", uid): flag(in.Enabled), tsKey("hostname", uid): in.Hostname, tsKey("serve_ui", uid): flag(in.ServeUI),
	} {
		if err := s.db.SetSetting(k, v); err != nil {
			serverErr(w, err)
			return
		}
	}
	s.applyTailscale(uid, in.AuthKey, in.SignIn)
	writeJSON(w, http.StatusOK, s.tailscaleView(r.Context(), uid))
}

// handleRemoveTailscale logs the user's node out and forgets its identity.
func (s *Server) handleRemoveTailscale(w http.ResponseWriter, r *http.Request, a *authed) {
	if err := s.db.SetSetting(tsKey("enabled", a.user.ID), "0"); err != nil {
		serverErr(w, err)
		return
	}
	if err := s.tsFor(a.user.ID).Remove(); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tailscaleView(r.Context(), a.user.ID))
}

// lookupHost asks the system resolver, which knows LAN and public names.
func lookupHost(ctx context.Context, host string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return net.DefaultResolver.LookupHost(ctx, host)
}

// useTailnet decides whether host should be reached through the user's node,
// and returns the address to dial. A Tailscale address or *.ts.net name always
// goes over the tailnet. Any other name is resolved with the system DNS first,
// so LAN and public names are fast and unchanged; it is only sent over the
// tailnet when it resolves to a Tailscale address or when system DNS does not
// know it at all, which is how MagicDNS short names (nas) get found.
func (s *Server) useTailnet(ctx context.Context, uid, host string) (string, bool) {
	if !s.tsFor(uid).Connected() {
		return "", false
	}
	if tailnet.IsTailnetHost(host) {
		return host, true
	}
	if ip := net.ParseIP(host); ip != nil || host == "" {
		return "", false
	}
	ips, err := lookupHost(ctx, host)
	if err != nil {
		return host, true
	}
	for _, ip := range ips {
		if tailnet.IsTailnetHost(ip) {
			return ip, true
		}
	}
	return "", false
}

// dialTCP connects to host:port for the user, over their tailnet when the name
// calls for it (see useTailnet) and directly otherwise.
func (s *Server) dialTCP(ctx context.Context, uid, host string, port int, timeout time.Duration) (net.Conn, bool, error) {
	if target, ok := s.useTailnet(ctx, uid, host); ok {
		c, err := s.tsFor(uid).Dial(ctx, net.JoinHostPort(target, strconv.Itoa(port)), timeout)
		return c, true, err
	}
	d := net.Dialer{Timeout: timeout}
	c, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	return c, false, err
}

// tailnetHint explains an unreachable tailnet address when the user's Tailscale is off.
func (s *Server) tailnetHint(uid, host string) string {
	if tailnet.IsTailnetHost(host) && !s.tsFor(uid).Connected() {
		return " This is a Tailscale address and your Tailscale is not connected: turn it on in Settings → Tailscale."
	}
	return ""
}

// tailnetRelay lets guacd, which can't use the embedded node, reach a tailnet
// RDP host: it listens on loopback and forwards each connection over the
// tailnet. It returns the loopback host and port for guacd to use, or "" when
// the host isn't on the tailnet.
func (s *Server) tailnetRelay(ctx context.Context, uid string, h *store.Host) (host, port string, stop func()) {
	target, ok := s.useTailnet(ctx, uid, h.Address)
	if !ok {
		return "", "", func() {}
	}
	ts := s.tsFor(uid)
	dial := func() (net.Conn, error) {
		return ts.Dial(ctx, net.JoinHostPort(target, strconv.Itoa(h.Port)), 10*time.Second)
	}
	first, err := dial()
	if err != nil {
		return "", "", func() {}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		first.Close()
		return "", "", func() {}
	}
	var once sync.Once
	take := func() net.Conn {
		var c net.Conn
		once.Do(func() { c = first })
		return c
	}
	go func() {
		for {
			in, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				out := take()
				if out == nil {
					var derr error
					if out, derr = dial(); derr != nil {
						in.Close()
						return
					}
				}
				pipe(in, out)
			}()
		}
	}()
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	return "127.0.0.1", p, func() {
		ln.Close()
		if c := take(); c != nil {
			c.Close()
		}
	}
}

// pipe copies both ways until either side closes, then closes both.
func pipe(a, b net.Conn) {
	var once sync.Once
	closeBoth := func() { a.Close(); b.Close() }
	go func() { io.Copy(a, b); once.Do(closeBoth) }()
	io.Copy(b, a)
	once.Do(closeBoth)
}
