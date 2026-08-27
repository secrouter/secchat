// secchat-mediad is the server-side media relay + recorder for SecChat's 1:1 voice calls
// (docs/plans/voice-calls-plan.md §2.3/§3.2). See docs/plans/voice-contracts.md for the exact
// wire shapes this binary implements.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"secchat-mediad/internal/api"
	"secchat-mediad/internal/config"
	"secchat-mediad/internal/session"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "probe this process's own GET /health and exit 0/1 (Dockerfile HEALTHCHECK — no curl/wget in the runtime image)")
	flag.Parse()

	if *healthcheck {
		os.Exit(runHealthcheck())
	}

	if err := run(); err != nil {
		slog.Error("mediad: fatal", "err", err)
		os.Exit(1)
	}
}

// runHealthcheck backs `mediad -healthcheck`, the Dockerfile's HEALTHCHECK CMD: GET /health is
// deliberately unauthenticated (docs/plans/voice-contracts.md §2.5), so this needs no token and
// stays a tiny in-binary probe rather than pulling curl/wget into the runtime image.
func runHealthcheck() int {
	cfg, err := config.FromEnv()
	if err != nil {
		return 1
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://localhost" + cfg.ControlAddr + "/health") //nolint:noctx // short-lived CLI probe
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}

	return 0
}

func run() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}

	mgr, err := session.NewManager(cfg)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go mgr.RunJanitor(ctx)

	srv := &http.Server{
		Addr:              cfg.ControlAddr,
		Handler:           api.New(mgr, cfg.Token),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		slog.Info("mediad: control API listening", "addr", cfg.ControlAddr, "mediaAddr", cfg.MediaAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err

			return
		}
		serveErr <- nil
	}()

	select {
	case <-ctx.Done():
		slog.Info("mediad: shutting down")
	case err := <-serveErr:
		if err != nil {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	_ = mgr.Close()

	return nil
}
