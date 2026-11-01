package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

var themes = map[string]bool{"auto": true, "dark": true, "light": true, "contrast": true}

var rdpSecurity = map[string]bool{"any": true, "nla": true, "tls": true, "rdp": true}

type folderView struct {
	ID       string `json:"id"`
	ParentID string `json:"parent_id"`
	Name     string `json:"name"`
}

type hostView struct {
	ID          string `json:"id"`
	FolderID    string `json:"folder_id"`
	Name        string `json:"name"`
	Address     string `json:"address"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	Auth        string `json:"auth"`
	IdentityID  string `json:"identity_id"`
	HasPassword bool   `json:"has_password"`
	Protocol    string `json:"protocol"`
	Theme       string `json:"theme"`
	Security    string `json:"security"`
	IgnoreCert  bool   `json:"ignore_cert"`
}

func toHostView(h *store.Host) hostView {
	v := hostView{ID: h.ID, FolderID: h.FolderID, Name: h.Name, Address: h.Address, Port: h.Port,
		Username: h.Username, Auth: h.Auth, IdentityID: h.IdentityID, HasPassword: h.PasswordBlob != nil,
		Protocol: h.Protocol, Theme: h.Theme, Security: h.RDPSecurity, IgnoreCert: h.RDPIgnoreCert}
	return v
}

func (s *Server) handleListHosts(w http.ResponseWriter, _ *http.Request, a *authed) {
	folders, err := s.db.ListFolders(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	hosts, err := s.db.ListHosts(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	out := struct {
		Folders []folderView `json:"folders"`
		Hosts   []hostView   `json:"hosts"`
	}{Folders: []folderView{}, Hosts: []hostView{}}
	for _, f := range folders {
		out.Folders = append(out.Folders, folderView{f.ID, f.ParentID, f.Name})
	}
	for _, h := range hosts {
		out.Hosts = append(out.Hosts, toHostView(h))
	}
	writeJSON(w, http.StatusOK, out)
}

/* folders */

type folderInput struct {
	Name     string `json:"name"`
	ParentID string `json:"parent_id"`
}

// checkParent verifies a parent folder belongs to the user and that moving
// folder id under it would not create a cycle.
func (s *Server) checkParent(userID, id, parentID string) bool {
	for depth := 0; parentID != "" && depth < 64; depth++ {
		if parentID == id {
			return false
		}
		p, err := s.db.GetFolder(parentID, userID)
		if err != nil {
			return false
		}
		parentID = p.ParentID
	}
	return parentID == ""
}

func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request, a *authed) {
	var in folderInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 80 || !s.checkParent(a.user.ID, "", in.ParentID) {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	f := &store.Folder{ID: newID(), UserID: a.user.ID, ParentID: in.ParentID, Name: in.Name}
	if err := s.db.CreateFolder(f); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, folderView{f.ID, f.ParentID, f.Name})
}

func (s *Server) handleUpdateFolder(w http.ResponseWriter, r *http.Request, a *authed) {
	f, err := s.db.GetFolder(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	var in folderInput
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 80 || !s.checkParent(a.user.ID, f.ID, in.ParentID) {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	f.Name, f.ParentID = in.Name, in.ParentID
	if err := s.db.UpdateFolder(f); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, folderView{f.ID, f.ParentID, f.Name})
}

func (s *Server) handleDeleteFolder(w http.ResponseWriter, r *http.Request, a *authed) {
	if err := s.db.DeleteFolder(r.PathValue("id"), a.user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			apiErr(w, http.StatusNotFound, "not_found")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

/* hosts */

type hostInput struct {
	Name       string  `json:"name"`
	FolderID   string  `json:"folder_id"`
	Address    string  `json:"address"`
	Port       int     `json:"port"`
	Username   string  `json:"username"`
	Auth       string  `json:"auth"`
	IdentityID string  `json:"identity_id"`
	Password   *string `json:"password"` // nil keeps the stored password, "" clears it
	Theme      string  `json:"theme"`
	Protocol   string  `json:"protocol"`
	Security   string  `json:"security"`
	IgnoreCert *bool   `json:"ignore_cert"`
}

// applyHostInput validates in and copies it onto h, sealing any new password
// with the caller's vault key.
func (s *Server) applyHostInput(h *store.Host, in *hostInput, a *authed) string {
	in.Name, in.Address, in.Username = strings.TrimSpace(in.Name), strings.TrimSpace(in.Address), strings.TrimSpace(in.Username)
	if in.Protocol == "" {
		in.Protocol = h.Protocol
	}
	if in.Protocol == "" {
		in.Protocol = "ssh"
	}
	if in.Protocol == "rdp" {
		// RDP signs in with a password, over a direct connection.
		in.Auth, in.IdentityID, in.Theme = "password", "", "auto"
		if in.Port == 0 {
			in.Port = 3389
		}
		if in.Security == "" {
			in.Security = "any"
		}
	} else if in.Port == 0 {
		in.Port = 22
	}
	if in.Theme == "" {
		in.Theme = "auto"
	}
	switch {
	case in.Name == "" || len(in.Name) > 80, in.Address == "" || len(in.Address) > 255,
		len(in.Username) > 128, in.Port < 1 || in.Port > 65535, !themes[in.Theme],
		in.Protocol != "ssh" && in.Protocol != "rdp",
		in.Protocol == "rdp" && !rdpSecurity[in.Security],
		in.Auth != "password" && in.Auth != "key":
		return "bad_request"
	}
	if in.FolderID != "" {
		if _, err := s.db.GetFolder(in.FolderID, a.user.ID); err != nil {
			return "bad_request"
		}
	}
	if in.Auth == "key" && in.IdentityID != "" {
		if _, err := s.db.GetIdentity(in.IdentityID, a.user.ID); err != nil {
			return "bad_request"
		}
	}
	h.Name, h.FolderID, h.Address, h.Port, h.Username = in.Name, in.FolderID, in.Address, in.Port, in.Username
	h.Auth, h.Theme, h.IdentityID = in.Auth, in.Theme, in.IdentityID
	h.Protocol = in.Protocol
	if in.Protocol == "rdp" {
		h.RDPSecurity = in.Security
		if in.IgnoreCert != nil {
			h.RDPIgnoreCert = *in.IgnoreCert
		} else if h.RDPSecurity == "" || h.CreatedAt == 0 {
			h.RDPIgnoreCert = true
		}
	}
	if h.RDPSecurity == "" {
		h.RDPSecurity = "any"
	}
	if in.Auth == "password" {
		h.IdentityID = ""
	}
	if in.Password != nil {
		h.PasswordBlob = nil
		if *in.Password != "" {
			h.PasswordBlob = crypto.SealSecret(s.master, a.sess.vk, h.ID, []byte(*in.Password))
		}
	}
	return ""
}

func (s *Server) handleCreateHost(w http.ResponseWriter, r *http.Request, a *authed) {
	var in hostInput
	if !decode(w, r, &in) {
		return
	}
	h := &store.Host{ID: newID(), UserID: a.user.ID, RDPSecurity: "any", RDPIgnoreCert: true}
	if code := s.applyHostInput(h, &in, a); code != "" {
		apiErr(w, http.StatusBadRequest, code)
		return
	}
	if err := s.db.CreateHost(h); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toHostView(h))
}

func (s *Server) handleUpdateHost(w http.ResponseWriter, r *http.Request, a *authed) {
	h, err := s.db.GetHost(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	var in hostInput
	if !decode(w, r, &in) {
		return
	}
	if code := s.applyHostInput(h, &in, a); code != "" {
		apiErr(w, http.StatusBadRequest, code)
		return
	}
	if err := s.db.UpdateHost(h); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toHostView(h))
}

func (s *Server) handleDeleteHost(w http.ResponseWriter, r *http.Request, a *authed) {
	if err := s.db.DeleteHost(r.PathValue("id"), a.user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			apiErr(w, http.StatusNotFound, "not_found")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleRevealHostPassword returns a host's saved password. Passwords are
// otherwise never sent to the browser, so it needs the account password again.
func (s *Server) handleRevealHostPassword(w http.ResponseWriter, r *http.Request, a *authed) {
	h, err := s.db.GetHost(r.PathValue("id"), a.user.ID)
	if err != nil || h.PasswordBlob == nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	if !s.confirmPassword(w, r, a) {
		return
	}
	pw, err := crypto.OpenSecret(s.master, a.sess.vk, h.ID, h.PasswordBlob)
	if err != nil {
		serverErr(w, err)
		return
	}
	defer crypto.Zero(pw)
	writeJSON(w, http.StatusOK, map[string]string{"password": string(pw)})
}
