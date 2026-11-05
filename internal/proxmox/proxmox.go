// Package proxmox is a small client for the Proxmox VE API: list VMs and containers and
// change their power state. It signs in with an API token, and trusts only the server
// certificate whose SHA-256 fingerprint was pinned when the server was added.
package proxmox

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Dial opens a TCP connection, so calls can go over a user's tailnet.
type Dial func(ctx context.Context, addr string) (net.Conn, error)

// ErrCertChanged means the server presented a different certificate than the pinned one.
var ErrCertChanged = errors.New("the server's certificate has changed")

type Client struct {
	base  string
	token string
	hc    *http.Client
}

// Resource is one VM or container.
type Resource struct {
	VMID   int    `json:"vmid"`
	Name   string `json:"name"`
	Node   string `json:"node"`
	Type   string `json:"type"` // "qemu" or "lxc"
	Status string `json:"status"`
	Uptime int64  `json:"uptime"`
}

// Fingerprint formats a certificate hash the way SSH and browsers do: upper-case hex pairs.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	h := strings.ToUpper(hex.EncodeToString(sum[:]))
	var parts []string
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":")
}

// Address checks that address is a plain https URL for a server and returns its host:port and base URL.
func Address(address string) (hostport, base string, err error) {
	u, err := url.Parse(strings.TrimSpace(address))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return "", "", errors.New("Enter the address as https://host:8006")
	}
	port := u.Port()
	if port == "" {
		port = "8006"
	}
	return net.JoinHostPort(u.Hostname(), port), "https://" + net.JoinHostPort(u.Hostname(), port), nil
}

func transport(pin string, dial Dial) *http.Transport {
	t := &http.Transport{
		TLSHandshakeTimeout: 10 * time.Second,
		DisableKeepAlives:   true,
		// Proxmox uses a self-signed certificate, so the chain cannot be checked. Instead the
		// certificate itself must be the one pinned when the server was added.
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, // #nosec G402 -- replaced by the pin check just below
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				if len(raw) == 0 || Fingerprint(raw[0]) != pin {
					return ErrCertChanged
				}
				return nil
			},
		},
	}
	if dial != nil {
		t.DialContext = func(ctx context.Context, _, addr string) (net.Conn, error) { return dial(ctx, addr) }
	}
	return t
}

// New returns a client for the server at address. pin is the pinned certificate fingerprint.
func New(address, tokenID, secret, pin string, dial Dial) (*Client, error) {
	_, base, err := Address(address)
	if err != nil {
		return nil, err
	}
	return &Client{base: base, token: "PVEAPIToken=" + tokenID + "=" + secret,
		hc: &http.Client{Transport: transport(pin, dial), Timeout: 20 * time.Second}}, nil
}

// Probe connects without trusting anything and returns the certificate the server presents, so
// the person can check it before it is pinned. It sends no credentials.
func Probe(ctx context.Context, address string, dial Dial) (string, error) {
	hostport, _, err := Address(address)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var raw net.Conn
	if dial != nil {
		raw, err = dial(ctx, hostport)
	} else {
		raw, err = (&net.Dialer{}).DialContext(ctx, "tcp", hostport)
	}
	if err != nil {
		return "", fmt.Errorf("Could not reach %s.", hostport)
	}
	host, _, _ := net.SplitHostPort(hostport)
	conn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: host}) // #nosec G402 -- only reads the certificate
	defer conn.Close()
	if err := conn.HandshakeContext(ctx); err != nil {
		return "", errors.New("That address did not answer with a TLS certificate. Is it the Proxmox web address?")
	}
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", errors.New("The server did not present a certificate.")
	}
	return Fingerprint(certs[0].Raw), nil
}

