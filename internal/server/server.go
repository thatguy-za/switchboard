package server

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

const (
	cookieSession = "sb_session"
	cookiePending = "sb_pending"
	maxFailures   = 5
	lockDuration  = 15 * time.Minute
	minPassword   = 12
)

func init() {
	// Not in Go's built-in table, and the minimal image has no mime.types file.
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{2,32}$`)

type Config struct {
	DataDir, KeysDir string
	Port             int // the web port; local forwards may not listen on it
	SessionTimeout   time.Duration
	Guacd            string // host:port of guacd, for RDP
	TransferDir      string // folder shared with guacd for RDP file transfer; empty turns it off
	MaxRDP           int    // concurrent RDP sessions allowed
}

type Server struct {
	cfg        Config
	db         *store.Store
	master     []byte
	keyCreated bool
	sess       *sessions
	limit      *limiter
	web        fs.FS
	dummyHash  string
	stop       chan struct{}
	rdpMu      sync.Mutex
	rdpActive  int
}

func New(cfg Config, web fs.FS) (*Server, error) {
	master, created, err := crypto.LoadMasterKey(cfg.KeysDir)
	if err != nil {
		return nil, err
	}
	db, err := store.Open(filepath.Join(cfg.DataDir, "switchboard.db"))
	if err != nil {
		return nil, err
	}
	if cfg.Guacd == "" {
		cfg.Guacd = "guacd:4822"
	}
	if cfg.MaxRDP == 0 {
		cfg.MaxRDP = 10
	}
	s := &Server{
		cfg: cfg, db: db, master: master, keyCreated: created, web: web,
		sess: newSessions(), limit: newLimiter(20, time.Minute),
		dummyHash: crypto.HashPassword("dummy"), stop: make(chan struct{}),
	}
	s.clearTransfers()
	go s.janitor()
	return s, nil
}

func (s *Server) KeyCreated() bool { return s.keyCreated }

func (s *Server) Close() {
	close(s.stop)
	s.db.Close()
}

func (s *Server) janitor() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.sess.sweep(s.cfg.SessionTimeout)
		case <-s.stop:
			return
		}
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })

	mux.HandleFunc("GET /api/state", s.handleState)
	mux.HandleFunc("POST /api/setup", s.handleSetup)
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/login/2fa", s.handleLogin2FA)
	mux.HandleFunc("POST /api/recover", s.handleRecover)
	mux.HandleFunc("POST /api/logout", s.auth(false, s.handleLogout))
	mux.HandleFunc("POST /api/logout-all", s.auth(false, s.handleLogoutAll))
	mux.HandleFunc("POST /api/password", s.auth(false, s.handlePassword))

	mux.HandleFunc("POST /api/2fa/setup", s.auth(false, s.handle2FASetup))
	mux.HandleFunc("POST /api/2fa/enable", s.auth(false, s.handle2FAEnable))
	mux.HandleFunc("POST /api/2fa/disable", s.auth(true, s.handle2FADisable))
	mux.HandleFunc("POST /api/2fa/backup-codes", s.auth(true, s.handleBackupCodes))

	mux.HandleFunc("GET /api/hosts", s.auth(true, s.handleListHosts))
	mux.HandleFunc("POST /api/hosts", s.auth(true, s.handleCreateHost))
	mux.HandleFunc("PUT /api/hosts/{id}", s.auth(true, s.handleUpdateHost))
	mux.HandleFunc("DELETE /api/hosts/{id}", s.auth(true, s.handleDeleteHost))
	mux.HandleFunc("POST /api/folders", s.auth(true, s.handleCreateFolder))
	mux.HandleFunc("PUT /api/folders/{id}", s.auth(true, s.handleUpdateFolder))
	mux.HandleFunc("DELETE /api/folders/{id}", s.auth(true, s.handleDeleteFolder))
	mux.HandleFunc("GET /api/identities", s.auth(true, s.handleListIdentities))
	mux.HandleFunc("POST /api/identities/generate", s.auth(true, s.handleGenerateIdentity))
	mux.HandleFunc("POST /api/identities/import", s.auth(true, s.handleImportIdentity))
	mux.HandleFunc("DELETE /api/identities/{id}", s.auth(true, s.handleDeleteIdentity))
	mux.HandleFunc("POST /api/identities/{id}/export", s.auth(true, s.handleExportIdentity))
	mux.HandleFunc("POST /api/identities/{id}/push", s.auth(true, s.handlePush))
	mux.HandleFunc("GET /api/ws/ssh/{id}", s.auth(true, s.handleSSH))
	mux.HandleFunc("GET /api/ws/rdp/{id}", s.auth(true, s.handleRDP))

	mux.HandleFunc("GET /api/admin/users", s.admin(s.handleListUsers))
	mux.HandleFunc("POST /api/admin/users", s.admin(s.handleCreateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", s.admin(s.handleDeleteUser))
	mux.HandleFunc("POST /api/admin/users/{id}/reset-2fa", s.admin(s.handleReset2FA))
	mux.HandleFunc("POST /api/admin/require-2fa", s.admin(s.handleRequire2FA))
	mux.HandleFunc("POST /api/admin/master-key", s.admin(s.handleMasterKey))
	mux.HandleFunc("POST /api/admin/key-backup-confirmed", s.admin(s.handleKeyBackupConfirmed))

	mux.Handle("/", http.FileServer(http.FS(s.web)))
	return s.secure(mux)
}

// secure applies response headers and a content-type check on writes, which
// together with SameSite=Strict cookies blocks cross-site form posts.
func (s *Server) secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
			if r.Method != http.MethodGet && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				apiErr(w, http.StatusUnsupportedMediaType, "json_required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func apiErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func serverErr(w http.ResponseWriter, err error) {
	apiErr(w, http.StatusInternalServerError, "server_error")
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return false
	}
	return true
}

// setCookie marks cookies Secure when the request came in over TLS, directly
// or through a reverse proxy that says so.
func (s *Server) setCookie(w http.ResponseWriter, r *http.Request, name, value string, maxAge int) {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name: name, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: secure,
	})
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func newID() string { return hex.EncodeToString(crypto.RandomBytes(16)) }

// limiter allows n events per window per key.
type limiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.n {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}

type authed struct {
	user  *store.User
	sess  *session
	token string
}

type authedHandler func(http.ResponseWriter, *http.Request, *authed)

func (s *Server) authenticate(r *http.Request) (*authed, bool) {
	c, err := r.Cookie(cookieSession)
	if err != nil {
		return nil, false
	}
	se, ok := s.sess.get(c.Value, s.cfg.SessionTimeout)
	if !ok {
		return nil, false
	}
	u, err := s.db.UserByID(se.userID)
	if err != nil {
		s.sess.remove(c.Value)
		return nil, false
	}
	return &authed{user: u, sess: se, token: c.Value}, true
}

func (s *Server) require2FA() bool {
	v, _ := s.db.Setting("require_2fa")
	return v == "1"
}

func (s *Server) needs2FASetup(u *store.User) bool { return s.require2FA() && !u.TOTPEnabled }

// auth requires a session. With strict set it also refuses sessions that still
// owe a password change or 2FA enrolment.
func (s *Server) auth(strict bool, h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a, ok := s.authenticate(r)
		if !ok {
			apiErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if strict {
			if a.user.MustChange {
				apiErr(w, http.StatusForbidden, "password_change_required")
				return
			}
			if s.needs2FASetup(a.user) {
				apiErr(w, http.StatusForbidden, "2fa_setup_required")
				return
			}
		}
		h(w, r, a)
	}
}

func (s *Server) admin(h authedHandler) http.HandlerFunc {
	return s.auth(true, func(w http.ResponseWriter, r *http.Request, a *authed) {
		if a.user.Role != "admin" {
			apiErr(w, http.StatusForbidden, "forbidden")
			return
		}
		h(w, r, a)
	})
}

type userView struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Role        string `json:"role"`
	TOTPEnabled bool   `json:"totp_enabled"`
	MustChange  bool   `json:"must_change"`
	Needs2FA    bool   `json:"needs_2fa_setup,omitempty"`
	BackupCodes *int   `json:"backup_codes_left,omitempty"`
	CreatedAt   int64  `json:"created_at"`
}

func (s *Server) view(u *store.User) userView {
	return userView{ID: u.ID, Username: u.Username, Role: u.Role, TOTPEnabled: u.TOTPEnabled,
		MustChange: u.MustChange, Needs2FA: s.needs2FASetup(u), CreatedAt: u.CreatedAt}
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	n, err := s.db.UserCount()
	if err != nil {
		serverErr(w, err)
		return
	}
	out := map[string]any{"setup_done": n > 0, "require_2fa": s.require2FA()}
	if a, ok := s.authenticate(r); ok {
		v := s.view(a.user)
		if left, err := s.db.BackupCodesLeft(a.user.ID); err == nil && a.user.TOTPEnabled {
			v.BackupCodes = &left
		}
		out["user"] = v
		if a.user.Role == "admin" {
			confirmed, _ := s.db.Setting("key_backup_confirmed")
			out["key_backup_pending"] = confirmed != "1"
		}
	}
	writeJSON(w, http.StatusOK, out)
}

var errBadInput = errors.New("bad input")
