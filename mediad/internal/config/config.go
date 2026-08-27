// Package config parses secchat-mediad's environment (docs/plans/voice-calls-plan.md §2.3/§2.5,
// docs/plans/voice-contracts.md §2/§3).
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is mediad's full runtime configuration, sourced from the environment.
type Config struct {
	// ControlAddr is the control-API HTTP listen address (docs/plans/voice-contracts.md §2's
	// "control API port", e.g. ":47021" — distinct from the media port).
	ControlAddr string
	// MediaAddr is the host:port ICEUDPMux/SetICETCPMux bind for ALL sessions' media
	// (docs/plans/voice-contracts.md §3, e.g. ":47020").
	MediaAddr string
	// AdvertiseAddr is fed to Pion's SetNAT1To1IPs — the suite host's cross-host-reachable
	// address (SECCHAT_MEDIAD_ADVERTISE_ADDR upstream; mediad's own env is ADVERTISE_ADDR —
	// docs/plans/voice-calls-plan.md's #1 containerized-Pion failure mode if left unset/wrong).
	AdvertiseAddr string
	// Token is the shared bearer token every control-API request must present
	// (docs/plans/voice-contracts.md §2's Authorization: Bearer <token>).
	Token string
	// RecordingsDir is mediad's write mount for the shared recordings volume
	// (docs/plans/voice-contracts.md §4) — the ONLY directory mediad writes to (hardening).
	RecordingsDir string
	// FfmpegPath is the ffmpeg binary invoked at finalize to mix the two legs
	// (docs/plans/voice-calls-plan.md §2.3's "the only shell invocation").
	FfmpegPath string
	// SessionCap bounds how many concurrent sessions mediad will accept (hardening: session cap).
	SessionCap int
	// MaxLegsPerSession bounds how many participants (legs) a single session may hold at once —
	// both POST /sessions' initial legs and POST /sessions/:id/legs joiners count against it
	// (multi-party SFU cap; was a hardcoded "exactly two legs" before group calls).
	MaxLegsPerSession int
	// ActiveDeadline bounds how long any one session may stay open before mediad force-ends it
	// (hardening: per-session activeDeadline; also R4's 2h call-length default).
	ActiveDeadline time.Duration
	// JanitorInterval is how often the orphaned-session janitor sweeps for sessions that never
	// finalized and have exceeded ActiveDeadline.
	JanitorInterval time.Duration
}

// FromEnv reads Config from the process environment, applying the documented defaults for
// everything that has one. Token, AdvertiseAddr are required — mediad refuses to start without
// them (an unset token would mean "no auth"; an unset advertise address is the #1 containerized-
// Pion failure mode called out in the plan, better to fail loudly at boot than fail silently at
// the first cross-host call).
func FromEnv() (Config, error) {
	cfg := Config{
		ControlAddr:   getEnv("MEDIAD_CONTROL_ADDR", ":47021"),
		MediaAddr:     getEnv("MEDIAD_MEDIA_ADDR", ":47020"),
		AdvertiseAddr: os.Getenv("MEDIAD_ADVERTISE_ADDR"),
		Token:         os.Getenv("MEDIAD_TOKEN"),
		RecordingsDir: getEnv("MEDIAD_RECORDINGS_DIR", "/var/lib/mediad/recordings"),
		FfmpegPath:    getEnv("MEDIAD_FFMPEG_PATH", "ffmpeg"),
	}

	var err error
	if cfg.SessionCap, err = getEnvInt("MEDIAD_SESSION_CAP", 64); err != nil {
		return Config{}, err
	}
	if cfg.MaxLegsPerSession, err = getEnvInt("MEDIAD_MAX_LEGS_PER_SESSION", 8); err != nil {
		return Config{}, err
	}
	if cfg.ActiveDeadline, err = getEnvDuration("MEDIAD_ACTIVE_DEADLINE", 2*time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.JanitorInterval, err = getEnvDuration("MEDIAD_JANITOR_INTERVAL", 5*time.Minute); err != nil {
		return Config{}, err
	}

	if cfg.Token == "" {
		return Config{}, fmt.Errorf("config: MEDIAD_TOKEN is required (control-API bearer auth)")
	}
	if cfg.AdvertiseAddr == "" {
		return Config{}, fmt.Errorf(
			"config: MEDIAD_ADVERTISE_ADDR is required — the suite host's cross-host-reachable " +
				"address for Pion's SetNAT1To1IPs; unset means every relayed call fails to connect " +
				"from a second host (docs/plans/voice-calls-plan.md §2.2/§2.5/R6)")
	}

	return cfg, nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}

	return def
}

func getEnvInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("config: %s: %w", key, err)
	}

	return n, nil
}

func getEnvDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("config: %s: %w", key, err)
	}

	return d, nil
}
