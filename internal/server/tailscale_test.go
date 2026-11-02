package server

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/thatguy-za/switchboard/internal/tailnet"
)

// fakeTailnet stands in for the embedded node: it records what it is asked to
// do and "dials the tailnet" by connecting to target.
type fakeTailnet struct {
	mu        sync.Mutex
	connected bool
	hasState  bool
	started   []tailnet.Options
	stopped   int
	removed   int
	dialed    []string
	target    string
}

func (f *fakeTailnet) Start(o tailnet.Options) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started = append(f.started, o)
	f.hasState = true
}
func (f *fakeTailnet) Stop() { f.mu.Lock(); f.stopped++; f.mu.Unlock() }
func (f *fakeTailnet) Remove() error {
	f.mu.Lock()
	f.removed++
	f.hasState = false
	f.mu.Unlock()
	return nil
}
func (f *fakeTailnet) HasState() bool  { f.mu.Lock(); defer f.mu.Unlock(); return f.hasState }
func (f *fakeTailnet) Connected() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.connected }
func (f *fakeTailnet) Status() tailnet.Status {
	if f.Connected() {
		return tailnet.Status{State: tailnet.StateUp, Name: "switchboard.tail1234.ts.net", IPs: []string{"100.64.0.2"}}
	}
	return tailnet.Status{State: tailnet.StateOff}
}
func (f *fakeTailnet) Peers(context.Context) []tailnet.Peer {
	if !f.Connected() {
		return nil
	}
	return []tailnet.Peer{{Name: "nas", DNSName: "nas.tail1234.ts.net", IPs: []string{"100.64.0.5"}, OS: "linux", Online: true}}
}
func (f *fakeTailnet) Dial(_ context.Context, addr string, _ time.Duration) (net.Conn, error) {
	f.mu.Lock()
	f.dialed = append(f.dialed, addr)
	target := f.target
	f.mu.Unlock()
	return net.Dial("tcp", target)
}
func (f *fakeTailnet) dials() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialed...)
}

func TestTailscaleSettings(t *testing.T) {
	srv, _, u := newBridgeEnv(t)
	fake := &fakeTailnet{}
	useTailnet(srv, fake)

	if code, out := u.do("GET", "/api/tailscale", nil); code != 200 || out["enabled"] != false || out["hostname"] != "switchboard-owner" || out["serve_ui"] != true {
		t.Fatalf("defaults: %d %v", code, out)
	}
	// The first join needs a key; names must be valid DNS labels.
	if code, out := u.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": "switchboard"}); code != 400 || out["error"] != "auth_key_required" {
		t.Fatalf("enabling without a key: %d %v", code, out)
	}
	for _, bad := range []string{"has space", "-lead", "trail-", "UPPER_case", strings.Repeat("a", 64)} {
		if code, _ := u.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": bad, "auth_key": "tskey-auth-x"}); code != 400 {
			t.Fatalf("hostname %q accepted: %d", bad, code)
		}
	}
	if code, _ := u.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": "box", "auth_key": "tskey with space"}); code != 400 {
		t.Fatalf("key with spaces accepted: %d", code)
	}
	if len(fake.started) != 0 {
		t.Fatalf("rejected requests started the node: %+v", fake.started)
	}

	// Signing in instead of pasting a key joins without one.
	if code, out := u.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": "switchboard", "sign_in": true}); code != 200 {
		t.Fatalf("sign in: %d %v", code, out)
	}
	if len(fake.started) != 1 || !fake.started[0].SignIn || fake.started[0].AuthKey != "" {
		t.Fatalf("sign-in options: %+v", fake.started)
	}
	fake.started, fake.hasState = nil, false

	if code, out := u.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": "Sb-Home", "serve_ui": false, "auth_key": " tskey-auth-abc "}); code != 200 || out["enabled"] != true || out["hostname"] != "sb-home" {
		t.Fatalf("enable: %d %v", code, out)
	}
	if len(fake.started) != 1 {
		t.Fatalf("expected one start, got %+v", fake.started)
	}
	o := fake.started[0]
	if o.Hostname != "sb-home" || o.AuthKey != "tskey-auth-abc" || o.ServeUI || o.Handler == nil {
		t.Fatalf("start options: %+v", o)
	}
	// The key is used once and never stored.
	for _, k := range []string{"enabled", "hostname", "serve_ui"} {
		if v, _ := srv.db.Setting(tsKey(k, ownerID(t, srv))); strings.Contains(v, "tskey") {
			t.Fatalf("auth key stored in %s", k)
		}
	}
	if out := srv.tailscaleView(context.Background(), ownerID(t, srv)); out.Hostname != "sb-home" || out.ServeUI {
		t.Fatalf("saved settings: %+v", out)
	}

	// With the node already joined, turning it back on needs no key; turning it off stops it.
	if code, _ := u.do("POST", "/api/tailscale", map[string]any{"enabled": false, "hostname": "sb-home"}); code != 200 || fake.stopped != 1 {
		t.Fatalf("disable: %d stopped=%d", code, fake.stopped)
	}
	if code, _ := u.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": "sb-home", "serve_ui": true}); code != 200 || len(fake.started) != 2 || fake.started[1].AuthKey != "" {
		t.Fatalf("re-enable without a key: %d %+v", code, fake.started)
	}
	if code, _ := u.do("POST", "/api/tailscale/remove", nil); code != 200 || fake.removed != 1 {
		t.Fatalf("remove: %d removed=%d", code, fake.removed)
	}
	if enabled, _, _ := srv.tailscaleSettings(ownerID(t, srv)); enabled {
		t.Fatal("still enabled after removal")
	}
}

