package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/thatguy-za/webterm/internal/proxmox"
)

// fakePVE answers like the parts of the Proxmox API that WebTerm uses.
type fakePVE struct {
	*httptest.Server
	mu     sync.Mutex
	status map[int]string
	calls  []string
}

const pveToken = "PVEAPIToken=webterm@pve!power=s3cret-value"

func newFakePVE(t *testing.T) *fakePVE {
	f := &fakePVE{status: map[int]string{102: "running", 110: "stopped", 200: "running"}}
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != pveToken {
				http.Error(w, "no", http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	reply := func(w http.ResponseWriter, v any) { json.NewEncoder(w).Encode(map[string]any{"data": v}) }
	mux.HandleFunc("/api2/json/version", auth(func(w http.ResponseWriter, r *http.Request) { reply(w, map[string]string{"version": "8.2.4"}) }))
	mux.HandleFunc("/api2/json/cluster/resources", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		reply(w, []map[string]any{
			{"vmid": 110, "name": "win11-test", "node": "pve1", "type": "qemu", "status": f.status[110]},
			{"vmid": 102, "name": "docker-host", "node": "pve1", "type": "qemu", "status": f.status[102], "uptime": 500},
			{"vmid": 200, "name": "Pihole", "node": "pve2", "type": "lxc", "status": f.status[200]},
			{"vmid": 9000, "name": "template", "node": "pve1", "type": "qemu", "status": "stopped", "template": 1},
			{"id": "storage/pve1/local", "type": "storage", "node": "pve1"},
		})
	}))
	mux.HandleFunc("/api2/json/nodes/pve1/qemu/102/agent/network-get-interfaces", auth(func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"result": []map[string]any{{"name": "eth0", "ip-addresses": []map[string]string{{"ip-address": "10.0.0.12"}}}}})
	}))
	mux.HandleFunc("/api2/json/nodes/", auth(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api2/json/nodes/"), "/")
		if r.Method != http.MethodPost || len(parts) != 5 || parts[3] != "status" {
			http.NotFound(w, r)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, parts[0]+"/"+parts[1]+"/"+parts[2]+"/"+parts[4])
		var id int
		for _, c := range parts[2] {
			id = id*10 + int(c-'0')
		}
		switch parts[4] {
		case "start":
			f.status[id] = "running"
		case "shutdown", "stop":
			f.status[id] = "stopped"
		}
		reply(w, "UPID:ok")
	}))
	f.Server = httptest.NewTLSServer(mux)
	t.Cleanup(f.Close)
	return f
}

func (f *fakePVE) fingerprint() string { return proxmox.Fingerprint(f.Certificate().Raw) }