func (c *Client) do(ctx context.Context, method, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/api2/json"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.token)
	resp, err := c.hc.Do(req)
	if err != nil {
		if errors.Is(err, ErrCertChanged) {
			return ErrCertChanged
		}
		return fmt.Errorf("Could not reach the Proxmox server: %v", cleanErr(err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return errors.New("Proxmox rejected the API token. Check the token ID and secret.")
	case resp.StatusCode == http.StatusForbidden:
		return errors.New("The token is not allowed to do that. Give it the VM.PowerMgmt and VM.Audit permissions.")
	case resp.StatusCode >= 300:
		return fmt.Errorf("Proxmox answered %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if out == nil {
		return nil
	}
	var wrap struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &wrap); err != nil {
		return errors.New("Proxmox sent a reply this app could not read.")
	}
	return json.Unmarshal(wrap.Data, out)
}

// cleanErr keeps the useful end of a network error.
func cleanErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return err.Error()
}

// Version checks that the token works, and returns the Proxmox version.
func (c *Client) Version(ctx context.Context) (string, error) {
	var v struct {
		Version string `json:"version"`
	}
	if err := c.do(ctx, http.MethodGet, "/version", &v); err != nil {
		return "", err
	}
	return v.Version, nil
}

// Resources lists every VM and container the token can see, templates excluded.
func (c *Client) Resources(ctx context.Context) ([]Resource, error) {
	var raw []struct {
		VMID     int    `json:"vmid"`
		Name     string `json:"name"`
		Node     string `json:"node"`
		Type     string `json:"type"`
		Status   string `json:"status"`
		Uptime   int64  `json:"uptime"`
		Template int    `json:"template"`
	}
	if err := c.do(ctx, http.MethodGet, "/cluster/resources?type=vm", &raw); err != nil {
		return nil, err
	}
	var out []Resource
	for _, r := range raw {
		if r.Template == 1 || (r.Type != "qemu" && r.Type != "lxc") {
			continue
		}
		out = append(out, Resource{VMID: r.VMID, Name: r.Name, Node: r.Node, Type: r.Type, Status: r.Status, Uptime: r.Uptime})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].VMID < out[j].VMID })
	return out, nil
}

// Find returns the VM or container with this id, wherever it is in the cluster now.
func (c *Client) Find(ctx context.Context, kind string, vmid int) (*Resource, error) {
	all, err := c.Resources(ctx)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].VMID == vmid && all[i].Type == kind {
			return &all[i], nil
		}
	}
	return nil, errors.New("That VM no longer exists on the Proxmox server.")
}

var actions = map[string]bool{"start": true, "shutdown": true, "reboot": true, "stop": true}

// Power starts, shuts down (asks the guest to), reboots or stops (cuts the power to) a VM.
func (c *Client) Power(ctx context.Context, kind string, vmid int, action string) error {
	if !actions[action] || (kind != "qemu" && kind != "lxc") {
		return errors.New("Unknown action.")
	}
	r, err := c.Find(ctx, kind, vmid)
	if err != nil {
		return err
	}
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/nodes/%s/%s/%d/status/%s", url.PathEscape(r.Node), kind, vmid, action), nil)
}

// GuestIPs asks the guest for its addresses (the QEMU guest agent, or the container's interfaces).
func (c *Client) GuestIPs(ctx context.Context, r Resource) []string {
	var ips []string
	if r.Type == "qemu" {
		var out struct {
			Result []struct {
				Addresses []struct {
					IP string `json:"ip-address"`
				} `json:"ip-addresses"`
			} `json:"result"`
		}
		if c.do(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/qemu/%d/agent/network-get-interfaces", url.PathEscape(r.Node), r.VMID), &out) == nil {
			for _, i := range out.Result {
				for _, a := range i.Addresses {
					ips = append(ips, a.IP)
				}
			}
		}
		return ips
	}
	var ifs []struct {
		Inet string `json:"inet"`
	}
	if c.do(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/lxc/%d/interfaces", url.PathEscape(r.Node), r.VMID), &ifs) == nil {
		for _, i := range ifs {
			ips = append(ips, strings.SplitN(i.Inet, "/", 2)[0])
		}
	}
	return ips
}
