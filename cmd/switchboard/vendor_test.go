package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The vendored libraries must match SHA256SUMS, and every file in the folder
// must be listed, so changing or adding third-party code is always deliberate.
func TestVendoredChecksums(t *testing.T) {
	dir := filepath.Join("web", "vendor")
	raw, err := os.ReadFile(filepath.Join(dir, "SHA256SUMS"))
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			t.Fatalf("bad line in SHA256SUMS: %q", line)
		}
		data, err := os.ReadFile(filepath.Join(dir, f[1]))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != f[0] {
			t.Errorf("%s changed: update SHA256SUMS and README.md if that was intended", f[1])
		}
		listed[f[1]] = true
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if n := e.Name(); n != "SHA256SUMS" && n != "README.md" && !listed[n] {
			t.Errorf("%s is not in SHA256SUMS", n)
		}
	}
}
