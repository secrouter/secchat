// Package session owns secchat-mediad's Pion PeerConnections (one per leg), packet-level RTP
// forwarding between the two legs of a call, and the control-API-facing session lifecycle
// (create, per-leg SDP offer/answer, state, finalize) described in docs/plans/voice-calls-plan.md
// §2.3/§3.2 and wired to the exact wire shapes in docs/plans/voice-contracts.md §2.
package session

import "errors"

// Sentinel errors the api package maps to the contract's error codes (docs/plans/voice-
// contracts.md §2.6).
var (
	ErrSessionNotFound   = errors.New("session_not_found")
	ErrLegNotFound       = errors.New("leg_not_found")
	ErrLegBusy           = errors.New("leg_already_connected")
	ErrSessionCapReached = errors.New("session_cap_reached")
	ErrSessionEnded      = errors.New("session_ended")
	// ErrLegAlreadyExists is returned by AddLeg for a legId already present in the session (live
	// or previously left — legIDs are never reused within a session).
	ErrLegAlreadyExists = errors.New("leg_already_exists")
	// ErrTooManyLegs is returned by AddLeg when the session already holds
	// config.MaxLegsPerSession ACTIVE (non-left) legs.
	ErrTooManyLegs = errors.New("session_full")
	// ErrLegNotConnected is returned by RenegotiateLeg/AnswerLeg for a leg with no live
	// PeerConnection yet (never offered) or one that has already left the call.
	ErrLegNotConnected = errors.New("leg_not_connected")
)

// LegSpec is one leg of a POST /sessions request (docs/plans/voice-contracts.md §2.1).
type LegSpec struct {
	LegID string
	Sub   string
}

// LegState is one leg's entry in GET /sessions/:id (docs/plans/voice-contracts.md §2.3).
type LegState struct {
	LegID    string `json:"legId"`
	ICEState string `json:"iceState"`
}

// SessionState is the full GET /sessions/:id response body.
type SessionState struct {
	SessionID string     `json:"sessionId"`
	Legs      []LegState `json:"legs"`
	Recording string     `json:"recording"` // "none" | "on" — mediad's ACTUAL writer state
}

// ManifestFile.Kind values — see ManifestFile.Kind's doc comment.
const (
	ManifestFileKindAudio = "audio"
	ManifestFileKindMixed = "mixed"
)

// ManifestFile is one entry in a finalize manifest's files[] (docs/plans/voice-contracts.md
// §2.4). LegID is omitted (absent, not empty-string) for the mixed playback file.
type ManifestFile struct {
	LegID         string `json:"legId,omitempty"`
	Path          string `json:"path"`
	StartOffsetMs int64  `json:"startOffsetMs"`
	DurationMs    int64  `json:"durationMs"`
	// Kind is "audio" for a per-leg file (mediad only ever records audio — see session.go's
	// onInboundRTP recording-isolation branch) or "mixed" for the mixed playback file.
	// Future-proofing only: no lookup logic discriminates by this field today (LegID=="" already
	// identifies the mixed entry) — it unblocks a future video writer without a wire-shape change;
	// the TS backend tolerates unknown/absent fields.
	Kind string `json:"kind,omitempty"`
}

// Manifest is the DELETE /sessions/:id response body, and what's persisted as manifest.json in
// the session directory (docs/plans/voice-contracts.md §2.4/§4).
type Manifest struct {
	SessionID string         `json:"sessionId"`
	Files     []ManifestFile `json:"files"`
	Truncated bool           `json:"truncated,omitempty"`
}

// Health is the GET /health response body (docs/plans/voice-contracts.md §2.5).
type Health struct {
	Status         string `json:"status"`
	ActiveSessions int    `json:"activeSessions"`
	DiskFreeBytes  int64  `json:"diskFreeBytes"`
}
