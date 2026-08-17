package session

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"

	"secchat-mediad/internal/config"
)

// Manager owns every live session and the shared Pion API/settings (single ICEUDPMux +
// SetICETCPMux on one well-known port for ALL sessions, docs/plans/voice-contracts.md §3).
type Manager struct {
	cfg config.Config
	api *webrtc.API

	udpMux net.PacketConn
	tcpMux net.Listener

	now func() time.Time

	mu       sync.Mutex
	sessions map[string]*Session
	reserved int // slots claimed by an in-flight CreateSession not yet in `sessions` — see CreateSession
	closed   bool
}

// NewManager builds the shared Pion API (ICEUDPMux + ICETCPMux on cfg.MediaAddr,
// SetNAT1To1IPs(cfg.AdvertiseAddr) applied to both — the #1 containerized-Pion failure mode if
// omitted, docs/plans/voice-calls-plan.md §2.2/§2.5/R6) and an empty session table.
func NewManager(cfg config.Config) (*Manager, error) {
	if err := os.MkdirAll(cfg.RecordingsDir, 0o750); err != nil {
		return nil, fmt.Errorf("session: create recordings dir: %w", err)
	}

	settingEngine := webrtc.SettingEngine{}

	udpAddr, err := net.ResolveUDPAddr("udp4", cfg.MediaAddr)
	if err != nil {
		return nil, fmt.Errorf("session: resolve media addr %s: %w", cfg.MediaAddr, err)
	}
	udpConn, err := net.ListenUDP("udp4", udpAddr)
	if err != nil {
		return nil, fmt.Errorf("session: listen udp %s: %w", cfg.MediaAddr, err)
	}
	udpMux := webrtc.NewICEUDPMux(nil, udpConn)
	settingEngine.SetICEUDPMux(udpMux)

	// Pion silently gathers ZERO host candidates for a UDPMux bound to a loopback address
	// unless loopback candidates are explicitly opted into (its safe default assumes a
	// loopback-bound mux is a mistake, not a deployment choice). mediad's real deployment binds
	// 0.0.0.0 and rewrites via SetNAT1To1IPs below, so this only ever fires for local/dev/test
	// setups that intentionally bind MEDIAD_MEDIA_ADDR to 127.0.0.1 — e.g. this package's own
	// integration test.
	if udpAddr.IP.IsLoopback() {
		settingEngine.SetIncludeLoopbackCandidate(true)
	}

	tcpLn, err := net.Listen("tcp4", cfg.MediaAddr)
	if err != nil {
		_ = udpConn.Close()

		return nil, fmt.Errorf("session: listen tcp %s: %w", cfg.MediaAddr, err)
	}
	tcpMux := webrtc.NewICETCPMux(nil, tcpLn, 32)
	settingEngine.SetICETCPMux(tcpMux)

	// SetNAT1To1IPs applies to BOTH UDP and TCP candidates mediad advertises — the suite host's
	// cross-host-reachable address, not the container-internal IP Pion would otherwise gather
	// (docs/plans/voice-contracts.md §3's "#1 containerized-Pion failure mode").
	settingEngine.SetNAT1To1IPs([]string{cfg.AdvertiseAddr}, webrtc.ICECandidateTypeHost)

	// Non-trickle: mediad gathers to completion and returns one response (§2.2 of the plan) —
	// candidates are still gathered normally via ICEUDPMux/ICETCPMux above; OfferLeg blocks on
	// webrtc.GatheringCompletePromise before answering, so no separate setting is needed here.

	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		_ = udpConn.Close()
		_ = tcpLn.Close()

		return nil, fmt.Errorf("session: register opus codec: %w", err)
	}

	// VP8 (live-only video forwarding — no recording, see session.go's onInboundRTP kind branch).
	// NewAPI below deliberately omits WithInterceptorRegistry: Pion auto-registers its default
	// interceptor set for a bare MediaEngine, which for video includes the NACK
	// generator/responder (RTCPFeedback "nack" below) — a custom registry is NOT needed and would
	// have to duplicate that wiring by hand.
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeVP8,
			ClockRate: 90000,
			RTCPFeedback: []webrtc.RTCPFeedback{
				{Type: "nack"},
				{Type: "nack", Parameter: "pli"},
				{Type: "goog-remb"},
				{Type: "transport-cc"},
			},
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		_ = udpConn.Close()
		_ = tcpLn.Close()

		return nil, fmt.Errorf("session: register vp8 codec: %w", err)
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine), webrtc.WithMediaEngine(mediaEngine))

	return &Manager{
		cfg:      cfg,
		api:      api,
		udpMux:   udpConn,
		tcpMux:   tcpLn,
		now:      time.Now,
		sessions: make(map[string]*Session),
	}, nil
}

