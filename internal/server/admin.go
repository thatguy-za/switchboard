package server

import (
	"encoding/base64"
	"errors"
	"net/http"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

func (s *Server) handleListUsers(w http.ResponseWriter, _ *http.Request, _ *authed) {
	users, err := s.db.ListUsers()
	if err != nil {
		serverErr(w, err)
		return
	}
	out := make([]userView, 0, len(users))
	for _, u := range users {
		v := s.view(u)
		v.Needs2FA = false
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request, _ *authed) {
	var in struct {
		credentials
		Role string `json:"role"`
	}
	if !decode(w, r, &in) {
		return
	}
	if code := validCredentials(in.Username, in.Password); code != "" {
		apiErr(w, http.StatusBadRequest, code)
		return
	}
	if in.Role != "admin" && in.Role != "member" {
		apiErr(w, http.StatusBadRequest, "invalid_role")
		return
	}
	u, vk, _ := s.newAccount(in.Username, in.Password, in.Role, true, false)
	crypto.Zero(vk) // the new user's vault key is only held in their own sessions
	if err := s.db.CreateUser(u); err != nil {
		if errors.Is(err, store.ErrExists) {
			apiErr(w, http.StatusConflict, "username_taken")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.view(u))
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request, a *authed) {
	id := r.PathValue("id")
	if id == a.user.ID {
		apiErr(w, http.StatusBadRequest, "cannot_delete_self")
		return
	}
	target, err := s.db.UserByID(id)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	if target.Role == "admin" {
		if n, _ := s.db.AdminCount(); n <= 1 {
			apiErr(w, http.StatusBadRequest, "last_admin")
			return
		}
	}
	s.sess.removeUser(id, "")
	s.forgetTailscale(id)
	if err := s.db.DeleteUser(id); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleReset2FA(w http.ResponseWriter, r *http.Request, _ *authed) {
	id := r.PathValue("id")
	if _, err := s.db.UserByID(id); err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	if err := s.db.ClearTOTP(id); err != nil {
		serverErr(w, err)
		return
	}
	s.sess.removeUser(id, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleRequire2FA(w http.ResponseWriter, r *http.Request, _ *authed) {
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	v := ""
	if in.Enabled {
		v = "1"
	}
	if err := s.db.SetSetting("require_2fa", v); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": in.Enabled})
}

// handleMasterKey returns the master key so an admin can back it up. It needs
// the admin's password again.
func (s *Server) handleMasterKey(w http.ResponseWriter, r *http.Request, a *authed) {
	if !s.confirmPassword(w, r, a) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"master_key": base64.StdEncoding.EncodeToString(s.master)})
}

func (s *Server) handleKeyBackupConfirmed(w http.ResponseWriter, _ *http.Request, _ *authed) {
	if err := s.db.SetSetting("key_backup_confirmed", "1"); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