func useTailnet(srv *Server, b tailnetBackend) {
	srv.tsNew = func(string) tailnetBackend { return b }
}

// Every user has their own node: one can be on a tailnet while another is not.
func TestTailscaleIsPerUser(t *testing.T) {
	srv, ts, owner := newBridgeEnv(t)
	nodes := map[string]*fakeTailnet{}
	srv.tsNew = func(dir string) tailnetBackend {
		f := &fakeTailnet{}
		nodes[filepath.Base(dir)] = f
		return f
	}
	if code, _ := owner.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatalf("add member: %d", code)
	}
	m := newClient(t, ts.URL)
	m.do("POST", "/api/login", credentials{"kim", "temporary password"})
	m.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "a different long password"})

	// A member can use Tailscale, with a device name made from their username.
	if code, out := m.do("GET", "/api/tailscale", nil); code != 200 || out["hostname"] != "switchboard-kim" || out["enabled"] != false {
		t.Fatalf("member view: %d %v", code, out)
	}
	if code, out := m.do("POST", "/api/tailscale", map[string]any{"enabled": true, "hostname": "kims-box", "auth_key": "tskey-auth-k"}); code != 200 || out["enabled"] != true {
		t.Fatalf("member enable: %d %v", code, out)
	}
	// The owner is unaffected.
	if _, out := owner.do("GET", "/api/tailscale", nil); out["enabled"] != false {
		t.Fatalf("owner picked up kim's setting: %v", out)
	}
	if len(nodes) != 2 {
		t.Fatalf("expected one node per user, got %d", len(nodes))
	}
	started := 0
	for _, n := range nodes {
		started += len(n.started)
	}
	if started != 1 {
		t.Fatalf("only kim's node should have started, got %d starts", started)
	}
	if code, _ := newClient(t, ts.URL).do("GET", "/api/tailscale", nil); code != 401 {
		t.Fatalf("anonymous access: %d", code)
	}
	// Deleting a user removes their node.
	users, _ := srv.db.ListUsers()
	var kim string
	for _, u := range users {
		if u.Username == "kim" {
			kim = u.ID
		}
	}
	if code, _ := owner.do("DELETE", "/api/admin/users/"+kim, nil); code != 200 || nodes[kim].removed != 1 {
		t.Fatalf("delete user: %d removed=%d", code, nodes[kim].removed)
	}
}

func TestDefaultTailscaleHostname(t *testing.T) {
	for in, want := range map[string]string{"owner": "switchboard-owner", "Kim O'Neil": "switchboard-kim-o-neil", "   ": "switchboard", "ünï": "switchboard-n", "a_b": "switchboard-a-b"} {
		if got := defaultTSHostname(in); got != want || !tsHostnameRe.MatchString(got) {
			t.Fatalf("%q -> %q, want %q", in, got, want)
		}
	}
}

// The single node that earlier versions kept for the whole server moves to the first admin.
func TestTailscaleMigration(t *testing.T) {
	srv, _, _ := newBridgeEnv(t)
	root := filepath.Join(srv.cfg.DataDir, "tailscale")
	os.MkdirAll(root, 0o700)
	os.WriteFile(filepath.Join(root, "tailscaled.state"), []byte("x"), 0o600)
	srv.db.SetSetting("tailscale_enabled", "1")
	srv.db.SetSetting("tailscale_hostname", "old-name")
	srv.db.SetSetting("tailscale_per_user", "")
	srv.migrateTailscale()
	id := ownerID(t, srv)
	if _, err := os.Stat(filepath.Join(root, id, "tailscaled.state")); err != nil {
		t.Fatalf("state did not move to the owner: %v", err)
	}
	if on, host, _ := srv.tailscaleSettings(id); !on || host != "old-name" {
		t.Fatalf("settings did not move: %v %q", on, host)
	}
}

