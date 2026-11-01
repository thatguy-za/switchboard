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
	KeyType     string `json:"key_type,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	OldPrint    string `json:"old_fingerprint,omitempty"`
	Changed     bool   `json:"changed,omitempty"`
	Retry       bool   `json:"retry,omitempty"` // the failure may be temporary
}

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

func (s *Server) handleSSH(w http.ResponseWriter, r *http.Request, a *authed) {
	host, err := s.db.GetHost(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
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

	send := func(m serverMsg) {
		b, _ := json.Marshal(m)
		c.Write(ctx, websocket.MessageText, b)
	}
	fail := func(msg string) {
		send(serverMsg{Type: "error", Message: msg})
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

	auth, wipe, err := s.sshAuth(host, a)
	if err != nil {
		fail("Could not read the stored credentials for this host.")
		return
	}
	defer wipe()

	addr := net.JoinHostPort(host.Address, strconv.Itoa(host.Port))
	d := net.Dialer{Timeout: 15 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		send(serverMsg{Type: "error", Message: "Could not reach " + addr + ".", Retry: true})
		c.Close(websocket.StatusNormalClosure, "error")
		return
	}
	stopClose := context.AfterFunc(ctx, func() { conn.Close() })
	defer stopClose()
	conn.SetDeadline(time.Now().Add(handshakeTimeout))

	cfg := &ssh.ClientConfig{
		User: host.Username, Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if err := s.verifyHostKey(ctx, host, key, send, trustCh); err != nil {
				return err
			}
			conn.SetDeadline(time.Now().Add(handshakeTimeout))
			return nil
		},
	}
	if known, err := s.db.KnownHost(host.ID); err == nil {
		cfg.HostKeyAlgorithms = algorithmsFor(known.KeyType)
	}
	sc, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		fail(describeSSHError(err))
		return
	}
	conn.SetDeadline(time.Time{})
	client := ssh.NewClient(sc, chans, reqs)
	defer client.Close()
	wipe()

	sess, err := client.NewSession()
	if err != nil {
		fail("The server refused to open a session.")
		return
	}
	defer sess.Close()
	cols, rows := size.get()
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sess.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		fail("The server refused a terminal.")
		return
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		fail("Could not attach to the session.")
		return
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		fail("Could not attach to the session.")
		return
	}
	if err := sess.Shell(); err != nil {
		fail("The server would not start a shell.")
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
	m := serverMsg{Type: "hostkey", KeyType: key.Type(), Fingerprint: fp}
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
	case strings.Contains(msg, "host key rejected"):
		return "Host key not trusted. Connection cancelled."
	case strings.Contains(msg, "host key not confirmed"):
		return "Host key was not confirmed in time."
	case strings.Contains(msg, "no common algorithm"):
		return "The server no longer offers the host key type saved for it. Edit the host and reconnect to review its key."
	}
	return fmt.Sprintf("Connection failed: %s", strings.TrimPrefix(msg, "ssh: "))
}
