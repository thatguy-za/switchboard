package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/thatguy-za/webterm/internal/crypto"
	"github.com/thatguy-za/webterm/internal/proxmox"
	"github.com/thatguy-za/webterm/internal/store"
)

var (
	pveTokenIDRe     = regexp.MustCompile(`^[^\s!@]+@[^\s!@]+![^\s!]+$`) // user@realm!name
	pveFingerprintRe = regexp.MustCompile(`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`)
)

// pveLink says which Proxmox VM or container a host runs on.
type pveLink struct {
	ServerID string `json:"server_id"`
	VMID     int    `json:"vmid"`
	Type     string `json:"type"`
}

// applyProxmoxLink checks a host's link and copies it on. An empty server id removes the link.
func (s *Server) applyProxmoxLink(h *store.Host, l *pveLink, a *authed) string {
	if l.ServerID == "" {
		h.ProxmoxServerID, h.ProxmoxVMID, h.ProxmoxType = "", 0, ""
		return ""
	}
	if (l.Type != "qemu" && l.Type != "lxc") || l.VMID < 1 || l.VMID > 999999999 {
		return "bad_request"
	}
	if _, err := s.db.GetProxmoxServer(l.ServerID, a.user.ID); err != nil {
		return "bad_request"
	}
	h.ProxmoxServerID, h.ProxmoxVMID, h.ProxmoxType = l.ServerID, l.VMID, l.Type
	return ""
}

// pveDial reaches a Proxmox server for the user, over their tailnet when its name calls for it.
func (s *Server) pveDial(a *authed) proxmox.Dial {
	return func(ctx context.Context, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		p, _ := strconv.Atoi(port)
		c, _, err := s.dialTCP(ctx, a.user.ID, host, p, 10*time.Second)
		return c, err
	}
}

func (s *Server) pveClient(a *authed, srv *store.ProxmoxServer) (*proxmox.Client, error) {
	secret, err := crypto.OpenSecret(s.master, a.sess.vk, "proxmox:"+srv.ID, srv.SecretBlob)
	if err != nil {
		return nil, err
	}
	defer crypto.Zero(secret)
	return proxmox.New(srv.Address, srv.TokenID, string(secret), srv.Fingerprint, s.pveDial(a))
}

func (s *Server) pveAllowed(w http.ResponseWriter, a *authed) bool {
	if !s.pveLimit.allow(a.user.ID) {
		apiErr(w, http.StatusTooManyRequests, "rate_limited")
		return false
	}
	return true
}

// pveFail sends a message people can act on, instead of a bare error code.
func pveFail(w http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	if errors.Is(err, proxmox.ErrCertChanged) {
		writeJSON(w, status, map[string]string{"error": "cert_changed", "message": "The server's certificate has changed since you added it. If you did not expect that, do not trust it. Otherwise remove the server and add it again."})
		return
	}
	writeJSON(w, status, map[string]string{"error": "proxmox", "message": err.Error()})
}

type pveServerView struct {
	ID          string `json:"id"`
	Address     string `json:"address"`
	TokenID     string `json:"token_id"`
	Fingerprint string `json:"fingerprint"`
}

