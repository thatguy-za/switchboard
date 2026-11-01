package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/guac"
	"github.com/thatguy-za/switchboard/internal/store"
)

// What a browser may send to guacd once connected. Everything else, including
// the JavaScript tunnel's own keepalive frames (empty opcode), is dropped.
var clientOpcodes = map[string]bool{
	"key": true, "mouse": true, "touch": true, "size": true, "clipboard": true,
	"ack": true, "blob": true, "end": true, "get": true, "put": true,
	"sync": true, "nop": true, "disconnect": true,
}

// Opcodes that mean a person is actually using the session. Acks and syncs
// are sent automatically while a screen is merely being watched.
var activityOpcodes = map[string]bool{
	"key": true, "mouse": true, "touch": true, "clipboard": true, "blob": true, "put": true, "get": true, "size": true,
}

const (
	maxDisplayW, maxDisplayH = 7680, 4320
	minDisplayW, minDisplayH = 320, 200
	guacHandshakeTimeout     = 20 * time.Second
)

// Guacamole status codes sent to the browser in "error" instructions.
const (
	statusServerError = 512
	statusServerBusy  = 513

	// Not a Guacamole code: the web session behind this connection ended. It is
	// also the WebSocket close code, as for SSH.
	statusWebSessionEnded = 4401
)

var transferDirName = regexp.MustCompile(`^[0-9a-f]{32}$`)

func queryInt(r *http.Request, key string, def, lo, hi int) int {
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil {
		return def
	}
	return max(lo, min(hi, n))
}

func (s *Server) rdpAcquire() bool {
	s.rdpMu.Lock()
	defer s.rdpMu.Unlock()
	if s.rdpActive >= s.cfg.MaxRDP {
		return false
	}
	s.rdpActive++
	return true
}

func (s *Server) rdpRelease() {
	s.rdpMu.Lock()
	s.rdpActive--
	s.rdpMu.Unlock()
}

// prepareTransfers makes sure the drive folder base exists and clears folders left behind by
// an earlier run.
func (s *Server) prepareTransfers() {
	if s.cfg.TransferDir == "" {
		return
	}
	// guacd runs as the same user here, but may not elsewhere, so leave the base open to it.
	if os.MkdirAll(s.cfg.TransferDir, 0o777) == nil {
		os.Chmod(s.cfg.TransferDir, 0o777)
	}
	s.clearTransfers()
}

// clearTransfers removes drive folders left behind by an earlier run.
func (s *Server) clearTransfers() {
	if s.cfg.TransferDir == "" {
		return
	}
	entries, _ := os.ReadDir(s.cfg.TransferDir)
	for _, e := range entries {
		if e.IsDir() && transferDirName.MatchString(e.Name()) {
			os.RemoveAll(filepath.Join(s.cfg.TransferDir, e.Name()))
		}
	}
}

