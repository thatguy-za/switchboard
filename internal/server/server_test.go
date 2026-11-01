package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestHOTPVector(t *testing.T) {
	// RFC 4226 appendix D, secret "12345678901234567890".
	secret := []byte("12345678901234567890")
	want := []string{"755224", "287082", "359152", "969429", "338314"}
	for i, w := range want {
		if got := hotp(secret, uint64(i)); got != w {
			t.Fatalf("counter %d: got %s want %s", i, got, w)
		}
	}
}

func TestTOTPReplay(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(59, 0) // step 1
	step, ok := checkTOTP(secret, "287082", now, 0)
	if !ok || step != 1 {
		t.Fatalf("valid code rejected (step %d ok %v)", step, ok)
	}
	if _, ok := checkTOTP(secret, "287082", now, step); ok {
		t.Fatal("code accepted twice")
	}
	if _, ok := checkTOTP(secret, "000000", now, 0); ok {
		t.Fatal("wrong code accepted")
	}
}

type client struct {
	t   *testing.T
	c   *http.Client
	url string
}

func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var buf bytes.Buffer
	json.NewEncoder(&buf).Encode(body)
	req, _ := http.NewRequest(method, c.url+path, &buf)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.c.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func newClient(t *testing.T, url string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, c: &http.Client{Jar: jar}, url: url}
}

func TestFlow(t *testing.T) {
	dir := t.TempDir()
	srv, err := New(Config{DataDir: dir, KeysDir: dir + "/keys", SessionTimeout: time.Minute},
		fstest.MapFS{"index.html": {Data: []byte("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	srv.limit = newLimiter(1000, time.Minute)

	a := newClient(t, ts.URL)
	if code, _ := a.do("POST", "/api/setup", credentials{"owner", ""}); code != 400 {
		t.Fatalf("empty password: got %d", code)
	}
	code, out := a.do("POST", "/api/setup", credentials{"owner", "a long enough password"})
	if code != 200 || out["recovery_key"] == "" {
		t.Fatalf("setup: %d %v", code, out)
	}
	if code, _ := newClient(t, ts.URL).do("POST", "/api/setup", credentials{"intruder", "another long password"}); code != 409 {
		t.Fatalf("setup should be locked, got %d", code)
	}
	recovery := out["recovery_key"].(string)

	// Admin creates a member with a temporary password; member must change it.
	if code, _ := a.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatalf("create user: %d", code)
	}
	b := newClient(t, ts.URL)
	if code, _ := b.do("POST", "/api/login", credentials{"kim", "temporary password"}); code != 200 {
		t.Fatalf("member login: %d", code)
	}
	if code, out := b.do("GET", "/api/admin/users", nil); code != 403 {
		t.Fatalf("gated/forbidden expected, got %d %v", code, out)
	}
	code, out = b.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "kims real password"})
	if code != 200 || out["recovery_key"] == nil {
		t.Fatalf("password change: %d %v", code, out)
	}

	// 2FA enrolment, then login needs a code.
	code, out = a.do("POST", "/api/2fa/setup", nil)
	if code != 200 {
		t.Fatalf("2fa setup: %d", code)
	}
	secretText := out["secret"].(string)
	secret, _ := b32.DecodeString(secretText)
	now := time.Now().Unix() / 30
	if code, out = a.do("POST", "/api/2fa/enable", map[string]string{"code": hotp(secret, uint64(now))}); code != 200 {
		t.Fatalf("2fa enable: %d %v", code, out)
	}
	backup := out["backup_codes"].([]any)[0].(string)

	a2 := newClient(t, ts.URL)
	code, out = a2.do("POST", "/api/login", credentials{"owner", "a long enough password"})
	if code != 200 || out["need_2fa"] != true {
		t.Fatalf("expected 2fa challenge: %d %v", code, out)
	}
	if code, _ := a2.do("GET", "/api/admin/users", nil); code != 401 {
		t.Fatalf("pending login must not be a session, got %d", code)
	}
	if code, _ := a2.do("POST", "/api/login/2fa", map[string]string{"code": backup}); code != 200 {
		t.Fatalf("backup code login failed: %d", code)
	}
	if code, _ := a2.do("GET", "/api/admin/users", nil); code != 200 {
		t.Fatalf("admin list after 2fa: %d", code)
	}
	a3 := newClient(t, ts.URL)
	a3.do("POST", "/api/login", credentials{"owner", "a long enough password"})
	if code, _ := a3.do("POST", "/api/login/2fa", map[string]string{"code": backup}); code != 401 {
		t.Fatalf("backup code reused, got %d", code)
	}

	// Lockout after repeated bad passwords.
	c := newClient(t, ts.URL)
	var last int
	for i := 0; i < maxFailures; i++ {
		last, _ = c.do("POST", "/api/login", credentials{"kim", "wrong password!!"})
	}
	if last != 429 {
		t.Fatalf("expected lockout, got %d", last)
	}
	if code, _ := c.do("POST", "/api/login", credentials{"kim", "kims real password"}); code != 429 {
		t.Fatalf("locked account logged in: %d", code)
	}

	// Recovery key sets a new password for the owner.
	r := newClient(t, ts.URL)
	if code, _ := r.do("POST", "/api/recover", map[string]string{"username": "owner", "recovery_key": recovery, "new_password": "brand new password"}); code != 200 {
		t.Fatalf("recover: %d", code)
	}
	if code, _ := newClient(t, ts.URL).do("POST", "/api/login", credentials{"owner", "a long enough password"}); code != 401 {
		t.Fatalf("old password still works: %d", code)
	}
}

func TestPWAFilesAreServedCorrectly(t *testing.T) {
	dir := t.TempDir()
	srv, err := New(Config{DataDir: dir, KeysDir: dir + "/keys", SessionTimeout: time.Minute}, fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html>")},
		"manifest.webmanifest": {Data: []byte(`{"name":"x"}`)},
		"sw.js":                {Data: []byte("self.skipWaiting()")},
		"icon.svg":             {Data: []byte("<svg xmlns='http://www.w3.org/2000/svg'/>")},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for path, wantType := range map[string]string{
		"/manifest.webmanifest": "application/manifest+json",
		"/sw.js":                "javascript",
		"/icon.svg":             "image/svg+xml",
	} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Content-Type"), wantType) {
			t.Errorf("%s: %d %q, want type %q", path, resp.StatusCode, resp.Header.Get("Content-Type"), wantType)
		}
		if !strings.Contains(resp.Header.Get("Content-Security-Policy"), "default-src 'self'") {
			t.Errorf("%s: missing content security policy", path)
		}
	}
}

func TestAnyPasswordLength(t *testing.T) {
	_, ts, owner := newBridgeEnv(t)
	for name, pw := range map[string]string{"tiny": "x", "huge": strings.Repeat("long passphrase ", 400)} {
		if code, out := owner.do("POST", "/api/admin/users", map[string]string{"username": name, "password": pw, "role": "member"}); code != 200 {
			t.Fatalf("create %s: %d %v", name, code, out)
		}
		if code, _ := newClient(t, ts.URL).do("POST", "/api/login", credentials{name, pw}); code != 200 {
			t.Fatalf("login with the %s password: %d", name, code)
		}
	}
}
