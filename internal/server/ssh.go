package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/ssh"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

// Wire protocol on /api/ws/ssh/{id}: binary frames carry terminal bytes in both
// directions; text frames carry JSON control messages.
type clientMsg struct {
	Type   string `json:"type"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
	Accept bool   `json:"accept"`
}

type serverMsg struct {
	Type        string `json:"type"`
	Message     string `json:"message,omitempty"`
	Host        string `json:"host,omitempty"` // which host a hostkey prompt is about
	KeyType     string `json:"key_type,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	OldPrint    string `json:"old_fingerprint,omitempty"`
	Changed     bool   `json:"changed,omitempty"`
	Retry       bool   `json:"retry,omitempty"` // the failure may be temporary
}

// How often a terminal's WebSocket is pinged, so that reverse proxies with an
// idle timeout don't drop a terminal that has been quiet for a while.
var wsPingEvery = 25 * time.Second

const (
	trustTimeout     = 2 * time.Minute
	handshakeTimeout = 20 * time.Second
	keepaliveEvery   = 30 * time.Second
	defaultCols      = 80
	defaultRows      = 24
)

type termSize struct {
	mu         sync.Mutex
	cols, rows int
}

func (t *termSize) set(c, r int) {
	if c < 1 || r < 1 || c > 1000 || r > 1000 {
		return
	}
	t.mu.Lock()
	t.cols, t.rows = c, r
	t.mu.Unlock()
}

func (t *termSize) get() (int, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cols, t.rows
}

// hopError is a failure to reach or authenticate to the host.
type hopError struct {
	hop       *store.Host
	unreached bool
	hint      string
	err       error
}

func (e *hopError) Error() string { return e.err.Error() }

func (e *hopError) message() string {
	if e.unreached {
		return "could not reach " + net.JoinHostPort(e.hop.Address, strconv.Itoa(e.hop.Port)) + "." + e.hint
	}
	return describeSSHError(e.err)
}

