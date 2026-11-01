package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"net/http"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/thatguy-za/switchboard/internal/crypto"
	"github.com/thatguy-za/switchboard/internal/store"
)

type identityView struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Comment     string   `json:"comment"`
	Kind        string   `json:"kind"`
	PublicKey   string   `json:"public_key"`
	Fingerprint string   `json:"fingerprint"`
	CreatedAt   int64    `json:"created_at"`
	Hosts       []string `json:"hosts"`
}

func (s *Server) handleListIdentities(w http.ResponseWriter, _ *http.Request, a *authed) {
	ids, err := s.db.ListIdentities(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	hosts, err := s.db.ListHosts(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	used := map[string][]string{}
	for _, h := range hosts {
		if h.IdentityID != "" {
			used[h.IdentityID] = append(used[h.IdentityID], h.Name)
		}
	}
	out := make([]identityView, 0, len(ids))
	for _, i := range ids {
		hs := used[i.ID]
		if hs == nil {
			hs = []string{}
		}
		out = append(out, identityView{i.ID, i.Name, i.Comment, i.Kind, i.PublicKey, i.Fingerprint, i.CreatedAt, hs})
	}
	writeJSON(w, http.StatusOK, out)
}

// storeIdentity derives the public half from an OpenSSH-format private key,
// seals the private key with the vault key and saves the record.
func (s *Server) storeIdentity(a *authed, name, comment string, signer ssh.Signer, privatePEM []byte) (*store.Identity, error) {
	kind := "ed25519"
	if signer.PublicKey().Type() == "ssh-rsa" {
		kind = "rsa"
	}
	pub := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if comment != "" {
		pub += " " + comment
	}
	i := &store.Identity{
		ID: newID(), UserID: a.user.ID, Name: name, Comment: comment, Kind: kind, PublicKey: pub,
		Fingerprint: ssh.FingerprintSHA256(signer.PublicKey()),
	}
	i.PrivateBlob = crypto.SealSecret(s.master, a.sess.vk, i.ID, privatePEM)
	return i, s.db.CreateIdentity(i)
}

func cleanIdentityFields(name, comment string) (string, string, bool) {
	name, comment = strings.TrimSpace(name), strings.TrimSpace(comment)
	ok := name != "" && len(name) <= 80 && len(comment) <= 120 && !strings.ContainsAny(comment, "\r\n")
	return name, comment, ok
}

func (s *Server) handleGenerateIdentity(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Name    string `json:"name"`
		Comment string `json:"comment"`
		Kind    string `json:"kind"`
	}
	if !decode(w, r, &in) {
		return
	}
	name, comment, ok := cleanIdentityFields(in.Name, in.Comment)
	if !ok || (in.Kind != "ed25519" && in.Kind != "rsa") {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	var priv any
	if in.Kind == "rsa" {
		k, err := rsa.GenerateKey(rand.Reader, 4096)
		if err != nil {
			serverErr(w, err)
			return
		}
		priv = k
	} else {
		_, k, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			serverErr(w, err)
			return
		}
		priv = k
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		serverErr(w, err)
		return
	}
	block, err := ssh.MarshalPrivateKey(priv, comment)
	if err != nil {
		serverErr(w, err)
		return
	}
	i, err := s.storeIdentity(a, name, comment, signer, pem.EncodeToMemory(block))
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identityView{i.ID, i.Name, i.Comment, i.Kind, i.PublicKey, i.Fingerprint, i.CreatedAt, []string{}})
}

func (s *Server) handleImportIdentity(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		Name       string `json:"name"`
		PrivateKey string `json:"private_key"`
		Passphrase string `json:"passphrase"`
	}
	if !decode(w, r, &in) {
		return
	}
	var raw any
	var err error
	if in.Passphrase != "" {
		raw, err = ssh.ParseRawPrivateKeyWithPassphrase([]byte(in.PrivateKey), []byte(in.Passphrase))
	} else {
		raw, err = ssh.ParseRawPrivateKey([]byte(in.PrivateKey))
	}
	var missing *ssh.PassphraseMissingError
	if errors.As(err, &missing) {
		apiErr(w, http.StatusBadRequest, "passphrase_required")
		return
	}
	if err != nil {
		apiErr(w, http.StatusBadRequest, "invalid_key")
		return
	}
	signer, err := ssh.NewSignerFromKey(raw)
	if err != nil || (signer.PublicKey().Type() != "ssh-rsa" && signer.PublicKey().Type() != "ssh-ed25519") {
		apiErr(w, http.StatusBadRequest, "unsupported_key")
		return
	}
	name, _, ok := cleanIdentityFields(in.Name, "")
	if !ok {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	// Store unprotected; the vault already encrypts it. ssh.MarshalPrivateKey
	// wants a pointer for ed25519 keys parsed as values.
	if k, isVal := raw.(ed25519.PrivateKey); isVal {
		raw = &k
	}
	block, err := ssh.MarshalPrivateKey(raw, "")
	if err != nil {
		serverErr(w, err)
		return
	}
	i, err := s.storeIdentity(a, name, "", signer, pem.EncodeToMemory(block))
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, identityView{i.ID, i.Name, i.Comment, i.Kind, i.PublicKey, i.Fingerprint, i.CreatedAt, []string{}})
}

func (s *Server) handleDeleteIdentity(w http.ResponseWriter, r *http.Request, a *authed) {
	if err := s.db.DeleteIdentity(r.PathValue("id"), a.user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			apiErr(w, http.StatusNotFound, "not_found")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleExportIdentity is the one deliberate path that returns a private key
// to the browser; it needs the account password again.
func (s *Server) handleExportIdentity(w http.ResponseWriter, r *http.Request, a *authed) {
	i, err := s.db.GetIdentity(r.PathValue("id"), a.user.ID)
	if err != nil {
		apiErr(w, http.StatusNotFound, "not_found")
		return
	}
	if !s.confirmPassword(w, r, a) {
		return
	}
	pemBytes, err := crypto.OpenSecret(s.master, a.sess.vk, i.ID, i.PrivateBlob)
	if err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"private_key": string(pemBytes)})
}
