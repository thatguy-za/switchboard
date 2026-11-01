// Package tailnet runs an embedded Tailscale node so Switchboard can reach
// hosts on a tailnet and, if asked, serve its web UI there.
package tailnet

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

const (
	StateOff      = "off"
	StateNeedsKey = "needs_key"
	StateStarting = "starting"
	StateUp       = "connected"
	StateError    = "error"

	upTimeout = 2 * time.Minute
)

// Status is what the settings page shows.
type Status struct {
	State string   `json:"state"`
	Error string   `json:"error,omitempty"`
	Name  string   `json:"name,omitempty"` // the node's MagicDNS name
	IPs   []string `json:"ips,omitempty"`
}

// Options configure a node. AuthKey is only needed for the first join: after
// that the node's state in the data folder is enough.
type Options struct {
	Hostname string
	AuthKey  string
	ServeUI  bool
	Port     int
	Handler  http.Handler
}

// Manager owns at most one running node.
type Manager struct {
	dir string

	mu     sync.Mutex
	srv    *tsnet.Server
	web    *http.Server
	cancel context.CancelFunc
	st     Status
}

func New(dir string) *Manager { return &Manager{dir: dir, st: Status{State: StateOff}} }

var (
	cgnat = netip.MustParsePrefix("100.64.0.0/10")
	ula   = netip.MustParsePrefix("fd7a:115c:a1e0::/48")
)

// IsTailnetHost reports whether host is clearly a tailnet address: a Tailscale
// IP or a *.ts.net name.
func IsTailnetHost(host string) bool {
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		return cgnat.Contains(ip) || ula.Contains(ip)
	}
	return strings.HasSuffix(strings.ToLower(strings.TrimSuffix(host, ".")), ".ts.net")
}

// IsShortName reports whether host is a single-label name, which could be a
// MagicDNS short name.
func IsShortName(host string) bool {
	if host == "" || strings.Contains(host, ".") || strings.Contains(host, ":") {
		return false
	}
	_, err := netip.ParseAddr(host)
	return err != nil
}

func (m *Manager) stateFile() string { return filepath.Join(m.dir, "tailscaled.state") }

// HasState reports whether this node has joined a tailnet before.
func (m *Manager) HasState() bool {
	_, err := os.Stat(m.stateFile())
	return err == nil
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.st
}

func (m *Manager) Connected() bool { return m.Status().State == StateUp }

// Start (re)starts the node. It returns at once; Status shows the progress.
func (m *Manager) Start(o Options) {
	m.Stop()
	if !m.HasState() && o.AuthKey == "" {
		m.set(Status{State: StateNeedsKey})
		return
	}
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		m.set(Status{State: StateError, Error: "Could not create the Tailscale state folder."})
		return
	}
	srv := &tsnet.Server{
		Dir: m.dir, Hostname: o.Hostname, AuthKey: o.AuthKey,
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {},
	}
	ctx, cancel := context.WithTimeout(context.Background(), upTimeout)
	m.mu.Lock()
	m.srv, m.cancel = srv, cancel
	m.st = Status{State: StateStarting}
	m.mu.Unlock()

	go func() {
		defer cancel()
		st, err := srv.Up(ctx)
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.srv != srv {
			return // stopped or replaced meanwhile
		}
		if err != nil {
			m.st = Status{State: StateError, Error: upError(err)}
			return
		}
		m.st = Status{State: StateUp}
		if st.Self != nil {
			m.st.Name = strings.TrimSuffix(st.Self.DNSName, ".")
		}
		for _, ip := range st.TailscaleIPs {
			m.st.IPs = append(m.st.IPs, ip.String())
		}
		if o.ServeUI && o.Handler != nil {
			m.serveLocked(srv, o)
		}
	}()
}

// serveLocked serves the web UI on the node's tailnet addresses.
func (m *Manager) serveLocked(srv *tsnet.Server, o Options) {
	ln, err := srv.Listen("tcp", ":"+itoa(o.Port))
	if err != nil {
		m.st.Error = "Joined the tailnet, but could not serve the web UI on port " + itoa(o.Port) + "."
		return
	}
	m.web = &http.Server{Handler: o.Handler, ReadHeaderTimeout: 10 * time.Second}
	go m.web.Serve(ln)
}

// Stop shuts the node down. Its state is kept, so it can rejoin without a key.
func (m *Manager) Stop() {
	m.mu.Lock()
	srv, web, cancel := m.srv, m.web, m.cancel
	m.srv, m.web, m.cancel = nil, nil, nil
	m.st = Status{State: StateOff}
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if web != nil {
		web.Close()
	}
	if srv != nil {
		srv.Close()
	}
}

// Remove logs the node out of the tailnet and forgets it.
func (m *Manager) Remove() error {
	m.mu.Lock()
	srv := m.srv
	m.mu.Unlock()
	if srv != nil {
		if lc, err := srv.LocalClient(); err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			lc.Logout(ctx) // best effort: offline nodes are cleaned up by an admin in Tailscale
			cancel()
		}
	}
	m.Stop()
	return os.RemoveAll(m.dir)
}

// Dial connects to addr (host:port) through the tailnet.
func (m *Manager) Dial(ctx context.Context, addr string, timeout time.Duration) (net.Conn, error) {
	m.mu.Lock()
	srv, up := m.srv, m.st.State == StateUp
	m.mu.Unlock()
	if srv == nil || !up {
		return nil, errors.New("tailscale is not connected")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return srv.Dial(ctx, "tcp", addr)
}

func (m *Manager) set(st Status) {
	m.mu.Lock()
	m.st = st
	m.mu.Unlock()
}

func upError(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "Could not join the tailnet. Check that the auth key is valid and unused, and that this machine can reach Tailscale."
	}
	return "Could not join the tailnet: " + err.Error()
}

func itoa(n int) string {
	if n == 0 {
		n = 3000
	}
	return strconv.Itoa(n)
}
