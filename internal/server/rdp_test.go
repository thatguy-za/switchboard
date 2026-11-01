package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/thatguy-za/switchboard/internal/guac"
)

var fakeArgNames = []string{"hostname", "port", "username", "password", "domain", "security", "ignore-cert",
	"resize-method", "enable-drive", "drive-path", "create-drive-path", "drive-name", "client-name", "color-depth", "unknown-extra"}

// fakeGuacd speaks just enough of guacd's side of the protocol to test the relay.
type fakeGuacd struct {
	addr       string
	sessions   chan *guacdConn
	refuse     []string // when set, answer connect with an error: message, status
	afterReady func(*guacdConn)
}

type guacdConn struct {
	conn               net.Conn
	selected           string
	size, audio, image []string
	args               map[string]string
	frames             chan guac.Instruction
	closed             chan struct{}
	mu                 sync.Mutex
}

func (g *guacdConn) write(s string) { g.mu.Lock(); io.WriteString(g.conn, s); g.mu.Unlock() }

func newFakeGuacd(t *testing.T) *fakeGuacd {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	f := &fakeGuacd{addr: ln.Addr().String(), sessions: make(chan *guacdConn, 16)}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	return f
}

func (f *fakeGuacd) serve(conn net.Conn) {
	defer conn.Close()
	rd := guac.NewReader(conn)
	g := &guacdConn{conn: conn, args: map[string]string{}, frames: make(chan guac.Instruction, 256), closed: make(chan struct{})}
	ins, err := rd.Next()
	if err != nil || ins.Opcode != "select" {
		return
	}
	g.selected = ins.Args[0]
	g.write(guac.Encode("args", append([]string{"VERSION_1_5_0"}, fakeArgNames...)...))
	for {
		ins, err := rd.Next()
		if err != nil {
			return
		}
		switch ins.Opcode {
		case "size":
			g.size = ins.Args
		case "audio":
			g.audio = ins.Args
		case "image":
			g.image = ins.Args
		case "connect":
			for i, name := range fakeArgNames {
				g.args[name] = ins.Args[i+1]
			}
			goto ready
		}
	}
ready:
	if f.refuse != nil {
		g.write(guac.Encode("error", f.refuse[0], f.refuse[1]))
		return
	}
	g.write(guac.Encode("ready", "fake-connection"))
	f.sessions <- g
	if f.afterReady != nil {
		go f.afterReady(g)
	}
	for {
		ins, err := rd.Next()
		if err != nil {
			close(g.closed)
			return
		}
		g.frames <- ins
	}
}

func (f *fakeGuacd) next(t *testing.T) *guacdConn {
	t.Helper()
	select {
	case g := <-f.sessions:
		return g
	case <-time.After(5 * time.Second):
		t.Fatal("guacd never received a session")
		return nil
	}
}

func rdpEnv(t *testing.T, mutate func(*Config)) (*Server, *httptest.Server, *client, *fakeGuacd, string) {
	f := newFakeGuacd(t)
	transfer := t.TempDir()
	srv, ts, u := newBridgeEnvCfg(t, func(c *Config) {
		c.Guacd, c.TransferDir = f.addr, transfer
		if mutate != nil {
			mutate(c)
		}
	})
	return srv, ts, u, f, transfer
}

func addRDPHost(t *testing.T, u *client, extra map[string]any) string {
	body := map[string]any{"name": "desktop", "protocol": "rdp", "address": "10.0.0.5", "username": `CORP\alice`, "password": "pa55!", "security": "nla"}
	for k, v := range extra {
		body[k] = v
	}
	code, out := u.do("POST", "/api/hosts", body)
	if code != 200 {
		t.Fatalf("create rdp host: %d %v", code, out)
	}
	return out["id"].(string)
}

