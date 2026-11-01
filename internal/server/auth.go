package server

import (
	"errors"
	"net/http"
	"time"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

func validCredentials(username, password string) string {
	if !usernameRe.MatchString(username) {
		return "invalid_username"
	}
	if password == "" {
		return "weak_password"
	}
	return ""
}

// newAccount builds a user with a fresh vault. When recovery is true it also
// creates a recovery key and returns its text form.
func (s *Server) newAccount(username, password, role string, mustChange, recovery bool) (u *store.User, vk []byte, recoveryText string) {
	id := newID()
	salt := crypto.RandomBytes(16)
	vk = crypto.NewVaultKey()
	u = &store.User{
		ID: id, Username: username, Role: role, MustChange: mustChange,
		PWHash: crypto.HashPassword(password), KEKSalt: salt,
		WrappedVK: crypto.WrapVault(s.master, crypto.DeriveKEK(password, salt), vk, id),
	}
	if recovery {
		raw, text := crypto.NewRecoveryKey()
		u.RecoveryVK = crypto.WrapVaultRecovery(s.master, raw, vk, id)
		recoveryText = text
	}
	return
}

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, u *store.User, vk []byte) {
	s.setCookie(w, r, cookiePending, "", -1)
	s.setCookie(w, r, cookieSession, s.sess.create(u.ID, vk), 0)
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	if !s.limit.allow(clientIP(r)) {
		apiErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	if code := validCredentials(in.Username, in.Password); code != "" {
		apiErr(w, http.StatusBadRequest, code)
		return
	}
	u, vk, recovery := s.newAccount(in.Username, in.Password, "admin", false, true)
	if err := s.db.CreateOwner(u); err != nil {
		if errors.Is(err, store.ErrSetupDone) {
			apiErr(w, http.StatusConflict, "setup_done")
			return
		}
		serverErr(w, err)
		return
	}
	s.startSession(w, r, u, vk)
	writeJSON(w, http.StatusOK, map[string]string{"recovery_key": recovery})
}

// failure records a bad attempt and answers with the right error.
func (s *Server) failure(w http.ResponseWriter, u *store.User, code string) {
	locked, _ := s.db.RecordFailure(u.ID, maxFailures, time.Now().Add(lockDuration).Unix())
	if locked {
		s.sess.removeUser(u.ID, "")
		apiErr(w, http.StatusTooManyRequests, "locked")
		return
	}
	apiErr(w, http.StatusUnauthorized, code)
}

func isLocked(u *store.User) bool { return u.LockedUntil > time.Now().Unix() }

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.limit.allow(clientIP(r)) {
		apiErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	u, err := s.db.UserByName(in.Username)
	if err != nil {
		crypto.VerifyPassword(in.Password, s.dummyHash) // keep timing similar
		apiErr(w, http.StatusUnauthorized, "invalid_credentials")
		return
	}
	if isLocked(u) {
		apiErr(w, http.StatusTooManyRequests, "locked")
		return
	}
	if !crypto.VerifyPassword(in.Password, u.PWHash) {
		s.failure(w, u, "invalid_credentials")
		return
	}
	vk, err := crypto.UnwrapVault(s.master, crypto.DeriveKEK(in.Password, u.KEKSalt), u.WrappedVK, u.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	if u.TOTPEnabled {
		s.setCookie(w, r, cookiePending, s.sess.addPending(u.ID, vk), int(pendingTTL.Seconds()))
		writeJSON(w, http.StatusOK, map[string]bool{"need_2fa": true})
		return
	}
	s.db.ResetFailures(u.ID)
	s.startSession(w, r, u, vk)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogin2FA(w http.ResponseWriter, r *http.Request) {
	if !s.limit.allow(clientIP(r)) {
		apiErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var in struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &in) {
		return
	}
	c, err := r.Cookie(cookiePending)
	if err != nil {
		apiErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	p, ok := s.sess.pending(c.Value)
	if !ok {
		apiErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	u, err := s.db.UserByID(p.userID)
	if err != nil {
		s.sess.dropPending(c.Value)
		apiErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if isLocked(u) {
		s.sess.dropPending(c.Value)
		apiErr(w, http.StatusTooManyRequests, "locked")
		return
	}
	if !s.verifySecondFactor(u, in.Code) {
		s.failure(w, u, "invalid_code")
		return
	}
	token, ok := s.sess.promote(c.Value)
	if !ok {
		apiErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	s.db.ResetFailures(u.ID)
	s.setCookie(w, r, cookiePending, "", -1)
	s.setCookie(w, r, cookieSession, token, 0)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, a *authed) {
	s.sess.remove(a.token)
	s.setCookie(w, r, cookieSession, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleLogoutAll(w http.ResponseWriter, r *http.Request, a *authed) {
	s.sess.removeUser(a.user.ID, "")
	s.setCookie(w, r, cookieSession, "", -1)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// rewrap stores a new password for u, re-wrapping its vault key. If u has no
// recovery key yet one is created and returned.
func (s *Server) rewrap(u *store.User, vk []byte, newPassword string) (recovery string, err error) {
	salt := crypto.RandomBytes(16)
	wrapped := crypto.WrapVault(s.master, crypto.DeriveKEK(newPassword, salt), vk, u.ID)
	recVK := u.RecoveryVK
	if recVK == nil {
		raw, text := crypto.NewRecoveryKey()
		recVK = crypto.WrapVaultRecovery(s.master, raw, vk, u.ID)
		recovery = text
	}
	err = s.db.SetCredentials(u.ID, crypto.HashPassword(newPassword), salt, wrapped, recVK, false)
	return
}

func (s *Server) handlePassword(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if !decode(w, r, &in) {
		return
	}
	if isLocked(a.user) {
		apiErr(w, http.StatusTooManyRequests, "locked")
		return
	}
	if !crypto.VerifyPassword(in.Current, a.user.PWHash) {
		s.failure(w, a.user, "invalid_credentials")
		return
	}
	if in.New == "" {
		apiErr(w, http.StatusBadRequest, "weak_password")
		return
	}
	recovery, err := s.rewrap(a.user, a.sess.vk, in.New)
	if err != nil {
		serverErr(w, err)
		return
	}
	s.sess.removeUser(a.user.ID, a.token)
	out := map[string]string{}
	if recovery != "" {
		out["recovery_key"] = recovery
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRecover(w http.ResponseWriter, r *http.Request) {
	if !s.limit.allow(clientIP(r)) {
		apiErr(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var in struct {
		Username    string `json:"username"`
		RecoveryKey string `json:"recovery_key"`
		NewPassword string `json:"new_password"`
	}
	if !decode(w, r, &in) {
		return
	}
	u, err := s.db.UserByName(in.Username)
	if err != nil || u.RecoveryVK == nil {
		apiErr(w, http.StatusUnauthorized, "invalid_recovery_key")
		return
	}
	if isLocked(u) {
		apiErr(w, http.StatusTooManyRequests, "locked")
		return
	}
	raw, err := crypto.ParseRecoveryKey(in.RecoveryKey)
	var vk []byte
	if err == nil {
		vk, err = crypto.UnwrapVaultRecovery(s.master, raw, u.RecoveryVK, u.ID)
	}
	if err != nil {
		s.failure(w, u, "invalid_recovery_key")
		return
	}
	if in.NewPassword == "" {
		apiErr(w, http.StatusBadRequest, "weak_password")
		return
	}
	if _, err := s.rewrap(u, vk, in.NewPassword); err != nil {
		serverErr(w, err)
		return
	}
	crypto.Zero(vk)
	s.sess.removeUser(u.ID, "")
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
