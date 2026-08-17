package session

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// TestRecoverFromDiskRejectsPathTraversalSessionID is the regression test for v3.1 finding #2:
// DELETE /sessions/:id's path value reaches recoverFromDisk unvalidated (Go 1.22's ServeMux
// PathValue decodes %2F), so a control-API caller could otherwise stat/read arbitrary
// directories via filepath.Join(RecordingsDir, sessionID). Every shape below must be rejected
// as not-found before any filesystem access, and — crucially — a real file planted OUTSIDE
// RecordingsDir must never be reachable through it.
func TestRecoverFromDiskRejectsPathTraversalSessionID(t *testing.T) {
	mgr := newTestManager(t)

	secretDir := filepath.Join(filepath.Dir(mgr.cfg.RecordingsDir), "mediad-test-secret")
	if err := os.MkdirAll(secretDir, 0o750); err != nil {
		t.Fatalf("MkdirAll secretDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(secretDir) })
	if err := os.WriteFile(filepath.Join(secretDir, "manifest.json"), []byte(`{"sessionId":"leaked"}`), 0o640); err != nil {
		t.Fatalf("WriteFile secret manifest: %v", err)
	}

	traversal := "../" + filepath.Base(secretDir)

	for _, id := range []string{
		traversal,
		"../../etc/passwd",
		"sess_" + strings.Repeat("a", 36), // right length, wrong shape (no dashes) — still rejected
		"not_even_close",
		"",
		"sess_",
	} {
		manifest, err := mgr.EndSession(id)
		if !errors.Is(err, ErrSessionNotFound) {
			t.Errorf("EndSession(%q) err = %v, want ErrSessionNotFound", id, err)
		}
		if manifest.SessionID != "" || len(manifest.Files) != 0 {
			t.Errorf("EndSession(%q) leaked manifest content: %+v", id, manifest)
		}
	}

	// A well-formed-but-never-created id must still 404 normally (the regex isn't overtightened
	// to reject legitimate ids).
	neverExisted := "sess_" + uuid.NewString()
	if _, err := mgr.EndSession(neverExisted); !errors.Is(err, ErrSessionNotFound) {
		t.Errorf("EndSession(%q) = %v, want ErrSessionNotFound", neverExisted, err)
	}
}

// TestEndSessionMixFailureReturnsLegsOnlyManifestAndForgetsSession is the regression test for
// v3.1 finding #3: an ffmpeg mix failure must not turn into an HTTP 500 that discards the
// (already-disk-written) legs-only manifest and strands the session in the live table forever.
func TestEndSessionMixFailureReturnsLegsOnlyManifestAndForgetsSession(t *testing.T) {
	cfg := testConfig(t)
	cfg.FfmpegPath = filepath.Join(t.TempDir(), "ffmpeg-does-not-exist")
	mgr, err := NewManager(cfg)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	manifest, err := mgr.EndSession(sess.ID())
	if err != nil {
		t.Fatalf("EndSession with a broken ffmpeg path returned an error, want nil (legs-only 200): %v", err)
	}
	if manifest.SessionID != sess.ID() {
		t.Fatalf("manifest.SessionID = %q, want %q", manifest.SessionID, sess.ID())
	}
	if len(manifest.Files) != 2 {
		t.Fatalf("expected exactly 2 legs-only manifest files, got %d: %+v", len(manifest.Files), manifest.Files)
	}
	for _, f := range manifest.Files {
		if f.Path == mixedFileName {
			t.Fatalf("expected no mixed.m4a entry when ffmpeg is unavailable, got one: %+v", manifest.Files)
		}
	}

	if _, ok := mgr.Get(sess.ID()); ok {
		t.Fatalf("expected the session to be forgotten from the live table even though the mix failed")
	}
	if got := mgr.Health().ActiveSessions; got != 0 {
		t.Fatalf("ActiveSessions after a mix-failure finalize = %d, want 0", got)
	}
}

// TestFinalizeManifestFilesCarryKind is the regression test for the FUTURE-PROOFING
// ManifestFile.Kind field (types.go): every per-leg file in a finalize manifest must carry
// Kind:"audio" (mediad only ever records audio) and the mixed playback file must carry
// Kind:"mixed" — added without changing the existing LegID=="" discrimination logic.
func TestFinalizeManifestFilesCarryKind(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	pushOnePacket(t, sess, "leg_alice", 0xAAAA)
	pushOnePacket(t, sess, "leg_bob", 0xBBBB)

	manifest, err := mgr.EndSession(sess.ID())
	if err != nil {
		t.Fatalf("EndSession: %v", err)
	}

	var sawAudio, sawMixed int
	for _, f := range manifest.Files {
		switch {
		case f.LegID != "":
			if f.Kind != ManifestFileKindAudio {
				t.Errorf("leg file %s Kind = %q, want %q", f.LegID, f.Kind, ManifestFileKindAudio)
			}
			sawAudio++
		case f.Path == mixedFileName:
			if f.Kind != ManifestFileKindMixed {
				t.Errorf("mixed file Kind = %q, want %q", f.Kind, ManifestFileKindMixed)
			}
			sawMixed++
		default:
			t.Errorf("unexpected manifest file with neither a LegID nor the mixed path: %+v", f)
		}
	}
	if sawAudio != 2 {
		t.Fatalf("expected 2 audio-kind leg files, got %d: %+v", sawAudio, manifest.Files)
	}
	if sawMixed != 1 {
		t.Fatalf("expected 1 mixed-kind file, got %d: %+v", sawMixed, manifest.Files)
	}
}

// TestFinalizeManifestNeverContainsVideoEntries confirms video RTP flowing through onInboundRTP
// never produces a manifest entry — mediad has no video writer (the Kind field exists so one can
// be added later without a wire-shape change, but today ONLY "audio" and "mixed" are ever
// written; finalize.go/recorder/ must stay byte-identical for audio regardless of video traffic).
func TestFinalizeManifestNeverContainsVideoEntries(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	pushOnePacket(t, sess, "leg_alice", 0xAAAA)
	sess.onInboundRTP("leg_alice", videoTrackKey("alice-cam"), webrtc.RTPCodecTypeVideo, &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 1, Timestamp: 1000, SSRC: 0xC0FFEE},
		Payload: []byte{0x00, 0x01},
	})
	pushOnePacket(t, sess, "leg_bob", 0xBBBB)

	manifest, err := mgr.EndSession(sess.ID())
	if err != nil {
		t.Fatalf("EndSession: %v", err)
	}

	for _, f := range manifest.Files {
		if f.Kind != "" && f.Kind != ManifestFileKindAudio && f.Kind != ManifestFileKindMixed {
			t.Errorf("unexpected manifest file kind %q (video must never be written): %+v", f.Kind, f)
		}
	}
	if len(manifest.Files) != 3 {
		t.Fatalf("expected exactly 3 manifest files (2 legs + mixed, no video entry), got %d: %+v", len(manifest.Files), manifest.Files)
	}
}

