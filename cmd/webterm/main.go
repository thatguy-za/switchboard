package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/thatguy-za/webterm/internal/server"
)

//go:embed web
var webFS embed.FS

// version is set at build time: -ldflags "-X main.version=v0.0.7".
var version = "dev"

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz and exit")
	flag.Parse()

	addr := ":" + env("WEBTERM_PORT", "3000")

	if *healthcheck {
		c := http.Client{Timeout: 3 * time.Second}
		resp, err := c.Get("http://127.0.0.1" + addr + "/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}

	timeout, err := time.ParseDuration(env("WEBTERM_SESSION_TIMEOUT", "30m"))
	if err != nil {
		log.Fatalf("WEBTERM_SESSION_TIMEOUT: %v", err)
	}
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	port, err := strconv.Atoi(env("WEBTERM_PORT", "3000"))
	if err != nil {
		log.Fatalf("WEBTERM_PORT: %v", err)
	}
	maxRDP, err := strconv.Atoi(env("WEBTERM_MAX_RDP", "10"))
	if err != nil || maxRDP < 1 {
		log.Fatal("WEBTERM_MAX_RDP must be a positive number")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	var children sync.WaitGroup

	// RDP goes through guacd. Unless WEBTERM_GUACD points at one elsewhere, run the copy
	// that ships in the image, reachable only from inside this container.
	guacd := os.Getenv("WEBTERM_GUACD")
	if guacd == "" {
		guacd = "127.0.0.1:4822"
		host, gport, _ := net.SplitHostPort(guacd)
		startGuacd(ctx, host, gport, &children)
	}

	keysDir := env("WEBTERM_KEYS_DIR", "/data/keys")
	srv, err := server.New(server.Config{
		DataDir:        env("WEBTERM_DATA_DIR", "/data"),
		KeysDir:        keysDir,
		Port:           port,
		SessionTimeout: timeout,
		Guacd:          guacd,
		TransferDir:    env("WEBTERM_TRANSFER_DIR", "/tmp/webterm-transfer"),
		MaxRDP:         maxRDP,
		TrustProxy:     env("WEBTERM_TRUST_PROXY", "") == "true",
		Version:        version,
	}, web)
	if err != nil {
		log.Fatal(err)
	}
	defer srv.Close()

	if srv.KeyCreated() {
		log.Printf("generated a new master key in %s; back it up from Settings", keysDir)
	}

	httpSrv := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 15 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		httpSrv.Shutdown(shutdown)
	}()
	log.Printf("webterm listening on %s", addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	stop()
	children.Wait()
}