func (s *Server) handleListProxmoxServers(w http.ResponseWriter, _ *http.Request, a *authed) {
	list, err := s.db.ListProxmoxServers(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	out := make([]pveServerView, 0, len(list))
	for _, p := range list {
		out = append(out, pveServerView{p.ID, p.Address, p.TokenID, p.Fingerprint})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleProbeProxmox shows the certificate a server presents, so the person can check it
// before it is pinned.
func (s *Server) handleProbeProxmox(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Address string `json:"address"`
	}
	if !decode(w, r, &in) || !s.pveAllowed(w, a) {
		return
	}
	fp, err := proxmox.Probe(r.Context(), in.Address, s.pveDial(a))
	if err != nil {
		pveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"fingerprint": fp})
}

func (s *Server) handleCreateProxmoxServer(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Address     string `json:"address"`
		TokenID     string `json:"token_id"`
		Secret      string `json:"secret"`
		Fingerprint string `json:"fingerprint"`
	}
	if !decode(w, r, &in) || !s.pveAllowed(w, a) {
		return
	}
	in.Address, in.TokenID, in.Secret, in.Fingerprint = strings.TrimSpace(in.Address), strings.TrimSpace(in.TokenID), strings.TrimSpace(in.Secret), strings.ToUpper(strings.TrimSpace(in.Fingerprint))
	if _, _, err := proxmox.Address(in.Address); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": err.Error()})
		return
	}
	if !pveTokenIDRe.MatchString(in.TokenID) || len(in.TokenID) > 200 || in.Secret == "" || len(in.Secret) > 200 || strings.ContainsAny(in.Secret, " \t\r\n") || !pveFingerprintRe.MatchString(in.Fingerprint) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad_request", "message": "Enter the token ID as user@realm!name, and paste the secret."})
		return
	}
	srv := &store.ProxmoxServer{ID: newID(), UserID: a.user.ID, Address: in.Address, TokenID: in.TokenID, Fingerprint: in.Fingerprint}
	srv.SecretBlob = crypto.SealSecret(s.master, a.sess.vk, "proxmox:"+srv.ID, []byte(in.Secret))
	c, err := s.pveClient(a, srv)
	if err == nil {
		_, err = c.Version(r.Context()) // proves the certificate and the token before anything is saved
	}
	if err != nil {
		pveFail(w, err)
		return
	}
	if err := s.db.CreateProxmoxServer(srv); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pveServerView{srv.ID, srv.Address, srv.TokenID, srv.Fingerprint})
}