func (f *fakePVE) callList() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func vmList(t *testing.T, u *client) (vms []map[string]any, errs []any) {
	t.Helper()
	req, _ := http.NewRequest("GET", u.url+"/api/proxmox/vms", nil)
	resp, err := u.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		VMs    []map[string]any `json:"vms"`
		Errors []any            `json:"errors"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	return out.VMs, out.Errors
}

func connectPVE(t *testing.T, u *client, f *fakePVE) string {
	t.Helper()
	code, out := u.do("POST", "/api/proxmox/servers", map[string]string{"address": f.URL, "token_id": "webterm@pve!power", "secret": "s3cret-value", "fingerprint": f.fingerprint()})
	if code != 200 {
		t.Fatalf("connect: %d %v", code, out)
	}
	return out["id"].(string)
}

func TestProxmoxClientPinsTheCertificate(t *testing.T) {
	f := newFakePVE(t)
	fp, err := proxmox.Probe(t.Context(), f.URL, nil)
	if err != nil || fp != f.fingerprint() {
		t.Fatalf("probe: %q %v", fp, err)
	}
	good, _ := proxmox.New(f.URL, "webterm@pve!power", "s3cret-value", fp, nil)
	if v, err := good.Version(t.Context()); err != nil || v != "8.2.4" {
		t.Fatalf("version: %q %v", v, err)
	}
	other := strings.Repeat("AA:", 31) + "AA"
	bad, _ := proxmox.New(f.URL, "webterm@pve!power", "s3cret-value", other, nil)
	if _, err := bad.Version(t.Context()); err == nil || err != proxmox.ErrCertChanged {
		t.Fatalf("a different certificate was accepted: %v", err)
	}
	wrong, _ := proxmox.New(f.URL, "webterm@pve!power", "nope", fp, nil)
	if _, err := wrong.Version(t.Context()); err == nil || !strings.Contains(err.Error(), "rejected the API token") {
		t.Fatalf("bad token: %v", err)
	}
	for _, addr := range []string{"http://pve:8006", "pve:8006", "https://user@pve", "https://pve/path", ""} {
		if _, _, err := proxmox.Address(addr); err == nil {
			t.Errorf("address %q accepted", addr)
		}
	}
}

func TestProxmoxServersAndPower(t *testing.T) {
	srv, ts, u := newBridgeEnv(t)
	f := newFakePVE(t)

	if code, out := u.do("POST", "/api/proxmox/probe", map[string]string{"address": f.URL}); code != 200 || out["fingerprint"] != f.fingerprint() {
		t.Fatalf("probe: %d %v", code, out)
	}
	// A wrong token, a wrong fingerprint and a malformed id are all refused, and nothing is saved.
	for name, in := range map[string]map[string]string{
		"wrong secret":      {"address": f.URL, "token_id": "webterm@pve!power", "secret": "nope", "fingerprint": f.fingerprint()},
		"other fingerprint": {"address": f.URL, "token_id": "webterm@pve!power", "secret": "s3cret-value", "fingerprint": strings.Repeat("AA:", 31) + "AA"},
		"bad token id":      {"address": f.URL, "token_id": "webterm", "secret": "s3cret-value", "fingerprint": f.fingerprint()},
		"plain http":        {"address": strings.Replace(f.URL, "https", "http", 1), "token_id": "webterm@pve!power", "secret": "s3cret-value", "fingerprint": f.fingerprint()},
	} {
		if code, _ := u.do("POST", "/api/proxmox/servers", in); code < 400 {
			t.Errorf("%s accepted: %d", name, code)
		}
	}
	if list, _ := srv.db.ListProxmoxServers(ownerID(t, srv)); len(list) != 0 {
		t.Fatalf("a refused server was saved: %d", len(list))
	}

	id := connectPVE(t, u, f)
	// The secret is sealed on disk.
	list, _ := srv.db.ListProxmoxServers(ownerID(t, srv))
	if len(list) != 1 || bytes.Contains(list[0].SecretBlob, []byte("s3cret-value")) {
		t.Fatalf("server not saved, or the secret is readable: %+v", list)
	}

	vms, errs := vmList(t, u)
	if len(errs) != 0 || len(vms) != 3 || vms[0]["name"] != "docker-host" || vms[0]["status"] != "running" {
		t.Fatalf("vms: %v %v", vms, errs)
	}
	for _, v := range vms {
		if v["name"] == "template" {
			t.Fatal("a template was listed")
		}
	}

	// Power actions go to the node the VM is on now.
	if code, _ := u.do("POST", "/api/proxmox/servers/"+id+"/qemu/110/start", nil); code != 200 {
		t.Fatalf("start: %d", code)
	}
	if code, _ := u.do("POST", "/api/proxmox/servers/"+id+"/lxc/200/reboot", nil); code != 200 {
		t.Fatalf("reboot: %d", code)
	}
	if got := f.callList(); len(got) != 2 || got[0] != "pve1/qemu/110/start" || got[1] != "pve2/lxc/200/reboot" {
		t.Fatalf("calls: %v", got)
	}
	if code, out := u.do("GET", "/api/proxmox/servers/"+id+"/qemu/110", nil); code != 200 || out["status"] != "running" {
		t.Fatalf("status after start: %d %v", code, out)
	}
	for _, bad := range []string{"/qemu/110/format", "/qemu/999/start", "/nas/110/start", "/qemu/abc/start"} {
		if code, _ := u.do("POST", "/api/proxmox/servers/"+id+bad, nil); code < 400 {
			t.Errorf("%s accepted: %d", bad, code)
		}
	}
	if len(f.callList()) != 2 {
		t.Fatalf("a refused request reached Proxmox: %v", f.callList())
	}

	// Another user can't see or use the server.
	if code, _ := u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatal("add member")
	}
	m := newClient(t, ts.URL)
	m.do("POST", "/api/login", credentials{"kim", "temporary password"})
	m.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "a different long password"})
	if vms, _ := vmList(t, m); len(vms) != 0 {
		t.Fatalf("a member sees the owner's VMs: %v", vms)
	}
	if code, _ := m.do("POST", "/api/proxmox/servers/"+id+"/qemu/110/stop", nil); code != 404 {
		t.Fatalf("a member used the owner's server: %d", code)
	}
	if code, _ := m.do("DELETE", "/api/proxmox/servers/"+id, nil); code != 404 {
		t.Fatalf("a member deleted the owner's server: %d", code)
	}
	if code, _ := newClient(t, ts.URL).do("GET", "/api/proxmox/servers", nil); code != 401 {
		t.Fatalf("anonymous access: %d", code)
	}
}

func TestProxmoxCertificateChangeIsReported(t *testing.T) {
	_, _, u := newBridgeEnv(t)
	f := newFakePVE(t)
	id := connectPVE(t, u, f)
	// Connecting with a fingerprint that is not the server's certificate says the certificate is not the expected one.
	code, out := u.do("POST", "/api/proxmox/servers", map[string]string{"address": f.URL, "token_id": "webterm@pve!power", "secret": "s3cret-value", "fingerprint": strings.Repeat("AA:", 31) + "AA"})
	if code == 200 || out["error"] != "cert_changed" || out["message"] == nil {
		t.Fatalf("a mismatched certificate was accepted or unexplained: %d %v", code, out)
	}
	// And the saved server still works.
	if vms, errs := vmList(t, u); len(vms) == 0 || len(errs) != 0 {
		t.Fatalf("the saved server broke: %v %v", vms, errs)
	}
	_ = id
}

func TestHostsLinkToProxmoxVMs(t *testing.T) {
	srv, ts, u := newBridgeEnv(t)
	f := newFakePVE(t)
	id := connectPVE(t, u, f)
	hid := addHost(t, u, "docker-host", 22, map[string]any{"address": "10.0.0.12"})

	link := func(server string, vmid int, kind string) int {
		code, _ := u.do("PUT", "/api/hosts/"+hid, map[string]any{"name": "docker-host", "address": "10.0.0.12", "port": 22, "username": "root", "auth": "password", "protocol": "ssh",
			"proxmox": map[string]any{"server_id": server, "vmid": vmid, "type": kind}})
		return code
	}
	if code := link(id, 102, "qemu"); code != 200 {
		t.Fatalf("link: %d", code)
	}
	h, _ := srv.db.GetHost(hid, ownerID(t, srv))
	if h.ProxmoxServerID != id || h.ProxmoxVMID != 102 || h.ProxmoxType != "qemu" {
		t.Fatalf("link not saved: %+v", h)
	}
	// The link shows on the host and on the VM list.
	if vms, _ := vmList(t, u); vms[0]["host_name"] != "docker-host" {
		t.Fatalf("the VM does not say which host it is: %v", vms[0])
	}
	// Saving the host without a link field keeps the link.
	u.do("PUT", "/api/hosts/"+hid, map[string]any{"name": "docker-host", "address": "10.0.0.12", "port": 22, "username": "root", "auth": "password", "protocol": "ssh"})
	if h, _ := srv.db.GetHost(hid, ownerID(t, srv)); h.ProxmoxVMID != 102 {
		t.Fatal("saving the host dropped the link")
	}
	for name, code := range map[string]int{"other type": link(id, 102, "vm"), "no such server": link("nope", 102, "qemu"), "bad id": link(id, 0, "qemu")} {
		if code != 400 {
			t.Errorf("%s accepted: %d", name, code)
		}
	}
	// A server that belongs to someone else can't be linked.
	if code, _ := u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatal("add member")
	}
	m := newClient(t, ts.URL)
	m.do("POST", "/api/login", credentials{"kim", "temporary password"})
	m.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "a different long password"})
	_, mh := m.do("POST", "/api/hosts", map[string]any{"name": "mine", "address": "10.9.9.9", "port": 22, "username": "root", "auth": "password", "protocol": "ssh", "proxmox": map[string]any{"server_id": id, "vmid": 102, "type": "qemu"}})
	if mh["error"] != "bad_request" {
		t.Fatalf("a member linked to the owner's server: %v", mh)
	}
	// Removing the server unlinks its hosts.
	if code, _ := u.do("DELETE", "/api/proxmox/servers/"+id, nil); code != 200 {
		t.Fatal("delete server")
	}
	if h, _ := srv.db.GetHost(hid, ownerID(t, srv)); h.ProxmoxServerID != "" || h.ProxmoxVMID != 0 {
		t.Fatalf("host still linked: %+v", h)
	}
}

func TestProxmoxSuggestsAMatch(t *testing.T) {
	_, _, u := newBridgeEnv(t)
	f := newFakePVE(t)
	connectPVE(t, u, f)
	suggest := func(q string) map[string]any {
		req, _ := http.NewRequest("GET", u.url+"/api/proxmox/suggest?"+q, nil)
		resp, err := u.c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var out struct {
			Match map[string]any `json:"match"`
		}
		json.NewDecoder(resp.Body).Decode(&out)
		return out.Match
	}
	if m := suggest("name=Docker-Host&address=1.2.3.4"); m == nil || m["vmid"] != float64(102) || m["reason"] != "name" {
		t.Fatalf("by name: %v", m)
	}
	if m := suggest("name=something&address=10.0.0.12"); m == nil || m["vmid"] != float64(102) || m["reason"] != "address" {
		t.Fatalf("by address: %v", m)
	}
	if m := suggest("name=nothing&address=10.9.9.9"); m != nil {
		t.Fatalf("a made-up match: %v", m)
	}
}

func TestHostReachable(t *testing.T) {
	_, _, u := newBridgeEnv(t)
	f := newFakePVE(t)
	addr := strings.TrimPrefix(f.URL, "https://")
	host, port := addr[:strings.LastIndex(addr, ":")], addr[strings.LastIndex(addr, ":")+1:]
	up := addHost(t, u, "up", atoi(port), map[string]any{"address": host})
	down := addHost(t, u, "down", 1, map[string]any{"address": "127.0.0.1"})
	if _, out := u.do("GET", "/api/hosts/"+up+"/reachable", nil); out["up"] != true {
		t.Fatalf("an open port reads as down: %v", out)
	}
	if _, out := u.do("GET", "/api/hosts/"+down+"/reachable", nil); out["up"] != false {
		t.Fatalf("a closed port reads as up: %v", out)
	}
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}
