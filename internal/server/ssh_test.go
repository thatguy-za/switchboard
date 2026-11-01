package server

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/ssh"
)

// testSSHServer accepts one password and echoes terminal input back.
type testSSHServer struct {
	ln      net.Listener
	cfg     *ssh.ServerConfig
	port    int
	noKeys  bool         // refuse public keys even if listed
	home    string       // when set, exec runs real commands here and keys come from ~/.ssh/authorized_keys
	tunnels atomic.Int32 // direct-tcpip channels opened through this server
}

func newTestSSHServer(t *testing.T, password string, authorized ssh.PublicKey) *testSSHServer {
	return newTestSSHServerHome(t, password, authorized, "")
}

// newTestSSHServerHome is a server whose exec requests run real shell commands
// with HOME set to home, and which accepts keys listed in home's authorized_keys.
func newTestSSHServerHome(t *testing.T, password string, authorized ssh.PublicKey, home string) *testSSHServer {
	srv := &testSSHServer{home: home}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, p []byte) (*ssh.Permissions, error) {
			if string(p) == password {
				return nil, nil
			}
			return nil, ssh.ErrNoAuth
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			if authorized != nil && string(k.Marshal()) == string(authorized.Marshal()) {
				return nil, nil
			}
			if srv.home != "" && !srv.noKeys {
				data, _ := os.ReadFile(filepath.Join(srv.home, ".ssh", "authorized_keys"))
				for len(data) > 0 {
					var pub ssh.PublicKey
					pub, _, _, data, _ = ssh.ParseAuthorizedKey(data)
					if pub == nil {
						break
					}
					if string(pub.Marshal()) == string(k.Marshal()) {
						return nil, nil
					}
				}
			}
			return nil, ssh.ErrNoAuth
		},
	}
	srv.cfg = cfg
	srv.setHostKey(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.ln = ln
	srv.port = ln.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go srv.serve(conn)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return srv
}

func (s *testSSHServer) setHostKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.AddHostKey(signer)
}

func (s *testSSHServer) serve(conn net.Conn) {
	sc, chans, reqs, err := ssh.NewServerConn(conn, s.cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go s.globalRequests(sc, reqs)
	for nc := range chans {
		switch nc.ChannelType() {
		case "direct-tcpip":
			s.tunnel(nc)
		case "session":
			s.session(nc)
		default:
			nc.Reject(ssh.UnknownChannelType, "no")
		}
	}
}

func (s *testSSHServer) session(nc ssh.NewChannel) {
	ch, creqs, _ := nc.Accept()
	go func() {
		for r := range creqs {
			switch r.Type {
			case "pty-req", "window-change":
				r.Reply(true, nil)
			case "shell":
				r.Reply(true, nil)
				go func() {
					buf := make([]byte, 1024)
					for {
						n, err := ch.Read(buf)
						if err != nil {
							return
						}
						ch.Write([]byte("echo:" + string(buf[:n])))
					}
				}()
			case "exec":
				var req struct{ Command string }
				ssh.Unmarshal(r.Payload, &req)
				r.Reply(s.home != "", nil)
				if s.home != "" {
					go s.runCommand(ch, req.Command)
				}
			default:
				r.Reply(false, nil)
			}
		}
	}()
}

func (s *testSSHServer) runCommand(ch ssh.Channel, command string) {
	cmd := exec.Command("sh", "-c", command)
	cmd.Env = []string{"HOME=" + s.home, "PATH=" + os.Getenv("PATH")}
	cmd.Stdin = ch
	cmd.Stdout = ch
	cmd.Stderr = ch.Stderr()
	status := uint32(0)
	if err := cmd.Run(); err != nil {
		status = 1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			status = uint32(ee.ExitCode())
		}
	}
	ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
	ch.Close()
}

