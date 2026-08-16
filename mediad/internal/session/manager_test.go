package session

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"secchat-mediad/internal/config"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()

	return config.Config{
		ControlAddr:     "127.0.0.1:0",
		MediaAddr:       "127.0.0.1:0",
		AdvertiseAddr:   "127.0.0.1",
		Token:           "test-token",
		RecordingsDir:   t.TempDir(),
		FfmpegPath:      "ffmpeg",
		SessionCap:      2,
		ActiveDeadline:  time.Hour,
		JanitorInterval: time.Hour,
	}
}

func newTestManager(t *testing.T) *Manager {
	t.Helper()

	mgr, err := NewManager(testConfig(t))
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	return mgr
}

func twoLegs(a, b string) []LegSpec {
	return []LegSpec{{LegID: "leg_" + a, Sub: a}, {LegID: "leg_" + b, Sub: b}}
}

func oneLeg(a string) []LegSpec {
	return []LegSpec{{LegID: "leg_" + a, Sub: a}}
}

// A solo self-DM voice memo: a session with a SINGLE leg. It must be created (not rejected as
// "exactly two legs"), expose exactly one leg, and have no forwarding peer for it.
func TestCreateSessionSingleLeg(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("solo1", oneLeg("alice"))
	if err != nil {
		t.Fatalf("one-leg CreateSession: %v", err)
	}
	st := sess.State()
	if len(st.Legs) != 1 {
		t.Fatalf("want 1 leg, got %d", len(st.Legs))
	}
	if st.Legs[0].LegID != "leg_alice" {
		t.Fatalf("want leg_alice, got %q", st.Legs[0].LegID)
	}
	if peer := sess.peerLeg("leg_alice"); peer != nil {
		t.Fatalf("a solo leg must have no forwarding peer, got %v", peer)
	}
}

func TestCreateSessionEnforcesSessionCap(t *testing.T) {
	mgr := newTestManager(t) // cap = 2

	if _, err := mgr.CreateSession("call1", twoLegs("alice", "bob")); err != nil {
		t.Fatalf("session 1: %v", err)
	}
	if _, err := mgr.CreateSession("call2", twoLegs("carol", "dave")); err != nil {
		t.Fatalf("session 2: %v", err)
	}
	if _, err := mgr.CreateSession("call3", twoLegs("eve", "frank")); !errors.Is(err, ErrSessionCapReached) {
		t.Fatalf("session 3: got %v, want ErrSessionCapReached", err)
	}
}

// TestCreateSessionEnforcesCapUnderConcurrency is the regression test for v3.1 suggested #5:
// the cap check and the eventual m.sessions insertion used to happen across an unlock, so
// concurrent CreateSession calls could all observe room and all proceed, exceeding SessionCap.
// Every goroutine below is released simultaneously (a start barrier) to maximize the race
// window around CreateSession's real file I/O (mkdir + two Ogg writer opens) between the cap
// check and the insertion.
func TestCreateSessionEnforcesCapUnderConcurrency(t *testing.T) {
	cfg := testConfig(t)
	cfg.SessionCap = 3
	mgr, err := NewManager(cfg)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	const attempts = 20
	start := make(chan struct{})
	results := make(chan error, attempts)
	var wg sync.WaitGroup
	for i := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := mgr.CreateSession(fmt.Sprintf("call%d", i), twoLegs(fmt.Sprintf("a%d", i), fmt.Sprintf("b%d", i)))
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	var successes, capReached int
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrSessionCapReached):
			capReached++
		default:
			t.Errorf("unexpected CreateSession error: %v", err)
		}
	}

	if successes != cfg.SessionCap {
		t.Fatalf("successes = %d, want exactly SessionCap (%d) — the cap was exceeded under concurrency", successes, cfg.SessionCap)
	}
	if successes+capReached != attempts {
		t.Fatalf("successes(%d)+capReached(%d) != attempts(%d)", successes, capReached, attempts)
	}
	if got := mgr.Health().ActiveSessions; got != cfg.SessionCap {
		t.Fatalf("ActiveSessions after concurrent creates = %d, want %d", got, cfg.SessionCap)
	}
}

func TestGetUnknownSessionNotFound(t *testing.T) {
	mgr := newTestManager(t)

	if _, ok := mgr.Get("sess_does_not_exist"); ok {
		t.Fatalf("expected unknown session to not be found")
	}
}

func TestOfferLegUnknownLegID(t *testing.T) {
	mgr := newTestManager(t)

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if _, err := sess.OfferLeg("leg_nonexistent", "v=0\r\n"); !errors.Is(err, ErrLegNotFound) {
		t.Fatalf("got %v, want ErrLegNotFound", err)
	}
}

func TestEndSessionOnUnknownSessionIsNotFound(t *testing.T) {
	mgr := newTestManager(t)

	if _, err := mgr.EndSession("sess_never_existed"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("got %v, want ErrSessionNotFound", err)
	}
}

func TestHealthReportsActiveSessionCount(t *testing.T) {
	mgr := newTestManager(t)

	if got := mgr.Health(); got.ActiveSessions != 0 {
		t.Fatalf("ActiveSessions = %d, want 0", got.ActiveSessions)
	}

	if _, err := mgr.CreateSession("call1", twoLegs("alice", "bob")); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if got := mgr.Health(); got.ActiveSessions != 1 {
		t.Fatalf("ActiveSessions = %d, want 1", got.ActiveSessions)
	}
	if got := mgr.Health(); got.Status != "ok" {
		t.Fatalf("Status = %q, want ok", got.Status)
	}
}

func TestNewSessionState(t *testing.T) {
	mgr := newTestManager(t)

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	state := sess.State()
	if state.SessionID != sess.ID() {
		t.Fatalf("SessionID mismatch")
	}
	if len(state.Legs) != 2 {
		t.Fatalf("expected 2 legs, got %d", len(state.Legs))
	}
	if state.Recording != "none" {
		t.Fatalf("Recording = %q, want none before any RTP has flowed", state.Recording)
	}
	// docs/plans/voice-contracts.md §2.3 documents iceState as one of Pion's ICEConnectionState
	// strings; "new" is correct here since no PeerConnection exists yet for either leg
	// (OfferLeg creates it lazily on the first offer).
	for _, l := range state.Legs {
		if l.ICEState != "new" {
			t.Fatalf("leg %s iceState = %q, want new (no PC created yet — no offer sent)", l.LegID, l.ICEState)
		}
	}
}

// TestJanitorForceFinalizesOrphanedSession exercises the orphaned-session janitor (hardening
// requirement, docs/plans/voice-calls-plan.md §3.2) without needing real ICE: a session that
// never receives an offer still has its (empty) recorder files, so a deadline sweep should
// still finalize and forget it.
func TestJanitorForceFinalizesOrphanedSession(t *testing.T) {
	cfg := testConfig(t)
	cfg.ActiveDeadline = 10 * time.Millisecond
	mgr, err := NewManager(cfg)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	time.Sleep(20 * time.Millisecond)
	mgr.sweepOrphans()

	if _, ok := mgr.Get(sess.ID()); ok {
		t.Fatalf("expected orphaned session to be forgotten after the janitor sweep")
	}
	if got := mgr.Health().ActiveSessions; got != 0 {
		t.Fatalf("ActiveSessions after sweep = %d, want 0", got)
	}
}