func (s *Server) handleRDP(w http.ResponseWriter, r *http.Request, a *authed) {
	host, err := s.db.GetHost(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	if host.Protocol != "rdp" {
		apiErr(w, http.StatusBadRequest, "wrong_protocol")
		return
	}
	opts := parseRDPOptions(host.RDPOptions)
	width := queryInt(r, "width", 1280, minDisplayW, maxDisplayW)
	height := queryInt(r, "height", 720, minDisplayH, maxDisplayH)
	if opts.fixedSize() {
		width, height = opts.Width, opts.Height
	}
	dpi := queryInt(r, "dpi", 96, 48, 384)

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"guacamole"}})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Connection problems reach the browser as a Guacamole "error" instruction,
	// which its client library already knows how to show.
	fail := func(code int, msg string) {
		c.Write(ctx, websocket.MessageText, []byte(guac.Encode("error", msg, strconv.Itoa(code))))
		c.Close(websocket.StatusNormalClosure, "")
	}

	if !s.rdpAcquire() {
		fail(statusServerBusy, "Too many RDP sessions are open. Close one and try again.")
		return
	}
	defer s.rdpRelease()

	params, cleanup := s.rdpParams(host, opts, a)
	defer cleanup()
	if rh, rp, stopRelay := s.tailnetRelay(ctx, host); rh != "" {
		params["hostname"], params["port"] = rh, rp
		defer stopRelay()
	}

	d := net.Dialer{Timeout: 5 * time.Second}
	gc, err := d.DialContext(ctx, "tcp", s.cfg.Guacd)
	if err != nil {
		fail(statusServerError, "Could not reach the RDP gateway (guacd). Check that its container is running.")
		return
	}
	defer gc.Close()
	context.AfterFunc(ctx, func() { gc.Close() })

	gr := guac.NewReader(gc)
	err = guacHandshake(gc, gr, params, width, height, dpi)
	delete(params, "password")
	if err != nil {
		var ge *guacError
		if errors.As(err, &ge) {
			fail(ge.code, ge.msg)
		} else {
			fail(statusServerError, "The RDP gateway did not accept the connection.")
		}
		return
	}

	// guacd -> browser, in whole instructions.
	go func() {
		defer cancel()
		for {
			raw, err := gr.Batch()
			if err != nil {
				return
			}
			if c.Write(ctx, websocket.MessageText, raw) != nil {
				return
			}
		}
	}()
	// browser -> guacd, filtered.
	policy := clientPolicy{size: !opts.fixedSize(), clipboard: opts.Clipboard, files: opts.Files}
	go func() {
		defer cancel()
		for {
			typ, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			out, echo, active, err := filterClientFrame(data, policy)
			if err != nil {
				c.Close(websocket.StatusPolicyViolation, "bad frame")
				return
			}
			var live bool
			if active {
				_, live = s.sess.get(a.token, s.cfg.SessionTimeout)
			} else {
				live = s.sess.alive(a.token, s.cfg.SessionTimeout)
			}
			if !live {
				// The reason is read by the browser's tunnel as a Guacamole status code.
				c.Close(statusWebSessionEnded, strconv.Itoa(statusWebSessionEnded))
				return
			}
			if len(echo) > 0 {
				c.Write(ctx, websocket.MessageText, echo)
			}
			if len(out) > 0 {
				if _, err := gc.Write(out); err != nil {
					return
				}
			}
		}
	}()
	<-ctx.Done()
}

// clientPolicy is what a host's settings let the browser do.
type clientPolicy struct{ size, clipboard, files bool }

// filterClientFrame keeps only the instructions a browser may send, and says
// whether any of them show real use. The browser's tunnel library also sends
// its own "ping" frames and expects them echoed back; those come back in echo.
func filterClientFrame(data []byte, policy clientPolicy) (out, echo []byte, active bool, err error) {
	for len(data) > 0 {
		ins, n, perr := guac.Parse(data)
		if perr != nil {
			return nil, nil, false, perr
		}
		raw := data[:n]
		data = data[n:]
		if ins.Opcode == "" {
			if len(ins.Args) > 0 && ins.Args[0] == "ping" {
				echo = append(echo, raw...)
			}
			continue
		}
		if !clientOpcodes[ins.Opcode] {
			continue
		}
		if ins.Opcode == "size" && (!policy.size || !validSize(ins.Args)) {
			continue
		}
		if ins.Opcode == "clipboard" && !policy.clipboard || (ins.Opcode == "get" || ins.Opcode == "put") && !policy.files {
			continue
		}
		out = append(out, raw...)
		active = active || activityOpcodes[ins.Opcode]
	}
	return out, echo, active, nil
}

func validSize(args []string) bool {
	if len(args) < 2 {
		return false
	}
	w, err1 := strconv.Atoi(args[0])
	h, err2 := strconv.Atoi(args[1])
	return err1 == nil && err2 == nil && w >= minDisplayW && w <= maxDisplayW && h >= minDisplayH && h <= maxDisplayH
}