// tunnel serves "ssh -J" and "ssh -L": it dials the requested address.
func (s *testSSHServer) tunnel(nc ssh.NewChannel) {
	var req struct {
		DestAddr   string
		DestPort   uint32
		OriginAddr string
		OriginPort uint32
	}
	if ssh.Unmarshal(nc.ExtraData(), &req) != nil {
		nc.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}
	out, err := net.Dial("tcp", net.JoinHostPort(req.DestAddr, strconv.Itoa(int(req.DestPort))))
	if err != nil {
		nc.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	s.tunnels.Add(1)
	ch, reqs, _ := nc.Accept()
	go ssh.DiscardRequests(reqs)
	go func() { io.Copy(ch, out); ch.Close() }()
	go func() { io.Copy(out, ch); out.Close() }()
}

// globalRequests serves "ssh -R": it listens and opens forwarded-tcpip channels.
func (s *testSSHServer) globalRequests(sc *ssh.ServerConn, reqs <-chan *ssh.Request) {
	for r := range reqs {
		if r.Type != "tcpip-forward" {
			r.Reply(false, nil)
			continue
		}
		var req struct {
			Addr string
			Port uint32
		}
		if ssh.Unmarshal(r.Payload, &req) != nil {
			r.Reply(false, nil)
			continue
		}
		ln, err := net.Listen("tcp", net.JoinHostPort(req.Addr, strconv.Itoa(int(req.Port))))
		if err != nil {
			r.Reply(false, nil)
			continue
		}
		r.Reply(true, ssh.Marshal(struct{ Port uint32 }{req.Port}))
		go func() {
			defer ln.Close()
			for {
				in, err := ln.Accept()
				if err != nil {
					return
				}
				payload := ssh.Marshal(struct {
					DestAddr   string
					DestPort   uint32
					OriginAddr string
					OriginPort uint32
				}{req.Addr, req.Port, "127.0.0.1", 40000})
				ch, creqs, err := sc.OpenChannel("forwarded-tcpip", payload)
				if err != nil {
					in.Close()
					continue
				}
				go ssh.DiscardRequests(creqs)
				go func() { io.Copy(ch, in); ch.Close() }()
				go func() { io.Copy(in, ch); in.Close() }()
			}
		}()
	}
}

// replaceHostKey swaps in a different key for later connections.
func (s *testSSHServer) replaceHostKey(t *testing.T) {
	s.cfg = &ssh.ServerConfig{PasswordCallback: s.cfg.PasswordCallback}
	s.setHostKey(t)
}

type wsClient struct {
	t *testing.T
	c *websocket.Conn
}

func dialWS(t *testing.T, base string, cl *client, hostID string) *wsClient {
	u, _ := url.Parse(base)
	var cookies []string
	for _, c := range cl.c.Jar.Cookies(u) {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/api/ws/ssh/"+hostID,
		&websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {strings.Join(cookies, "; ")}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return &wsClient{t, c}
}

func (w *wsClient) send(v any) {
	b, _ := json.Marshal(v)
	if err := w.c.Write(context.Background(), websocket.MessageText, b); err != nil {
		w.t.Fatal(err)
	}
}

// next returns the next control message, skipping terminal data.
func (w *wsClient) next() serverMsg {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		typ, data, err := w.c.Read(ctx)
		if err != nil {
			w.t.Fatalf("read: %v", err)
		}
		if typ == websocket.MessageText {
			var m serverMsg
			json.Unmarshal(data, &m)
			if m.Type == "status" {
				continue
			}
			return m
		}
	}
}

func (w *wsClient) expectEcho(text string) {
	w.t.Helper()
	if err := w.c.Write(context.Background(), websocket.MessageBinary, []byte(text)); err != nil {
		w.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		typ, data, err := w.c.Read(ctx)
		if err != nil {
			w.t.Fatalf("waiting for echo: %v", err)
		}
		if typ == websocket.MessageBinary && strings.Contains(string(data), "echo:"+text) {
			return
		}
	}
}

func TestSSHBridge(t *testing.T) {
	dir := t.TempDir()
	srv, err := New(Config{DataDir: dir, KeysDir: dir + "/keys", SessionTimeout: time.Minute},
		fstest.MapFS{"index.html": {Data: []byte("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	srv.limit = newLimiter(1000, time.Minute)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ssh1 := newTestSSHServer(t, "s3cret", nil)

	u := newClient(t, ts.URL)
	if code, _ := u.do("POST", "/api/setup", credentials{"owner", "a long enough password"}); code != 200 {
		t.Fatalf("setup: %d", code)
	}
	code, out := u.do("POST", "/api/hosts", map[string]any{
		"name": "test box", "address": "127.0.0.1", "port": ssh1.port, "username": "root",
		"auth": "password", "password": "s3cret",
	})
	if code != 200 || out["has_password"] != true || out["id"] == nil {
		t.Fatalf("create host: %d %v", code, out)
	}
	if _, leaked := out["password"]; leaked {
		t.Fatal("password returned to the browser")
	}
	hostID := out["id"].(string)

	// First connection: unknown key must be confirmed.
	w := dialWS(t, ts.URL, u, hostID)
	m := w.next()
	if m.Type != "hostkey" || m.Changed || !strings.HasPrefix(m.Fingerprint, "SHA256:") {
		t.Fatalf("expected first-use host key prompt, got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": true})
	if m = w.next(); m.Type != "connected" {
		t.Fatalf("expected connected, got %+v", m)
	}
	w.expectEcho("hello")
	w.c.CloseNow()

	// Second connection: key already trusted, no prompt.
	w = dialWS(t, ts.URL, u, hostID)
	if m = w.next(); m.Type != "connected" {
		t.Fatalf("known host should connect silently, got %+v", m)
	}
	w.c.CloseNow()

	// Changed key: blocking warning; rejecting aborts the connection.
	ssh1.replaceHostKey(t)
	w = dialWS(t, ts.URL, u, hostID)
	m = w.next()
	if m.Type != "hostkey" || !m.Changed || m.OldPrint == "" || m.OldPrint == m.Fingerprint {
		t.Fatalf("expected changed-key warning, got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": false})
	if m = w.next(); m.Type != "error" {
		t.Fatalf("rejected key should end in an error, got %+v", m)
	}

	// Wrong password.
	bad := map[string]any{"name": "bad", "address": "127.0.0.1", "port": ssh1.port, "username": "root", "auth": "password", "password": "nope"}
	_, out = u.do("POST", "/api/hosts", bad)
	w = dialWS(t, ts.URL, u, out["id"].(string))
	if m = w.next(); m.Type != "hostkey" {
		t.Fatalf("got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": true})
	if m = w.next(); m.Type != "error" || !strings.Contains(m.Message, "Authentication failed") {
		t.Fatalf("expected auth failure, got %+v", m)
	}

	// Another user cannot see or connect to this host.
	if code, _ := u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatalf("create user: %d", code)
	}
	k := newClient(t, ts.URL)
	k.do("POST", "/api/login", credentials{"kim", "temporary password"})
	k.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "kims real password"})
	if _, list := k.do("GET", "/api/hosts", nil); len(list["hosts"].([]any)) != 0 {
		t.Fatalf("another user's hosts visible: %v", list)
	}
	if code, _ := k.do("PUT", "/api/hosts/"+hostID, map[string]any{"name": "x", "address": "x", "auth": "password"}); code != 404 {
		t.Fatalf("cross-user update allowed: %d", code)
	}
}

func TestIdentities(t *testing.T) {
	dir := t.TempDir()
	srv, err := New(Config{DataDir: dir, KeysDir: dir + "/keys", SessionTimeout: time.Minute},
		fstest.MapFS{"index.html": {Data: []byte("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	srv.limit = newLimiter(1000, time.Minute)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	u := newClient(t, ts.URL)
	u.do("POST", "/api/setup", credentials{"owner", "a long enough password"})

	code, gen := u.do("POST", "/api/identities/generate", map[string]string{"name": "laptop", "comment": "owner@switchboard", "kind": "ed25519"})
	if code != 200 || !strings.HasPrefix(gen["public_key"].(string), "ssh-ed25519 ") || !strings.HasSuffix(gen["public_key"].(string), " owner@switchboard") {
		t.Fatalf("generate: %d %v", code, gen)
	}
	if _, leaked := gen["private_blob"]; leaked {
		t.Fatal("private key in list view")
	}

	// Export needs the password and round-trips through import.
	id := gen["id"].(string)
	if code, _ := u.do("POST", "/api/identities/"+id+"/export", map[string]string{"password": "wrong password!"}); code != 401 {
		t.Fatalf("export without password: %d", code)
	}
	code, exp := u.do("POST", "/api/identities/"+id+"/export", map[string]string{"password": "a long enough password"})
	if code != 200 || !strings.Contains(exp["private_key"].(string), "BEGIN OPENSSH PRIVATE KEY") {
		t.Fatalf("export: %d", code)
	}
	code, imp := u.do("POST", "/api/identities/import", map[string]string{"name": "copy", "private_key": exp["private_key"].(string)})
	if code != 200 || imp["fingerprint"] != gen["fingerprint"] {
		t.Fatalf("import: %d %v", code, imp)
	}

	// Passphrase-protected import.
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	block, err := ssh.MarshalPrivateKeyWithPassphrase(priv, "", []byte("pass"))
	if err != nil {
		t.Fatal(err)
	}
	pemText := string(pemEncode(block))
	if code, out := u.do("POST", "/api/identities/import", map[string]string{"name": "locked", "private_key": pemText}); code != 400 || out["error"] != "passphrase_required" {
		t.Fatalf("expected passphrase prompt: %d %v", code, out)
	}
	if code, _ := u.do("POST", "/api/identities/import", map[string]string{"name": "locked", "private_key": pemText, "passphrase": "pass"}); code != 200 {
		t.Fatalf("import with passphrase: %d", code)
	}
	if code, _ := u.do("POST", "/api/identities/import", map[string]string{"name": "junk", "private_key": "not a key"}); code != 400 {
		t.Fatalf("junk import: %d", code)
	}

}

func pemEncode(b *pem.Block) []byte { return pem.EncodeToMemory(b) }

func newBridgeEnv(t *testing.T) (*Server, *httptest.Server, *client) {
	return newBridgeEnvCfg(t, nil)
}

func newBridgeEnvCfg(t *testing.T, mutate func(*Config)) (*Server, *httptest.Server, *client) {
	dir := t.TempDir()
	cfg := Config{DataDir: dir, KeysDir: dir + "/keys", SessionTimeout: time.Minute}
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := New(cfg, fstest.MapFS{"index.html": {Data: []byte("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Close)
	srv.limit = newLimiter(1000, time.Minute)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	u := newClient(t, ts.URL)
	if code, _ := u.do("POST", "/api/setup", credentials{"owner", "a long enough password"}); code != 200 {
		t.Fatalf("setup: %d", code)
	}
	return srv, ts, u
}

func addHost(t *testing.T, u *client, name string, port int, extra map[string]any) string {
	body := map[string]any{"name": name, "address": "127.0.0.1", "port": port, "username": "root", "auth": "password", "password": "s3cret"}
	for k, v := range extra {
		body[k] = v
	}
	code, out := u.do("POST", "/api/hosts", body)
	if code != 200 {
		t.Fatalf("create host %s: %d %v", name, code, out)
	}
	return out["id"].(string)
}

// tcpEcho starts a plain TCP echo server.
func tcpEcho(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	return ln.Addr().(*net.TCPAddr).Port
}

func freePort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestJumpChain(t *testing.T) {
	_, ts, u := newBridgeEnv(t)
	jump := newTestSSHServer(t, "s3cret", nil)
	target := newTestSSHServer(t, "s3cret", nil)

	jumpID := addHost(t, u, "bastion", jump.port, nil)
	if code, _ := u.do("POST", "/api/hosts", map[string]any{"name": "self", "address": "x", "auth": "password", "jumps": []string{"missing"}}); code != 400 {
		t.Fatalf("unknown jump host accepted: %d", code)
	}
	targetID := addHost(t, u, "private box", target.port, map[string]any{"jumps": []string{jumpID}})

	w := dialWS(t, ts.URL, u, targetID)
	m := w.next()
	if m.Type != "hostkey" || m.Host != "bastion" {
		t.Fatalf("expected the jump host's key first, got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": true})
	m = w.next()
	if m.Type != "hostkey" || m.Host != "private box" {
		t.Fatalf("expected the target's key second, got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": true})
	if m = w.next(); m.Type != "connected" {
		t.Fatalf("expected connected, got %+v", m)
	}
	w.expectEcho("through-the-jump")
	if n := jump.tunnels.Load(); n != 1 {
		t.Fatalf("expected the connection to go through the jump host once, got %d tunnels", n)
	}
	w.c.CloseNow()

	// Both keys are now trusted, so the second connection is silent.
	w = dialWS(t, ts.URL, u, targetID)
	if m = w.next(); m.Type != "connected" {
		t.Fatalf("known chain should connect silently, got %+v", m)
	}
	w.c.CloseNow()

	// A bad jump host is named in the error.
	jump.replaceHostKey(t)
	w = dialWS(t, ts.URL, u, targetID)
	m = w.next()
	if m.Type != "hostkey" || !m.Changed || m.Host != "bastion" {
		t.Fatalf("expected a changed-key warning for the jump host, got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": false})
	if m = w.next(); m.Type != "error" || !strings.HasPrefix(m.Message, "Jump host bastion:") {
		t.Fatalf("expected an error naming the jump host, got %+v", m)
	}

	// Hosts can't jump through themselves.
	if code, _ := u.do("PUT", "/api/hosts/"+targetID, map[string]any{"name": "private box", "address": "127.0.0.1", "auth": "password", "jumps": []string{targetID}}); code != 400 {
		t.Fatalf("self jump accepted: %d", code)
	}
}

func TestPortForwards(t *testing.T) {
	_, ts, u := newBridgeEnv(t)
	sshd := newTestSSHServer(t, "s3cret", nil)
	echo := tcpEcho(t)
	local, remote := freePort(t), freePort(t)

	if code, _ := u.do("POST", "/api/hosts", map[string]any{"name": "x", "address": "x", "auth": "password",
		"forwards": []map[string]any{{"kind": "local", "bind_port": 80, "dest_host": "x", "dest_port": 1}}}); code != 400 {
		t.Fatalf("privileged local bind accepted: %d", code)
	}

	id := addHost(t, u, "tunnel box", sshd.port, map[string]any{"forwards": []map[string]any{
		{"kind": "local", "bind_port": local, "dest_host": "127.0.0.1", "dest_port": echo},
		{"kind": "remote", "bind_port": remote, "dest_host": "127.0.0.1", "dest_port": echo},
	}})

	w := dialWS(t, ts.URL, u, id)
	if m := w.next(); m.Type != "hostkey" {
		t.Fatalf("got %+v", m)
	}
	w.send(map[string]any{"type": "trust", "accept": true})
	if m := w.next(); m.Type != "connected" {
		t.Fatalf("got %+v", m)
	}
	for i := 0; i < 2; i++ {
		if m := w.next(); m.Type != "forward" || m.Forward == nil || !m.Forward.OK || m.Forward.Index != i {
			t.Fatalf("forward %d not active: %+v", i, m)
		}
	}

	// Local: connect to the Switchboard server's port, reach the echo server through SSH.
	// Remote: connect to the SSH server's port, reach the echo server from Switchboard.
	for _, port := range []int{local, remote} {
		c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 3*time.Second)
		if err != nil {
			t.Fatalf("port %d: %v", port, err)
		}
		c.SetDeadline(time.Now().Add(5 * time.Second))
		c.Write([]byte("ping"))
		buf := make([]byte, 4)
		if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
			t.Fatalf("port %d: got %q, %v", port, buf, err)
		}
		c.Close()
	}
	if n := sshd.tunnels.Load(); n != 1 {
		t.Fatalf("local forward should open one tunnel, got %d", n)
	}

	// Closing the session releases the local port.
	w.c.CloseNow()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ln, err := net.Listen("tcp", ":"+strconv.Itoa(local))
		if err == nil {
			ln.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("local forward port still held after the session closed")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// A second session finds a busy port and reports it without ending.
	hold, err := net.Listen("tcp", ":"+strconv.Itoa(local))
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Close()
	w = dialWS(t, ts.URL, u, id)
	if m := w.next(); m.Type != "connected" {
		t.Fatalf("got %+v", m)
	}
	if m := w.next(); m.Type != "forward" || m.Forward.OK || !strings.Contains(m.Forward.Message, "already in use") {
		t.Fatalf("expected a busy-port report, got %+v", m)
	}
	w.expectEcho("still-alive")
}
