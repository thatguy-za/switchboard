package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

const pushTimeout = 45 * time.Second

// pushScript runs on the remote host via "sh -s". The key sits in a quoted
// here-document, so nothing in it is interpreted by the shell.
const pushScript = `set -e
umask 077
read -r KEY <<'SWITCHBOARD_KEY_EOF'
__KEY__
SWITCHBOARD_KEY_EOF
B64=$(printf '%s' "$KEY" | cut -d' ' -f2)
[ -n "$B64" ]
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
F="$HOME/.ssh/authorized_keys"
touch "$F"
chmod 600 "$F"
if grep -qF -- "$B64" "$F"; then
	echo PRESENT
	exit 0
fi
if [ -s "$F" ] && [ "$(tail -c 1 "$F" | wc -l)" -eq 0 ]; then
	echo >> "$F"
fi
printf '%s\n' "$KEY" >> "$F"
echo ADDED
`

type pushResult struct {
	HostID  string `json:"host_id"`
	Result  string `json:"result"` // "added", "present" or "error"
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request, a *authed) {
	ident, err := s.db.GetIdentity(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	var in struct {
		HostID string `json:"host_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	host, err := s.db.GetHost(in.HostID, a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), pushTimeout)
	defer cancel()
	res := s.pushKey(ctx, a, ident, host)
	res.HostID = host.ID
	writeJSON(w, http.StatusOK, res)
}

func pushError(code, msg string) pushResult {
	return pushResult{Result: "error", Code: code, Message: msg}
}

// pushKey installs an identity's public key on a host, checks that signing in
// with it works, and only then switches the host over to it.
func (s *Server) pushKey(ctx context.Context, a *authed, ident *store.Identity, host *store.Host) pushResult {
	if host.Protocol != "ssh" {
		return pushError("unsupported", "Keys can only be pushed to SSH hosts.")
	}
	hops, _, err := s.chainFor(host, a)
	if err != nil {
		return pushError("error", "This host's jump list is no longer valid.")
	}
	line := strings.TrimSpace(ident.PublicKey)
	if line == "" || strings.ContainsAny(line, "\r\n") || strings.Contains(line, "SWITCHBOARD_KEY_EOF") {
		return pushError("error", "This identity's public key can't be pushed.")
	}

	// Connect with the host's current credentials. Host keys are never prompted
	// for here: an untrusted key has to be reviewed in a terminal first.
	client, closeAll, he := s.connectChain(ctx, hops, a, func(serverMsg) {}, nil, nil)
	if he != nil {
		return connectFailure(he)
	}
	stop := context.AfterFunc(ctx, closeAll)
	defer stop()
	defer closeAll()

	sess, err := client.NewSession()
	if err != nil {
		return pushError("error", "The server refused to open a session.")
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(strings.Replace(pushScript, "__KEY__", line, 1))
	out, err := sess.CombinedOutput("sh -s")
	text := strings.TrimSpace(string(out))
	var result string
	switch {
	case err == nil && strings.HasSuffix(text, "ADDED"):
		result = "added"
	case err == nil && strings.HasSuffix(text, "PRESENT"):
		result = "present"
	default:
		return classifyScriptFailure(text, err)
	}

	if msg := s.verifyKeyLogin(ctx, a, ident, hops); msg != "" {
		return pushError("verify_failed", msg)
	}
	if err := s.db.SetHostIdentity(host.ID, a.user.ID, ident.ID); err != nil {
		return pushError("error", "The key works, but this host could not be updated.")
	}
	s.db.RecordDeployment(ident.ID, host.ID)
	return pushResult{Result: result}
}

// verifyKeyLogin signs in again offering only the new key. It returns a
// message when that fails, and "" when it works.
func (s *Server) verifyKeyLogin(ctx context.Context, a *authed, ident *store.Identity, hops []*store.Host) string {
	pemBytes, err := crypto.OpenSecret(s.master, a.sess.vk, ident.ID, ident.PrivateBlob)
	if err != nil {
		return "The identity's private key could not be read."
	}
	signer, err := ssh.ParsePrivateKey(pemBytes)
	crypto.Zero(pemBytes)
	if err != nil {
		return "The identity's private key could not be read."
	}
	client, closeAll, he := s.connectChain(ctx, hops, a, func(serverMsg) {}, nil, []ssh.AuthMethod{ssh.PublicKeys(signer)})
	if he != nil {
		return "The key was added, but signing in with it failed. The server may have public key login turned off, or its permissions on your home directory may be too open. This host still uses its old credentials."
	}
	defer closeAll()
	if sess, err := client.NewSession(); err == nil {
		sess.Close()
	}
	return ""
}

func connectFailure(he *hopError) pushResult {
	e := he.err.Error()
	code := "error"
	switch {
	case he.unreached:
		code = "unreachable"
	case strings.Contains(e, errHostKeyUnknown.Error()):
		code = "hostkey_unknown"
	case strings.Contains(e, errHostKeyChanged.Error()):
		code = "hostkey_changed"
	case strings.Contains(e, "unable to authenticate"):
		code = "auth_failed"
	}
	return pushError(code, he.message())
}

// classifyScriptFailure turns the remote script's output into a clear result.
func classifyScriptFailure(out string, err error) pushResult {
	low := strings.ToLower(out)
	var exit *ssh.ExitError
	switch {
	case strings.Contains(low, "permission denied"), strings.Contains(low, "read-only file system"),
		strings.Contains(low, "operation not permitted"), strings.Contains(low, "no space left"):
		return pushError("permission_denied", "Switchboard could not write ~/.ssh/authorized_keys on this host. Check its permissions and free disk space.")
	case strings.Contains(low, "not found"), strings.Contains(low, "not recognized"),
		errors.As(err, &exit) && exit.ExitStatus() == 127:
		return pushError("unsupported", "This host doesn't look like it runs a POSIX shell, so keys can't be pushed to it automatically.")
	}
	if len(out) > 200 {
		out = out[len(out)-200:]
	}
	if out == "" {
		return pushError("error", "The key could not be added.")
	}
	return pushError("error", "The key could not be added: "+out)
}
