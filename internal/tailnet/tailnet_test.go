package tailnet

import "testing"

func TestIsTailnetHost(t *testing.T) {
	yes := []string{"100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1", "nas.tail1234.ts.net", "NAS.Tail1234.TS.NET.", "::ffff:100.64.0.1"}
	no := []string{"100.63.255.255", "100.128.0.1", "192.168.1.5", "10.0.0.1", "example.com", "ts.net.example.com", "nas", "fd7b::1", ""}
	for _, h := range yes {
		if !IsTailnetHost(h) {
			t.Errorf("%q should be a tailnet host", h)
		}
	}
	for _, h := range no {
		if IsTailnetHost(h) {
			t.Errorf("%q should not be a tailnet host", h)
		}
	}
}

func TestIsShortName(t *testing.T) {
	for h, want := range map[string]bool{"nas": true, "sbui-ssh": true, "nas.local": false, "10.0.0.1": false, "::1": false, "": false} {
		if IsShortName(h) != want {
			t.Errorf("IsShortName(%q) = %v, want %v", h, !want, want)
		}
	}
}

func TestNeedsKeyWithoutState(t *testing.T) {
	m := New(t.TempDir() + "/ts")
	m.Start(Options{Hostname: "webterm"})
	if st := m.Status(); st.State != StateNeedsKey {
		t.Fatalf("expected needs_key, got %+v", st)
	}
	m.Stop()
	if st := m.Status(); st.State != StateOff {
		t.Fatalf("expected off after stop, got %+v", st)
	}
}
