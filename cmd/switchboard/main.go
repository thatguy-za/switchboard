package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/thatguy-za/switchboard/internal/server"
)

//go:embed web
var webFS embed.FS

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe /healthz and exit")
	flag.Parse()

	addr := ":" + env("SWITCHBOARD_PORT", "3000")

	if *healthcheck {
		c := http.Client{Timeout: 3 * time.Second}
		resp, err := c.Get("http://127.0.0.1" + addr + "/healthz")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}

	timeout, err := time.ParseDuration(env("SWITCHBOARD_SESSION_TIMEOUT", "30m"))
	if err != nil {
		log.Fatalf("SWITCHBOARD_SESSION_TIMEOUT: %v", err)
	}
	web, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}
	port, err := strconv.Atoi(env("SWITCHBOARD_PORT", "3000"))
	if err != nil {
		log.Fatalf("SWITCHBOARD_PORT: %v", err)
	}
	srv, err := server.New(server.Config{
		DataDir:        env("SWITCHBOARD_DATA_DIR", "/data"),
		KeysDir:        env("SWITCHBOARD_KEYS_DIR", "/keys"),
		Port:           port,
		SessionTimeout: timeout,
	}, web)
	if err != nil {
		log.Fatal(err)
	}
	defer srv.Close()

	if srv.KeyCreated() {
		log.Printf("generated a new master key in %s; back it up from the admin panel", env("SWITCHBOARD_KEYS_DIR", "/keys"))
	}
	log.Printf("switchboard listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, srv.Handler()))
}
