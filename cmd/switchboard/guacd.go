package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// guacdPaths are where the image puts guacd, the Apache Guacamole proxy that does the RDP.
var guacdPaths = []string{"/opt/guacamole/sbin/guacd", "/usr/local/sbin/guacd", "/usr/sbin/guacd"}

func findGuacd() string {
	if p, err := exec.LookPath("guacd"); err == nil {
		return p
	}
	for _, p := range guacdPaths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// startGuacd runs the bundled guacd on the loopback interface, so nothing outside the
// container can reach it, and starts it again if it ever stops. It returns when ctx is
// cancelled and guacd has exited.
func startGuacd(ctx context.Context, host, port string, wg *sync.WaitGroup) {
	bin := findGuacd()
	if bin == "" {
		log.Print("guacd not found: remote desktops need it, so set SWITCHBOARD_GUACD to one that is running")
		return
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for ctx.Err() == nil {
			cmd := exec.CommandContext(ctx, bin, "-b", host, "-l", port, "-f", "-L", "warning")
			cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
			cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
			cmd.WaitDelay = 5 * time.Second
			err := cmd.Run()
			if ctx.Err() != nil {
				return
			}
			log.Printf("guacd stopped (%v); starting it again", err)
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return
			}
		}
	}()
}
