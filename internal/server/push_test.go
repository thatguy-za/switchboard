package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestClassifyScriptFailure(t *testing.T) {
	cases := []struct{ out, code string }{
		{"touch: cannot touch '/home/x/.ssh/authorized_keys': Permission denied", "permission_denied"},
		{"mkdir: cannot create directory: Read-only file system", "permission_denied"},
		{"'sh' is not recognized as an internal or external command", "unsupported"},
		{"sh: command not found", "unsupported"},
		{"something odd", "error"},
		{"", "error"},
	}
	for _, c := range cases {
		if got := classifyScriptFailure(c.out, errors.New("exit")); got.Code != c.code {
			t.Errorf("%q: got %q want %q", c.out, got.Code, c.code)
		}
	}
	if got := classifyScriptFailure("", &ssh.ExitError{Waitmsg: ssh.Waitmsg{}}); got.Code != "error" {
		t.Errorf("plain exit error: %q", got.Code)
	}
}

type pushResp struct {
	HostID, Result, Code, Message string
}

func push(t *testing.T, u *client, identityID, hostID string) pushResp {
	t.Helper()
	code, out := u.do("POST", "/api/identities/"+identityID+"/push", map[string]string{"host_id": hostID})
	if code != 200 {
		t.Fatalf("push: %d %v", code, out)
	}
	str := func(k string) string { v, _ := out[k].(string); return v }
	return pushResp{str("host_id"), str("result"), str("code"), str("message")}
}

// trustHost opens a terminal once and accepts the host key(s), like a user would.
func trustHost(t *testing.T, ts string, u *client, hostID string, prompts int) {
	t.Helper()
	w := dialWS(t, ts, u, hostID)
	for i := 0; i < prompts; i++ {
		if m := w.next(); m.Type != "hostkey" {
			t.Fatalf("expected a host key prompt, got %+v", m)
		}
		w.send(map[string]any{"type": "trust", "accept": true})
	}
	if m := w.next(); m.Type != "connected" {
		t.Fatalf("expected connected, got %+v", m)
	}
	w.c.CloseNow()
}

func TestKeyPush(t *testing.T) {
	_, ts, u := newBridgeEnv(t)
	home := t.TempDir()
	sshd := newTestSSHServerHome(t, "s3cret", nil, home)

	_, gen := u.do("POST", "/api/identities/generate", map[string]string{"name": "laptop", "comment": "owner@switchboard", "kind": "ed25519"})
	identityID := gen["id"].(string)
	hostID := addHost(t, u, "box", sshd.port, nil)

	// Host key not trusted yet: the push refuses rather than prompting.
	if r := push(t, u, identityID, hostID); r.Result != "error" || r.Code != "hostkey_unknown" {
		t.Fatalf("expected an untrusted host key, got %+v", r)
	}
	trustHost(t, ts.URL, u, hostID, 1)

	// First push adds the key, with the right modes.
	if r := push(t, u, identityID, hostID); r.Result != "added" {
		t.Fatalf("first push: %+v", r)
	}
	for path, want := range map[string]os.FileMode{".ssh": 0o700, ".ssh/authorized_keys": 0o600} {
		fi, err := os.Stat(filepath.Join(home, path))
		if err != nil || fi.Mode().Perm() != want {
			t.Fatalf("%s: mode %v err %v, want %v", path, fi, err, want)
		}
	}
	data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys"))
	if strings.Count(string(data), "\n") != 1 || !strings.HasPrefix(string(data), "ssh-ed25519 ") || !strings.Contains(string(data), "owner@switchboard") {
		t.Fatalf("authorized_keys: %q", data)
	}

	// The host now signs in with the key, and keeps its saved password.
	_, list := u.do("GET", "/api/hosts", nil)
	h := list["hosts"].([]any)[0].(map[string]any)
	if h["auth"] != "key" || h["identity_id"] != identityID || h["has_password"] != true {
		t.Fatalf("host after push: %v", h)
	}
	w := dialWS(t, ts.URL, u, hostID)
	if m := w.next(); m.Type != "connected" {
		t.Fatalf("key login through the terminal failed: %+v", m)
	}
	w.c.CloseNow()

	// A second push finds the key and adds nothing, even if the file lacks a trailing newline.
	if r := push(t, u, identityID, hostID); r.Result != "present" {
		t.Fatalf("second push: %+v", r)
	}
	if again, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys")); string(again) != string(data) {
		t.Fatalf("file changed on a repeat push: %q", again)
	}

	// A second identity is appended on its own line, after a missing newline is repaired.
	path := filepath.Join(home, ".ssh", "authorized_keys")
	os.WriteFile(path, []byte("ssh-rsa AAAAexisting old-key"), 0o600)
	_, gen2 := u.do("POST", "/api/identities/generate", map[string]string{"name": "second", "comment": "two", "kind": "ed25519"})
	// Needs a credential that still works: switch the host back to its password.
	u.do("PUT", "/api/hosts/"+hostID, map[string]any{"name": "box", "address": "127.0.0.1", "port": sshd.port, "username": "root", "auth": "password"})
	if r := push(t, u, gen2["id"].(string), hostID); r.Result != "added" {
		t.Fatalf("push of a second identity: %+v", r)
	}
	data, _ = os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 || lines[0] != "ssh-rsa AAAAexisting old-key" || !strings.HasSuffix(lines[1], " two") {
		t.Fatalf("authorized_keys after second push: %q", data)
	}

	// Deployments are tracked per identity, separately from which hosts use it.
	_, _ = u.do("GET", "/api/identities", nil)
}