func (s *Server) handleDeleteProxmoxServer(w http.ResponseWriter, r *http.Request, a *authed) {
	if err := s.db.DeleteProxmoxServer(r.PathValue("id"), a.user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			apiErr(w, http.StatusNotFound, "not_found")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type pveVM struct {
	ServerID string `json:"server_id"`
	Server   string `json:"server"`
	proxmox.Resource
	HostID   string `json:"host_id,omitempty"`
	HostName string `json:"host_name,omitempty"`
}

type pveProblem struct {
	ServerID string `json:"server_id"`
	Server   string `json:"server"`
	Message  string `json:"message"`
}

// handleProxmoxVMs lists the VMs and containers on every server the user connected. A server
// that can't be reached is reported next to the ones that can.
func (s *Server) handleProxmoxVMs(w http.ResponseWriter, r *http.Request, a *authed) {
	servers, err := s.db.ListProxmoxServers(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	hosts, _ := s.db.ListHosts(a.user.ID)
	linked := map[string]*store.Host{}
	for _, h := range hosts {
		if h.ProxmoxServerID != "" {
			linked[h.ProxmoxServerID+"/"+h.ProxmoxType+"/"+strconv.Itoa(h.ProxmoxVMID)] = h
		}
	}
	if !s.pveAllowed(w, a) {
		return
	}
	type result struct {
		vms []pveVM
		err *pveProblem
	}
	results := make([]result, len(servers))
	var wg sync.WaitGroup
	for i, srv := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			label := strings.TrimPrefix(srv.Address, "https://")
			c, err := s.pveClient(a, srv)
			var res []proxmox.Resource
			if err == nil {
				res, err = c.Resources(r.Context())
			}
			if err != nil {
				msg := err.Error()
				if errors.Is(err, proxmox.ErrCertChanged) {
					msg = "The server's certificate has changed. Remove the server and add it again if that is expected."
				}
				results[i].err = &pveProblem{srv.ID, label, msg}
				return
			}
			for _, x := range res {
				v := pveVM{ServerID: srv.ID, Server: label, Resource: x}
				if h := linked[srv.ID+"/"+x.Type+"/"+strconv.Itoa(x.VMID)]; h != nil {
					v.HostID, v.HostName = h.ID, h.Name
				}
				results[i].vms = append(results[i].vms, v)
			}
		}()
	}
	wg.Wait()
	out := struct {
		VMs    []pveVM      `json:"vms"`
		Errors []pveProblem `json:"errors"`
	}{VMs: []pveVM{}, Errors: []pveProblem{}}
	for _, res := range results {
		out.VMs = append(out.VMs, res.vms...)
		if res.err != nil {
			out.Errors = append(out.Errors, *res.err)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// pveTarget finds the server and VM a request names.
func (s *Server) pveTarget(w http.ResponseWriter, r *http.Request, a *authed) (*proxmox.Client, string, int, bool) {
	srv, err := s.db.GetProxmoxServer(r.PathValue("id"), a.user.ID)
	kind := r.PathValue("kind")
	vmid, convErr := strconv.Atoi(r.PathValue("vmid"))
	if err != nil || convErr != nil || vmid < 1 || (kind != "qemu" && kind != "lxc") {
		apiErr(w, http.StatusNotFound, "not_found")
		return nil, "", 0, false
	}
	if !s.pveAllowed(w, a) {
		return nil, "", 0, false
	}
	c, err := s.pveClient(a, srv)
	if err != nil {
		serverErr(w, err)
		return nil, "", 0, false
	}
	return c, kind, vmid, true
}

func (s *Server) handleProxmoxStatus(w http.ResponseWriter, r *http.Request, a *authed) {
	c, kind, vmid, ok := s.pveTarget(w, r, a)
	if !ok {
		return
	}
	res, err := c.Find(r.Context(), kind, vmid)
	if err != nil {
		pveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": res.Status, "name": res.Name, "node": res.Node, "uptime": res.Uptime})
}

func (s *Server) handleProxmoxPower(w http.ResponseWriter, r *http.Request, a *authed) {
	c, kind, vmid, ok := s.pveTarget(w, r, a)
	if !ok {
		return
	}
	if err := c.Power(r.Context(), kind, vmid, r.PathValue("action")); err != nil {
		pveFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleProxmoxSuggest looks for the VM a host probably runs on: first one with the host's name,
// then one whose guest reports the host's address.
func (s *Server) handleProxmoxSuggest(w http.ResponseWriter, r *http.Request, a *authed) {
	name, address := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("name"))), strings.TrimSpace(r.URL.Query().Get("address"))
	servers, err := s.db.ListProxmoxServers(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	if !s.pveAllowed(w, a) {
		return
	}
	type match struct {
		ServerID string `json:"server_id"`
		VMID     int    `json:"vmid"`
		Type     string `json:"type"`
		Name     string `json:"name"`
		Server   string `json:"server"`
		Reason   string `json:"reason"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	var best *match
	var running []struct {
		srv *store.ProxmoxServer
		c   *proxmox.Client
		res proxmox.Resource
	}
	for _, srv := range servers {
		c, err := s.pveClient(a, srv)
		if err != nil {
			continue
		}
		list, err := c.Resources(ctx)
		if err != nil {
			continue
		}
		for _, x := range list {
			label := strings.TrimPrefix(srv.Address, "https://")
			if name != "" && strings.ToLower(x.Name) == name && best == nil {
				best = &match{srv.ID, x.VMID, x.Type, x.Name, label, "name"}
			}
			if x.Status == "running" && len(running) < 12 {
				running = append(running, struct {
					srv *store.ProxmoxServer
					c   *proxmox.Client
					res proxmox.Resource
				}{srv, c, x})
			}
		}
	}
	if best == nil && address != "" {
		var mu sync.Mutex
		var wg sync.WaitGroup
		for _, rv := range running {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for _, ip := range rv.c.GuestIPs(ctx, rv.res) {
					if ip == address {
						mu.Lock()
						if best == nil {
							best = &match{rv.srv.ID, rv.res.VMID, rv.res.Type, rv.res.Name, strings.TrimPrefix(rv.srv.Address, "https://"), "address"}
						}
						mu.Unlock()
					}
				}
			}()
		}
		wg.Wait()
	}
	writeJSON(w, http.StatusOK, map[string]any{"match": best})
}

// handleHostReachable says whether the host answers on its port, so the page can wait for a VM it started.
func (s *Server) handleHostReachable(w http.ResponseWriter, r *http.Request, a *authed) {
	h, err := s.db.GetHost(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	c, _, err := s.dialTCP(ctx, a.user.ID, h.Address, h.Port, 3*time.Second)
	if err == nil {
		c.Close()
	}
	writeJSON(w, http.StatusOK, map[string]bool{"up": err == nil})
}