// rdpParams builds the guacd connection settings, including the decrypted
// password. The returned function removes the session's drive folder.
func (s *Server) rdpParams(h *store.Host, o rdpOptions, a *authed) (map[string]string, func()) {
	user, domain := h.Username, ""
	if i := strings.Index(user, `\`); i > 0 {
		domain, user = user[:i], user[i+1:]
	}
	p := map[string]string{
		"hostname": h.Address, "port": strconv.Itoa(h.Port),
		"username": user, "domain": domain,
		"security":      h.RDPSecurity,
		"ignore-cert":   strconv.FormatBool(h.RDPIgnoreCert),
		"resize-method": "display-update",
		"color-depth":   strconv.Itoa(o.Depth), "enable-wallpaper": strconv.FormatBool(o.Wallpaper),
		"enable-font-smoothing": strconv.FormatBool(o.Smoothing),
		"disable-audio":         strconv.FormatBool(!o.Audio), "enable-audio-input": "false",
		"client-name": "Switchboard", "server-layout": o.Layout,
		"enable-drive": "false",
		"disable-copy": strconv.FormatBool(!o.Clipboard), "disable-paste": strconv.FormatBool(!o.Clipboard),
	}
	if o.fixedSize() {
		p["resize-method"] = ""
	}
	if h.PasswordBlob != nil {
		if pw, err := crypto.OpenSecret(s.master, a.sess.vk, h.ID, h.PasswordBlob); err == nil {
			p["password"] = string(pw)
			crypto.Zero(pw)
		}
	}
	cleanup := func() {}
	if s.cfg.TransferDir != "" && o.Files {
		dir := filepath.Join(s.cfg.TransferDir, newID())
		// guacd runs as a different user, so the folder must be open to it.
		if os.Mkdir(dir, 0o777) == nil && os.Chmod(dir, 0o777) == nil {
			p["enable-drive"], p["drive-path"], p["create-drive-path"], p["drive-name"] = "true", dir, "true", "Switchboard"
			cleanup = func() { os.RemoveAll(dir) }
		}
	}
	return p, cleanup
}

type guacError struct {
	code int
	msg  string
}

func (e *guacError) Error() string { return e.msg }

// guacHandshake runs the select/args/connect exchange with guacd.
func guacHandshake(conn net.Conn, rd *guac.Reader, params map[string]string, width, height, dpi int) error {
	conn.SetDeadline(time.Now().Add(guacHandshakeTimeout))
	defer conn.SetDeadline(time.Time{})
	send := func(op string, args ...string) error {
		_, err := io.WriteString(conn, guac.Encode(op, args...))
		return err
	}
	if err := send("select", "rdp"); err != nil {
		return err
	}
	ins, err := rd.Next()
	if err != nil {
		return err
	}
	if ins.Opcode != "args" {
		return errors.New("guacd did not offer connection arguments")
	}
	for _, step := range []struct {
		op   string
		args []string
	}{
		{"size", []string{strconv.Itoa(width), strconv.Itoa(height), strconv.Itoa(dpi)}},
		{"audio", []string{"audio/L16", "audio/L8"}},
		{"video", nil},
		{"image", []string{"image/png", "image/jpeg", "image/webp"}},
	} {
		if err := send(step.op, step.args...); err != nil {
			return err
		}
	}
	values := make([]string, len(ins.Args))
	for i, name := range ins.Args {
		if strings.HasPrefix(name, "VERSION_") {
			values[i] = name
		} else {
			values[i] = params[name]
		}
	}
	if err := send("connect", values...); err != nil {
		return err
	}
	ins, err = rd.Next()
	if err != nil {
		return err
	}
	switch ins.Opcode {
	case "ready":
		return nil
	case "error":
		ge := &guacError{code: statusServerError, msg: "The RDP gateway refused the connection."}
		if len(ins.Args) > 0 {
			ge.msg = ins.Args[0]
		}
		if len(ins.Args) > 1 {
			if n, err := strconv.Atoi(ins.Args[1]); err == nil {
				ge.code = n
			}
		}
		return ge
	}
	return errors.New("unexpected reply from guacd")
}