func identityList(t *testing.T, u *client) []map[string]any {
	req, _ := http.NewRequest("GET", u.url+"/api/identities", nil)
	resp, err := u.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func TestPushRecordsDeployments(t *testing.T) {
	_, ts, u := newBridgeEnv(t)
	sshd := newTestSSHServerHome(t, "s3cret", nil, t.TempDir())
	_, gen := u.do("POST", "/api/identities/generate", map[string]string{"name": "k", "comment": "c", "kind": "ed25519"})
	hostID := addHost(t, u, "box", sshd.port, nil)
	trustHost(t, ts.URL, u, hostID, 1)

	ids := identityList(t, u)
	if len(ids[0]["deployed"].([]any)) != 0 {
		t.Fatalf("deployed before any push: %v", ids[0])
	}
	if r := push(t, u, gen["id"].(string), hostID); r.Result != "added" {
		t.Fatalf("push: %+v", r)
	}
	ids = identityList(t, u)
	dep, used := ids[0]["deployed"].([]any), ids[0]["hosts"].([]any)
	if len(dep) != 1 || dep[0] != "box" || len(used) != 1 || used[0] != "box" {
		t.Fatalf("deployed %v, used by %v", dep, used)
	}

	// Switching the host to another credential keeps the deployment record.
	u.do("PUT", "/api/hosts/"+hostID, map[string]any{"name": "box", "address": "127.0.0.1", "port": sshd.port, "username": "root", "auth": "password"})
	ids = identityList(t, u)
	if len(ids[0]["deployed"].([]any)) != 1 || len(ids[0]["hosts"].([]any)) != 0 {
		t.Fatalf("after switching away: %v", ids[0])
	}
	// Another user cannot push with this identity or to this host.
	if code, _ := u.do("POST", "/api/identities/nope/push", map[string]string{"host_id": hostID}); code != 404 {
		t.Fatalf("unknown identity: %d", code)
	}
}

func TestPushFailures(t *testing.T) {
	_, ts, u := newBridgeEnv(t)
	_, gen := u.do("POST", "/api/identities/generate", map[string]string{"name": "k", "comment": "c", "kind": "ed25519"})
	id := gen["id"].(string)

	// Wrong password: the host key is trusted through a terminal first, then the push reports it.
	sshd := newTestSSHServerHome(t, "s3cret", nil, t.TempDir())
	badID := addHost(t, u, "bad password", sshd.port, map[string]any{"password": "wrong"})
	w := dialWS(t, ts.URL, u, badID)
	w.next()
	w.send(map[string]any{"type": "trust", "accept": true})
	if m := w.next(); m.Type != "error" {
		t.Fatalf("got %+v", m)
	}
	if r := push(t, u, id, badID); r.Code != "auth_failed" {
		t.Fatalf("wrong password: %+v", r)
	}

	// Unreachable.
	closed := addHost(t, u, "closed", freePort(t), nil)
	if r := push(t, u, id, closed); r.Code != "unreachable" {
		t.Fatalf("closed port: %+v", r)
	}

	// Changed host key blocks the push.
	goodID := addHost(t, u, "good", sshd.port, nil)
	trustHost(t, ts.URL, u, goodID, 1)
	sshd.replaceHostKey(t)
	if r := push(t, u, id, goodID); r.Code != "hostkey_changed" {
		t.Fatalf("changed key: %+v", r)
	}

	// A server that takes the key but won't let it sign in: reported, and the host stays as it was.
	home := t.TempDir()
	noKeys := newTestSSHServerHome(t, "s3cret", nil, home)
	noKeys.noKeys = true
	nkID := addHost(t, u, "no key login", noKeys.port, nil)
	trustHost(t, ts.URL, u, nkID, 1)
	r := push(t, u, id, nkID)
	if r.Code != "verify_failed" || !strings.Contains(r.Message, "old credentials") {
		t.Fatalf("verify failure: %+v", r)
	}
	if data, _ := os.ReadFile(filepath.Join(home, ".ssh", "authorized_keys")); !strings.Contains(string(data), "ssh-ed25519") {
		t.Fatalf("key should have been added before the login check: %q", data)
	}
	_, list := u.do("GET", "/api/hosts", nil)
	for _, h := range list["hosts"].([]any) {
		if h.(map[string]any)["id"] == nkID && h.(map[string]any)["auth"] != "password" {
			t.Fatalf("host switched to a key that doesn't work: %v", h)
		}
	}
	if dep := identityList(t, u)[0]["deployed"].([]any); len(dep) != 0 {
		t.Fatalf("failed push recorded as deployed: %v", dep)
	}
}
