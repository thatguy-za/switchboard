package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/thatguy-za/switchboard/internal/store"
	"github.com/thatguy-za/switchboard/internal/tailnet"
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

const defaultTSHostname = "switchboard"

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

func (s *Server) tailscaleSettings() (enabled bool, hostname string, serveUI bool) {
	v, _ := s.db.Setting("tailscale_enabled")
	hostname, _ = s.db.Setting("tailscale_hostname")
	if hostname == "" {
		hostname = defaultTSHostname
	}
	ui, _ := s.db.Setting("tailscale_serve_ui")
	return v == "1", hostname, ui != "0"
}

func (s *Server) tailscaleView(ctx context.Context) tailscaleView {
	enabled, hostname, serveUI := s.tailscaleSettings()
	port := s.cfg.Port
	if port == 0 {
		port = 3000
	}
	return tailscaleView{Enabled: enabled, Hostname: hostname, ServeUI: serveUI, Port: port,
		Status: s.ts.Status(), HasState: s.ts.HasState(), Peers: s.ts.Peers(ctx)}
}

// applyTailscale starts or stops the node to match the saved settings.
// authKey is used for the first join only and is never stored.
func (s *Server) applyTailscale(authKey string, signIn bool) {
	enabled, hostname, serveUI := s.tailscaleSettings()
	if !enabled {
		s.ts.Stop()
		return
	}
	s.ts.Start(tailnet.Options{Hostname: hostname, AuthKey: authKey, SignIn: signIn, ServeUI: serveUI,
		Port: s.cfg.Port, Handler: s.Handler()})
}

func (s *Server) handleGetTailscale(w http.ResponseWriter, r *http.Request, _ *authed) {
	writeJSON(w, http.StatusOK, s.tailscaleView(r.Context()))
}

func (s *Server) handleSetTailscale(w http.ResponseWriter, r *http.Request, _ *authed) {
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
	in.Hostname = strings.ToLower(strings.TrimSpace(in.Hostname))
	if in.Hostname == "" {
		in.Hostname = defaultTSHostname
	}
	in.AuthKey = strings.TrimSpace(in.AuthKey)
	if !tsHostnameRe.MatchString(in.Hostname) || len(in.AuthKey) > 300 || strings.ContainsAny(in.AuthKey, " \t\r\n") {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if in.Enabled && in.AuthKey == "" && !in.SignIn && !s.ts.HasState() {
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
		"tailscale_enabled": flag(in.Enabled), "tailscale_hostname": in.Hostname, "tailscale_serve_ui": flag(in.ServeUI),
	} {
		if err := s.db.SetSetting(k, v); err != nil {
			serverErr(w, err)
			return
		}
	}
	s.applyTailscale(in.AuthKey, in.SignIn)
	writeJSON(w, http.StatusOK, s.tailscaleView(r.Context()))
}

// handleRemoveTailscale logs the node out and forgets its identity.
func (s *Server) handleRemoveTailscale(w http.ResponseWriter, r *http.Request, _ *authed) {
	if err := s.db.SetSetting("tailscale_enabled", "0"); err != nil {
		serverErr(w, err)
		return
	}
	if err := s.ts.Remove(); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.tailscaleView(r.Context()))
}

// viaTailnet reports whether host should be tried on the tailnet.
func (s *Server) viaTailnet(host string) bool {
	return s.ts.Connected() && (tailnet.IsTailnetHost(host) || tailnet.IsShortName(host))
}

// dialTCP connects to host:port, over the tailnet for tailnet addresses and
// directly otherwise. A short name that the tailnet can't resolve falls back
// to a direct dial, so Docker network names keep working.
func (s *Server) dialTCP(ctx context.Context, host string, port int, timeout time.Duration) (net.Conn, bool, error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	if s.viaTailnet(host) {
		if tailnet.IsTailnetHost(host) {
			c, err := s.ts.Dial(ctx, addr, timeout)
			return c, true, err
		}
		if c, err := s.ts.Dial(ctx, addr, 3*time.Second); err == nil {
			return c, true, nil
		}
	}
	d := net.Dialer{Timeout: timeout}
	c, err := d.DialContext(ctx, "tcp", addr)
	return c, false, err
}

// tailnetHint explains an unreachable tailnet address when Tailscale is off.
func (s *Server) tailnetHint(host string) string {
	if tailnet.IsTailnetHost(host) && !s.ts.Connected() {
		return " This is a Tailscale address and Tailscale is not connected: turn it on in Settings → Server."
	}
	return ""
}

// tailnetRelay lets guacd, which can't use the embedded node, reach a tailnet
// RDP host: it listens on loopback and forwards each connection over the
// tailnet. It returns the loopback host and port for guacd to use, or "" when
// the host isn't on the tailnet.
func (s *Server) tailnetRelay(ctx context.Context, h *store.Host) (host, port string, stop func()) {
	if !s.viaTailnet(h.Address) {
		return "", "", func() {}
	}
	first, via, err := s.dialTCP(ctx, h.Address, h.Port, 10*time.Second)
	if err != nil || !via {
		if first != nil {
			first.Close()
		}
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
					if out, _, derr = s.dialTCP(ctx, h.Address, h.Port, 10*time.Second); derr != nil {
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