func dialRDP(t *testing.T, base string, cl *client, hostID, query string) *websocket.Conn {
	t.Helper()
	u, _ := url.Parse(base)
	var cookies []string
	for _, c := range cl.c.Jar.Cookies(u) {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/api/ws/rdp/"+hostID+"?"+query,
		&websocket.DialOptions{Subprotocols: []string{"guacamole"}, HTTPHeader: http.Header{"Cookie": {strings.Join(cookies, "; ")}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func readText(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(data)
}

func writeText(t *testing.T, c *websocket.Conn, s string) {
	t.Helper()
	if err := c.Write(context.Background(), websocket.MessageText, []byte(s)); err != nil {
		t.Fatal(err)
	}
}

func TestRDPHandshakeAndFiltering(t *testing.T) {
	_, ts, u, guacd, transfer := rdpEnv(t, nil)
	code, out := u.do("POST", "/api/hosts", map[string]any{"name": "desktop", "protocol": "rdp", "address": "10.0.0.5",
		"username": `CORP\alice`, "password": "pa55!", "security": "nla"})
	if code != 200 || out["auth"] != "password" || out["port"] != float64(3389) || out["security"] != "nla" ||
		out["ignore_cert"] != true || out["has_password"] != true || out["protocol"] != "rdp" {
		t.Fatalf("rdp host: %d %v", code, out)
	}
	if _, leaked := out["password"]; leaked {
		t.Fatal("password returned to the browser")
	}
	id := out["id"].(string)

	guacd.afterReady = func(g *guacdConn) { g.write(guac.Encode("sync", "1")) }
	c := dialRDP(t, ts.URL, u, id, "width=1000&height=700&dpi=120")
	g := guacd.next(t)

	if g.selected != "rdp" || strings.Join(g.size, ",") != "1000,700,120" {
		t.Fatalf("select %q size %v", g.selected, g.size)
	}
	if !contains(g.audio, "audio/L16") || !contains(g.image, "image/png") {
		t.Fatalf("audio %v image %v", g.audio, g.image)
	}
	for k, want := range map[string]string{
		"hostname": "10.0.0.5", "port": "3389", "username": "alice", "domain": "CORP", "password": "pa55!",
		"security": "nla", "ignore-cert": "true", "resize-method": "display-update", "enable-drive": "true",
		"client-name": "Switchboard", "unknown-extra": "",
	} {
		if g.args[k] != want {
			t.Errorf("connect %s = %q, want %q", k, g.args[k], want)
		}
	}
	drive := g.args["drive-path"]
	fi, err := os.Stat(drive)
	if filepath.Dir(drive) != transfer || err != nil || fi.Mode().Perm() != 0o777 {
		t.Fatalf("drive folder %q: %v %v", drive, fi, err)
	}

	// The first thing the browser sees is guacd's first frame, not the handshake.
	if got := readText(t, c); got != guac.Encode("sync", "1") {
		t.Fatalf("first frame: %q", got)
	}

	// Only allowed instructions reach guacd, in order; pings and impostors are dropped.
	ping := "0.,4.ping,13.1730000000000;"
	writeText(t, c, guac.Encode("mouse", "10", "20", "1")+ping+guac.Encode("key", "65293", "1"))
	if got := readText(t, c); got != ping {
		t.Fatalf("the tunnel's ping should be echoed back, got %q", got)
	}
	writeText(t, c, guac.Encode("select", "vnc")+guac.Encode("connect", "x")+guac.Encode("size", "9", "9", "96")+
		guac.Encode("size", "1600", "900", "96")+guac.Encode("clipboard", "1", "text/plain"))
	var got []string
	for len(got) < 4 {
		select {
		case ins := <-g.frames:
			got = append(got, ins.Opcode)
		case <-time.After(3 * time.Second):
			t.Fatalf("frames so far: %v", got)
		}
	}
	if strings.Join(got, ",") != "mouse,key,size,clipboard" {
		t.Fatalf("guacd received %v", got)
	}
	select {
	case ins := <-g.frames:
		t.Fatalf("unexpected extra frame %+v", ins)
	case <-time.After(200 * time.Millisecond):
	}

	// A malformed frame ends the session.
	writeText(t, c, "this is not guacamole")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("malformed frame: %v", err)
	}

	// Ending the session removes the drive folder.
	select {
	case <-g.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("guacd connection stayed open")
	}
	waitGone(t, drive)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func waitGone(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s still exists", path)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func TestRDPFramesStayWhole(t *testing.T) {
	_, ts, u, guacd, _ := rdpEnv(t, nil)
	id := addRDPHost(t, u, nil)
	stream := guac.Encode("clipboard", "1", "text/plain") + guac.Encode("blob", "1", "5pel5pys6KqeIOKckw==") +
		guac.Encode("sync", "99") + guac.Encode("name", "日本語🙂")
	guacd.afterReady = func(g *guacdConn) {
		// Dribble the stream out a few bytes at a time, splitting instructions and characters.
		b := []byte(stream)
		for len(b) > 0 {
			n := min(7, len(b))
			g.write(string(b[:n]))
			b = b[n:]
			time.Sleep(2 * time.Millisecond)
		}
	}
	c := dialRDP(t, ts.URL, u, id, "")
	guacd.next(t)
	var all string
	for len(all) < len(stream) {
		msg := readText(t, c)
		rest := []byte(msg)
		for len(rest) > 0 {
			_, n, err := guac.Parse(rest)
			if err != nil {
				t.Fatalf("a WebSocket message held a partial instruction: %q (%v)", msg, err)
			}
			rest = rest[n:]
		}
		all += msg
	}
	if all != stream {
		t.Fatalf("stream changed in transit:\n got %q\nwant %q", all, stream)
	}
}

func TestRDPErrorsReachTheBrowser(t *testing.T) {
	_, ts, u, guacd, _ := rdpEnv(t, nil)
	id := addRDPHost(t, u, nil)

	guacd.refuse = []string{"Wrong password", "769"}
	c := dialRDP(t, ts.URL, u, id, "")
	ins, _, err := guac.Parse([]byte(readText(t, c)))
	if err != nil || ins.Opcode != "error" || ins.Args[0] != "Wrong password" || ins.Args[1] != "769" {
		t.Fatalf("guacd's error should be passed on: %+v %v", ins, err)
	}

	// guacd not running at all.
	_, ts2, u2, _, _ := rdpEnv(t, func(c *Config) { c.Guacd = "127.0.0.1:1" })
	c2 := dialRDP(t, ts2.URL, u2, addRDPHost(t, u2, nil), "")
	ins, _, _ = guac.Parse([]byte(readText(t, c2)))
	if ins.Opcode != "error" || !strings.Contains(ins.Args[0], "guacd") || ins.Args[1] != "512" {
		t.Fatalf("unreachable guacd: %+v", ins)
	}
}

func TestRDPSessionLimit(t *testing.T) {
	_, ts, u, guacd, _ := rdpEnv(t, func(c *Config) { c.MaxRDP = 1 })
	id := addRDPHost(t, u, nil)
	first := dialRDP(t, ts.URL, u, id, "")
	g := guacd.next(t)

	second := dialRDP(t, ts.URL, u, id, "")
	ins, _, _ := guac.Parse([]byte(readText(t, second)))
	if ins.Opcode != "error" || ins.Args[1] != "513" {
		t.Fatalf("over the limit: %+v", ins)
	}

	first.CloseNow()
	<-g.closed
	deadline := time.Now().Add(3 * time.Second)
	for {
		third := dialRDP(t, ts.URL, u, id, "")
		select {
		case <-guacd.sessions:
			third.CloseNow()
			return
		case <-time.After(300 * time.Millisecond):
			third.CloseNow()
			if time.Now().After(deadline) {
				t.Fatal("slot was not released after the first session ended")
			}
		}
	}
}

func TestRDPIdleTimeoutIgnoresKeepalives(t *testing.T) {
	// Only a person using the session keeps it alive, not the tunnel's own pings.
	for _, tc := range []struct {
		name  string
		frame string
		dies  bool
	}{
		{"pings only", "0.,4.ping,13.1730000000000;", true},
		{"typing", guac.Encode("key", "97", "1"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, ts, u, guacd, _ := rdpEnv(t, func(c *Config) { c.SessionTimeout = time.Second })
			id := addRDPHost(t, u, nil)
			c := dialRDP(t, ts.URL, u, id, "")
			guacd.next(t)
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			go func() {
				for ctx.Err() == nil {
					c.Write(ctx, websocket.MessageText, []byte(tc.frame))
					time.Sleep(150 * time.Millisecond)
				}
			}()
			readCtx, stop := context.WithTimeout(ctx, 2500*time.Millisecond)
			defer stop()
			var err error
			for err == nil { // pings are echoed back; keep reading until something ends the connection
				_, _, err = c.Read(readCtx)
			}
			if tc.dies && websocket.CloseStatus(err) != 4401 {
				t.Fatalf("idle session should end with 4401, got %v", err)
			}
			if !tc.dies && websocket.CloseStatus(err) == 4401 {
				t.Fatalf("an active session was ended: %v", err)
			}
		})
	}
}

func TestRDPHostRules(t *testing.T) {
	srv, ts, u, _, transfer := rdpEnv(t, nil)
	rdpID := addRDPHost(t, u, nil)
	sshd := newTestSSHServerHome(t, "s3cret", nil, t.TempDir())
	sshID := addHost(t, u, "linux", sshd.port, nil)

	// Each endpoint only serves its own protocol.
	if code, out := u.do("GET", "/api/ws/ssh/"+rdpID, nil); code != 400 || out["error"] != "wrong_protocol" {
		t.Fatalf("ssh endpoint on an rdp host: %d %v", code, out)
	}
	if code, out := u.do("GET", "/api/ws/rdp/"+sshID, nil); code != 400 || out["error"] != "wrong_protocol" {
		t.Fatalf("rdp endpoint on an ssh host: %d %v", code, out)
	}
	// RDP hosts can't be jump hosts, take jump hosts, or forward ports; and keys can't be pushed to them.
	if code, _ := u.do("POST", "/api/hosts", map[string]any{"name": "x", "address": "x", "auth": "password", "jumps": []string{rdpID}}); code != 400 {
		t.Fatalf("rdp host used as a jump host: %d", code)
	}
	if code, _ := u.do("POST", "/api/hosts", map[string]any{"name": "x", "protocol": "rdp", "address": "x", "jumps": []string{sshID}}); code != 400 {
		t.Fatalf("rdp host with a jump host: %d", code)
	}
	if code, _ := u.do("POST", "/api/hosts", map[string]any{"name": "x", "protocol": "rdp", "address": "x", "security": "bogus"}); code != 400 {
		t.Fatalf("bad security mode: %d", code)
	}
	if code, _ := u.do("POST", "/api/hosts", map[string]any{"name": "x", "protocol": "vnc", "address": "x", "auth": "password"}); code != 400 {
		t.Fatalf("unknown protocol: %d", code)
	}
	_, gen := u.do("POST", "/api/identities/generate", map[string]string{"name": "k", "comment": "c", "kind": "ed25519"})
	if r := push(t, u, gen["id"].(string), rdpID); r.Code != "unsupported" {
		t.Fatalf("push to rdp host: %+v", r)
	}

	// Another user can't open it.
	u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"})
	k := newClient(t, ts.URL)
	k.do("POST", "/api/login", credentials{"kim", "temporary password"})
	k.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "kims real password"})
	if code, _ := k.do("GET", "/api/ws/rdp/"+rdpID, nil); code != 404 {
		t.Fatalf("another user's rdp host: %d", code)
	}

	// Switching an existing host between protocols keeps it consistent.
	code, out := u.do("PUT", "/api/hosts/"+rdpID, map[string]any{"name": "desktop", "address": "10.0.0.5", "protocol": "rdp", "security": "tls", "ignore_cert": false})
	if code != 200 || out["security"] != "tls" || out["ignore_cert"] != false || out["has_password"] != true {
		t.Fatalf("update rdp host: %d %v", code, out)
	}

	// Stale drive folders from an earlier run are cleared at startup; other files are left alone.
	stale := filepath.Join(transfer, strings.Repeat("a", 32))
	keep := filepath.Join(transfer, "notes")
	os.Mkdir(stale, 0o777)
	os.Mkdir(keep, 0o777)
	srv.clearTransfers()
	if _, err := os.Stat(stale); err == nil {
		t.Fatal("stale drive folder survived")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("unrelated folder was removed")
	}
}
