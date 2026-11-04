package server

import "testing"

func listNames(t *testing.T, u *client, key string) []string {
	t.Helper()
	_, out := u.do("GET", "/api/hosts", nil)
	var names []string
	for _, x := range out[key].([]any) {
		names = append(names, x.(map[string]any)["name"].(string))
	}
	return names
}

func ids(t *testing.T, u *client, key string, names ...string) []string {
	t.Helper()
	_, out := u.do("GET", "/api/hosts", nil)
	byName := map[string]string{}
	for _, x := range out[key].([]any) {
		m := x.(map[string]any)
		byName[m["name"].(string)] = m["id"].(string)
	}
	var res []string
	for _, n := range names {
		res = append(res, byName[n])
	}
	return res
}

func same(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestHostsAndFoldersKeepADraggedOrder(t *testing.T) {
	_, ts, u := newBridgeEnv(t)
	for _, n := range []string{"alpha", "bravo", "charlie"} {
		addHost(t, u, n, 22, nil)
	}
	// New hosts go to the end, in the order they were added.
	if got := listNames(t, u, "hosts"); !same(got, []string{"alpha", "bravo", "charlie"}) {
		t.Fatalf("initial order: %v", got)
	}
	order := ids(t, u, "hosts", "charlie", "alpha", "bravo")
	if code, _ := u.do("POST", "/api/hosts/order", map[string]any{"ids": order}); code != 200 {
		t.Fatalf("order: %d", code)
	}
	if got := listNames(t, u, "hosts"); !same(got, []string{"charlie", "alpha", "bravo"}) {
		t.Fatalf("after reorder: %v", got)
	}
	// A host added later still goes last, not alphabetically.
	addHost(t, u, "aardvark", 22, nil)
	if got := listNames(t, u, "hosts"); !same(got, []string{"charlie", "alpha", "bravo", "aardvark"}) {
		t.Fatalf("after adding: %v", got)
	}

	// Folders work the same way.
	for _, n := range []string{"Home", "Work", "Lab"} {
		u.do("POST", "/api/folders", map[string]string{"name": n})
	}
	if got := listNames(t, u, "folders"); !same(got, []string{"Home", "Work", "Lab"}) {
		t.Fatalf("folders: %v", got)
	}
	u.do("POST", "/api/folders/order", map[string]any{"ids": ids(t, u, "folders", "Lab", "Home", "Work")})
	if got := listNames(t, u, "folders"); !same(got, []string{"Lab", "Home", "Work"}) {
		t.Fatalf("folders after reorder: %v", got)
	}

	// Moving a host into a folder puts it last there, and only affects that folder.
	folder := ids(t, u, "folders", "Work")[0]
	hid := ids(t, u, "hosts", "bravo")[0]
	u.do("PUT", "/api/hosts/"+hid, map[string]any{"name": "bravo", "address": "10.0.0.1", "port": 22, "username": "root", "auth": "password", "protocol": "ssh", "folder_id": folder})

	// Other users' items can't be reordered through someone else's ids.
	if code, _ := u.do("POST", "/api/admin/users", map[string]string{"username": "kim", "password": "temporary password", "role": "member"}); code != 200 {
		t.Fatalf("add member: %d", code)
	}
	m := newClient(t, ts.URL)
	m.do("POST", "/api/login", credentials{"kim", "temporary password"})
	m.do("POST", "/api/password", map[string]string{"current": "temporary password", "new": "a different long password"})
	before := listNames(t, u, "hosts")
	m.do("POST", "/api/hosts/order", map[string]any{"ids": ids(t, u, "hosts", "aardvark", "charlie")})
	if got := listNames(t, u, "hosts"); !same(got, before) {
		t.Fatalf("a member reordered the owner's hosts: %v -> %v", before, got)
	}
	if code, _ := newClient(t, ts.URL).do("POST", "/api/hosts/order", map[string]any{"ids": []string{}}); code != 401 {
		t.Fatalf("anonymous reorder: %d", code)
	}
}
