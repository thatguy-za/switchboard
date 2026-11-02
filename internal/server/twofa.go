package server

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"github.com/thatguy-za/webterm/internal/crypto"
	"github.com/thatguy-za/webterm/internal/store"
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// hotp is RFC 4226 with SHA-1 and 6 digits; TOTP (RFC 6238) feeds it time steps.
func hotp(secret []byte, counter uint64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	n := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", n%1000000)
}

// checkTOTP accepts the current step and one either side, but never a step at
// or before lastStep, so a code works once. It returns the matched step.
func checkTOTP(secret []byte, code string, now time.Time, lastStep int64) (int64, bool) {
	code = strings.ReplaceAll(strings.TrimSpace(code), " ", "")
	if len(code) != 6 {
		return 0, false
	}
	cur := now.Unix() / 30
	for step := cur - 1; step <= cur+1; step++ {
		if step > lastStep && subtle.ConstantTimeCompare([]byte(hotp(secret, uint64(step))), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

func hashBackupCode(code string) []byte {
	norm := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(code)))
	h := sha256.Sum256([]byte(norm))
	return h[:]
}

func newBackupCodes() (plain []string, hashes [][]byte) {
	for i := 0; i < 10; i++ {
		s := b32.EncodeToString(crypto.RandomBytes(5))
		code := s[:4] + "-" + s[4:]
		plain = append(plain, code)
		hashes = append(hashes, hashBackupCode(code))
	}
	return
}

func (s *Server) totpSecret(u *store.User) ([]byte, bool) {
	if u.TOTPSecret == nil {
		return nil, false
	}
	secret, err := crypto.OpenMaster(s.master, u.TOTPSecret, "totp", u.ID)
	return secret, err == nil
}

// verifySecondFactor accepts a TOTP code or an unused backup code.
func (s *Server) verifySecondFactor(u *store.User, code string) bool {
	if secret, ok := s.totpSecret(u); ok {
		if step, ok := checkTOTP(secret, code, time.Now(), u.TOTPStep); ok {
			return s.db.SetTOTPStep(u.ID, step) == nil
		}
	}
	ok, err := s.db.UseBackupCode(u.ID, hashBackupCode(code))
	return err == nil && ok
}

func (s *Server) handle2FASetup(w http.ResponseWriter, _ *http.Request, a *authed) {
	if a.user.TOTPEnabled {
		apiErr(w, http.StatusConflict, "2fa_enabled")
		return
	}
	secret := crypto.RandomBytes(20)
	if err := s.db.SetTOTP(a.user.ID, crypto.SealMaster(s.master, secret, "totp", a.user.ID), false, 0); err != nil {
		serverErr(w, err)
		return
	}
	text := b32.EncodeToString(secret)
	uri := fmt.Sprintf("otpauth://totp/WebTerm:%s?secret=%s&issuer=WebTerm&algorithm=SHA1&digits=6&period=30",
		url.PathEscape(a.user.Username), text)
	png, err := qrcode.Encode(uri, qrcode.Medium, 220)
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"secret": text, "uri": uri, "qr": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	})
}

func (s *Server) handle2FAEnable(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &in) {
		return
	}
	if a.user.TOTPEnabled {
		apiErr(w, http.StatusConflict, "2fa_enabled")
		return
	}
	secret, ok := s.totpSecret(a.user)
	if !ok {
		apiErr(w, http.StatusConflict, "2fa_not_started")
		return
	}
	step, ok := checkTOTP(secret, in.Code, time.Now(), 0)
	if !ok {
		apiErr(w, http.StatusUnauthorized, "invalid_code")
		return
	}
	plain, hashes := newBackupCodes()
	if err := s.db.SetTOTP(a.user.ID, a.user.TOTPSecret, true, step); err != nil {
		serverErr(w, err)
		return
	}
	if err := s.db.ReplaceBackupCodes(a.user.ID, hashes); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"backup_codes": plain})
}

type passwordBody struct {
	Password string `json:"password"`
}

// confirmPassword re-checks the caller's password for sensitive actions.
func (s *Server) confirmPassword(w http.ResponseWriter, r *http.Request, a *authed) bool {
	var in passwordBody
	if !decode(w, r, &in) {
		return false
	}
	if isLocked(a.user) {
		apiErr(w, http.StatusTooManyRequests, "locked")
		return false
	}
	if !crypto.VerifyPassword(in.Password, a.user.PWHash) {
		s.failure(w, a.user, "invalid_credentials")
		return false
	}
	return true
}

func (s *Server) handle2FADisable(w http.ResponseWriter, r *http.Request, a *authed) {
	if s.require2FA() {
		apiErr(w, http.StatusForbidden, "2fa_required")
		return
	}
	if !s.confirmPassword(w, r, a) {
		return
	}
	if err := s.db.ClearTOTP(a.user.ID); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleBackupCodes(w http.ResponseWriter, r *http.Request, a *authed) {
	if !a.user.TOTPEnabled {
		apiErr(w, http.StatusConflict, "2fa_not_enabled")
		return
	}
	if !s.confirmPassword(w, r, a) {
		return
	}
	plain, hashes := newBackupCodes()
	if err := s.db.ReplaceBackupCodes(a.user.ID, hashes); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"backup_codes": plain})
}