// Close shuts down every live session's PeerConnections and the shared media mux listeners.
func (m *Manager) Close() error {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.closed = true
	m.mu.Unlock()

	for _, s := range sessions {
		s.closePeerConnections()
	}

	var err error
	if cerr := m.udpMux.Close(); cerr != nil {
		err = cerr
	}
	if cerr := m.tcpMux.Close(); cerr != nil && err == nil {
		err = cerr
	}

	return err
}

// CreateSession allocates a new session: one or two legs (one = a solo self-DM voice memo, two =
// a 1:1 call), per-leg recorder writers opened (not yet writing — no RTP has arrived), and the
// session's shared t0 established (docs/plans/voice-contracts.md §2.1).
func (m *Manager) CreateSession(callID string, legs []LegSpec) (*Session, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()

		return nil, ErrSessionEnded
	}
	// Reserve a slot against SessionCap in the SAME lock acquisition as the check (v3.1
	// suggested #5): the actual session construction below does real file I/O (mkdir, opening
	// two Ogg writers) and doesn't get inserted into m.sessions until it succeeds, so checking
	// len(m.sessions) again after re-locking would leave the exact check-then-act gap this fixes
	// — two concurrent callers could both observe room and both proceed, exceeding SessionCap.
	// `reserved` closes that gap: it's incremented here, still under this lock, and only
	// decremented once the session lands in m.sessions (success) or the attempt is abandoned
	// (failure) — either way under m.mu, so len(m.sessions)+m.reserved is exactly "slots spoken
	// for" at every instant a cap check can observe it.
	if len(m.sessions)+m.reserved >= m.cfg.SessionCap {
		m.mu.Unlock()

		return nil, ErrSessionCapReached
	}
	m.reserved++
	m.mu.Unlock()

	release := func() {
		m.mu.Lock()
		m.reserved--
		m.mu.Unlock()
	}

	sessionID := "sess_" + uuid.NewString()
	dir := filepath.Join(m.cfg.RecordingsDir, sessionID)
	// 0770, not 0750: the recordings volume is SHARED with the secchat backend, which ingests +
	// transcribes + deletes these files as a DIFFERENT uid. mediad runs with secchat's gid (compose
	// `user: "<uid>:<secchat-gid>"`), so group-rwx on the session dir lets secchat traverse, read,
	// and clean up. Without the group bits secchat hits EACCES on every ingest/transcribe read.
	if err := os.MkdirAll(dir, 0o770); err != nil {
		release()

		return nil, fmt.Errorf("session: create session dir: %w", err)
	}
	// MkdirAll honors the process umask (typically 022), which strips the group-write bit and would
	// leave secchat unable to CLEAN UP the session dir after transcription (deleteSessionDir → EACCES,
	// which then mis-marks the just-posted transcript as failed). Chmod is umask-independent, so the
	// shared group (secchat's gid, see the compose `user:`) gets full rwx.
	if err := os.Chmod(dir, 0o770); err != nil {
		release()

		return nil, fmt.Errorf("session: chmod session dir: %w", err)
	}

	s, err := newSession(m, sessionID, callID, dir, legs, m.now())
	if err != nil {
		release()

		return nil, err
	}

	m.mu.Lock()
	m.sessions[sessionID] = s
	m.reserved--
	m.mu.Unlock()

	return s, nil
}

// Get returns the in-memory Session for sessionID, if mediad still has it live (false after a
// clean DELETE finalize, or if this process never had it — e.g. after a restart; see
// finalize.go's disk-backed idempotency for that case).
func (m *Manager) Get(sessionID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[sessionID]

	return s, ok
}

// forget removes a finalized session from the live table (called by Session.finalizeLocked).
func (m *Manager) forget(sessionID string) {
	m.mu.Lock()
	delete(m.sessions, sessionID)
	m.mu.Unlock()
}

// MaxLegsPerSession returns the configured cap on how many ACTIVE participants (legs) a single
// session may hold at once — enforced by both POST /sessions' initial legs (handlers.go) and
// POST /sessions/:id/legs joiners (Session.AddLeg).
func (m *Manager) MaxLegsPerSession() int {
	return m.cfg.MaxLegsPerSession
}

// Health backs GET /health (docs/plans/voice-contracts.md §2.5).
func (m *Manager) Health() Health {
	m.mu.Lock()
	active := len(m.sessions)
	m.mu.Unlock()

	free, err := diskFree(m.cfg.RecordingsDir)
	if err != nil {
		free = -1
	}

	return Health{Status: "ok", ActiveSessions: active, DiskFreeBytes: free}
}

// AllSessions snapshots the live session table — used by the janitor sweep.
func (m *Manager) AllSessions() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}

	return out
}
