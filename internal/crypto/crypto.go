// Package crypto holds the key hierarchy: master key -> vault key -> records.
// Primitives come from golang.org/x/crypto (Argon2id, XChaCha20-Poly1305).
package crypto

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
)

const KeySize = 32

const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 2
)

var ErrDecrypt = errors.New("crypto: decryption failed")

func RandomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func Zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// Seal encrypts plaintext under key; aad binds the ciphertext to its context.
// The output is nonce || ciphertext.
func Seal(key, plaintext []byte, aad string) []byte {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		panic(err)
	}
	nonce := RandomBytes(aead.NonceSize())
	return aead.Seal(nonce, nonce, plaintext, []byte(aad))
}

func Open(key, blob []byte, aad string) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	if len(blob) < aead.NonceSize()+aead.Overhead() {
		return nil, ErrDecrypt
	}
	pt, err := aead.Open(nil, blob[:aead.NonceSize()], blob[aead.NonceSize():], []byte(aad))
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}

func HashPassword(password string) string {
	salt := RandomBytes(16)
	h := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, 32)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(h))
}

func VerifyPassword(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[4])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[5])
	if err1 != nil || err2 != nil {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// DeriveKEK turns a password into the key that wraps the vault key.
// The salt is separate from the one inside the password hash.
func DeriveKEK(password string, salt []byte) []byte {
	return argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, KeySize)
}

func NewVaultKey() []byte { return RandomBytes(KeySize) }

// WrapVault seals the vault key under the user's KEK, then under the master key.
func WrapVault(master, kek, vk []byte, userID string) []byte {
	return Seal(master, Seal(kek, vk, "vault:"+userID), "master:vault:"+userID)
}

func UnwrapVault(master, kek, blob []byte, userID string) ([]byte, error) {
	inner, err := Open(master, blob, "master:vault:"+userID)
	if err != nil {
		return nil, err
	}
	return Open(kek, inner, "vault:"+userID)
}

func WrapVaultRecovery(master, recovery, vk []byte, userID string) []byte {
	return Seal(master, Seal(recovery, vk, "recovery:"+userID), "master:recovery:"+userID)
}

func UnwrapVaultRecovery(master, recovery, blob []byte, userID string) ([]byte, error) {
	inner, err := Open(master, blob, "master:recovery:"+userID)
	if err != nil {
		return nil, err
	}
	return Open(recovery, inner, "recovery:"+userID)
}

// SealSecret encrypts a stored secret (private key, host password) with the
// vault key, bound to the record ID, then wraps it with the master key.
func SealSecret(master, vk []byte, recordID string, plaintext []byte) []byte {
	return Seal(master, Seal(vk, plaintext, "record:"+recordID), "master:record:"+recordID)
}

func OpenSecret(master, vk []byte, recordID string, blob []byte) ([]byte, error) {
	inner, err := Open(master, blob, "master:record:"+recordID)
	if err != nil {
		return nil, err
	}
	return Open(vk, inner, "record:"+recordID)
}

// SealMaster / OpenMaster protect server-side values (TOTP secrets) that are
// not tied to a user's vault.
func SealMaster(master, plaintext []byte, purpose, id string) []byte {
	return Seal(master, plaintext, "master:"+purpose+":"+id)
}

func OpenMaster(master, blob []byte, purpose, id string) ([]byte, error) {
	return Open(master, blob, "master:"+purpose+":"+id)
}

var recoveryEnc = base32.StdEncoding.WithPadding(base32.NoPadding)

func NewRecoveryKey() (raw []byte, text string) {
	raw = RandomBytes(KeySize)
	s := recoveryEnc.EncodeToString(raw)
	var groups []string
	for i := 0; i < len(s); i += 4 {
		groups = append(groups, s[i:min(i+4, len(s))])
	}
	return raw, strings.Join(groups, "-")
}

func ParseRecoveryKey(text string) ([]byte, error) {
	s := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(text)))
	raw, err := recoveryEnc.DecodeString(s)
	if err != nil || len(raw) != KeySize {
		return nil, errors.New("invalid recovery key")
	}
	return raw, nil
}

// LoadMasterKey reads the instance master key from dir, generating it on the
// first run. created reports whether this call generated it.
func LoadMasterKey(dir string) (key []byte, created bool, err error) {
	path := filepath.Join(dir, "master.key")
	if data, err := os.ReadFile(path); err == nil {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(key) != KeySize {
			return nil, false, fmt.Errorf("%s is not a valid master key", path)
		}
		return key, false, nil
	} else if !os.IsNotExist(err) {
		return nil, false, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, false, err
	}
	key = RandomBytes(KeySize)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(key) + "\n"); err != nil {
		return nil, false, err
	}
	return key, true, f.Sync()
}
