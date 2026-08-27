package session

import (
	"context"
	"log/slog"
	"time"
)

// RunJanitor sweeps for orphaned sessions — ones that exceeded cfg.ActiveDeadline without a
// clean client DELETE (a crashed client, a backend that never told mediad to end the call, or
// R4's long-call cap) — and force-finalizes them so their partial recordings aren't held open
// forever (docs/plans/voice-calls-plan.md §2.3/§3.2's "orphaned-session janitor"; R4's 2h
// default cap). Blocks until ctx is cancelled; run it in its own goroutine.
func (m *Manager) RunJanitor(ctx context.Context) {
	ticker := time.NewTicker(m.cfg.JanitorInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.sweepOrphans()
		}
	}
}

func (m *Manager) sweepOrphans() {
	now := m.now()
	for _, s := range m.AllSessions() {
		s.mu.Lock()
		deadline := s.createdAt.Add(m.cfg.ActiveDeadline)
		ended := s.ended
		s.mu.Unlock()

		if ended || now.Before(deadline) {
			continue
		}

		slog.Warn("mediad: janitor force-finalizing orphaned session", "session", s.id, "callId", s.callID)
		if _, err := s.finalize(true); err != nil {
			slog.Error("mediad: janitor finalize failed", "session", s.id, "err", err)
		}
		m.forget(s.id)
	}
}
