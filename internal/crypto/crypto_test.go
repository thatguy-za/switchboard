package crypto

import (
	"bytes"
	"testing"
)

func TestPasswordHash(t *testing.T) {
	h := HashPassword("correct horse battery")
	if !VerifyPassword("correct horse battery", h) {
		t.Fatal("valid password rejected")
	}
	if VerifyPassword("wrong", h) {
		t.Fatal("wrong password accepted")
	}
	if h == HashPassword("correct horse battery") {
		t.Fatal("hashes should be salted")
	}
}

func TestVaultWrapAndPasswordChange(t *testing.T) {
	master := RandomBytes(KeySize)
	vk := NewVaultKey()
	salt := RandomBytes(16)
	wrapped := WrapVault(master, DeriveKEK("old password", salt), vk, "u1")
	secret := SealSecret(master, vk, "host-1", []byte("hunter2"))

	got, err := UnwrapVault(master, DeriveKEK("old password", salt), wrapped, "u1")
	if err != nil || !bytes.Equal(got, vk) {
		t.Fatalf("unwrap failed: %v", err)
	}
	if _, err := UnwrapVault(master, DeriveKEK("bad", salt), wrapped, "u1"); err == nil {
		t.Fatal("wrong password unwrapped the vault")
	}
	if _, err := UnwrapVault(master, DeriveKEK("old password", salt), wrapped, "u2"); err == nil {
		t.Fatal("vault unwrapped for a different user")
	}

	// Password change re-wraps the vault key only; the secret stays as it was.
	salt2 := RandomBytes(16)
	rewrapped := WrapVault(master, DeriveKEK("new password", salt2), got, "u1")
	vk2, err := UnwrapVault(master, DeriveKEK("new password", salt2), rewrapped, "u1")
	if err != nil {
		t.Fatal(err)
	}
	pt, err := OpenSecret(master, vk2, "host-1", secret)
	if err != nil || string(pt) != "hunter2" {
		t.Fatalf("secret unreadable after password change: %v", err)
	}
}

func TestSecretBindingAndTamper(t *testing.T) {
	master, vk := RandomBytes(KeySize), NewVaultKey()
	blob := SealSecret(master, vk, "a", []byte("data"))
	if _, err := OpenSecret(master, vk, "b", blob); err == nil {
		t.Fatal("secret opened under another record ID")
	}
	if _, err := OpenSecret(RandomBytes(KeySize), vk, "a", blob); err == nil {
		t.Fatal("secret opened with the wrong master key")
	}
	blob[len(blob)-1] ^= 1
	if _, err := OpenSecret(master, vk, "a", blob); err == nil {
		t.Fatal("tampered secret accepted")
	}
}

func TestRecoveryKey(t *testing.T) {
	master, vk := RandomBytes(KeySize), NewVaultKey()
	raw, text := NewRecoveryKey()
	wrapped := WrapVaultRecovery(master, raw, vk, "u1")

	parsed, err := ParseRecoveryKey(" " + text + " ")
	if err != nil {
		t.Fatal(err)
	}
	got, err := UnwrapVaultRecovery(master, parsed, wrapped, "u1")
	if err != nil || !bytes.Equal(got, vk) {
		t.Fatalf("recovery unwrap failed: %v", err)
	}
	if _, err := ParseRecoveryKey("nonsense"); err == nil {
		t.Fatal("garbage parsed as a recovery key")
	}
}

func TestMasterKeyPersists(t *testing.T) {
	dir := t.TempDir()
	k1, created, err := LoadMasterKey(dir)
	if err != nil || !created {
		t.Fatalf("first load: created=%v err=%v", created, err)
	}
	k2, created, err := LoadMasterKey(dir)
	if err != nil || created || !bytes.Equal(k1, k2) {
		t.Fatalf("second load: created=%v err=%v", created, err)
	}
}
