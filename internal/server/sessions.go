package server

import (
	"encoding/base64"
	"sync"
	"time"

	"github.com/thatguy-za/webterm/internal/crypto"
)

const pendingTTL = 5 * time.Minute

// session holds the unwrapped vault key in memory only; it is zeroed when the
// session ends.
type session struct {
	userID string
	vk     []byte
	last   time.Time
}

// pending is a password-verified login waiting for its second factor.
type pending struct {
	userID  string
	vk      []byte
	expires time.Time
}

type sessions struct {
	mu sync.Mutex
	s  map[string]*session
	p  map[string]*pending
}

func newSessions() *sessions {
	return &sessions{s: map[string]*session{}, p: map[string]*pending{}}
}

func newToken() string { return base64.RawURLEncoding.EncodeToString(crypto.RandomBytes(32)) }

func (x *sessions) create(userID string, vk []byte) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	t := newToken()
	x.s[t] = &session{userID: userID, vk: vk, last: time.Now()}
	return t
}

// get returns the live session for token and refreshes its idle timer.
func (x *sessions) get(token string, timeout time.Duration) (*session, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	se, ok := x.s[token]
	if !ok {
		return nil, false
	}
	if time.Since(se.last) > timeout {
		x.dropLocked(token)
		return nil, false
	}
	se.last = time.Now()
	return se, true
}

// alive reports whether a session is still valid without counting as activity.
func (x *sessions) alive(token string, timeout time.Duration) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	se, ok := x.s[token]
	return ok && time.Since(se.last) <= timeout
}

func (x *sessions) dropLocked(token string) {
	if se, ok := x.s[token]; ok {
		crypto.Zero(se.vk)
		delete(x.s, token)
	}
}

func (x *sessions) remove(token string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.dropLocked(token)
}

// removeUser ends every session and pending login for a user. If keep is
// non-empty, that session token survives.
func (x *sessions) removeUser(userID, keep string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	for t, se := range x.s {
		if se.userID == userID && t != keep {
			x.dropLocked(t)
		}
	}
	for t, p := range x.p {
		if p.userID == userID {
			crypto.Zero(p.vk)
			delete(x.p, t)
		}
	}
}

func (x *sessions) addPending(userID string, vk []byte) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	t := newToken()
	x.p[t] = &pending{userID: userID, vk: vk, expires: time.Now().Add(pendingTTL)}
	return t
}

func (x *sessions) pending(token string) (*pending, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	p, ok := x.p[token]
	if !ok || time.Now().After(p.expires) {
		return nil, false
	}
	return p, true
}

// promote turns a pending login into a full session.
func (x *sessions) promote(pendingToken string) (string, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	p, ok := x.p[pendingToken]
	if !ok || time.Now().After(p.expires) {
		return "", false
	}
	delete(x.p, pendingToken)
	t := newToken()
	x.s[t] = &session{userID: p.userID, vk: p.vk, last: time.Now()}
	return t, true
}

func (x *sessions) dropPending(token string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if p, ok := x.p[token]; ok {
		crypto.Zero(p.vk)
		delete(x.p, token)
	}
}

func (x *sessions) sweep(timeout time.Duration) {
	x.mu.Lock()
	defer x.mu.Unlock()
	for t, se := range x.s {
		if time.Since(se.last) > timeout {
			x.dropLocked(t)
		}
	}
	for t, p := range x.p {
		if time.Now().After(p.expires) {
			crypto.Zero(p.vk)
			delete(x.p, t)
		}
	}
}