func TestSSHOverTailnet(t *testing.T) {
	srv, ts, u := newBridgeEnv(t)
	sshd := newTestSSHServer(t, "s3cret", nil)
	fake := &fakeTailnet{connected: true, target: net.JoinHostPort("127.0.0.1", strconv.Itoa(sshd.port))}
	useTailnet(srv, fake)

	// A Tailscale address goes over the tailnet.
	id := addHost(t, u, "nas", sshd.port, map[string]any{"address": "100.64.0.9"})
	trustHost(t, ts.URL, u, id, 1)
	if d := fake.dials(); len(d) != 1 || d[0] != net.JoinHostPort("100.64.0.9", strconv.Itoa(sshd.port)) {
		t.Fatalf("expected one tailnet dial, got %v", d)
	}
	// An ordinary address does not.
	direct := addHost(t, u, "direct", sshd.port, nil)
	trustHost(t, ts.URL, u, direct, 1)
	if d := fake.dials(); len(d) != 1 {
		t.Fatalf("a direct host used the tailnet: %v", d)
	}
	// A name the system DNS knows is dialled directly, not over the tailnet.
	short := addHost(t, u, "short", sshd.port, map[string]any{"address": "localhost"})
	trustHost(t, ts.URL, u, short, 1)
	if d := fake.dials(); len(d) != 1 {
		t.Fatalf("a name the system DNS resolves used the tailnet: %v", d)
	}
	// A name only the tailnet knows (MagicDNS) is looked up there.
	magic := addHost(t, u, "magic", sshd.port, map[string]any{"address": "nas-box.invalid"})
	trustHost(t, ts.URL, u, magic, 1)
	if d := fake.dials(); len(d) != 2 || !strings.HasPrefix(d[1], "nas-box.invalid:") {
		t.Fatalf("expected a tailnet lookup for the unknown name, got %v", d)
	}
}

func TestTailnetAddressWhileDisconnected(t *testing.T) {
	srv, _, _ := newBridgeEnv(t)
	fake := &fakeTailnet{}
	useTailnet(srv, fake)
	// An unreachable tailnet address points the user at the Tailscale setting.
	if h := srv.tailnetHint(ownerID(t, srv), "100.64.0.9"); !strings.Contains(h, "Tailscale") {
		t.Fatalf("no hint for a tailnet address: %q", h)
	}
	if h := srv.tailnetHint(ownerID(t, srv), "192.168.1.5"); h != "" {
		t.Fatalf("hint for an ordinary address: %q", h)
	}
	fake.connected = true
	if h := srv.tailnetHint(ownerID(t, srv), "100.64.0.9"); h != "" {
		t.Fatalf("hint while connected: %q", h)
	}
}

func TestRDPRelayOverTailnet(t *testing.T) {
	srv, _, u := newBridgeEnv(t)
	echo := tcpEcho(t)
	fake := &fakeTailnet{connected: true, target: net.JoinHostPort("127.0.0.1", strconv.Itoa(echo))}
	useTailnet(srv, fake)
	id := addHost(t, u, "pc", 3389, map[string]any{"protocol": "rdp", "address": "pc.tail1234.ts.net", "auth": "password"})
	h, err := srv.db.GetHost(id, ownerID(t, srv))
	if err != nil {
		t.Fatal(err)
	}
	host, port, stop := srv.tailnetRelay(context.Background(), ownerID(t, srv), h)
	defer stop()
	if host != "127.0.0.1" || port == "" {
		t.Fatalf("expected a loopback relay, got %q %q", host, port)
	}
	// Two connections both reach the host through the tailnet.
	for i := 0; i < 2; i++ {
		c, err := net.Dial("tcp", net.JoinHostPort(host, port))
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte("hello"))
		buf := make([]byte, 5)
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := c.Read(buf); err != nil || string(buf) != "hello" {
			t.Fatalf("relay %d: %q %v", i, buf, err)
		}
		c.Close()
	}
	// A host that isn't on the tailnet gets no relay.
	plain := addHost(t, u, "lan", 3389, map[string]any{"protocol": "rdp", "address": "192.168.1.5", "auth": "password"})
	h2, _ := srv.db.GetHost(plain, ownerID(t, srv))
	if host, _, stop2 := srv.tailnetRelay(context.Background(), ownerID(t, srv), h2); host != "" {
		stop2()
		t.Fatalf("a LAN host got a relay: %q", host)
	}
}

func ownerID(t *testing.T, srv *Server) string {
	t.Helper()
	u, err := srv.db.UserByName("owner")
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

func TestTailscaleListsPeers(t *testing.T) {
	srv, _, u := newBridgeEnv(t)
	fake := &fakeTailnet{}
	useTailnet(srv, fake)
	if _, out := u.do("GET", "/api/tailscale", nil); out["peers"] != nil {
		t.Fatalf("peers while disconnected: %v", out["peers"])
	}
	fake.connected = true
	_, out := u.do("GET", "/api/tailscale", nil)
	peers, _ := out["peers"].([]any)
	if len(peers) != 1 || peers[0].(map[string]any)["dns_name"] != "nas.tail1234.ts.net" {
		t.Fatalf("peers: %v", out["peers"])
	}
}
