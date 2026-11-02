package server

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/thatguy-za/webterm/internal/crypto"
	"github.com/thatguy-za/webterm/internal/store"
)

const (
	maxCommands     = 100
	maxCommandName  = 60
	maxCommandBytes = 4000
)

type commandView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Body string `json:"body"`
}

type commandInput struct {
	Name string `json:"name"`
	Body string `json:"body"`
}

// clean trims the name and checks both fields.
func (in *commandInput) clean() bool {
	in.Name = strings.TrimSpace(in.Name)
	in.Body = strings.ReplaceAll(in.Body, "\r\n", "\n")
	return in.Name != "" && utf8.RuneCountInString(in.Name) <= maxCommandName &&
		strings.TrimSpace(in.Body) != "" && len(in.Body) <= maxCommandBytes &&
		!strings.ContainsRune(in.Body, 0) && utf8.ValidString(in.Body)
}

// sealCommand encrypts the text with the user's vault key, bound to the command id.
func (s *Server) sealCommand(a *authed, id, body string) []byte {
	return crypto.SealSecret(s.master, a.sess.vk, "command:"+id, []byte(body))
}

func (s *Server) handleListCommands(w http.ResponseWriter, _ *http.Request, a *authed) {
	cmds, err := s.db.ListCommands(a.user.ID)
	if err != nil {
		serverErr(w, err)
		return
	}
	out := make([]commandView, 0, len(cmds))
	for _, c := range cmds {
		body, err := crypto.OpenSecret(s.master, a.sess.vk, "command:"+c.ID, c.Blob)
		if err != nil {
			continue // unreadable: skip it rather than fail the whole list
		}
		out = append(out, commandView{c.ID, c.Name, string(body)})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleCreateCommand(w http.ResponseWriter, r *http.Request, a *authed) {
	var in commandInput
	if !decode(w, r, &in) || !s.requireClean(w, &in) {
		return
	}
	if n, _ := s.db.CountCommands(a.user.ID); n >= maxCommands {
		apiErr(w, http.StatusBadRequest, "too_many_commands")
		return
	}
	id := newID()
	if err := s.db.CreateCommand(&store.Command{ID: id, UserID: a.user.ID, Name: in.Name, Blob: s.sealCommand(a, id, in.Body)}); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, commandView{id, in.Name, in.Body})
}

func (s *Server) requireClean(w http.ResponseWriter, in *commandInput) bool {
	if !in.clean() {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return false
	}
	return true
}

func (s *Server) handleUpdateCommand(w http.ResponseWriter, r *http.Request, a *authed) {
	var in commandInput
	if !decode(w, r, &in) || !s.requireClean(w, &in) {
		return
	}
	id := r.PathValue("id")
	if err := s.db.UpdateCommand(&store.Command{ID: id, UserID: a.user.ID, Name: in.Name, Blob: s.sealCommand(a, id, in.Body)}); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			apiErr(w, http.StatusNotFound, "not_found")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, commandView{id, in.Name, in.Body})
}

func (s *Server) handleDeleteCommand(w http.ResponseWriter, r *http.Request, a *authed) {
	if err := s.db.DeleteCommand(r.PathValue("id"), a.user.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			apiErr(w, http.StatusNotFound, "not_found")
			return
		}
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleOrderCommands(w http.ResponseWriter, r *http.Request, a *authed) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if !decode(w, r, &in) || len(in.IDs) > maxCommands {
		apiErr(w, http.StatusBadRequest, "bad_request")
		return
	}
	if err := s.db.ReorderCommands(a.user.ID, in.IDs); err != nil {
		serverErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