func (s *Server) handleSSH(w http.ResponseWriter, r *http.Request, a *authed) {
	host, err := s.db.GetHost(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	if host.Protocol != "ssh" {
		apiErr(w, http.StatusBadRequest, "wrong_protocol")
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		t := time.NewTicker(wsPingEvery)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				pctx, stop := context.WithTimeout(ctx, 10*time.Second)
				err := c.Ping(pctx)
				stop()
				if err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	send := func(m serverMsg) {
		b, _ := json.Marshal(m)
		c.Write(ctx, websocket.MessageText, b)
	}
	fail := func(msg string, retry bool) {
		send(serverMsg{Type: "error", Message: msg, Retry: retry})
		c.Close(websocket.StatusNormalClosure, "error")
	}

	size := &termSize{cols: defaultCols, rows: defaultRows}
	stdinCh := make(chan []byte, 64)
	trustCh := make(chan bool, 1)
	resizeCh := make(chan struct{}, 1)
	var ready sync.Mutex // guards readyFlag
	readyFlag := false
	isReady := func() bool { ready.Lock(); defer ready.Unlock(); return readyFlag }

	// Reader: dispatches everything the browser sends, and ends the bridge if
	// the web session has been signed out or has timed out.
	go func() {
		defer cancel()
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if _, ok := s.sess.get(a.token, s.cfg.SessionTimeout); !ok {
				c.Close(4401, "session ended")
				return
			}
			if typ == websocket.MessageBinary {
				if isReady() {
					select {
					case stdinCh <- data:
					case <-ctx.Done():
						return
					}
				}
				continue
			}
			var m clientMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.Type {
			case "resize":
				size.set(m.Cols, m.Rows)
				select {
				case resizeCh <- struct{}{}:
				default:
				}
			case "trust":
				select {
				case trustCh <- m.Accept:
				default:
				}
			}
		}
	}()

	send(serverMsg{Type: "status", Message: "connecting"})

	client, closeAll, he := s.connectHost(ctx, host, a, send, trustCh, nil)
	if he != nil {
		fail(he.message(), he.unreached)
		return
	}
	defer closeAll()

	sess, err := client.NewSession()
	if err != nil {
		fail("The server refused to open a session.", false)
		return
	}
	defer sess.Close()
	cols, rows := size.get()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		fail("The server refused a terminal.", false)
		return
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		fail("Could not attach to the session.", false)
		return
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		fail("Could not attach to the session.", false)
		return
	}
	if err := sess.Shell(); err != nil {
		fail("The server would not start a shell.", false)
		return
	}
	ready.Lock()
	readyFlag = true
	ready.Unlock()
	send(serverMsg{Type: "connected"})

	// SSH -> browser.
	done := make(chan string, 1)
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				if werr := c.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					done <- ""
					return
				}
			}
			if err != nil {
				// A shell that exited reports an exit status; a vanished server does not.
				reason := "dropped"
				if errors.Is(err, io.EOF) {
					var exit *ssh.ExitError
					if werr := sess.Wait(); werr == nil || errors.As(werr, &exit) {
						reason = "closed"
					}
				}
				done <- reason
				return
			}
		}
	}()
	// Browser -> SSH, window changes, keepalives.
	go func() {
		tick := time.NewTicker(keepaliveEvery)
		defer tick.Stop()
		for {
			select {
			case b := <-stdinCh:
				if _, err := stdin.Write(b); err != nil {
					return
				}
			case <-resizeCh:
				cols, rows := size.get()
				sess.WindowChange(rows, cols)
			case <-tick.C:
				if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
					select {
					case done <- "dropped":
					default:
					}
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	select {
	case reason := <-done:
		if reason != "" {
			send(serverMsg{Type: reason})
			c.Close(websocket.StatusNormalClosure, reason)
		}
	case <-ctx.Done():
	}
}

// connectHost dials and authenticates to host and returns its client. A nil
// trust channel means host keys are never prompted for: unknown or changed keys
// fail the connection. A non-nil override replaces the host's credentials.
func (s *Server) connectHost(ctx context.Context, host *store.Host, a *authed, send func(serverMsg), trust <-chan bool, override []ssh.AuthMethod) (*ssh.Client, func(), *hopError) {
	client, err := s.dialHost(ctx, host, a, send, trust, override)
	if err != nil {
		he := &hopError{hop: host, err: err}
		var de *dialError
		if errors.As(err, &de) {
			he.unreached = true
			he.hint = s.tailnetHint(a.user.ID, host.Address)
		}
		return nil, nil, he
	}
	return client, func() { client.Close() }, nil
}

type dialError struct{ err error }

func (e *dialError) Error() string { return e.err.Error() }

// dialHost connects and authenticates to hop over TCP and returns the SSH client for it.
func (s *Server) dialHost(ctx context.Context, hop *store.Host, a *authed, send func(serverMsg), trust <-chan bool, override []ssh.AuthMethod) (*ssh.Client, error) {
	auth, wipe := override, func() {}
	var err error
	if auth == nil {
		if auth, wipe, err = s.sshAuth(hop, a); err != nil {
			return nil, errors.New("unable to authenticate: no usable credentials")
		}
	}
	defer wipe()

	addr := net.JoinHostPort(hop.Address, strconv.Itoa(hop.Port))
	conn, _, err := s.dialTCP(ctx, a.user.ID, hop.Address, hop.Port, 15*time.Second)
	if err != nil {
		return nil, &dialError{err}
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()

	// Channel connections can't take deadlines, so close on a timer instead,
	// pausing it while the user decides about a host key.
	timer := time.AfterFunc(handshakeTimeout, func() { conn.Close() })
	defer timer.Stop()

	cfg := &ssh.ClientConfig{
		User: hop.Username, Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			timer.Stop()
			err := s.verifyHostKey(ctx, hop, key, send, trust)
			timer.Reset(handshakeTimeout)
			return err
		},
	}
	if known, err := s.db.KnownHost(hop.ID); err == nil {
		cfg.HostKeyAlgorithms = algorithmsFor(known.KeyType)
	}
	sc, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return ssh.NewClient(sc, chans, reqs), nil
}

// sshAuth decrypts the host's credential and returns auth methods plus a
// function that wipes the decrypted bytes. The vault key never leaves memory
// and the secret never goes to the browser.
func (s *Server) sshAuth(h *store.Host, a *authed) ([]ssh.AuthMethod, func(), error) {
	switch h.Auth {
	case "password":
		if h.PasswordBlob == nil {
			return nil, nil, errors.New("no password stored")
		}
		pw, err := crypto.OpenSecret(s.master, a.sess.vk, h.ID, h.PasswordBlob)
		if err != nil {
			return nil, nil, err
		}
		return []ssh.AuthMethod{
			ssh.PasswordCallback(func() (string, error) { return string(pw), nil }),
			ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
				if len(qs) != 1 {
					return nil, errors.New("unsupported prompt")
				}
				return []string{string(pw)}, nil
			}),
		}, func() { crypto.Zero(pw) }, nil
	case "key":
		if h.IdentityID == "" {
			return nil, nil, errors.New("no identity selected")
		}
		id, err := s.db.GetIdentity(h.IdentityID, a.user.ID)
		if err != nil {
			return nil, nil, err
		}
		pemBytes, err := crypto.OpenSecret(s.master, a.sess.vk, id.ID, id.PrivateBlob)
		if err != nil {
			return nil, nil, err
		}
		signer, err := ssh.ParsePrivateKey(pemBytes)
		crypto.Zero(pemBytes)
		if err != nil {
			return nil, nil, err
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, func() {}, nil
	}
	return nil, nil, errors.New("unknown auth type")
}

// verifyHostKey implements trust-on-first-use. An unknown key, or a key that
// differs from the stored one, is sent to the browser and the handshake waits
// for an explicit answer.
func (s *Server) verifyHostKey(ctx context.Context, h *store.Host, key ssh.PublicKey, send func(serverMsg), trust <-chan bool) error {
	fp := ssh.FingerprintSHA256(key)
	known, err := s.db.KnownHost(h.ID)
	if err == nil && known.Fingerprint == fp {
		return nil
	}
	if trust == nil {
		if err == nil {
			return errHostKeyChanged
		}
		return errHostKeyUnknown
	}
	m := serverMsg{Type: "hostkey", Host: h.Name, KeyType: key.Type(), Fingerprint: fp}
	if err == nil {
		m.Changed, m.OldPrint = true, known.Fingerprint
	}
	send(m)
	select {
	case ok := <-trust:
		if !ok {
			return errors.New("host key rejected")
		}
	case <-time.After(trustTimeout):
		return errors.New("host key not confirmed in time")
	case <-ctx.Done():
		return ctx.Err()
	}
	return s.db.SetKnownHost(h.ID, key.Type(), fp)
}

var (
	errHostKeyUnknown = errors.New("host key not trusted yet")
	errHostKeyChanged = errors.New("host key has changed")
)

func algorithmsFor(keyType string) []string {
	if keyType == "ssh-rsa" {
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}
	}
	return []string{keyType}
}

func describeSSHError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "unable to authenticate"):
		return "Authentication failed. Check the username and credentials for this host."
	case strings.Contains(msg, errHostKeyUnknown.Error()):
		return "Host key not trusted yet. Open this host in a terminal once, trust its key, then try again."
	case strings.Contains(msg, errHostKeyChanged.Error()):
		return "Host key has changed. Open this host in a terminal to review it."
	case strings.Contains(msg, "host key rejected"):
		return "Host key not trusted. Connection cancelled."
	case strings.Contains(msg, "host key not confirmed"):
		return "Host key was not confirmed in time."
	case strings.Contains(msg, "no common algorithm"):
		return "The server no longer offers the host key type saved for it. Edit the host and reconnect to review its key."
	}
	return fmt.Sprintf("Connection failed: %s", strings.TrimPrefix(msg, "ssh: "))
}
