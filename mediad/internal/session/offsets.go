package session

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// offsetsFileName is the sidecar recordLegOffset maintains in each session's directory (v3.1
// suggested #6): a tiny, incrementally-written record of the ONE thing finalize.go's disk-
// recovery path (remixFromDisk) needs but can't otherwise reconstruct after a crash — each leg's
// startOffsetMs, which is only ever computed in memory (recorder.Leg.startOffsetMs) at the
// instant that leg's first packet arrives. Without this, a crash before a clean DELETE loses it
// entirely and every crash-recovered manifest reports startOffsetMs: 0 for every leg, silently
// mis-aligning the merged transcript for exactly the truncated-call case that matters.
const offsetsFileName = "offsets.json"

// offsetsSidecar is offsets.json's shape. Not part of the wire contract (docs/plans/voice-
// contracts.md §2/§4 only specify manifest.json) — purely an internal recovery aid mediad writes
// and reads itself.
type offsetsSidecar struct {
	SessionT0 time.Time        `json:"sessionT0"`
	Legs      map[string]int64 `json:"legs"` // legID -> startOffsetMs
}

// recordLegOffset persists legID's startOffsetMs into the session's offsets.json the first time
// it's known (recorder.Options.OnFirstPacket, wired up in newSession below). Best-effort: a
// write failure is logged, not fatal — offsets.json is a recovery aid, not the manifest itself,
// and the live (non-crashed) finalize path never needs it at all (it reads straight from the
// in-memory *recorder.Leg).
func (s *Session) recordLegOffset(legID string, startOffsetMs int64) {
	s.offsetsMu.Lock()
	defer s.offsetsMu.Unlock()

	sidecar := readOffsetsSidecar(s.dir)
	if sidecar.Legs == nil {
		sidecar.Legs = make(map[string]int64, 2)
	}
	sidecar.SessionT0 = s.t0
	sidecar.Legs[legID] = startOffsetMs

	if err := writeOffsetsSidecar(s.dir, sidecar); err != nil {
		slog.Error("mediad: write offsets sidecar failed", "session", s.id, "leg", legID, "err", err)
	}
}

// readOffsetsSidecar best-effort reads dir's offsets.json. A missing or corrupt sidecar (never
// written — e.g. a crash before ANY leg's first packet — or a pre-this-fix session directory)
// returns the zero value: callers fall back to startOffsetMs 0 for whichever legs aren't in
// Legs, exactly the prior documented behavior.
func readOffsetsSidecar(dir string) offsetsSidecar {
	data, err := os.ReadFile(filepath.Join(dir, offsetsFileName)) //nolint:gosec // dir comes from a validated session id
	if err != nil {
		return offsetsSidecar{}
	}

	var sidecar offsetsSidecar
	if err := json.Unmarshal(data, &sidecar); err != nil {
		return offsetsSidecar{}
	}

	return sidecar
}

func writeOffsetsSidecar(dir string, sidecar offsetsSidecar) error {
	data, err := json.MarshalIndent(sidecar, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(dir, offsetsFileName), data, 0o640) //nolint:gosec // recordings dir, not world-readable
}