// TestRemixFromDiskUsesOffsetsSidecarForStartOffsetMs is the regression test for v3.1
// suggested #6: a session recovered from disk (no manifest.json — the mid-finalize-crash case)
// must report each leg's REAL startOffsetMs from the offsets.json sidecar, not the documented
// "assume simultaneous start" fallback that used to be the only option.
func TestRemixFromDiskUsesOffsetsSidecarForStartOffsetMs(t *testing.T) {
	mgr := newTestManager(t)

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Simulate real RTP arriving on each leg directly (bypassing ICE/DTLS — the recorder.Leg
	// underneath doesn't care) with a real gap between the two legs joining, so their
	// startOffsetMs values are meaningfully different and the fallback (0 for both) would be
	// distinguishable from the fix.
	time.Sleep(30 * time.Millisecond)
	pushOnePacket(t, sess, "leg_alice", 0xAAAA)
	time.Sleep(70 * time.Millisecond)
	pushOnePacket(t, sess, "leg_bob", 0xBBBB)

	// Do NOT call EndSession/finalize — that's the clean-shutdown path this test isn't
	// exercising. Instead go straight at recoverFromDisk, exactly what a restarted process does
	// for a session it crashed mid-call on (manifest.json never got written).
	manifest, err := mgr.recoverFromDisk(sess.ID())
	if err != nil {
		t.Fatalf("recoverFromDisk: %v", err)
	}
	if !manifest.Truncated {
		t.Fatalf("expected a disk-recovered manifest to be marked truncated")
	}

	offsets := map[string]int64{}
	for _, f := range manifest.Files {
		if f.LegID != "" {
			offsets[f.LegID] = f.StartOffsetMs
		}
	}

	aliceOffset, ok := offsets["leg_alice"]
	if !ok {
		t.Fatalf("manifest missing leg_alice: %+v", manifest.Files)
	}
	bobOffset, ok := offsets["leg_bob"]
	if !ok {
		t.Fatalf("manifest missing leg_bob: %+v", manifest.Files)
	}

	if aliceOffset <= 0 {
		t.Errorf("leg_alice startOffsetMs = %d, want > 0 (sidecar-recovered, not the old always-0 fallback)", aliceOffset)
	}
	gap := bobOffset - aliceOffset
	if gap < 35 || gap > 300 {
		t.Errorf("leg_bob-leg_alice startOffsetMs gap = %dms, want roughly 70ms (35-300 given scheduling slack); alice=%d bob=%d",
			gap, aliceOffset, bobOffset)
	}
}

// TestRecoverFromDiskRetriesMixWhenManifestHasLegsButNoMixedEntry is the regression test for the
// residual v3.1 suggested #3 finding: an ffmpeg mix failure writes a legs-only manifest.json to
// disk (correct — see TestEndSessionMixFailureReturnsLegsOnlyManifestAndForgetsSession above),
// but every SUBSEQUENT DELETE used to return that manifest verbatim from disk forever, because
// recoverFromDisk only ever attempted a remix when manifest.json was entirely absent. That left
// the mix permanently broken once one attempt failed (e.g. a transient ffmpeg hiccup, an out-of-
// disk blip) even though both leg recordings were sitting right there and a later retry would
// succeed. This drives the exact sequence: finalize once with a broken ffmpeg path (legs-only
// manifest.json lands on disk), then hit recoverFromDisk again — as a restarted process's
// reconciliation sweep or a simple DELETE retry would — with a WORKING ffmpeg, and assert the
// mixed entry now appears, both in the returned manifest and in manifest.json on disk.
func TestRecoverFromDiskRetriesMixWhenManifestHasLegsButNoMixedEntry(t *testing.T) {
	dir := t.TempDir()

	brokenCfg := testConfig(t)
	brokenCfg.RecordingsDir = dir
	brokenCfg.FfmpegPath = filepath.Join(t.TempDir(), "ffmpeg-does-not-exist")
	brokenMgr, err := NewManager(brokenCfg)
	if err != nil {
		t.Fatalf("NewManager (broken ffmpeg): %v", err)
	}
	t.Cleanup(func() { _ = brokenMgr.Close() })

	sess, err := brokenMgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	sessionID := sess.ID()

	manifest, err := brokenMgr.EndSession(sessionID)
	if err != nil {
		t.Fatalf("EndSession with a broken ffmpeg path: %v", err)
	}
	for _, f := range manifest.Files {
		if f.Path == mixedFileName {
			t.Fatalf("expected no mixed entry from the broken-ffmpeg finalize, got one: %+v", manifest.Files)
		}
	}

	// Simulate a retry — either a restarted process's startup reconciliation sweep or the
	// backend simply DELETE-ing again — now that ffmpeg actually works. Same RecordingsDir, same
	// on-disk session, new Manager (mirrors a real restart: nothing live in memory).
	workingCfg := testConfig(t)
	workingCfg.RecordingsDir = dir
	workingMgr, err := NewManager(workingCfg)
	if err != nil {
		t.Fatalf("NewManager (working ffmpeg): %v", err)
	}
	t.Cleanup(func() { _ = workingMgr.Close() })

	retried, err := workingMgr.recoverFromDisk(sessionID)
	if err != nil {
		t.Fatalf("recoverFromDisk retry: %v", err)
	}

	var gotMixed bool
	for _, f := range retried.Files {
		if f.Path == mixedFileName {
			gotMixed = true
		}
	}
	if !gotMixed {
		t.Fatalf("expected recoverFromDisk to retry the ffmpeg mix and add a mixed entry, got: %+v", retried.Files)
	}

	// The retried manifest must also have been persisted back to manifest.json — otherwise a
	// THIRD DELETE (or another reconciliation pass after a crash right after this one) would
	// retry the mix yet again indefinitely instead of ever settling.
	onDisk, err := os.ReadFile(filepath.Join(dir, sessionID, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest.json: %v", err)
	}
	var persisted Manifest
	if err := json.Unmarshal(onDisk, &persisted); err != nil {
		t.Fatalf("unmarshal persisted manifest: %v", err)
	}
	gotMixed = false
	for _, f := range persisted.Files {
		if f.Path == mixedFileName {
			gotMixed = true
		}
	}
	if !gotMixed {
		t.Fatalf("expected the retried manifest with a mixed entry to be persisted to disk, got: %+v", persisted.Files)
	}
}

// pushOnePacket simulates one leg's first RTP packet arriving, directly against the leg's
// recorder (same package — white-box), which is what actually triggers recordLegOffset's
// offsets.json write (recorder.Options.OnFirstPacket, wired up in newSession).
func pushOnePacket(t *testing.T, sess *Session, legID string, ssrc uint32) {
	t.Helper()

	sess.mu.Lock()
	l, ok := sess.legs[legID]
	sess.mu.Unlock()
	if !ok {
		t.Fatalf("pushOnePacket: unknown leg %s", legID)
	}

	l.rec.Push(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 0, Timestamp: 10000, SSRC: ssrc},
		Payload: []byte{0xfc, 0x01, 0x02},
	})
}
