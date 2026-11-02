package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/thatguy-za/webterm/internal/store"
)

func commandList(t *testing.T, u *client) []map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", u.url+"/api/commands", nil)
	resp, err := u.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out []map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return out
}

func TestSavedCommands(t *testing.T) {
	srv, ts, u := newBridgeEnv(t)
	code, a := u.do("POST", "/api/commands", map[string]string{"name": " Restart nginx ", "body": "sudo systemctl restart nginx\r\n"})
	if code != 200 || a["name"] != "Restart nginx" || a["body"] != "sudo systemctl restart nginx\n" {
		t.Fatalf("create: %d %v", code, a)
	}
	_, b := u.do("POST", "/api/commands", map[string]string{"name": "Disk usage", "body": "df -h"})
	if got := commandList(t, u); len(got) != 2 || got[0]["name"] != "Restart nginx" || got[1]["body"] != "df -h" {
		t.Fatalf("list: %v", got)
	}

	// The text is sealed on disk; only the name is readable.
	rows, _ := srv.db.ListCommands(ownerID(t, srv))
	for _, c := range rows {
		if bytes.Contains(c.Blob, []byte("systemctl")) || bytes.Contains(c.Blob, []byte("df -h")) {
			t.Fatal("command text is stored in the clear")
		}
	}

	// Edit, then reorder.
	if code, out := u.do("PUT", "/api/commands/"+a["id"].(string), map[string]string{"name": "Restart web", "body": "sudo systemctl restart nginx php-fpm"}); code != 200 || out["name"] != "Restart web" {
		t.Fatalf("update: %d %v", code, out)
	}
	if code, _ := u.do("POST", "/api/commands/order", map[string]any{"ids": []string{b["id"].(string), a["id"].(string)}}); code != 200 {
		t.Fatalf("order: %d", code)
	}
	if got := commandList(t, u); got[0]["name"] != "Disk usage" || got[1]["body"] != "sudo systemctl restart nginx php-fpm" {
		t.Fatalf("after reorder: %v", got)
	}

	// Other users can't see, change or delete them.
	if code, _ := u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatalf("add member: %d", code)
	}
	m := newClient(t, ts.URL)
	m.do("POST", "/api/login", credentials{"kim", "temporary password"})
	m.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "a different long password"})
	if got := commandList(t, m); len(got) != 0 {
		t.Fatalf("member sees the owner's commands: %v", got)
	}
	if code, _ := m.do("PUT", "/api/commands/"+a["id"].(string), map[string]string{"name": "x", "body": "x"}); code != 404 {
		t.Fatalf("member edited the owner's command: %d", code)
	}
	if code, _ := m.do("DELETE", "/api/commands/"+a["id"].(string), nil); code != 404 {
		t.Fatalf("member deleted the owner's command: %d", code)
	}
	if code, _ := newClient(t, ts.URL).do("GET", "/api/commands", nil); code != 401 {
		t.Fatalf("anonymous access: %d", code)
	}

	if code, _ := u.do("DELETE", "/api/commands/"+a["id"].(string), nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	if got := commandList(t, u); len(got) != 1 {
		t.Fatalf("after delete: %v", got)
	}
}

func TestSavedCommandValidation(t *testing.T) {
	_, _, u := newBridgeEnv(t)
	for name, in := range map[string]map[string]string{
		"empty name":  {"name": "  ", "body": "ls"},
		"empty body":  {"name": "x", "body": " \n"},
		"long name":   {"name": strings.Repeat("a", maxCommandName+1), "body": "ls"},
		"long body":   {"name": "x", "body": strings.Repeat("a", maxCommandBytes+1)},
		"nul in body": {"name": "x", "body": "ls\x00"},
	} {
		if code, _ := u.do("POST", "/api/commands", in); code != 400 {
			t.Errorf("%s accepted: %d", name, code)
		}
	}
	for i := 0; i < maxCommands; i++ {
		if code, _ := u.do("POST", "/api/commands", map[string]string{"name": "c", "body": "ls"}); code != 200 {
			t.Fatalf("command %d: %d", i, code)
		}
	}
	if code, out := u.do("POST", "/api/commands", map[string]string{"name": "one too many", "body": "ls"}); code != 400 || out["error"] != "too_many_commands" {
		t.Fatalf("limit: %d %v", code, out)
	}
}

func TestDeletingAUserRemovesTheirCommands(t *testing.T) {
	srv, _, u := newBridgeEnv(t)
	u.do("POST", "/api/commands", map[string]string{"name": "x", "body": "ls"})
	if code, _ := u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatal("add member")
	}
	users, _ := srv.db.ListUsers()
	var kim string
	for _, x := range users {
		if x.Username == "kim" {
			kim = x.ID
		}
	}
	srv.db.CreateCommand(&store.Command{ID: "c1", UserID: kim, Name: "k", Blob: []byte("x")})
	if code, _ := u.do("DELETE", "/api/admin/users/"+kim, nil); code != 200 {
		t.Fatal("delete user")
	}
	if n, _ := srv.db.CountCommands(kim); n != 0 {
		t.Fatalf("%d commands left behind", n)
	}
	if n, _ := srv.db.CountCommands(ownerID(t, srv)); n != 1 {
		t.Fatalf("the owner lost commands: %d", n)
	}
}
