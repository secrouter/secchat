package session

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"secchat-mediad/internal/recorder"
)

func threeLegs(a, b, c string) []LegSpec {
	return []LegSpec{{LegID: "leg_" + a, Sub: a}, {LegID: "leg_" + b, Sub: b}, {LegID: "leg_" + c, Sub: c}}
}

// dialBrowserLeg drives Session.OfferLeg directly (a function call, not HTTP) with a REAL Pion
// PeerConnection standing in for a browser client — the same fake-browser pattern
// integration_test.go's dialFakeBrowser uses against the control API, adapted to call the
// session package directly since these are white-box, same-package tests.
func dialBrowserLeg(t *testing.T, sess *Session, legID string) *webrtc.PeerConnection {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "fake-"+legID,
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticRTP: %v", err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatalf("AddTrack: %v", err)
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		t.Fatalf("AddTransceiverFromKind: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("SetLocalDescription: %v", err)
	}
	select {
	case <-gatherComplete:
	case <-time.After(10 * time.Second):
		t.Fatalf("client ICE gathering did not complete")
	}

	answerSDP, err := sess.OfferLeg(legID, pc.LocalDescription().SDP)
	if err != nil {
		t.Fatalf("OfferLeg(%s): %v", legID, err)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answerSDP}); err != nil {
		t.Fatalf("SetRemoteDescription(answer): %v", err)
	}

	return pc
}

// TestOnInboundRTPFansOutToAllPeersThreeWay is the regression test for the fan-out generalization
// (session.go peerLegs/onInboundRTP): a 3-leg session must forward each leg's RTP to BOTH other
// legs' outbound tracks, one track per remote source, never to itself. Uses real (but never
// ICE/DTLS-connected) PeerConnections — TrackLocalStaticRTP.WriteRTP against a track with no
// bound senders yet is a documented no-op success (see pion/webrtc's writeRTP: ranging over zero
// bindings returns a nil error), so onInboundRTP's forwarding bookkeeping below is exercised
// exactly as it would be over a real connected call, without needing real ICE.
func TestOnInboundRTPFansOutToAllPeersThreeWay(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", threeLegs("alice", "bob", "carol"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	allLegIDs := []string{"leg_alice", "leg_bob", "leg_carol"}
	for _, legID := range allLegIDs {
		sess.mu.Lock()
		l := sess.legs[legID]
		sess.mu.Unlock()
		if _, err := sess.newPeerConnectionForLeg(l); err != nil {
			t.Fatalf("newPeerConnectionForLeg(%s): %v", legID, err)
		}
		t.Cleanup(func() {
			l.mu.Lock()
			pc := l.pc
			l.mu.Unlock()
			if pc != nil {
				_ = pc.Close()
			}
		})
	}

	// Every leg must have exactly N-1=2 outbound tracks: one per OTHER peer, never one for
	// itself — the "no single mixed track" no-decode SFU design.
	for _, legID := range allLegIDs {
		sess.mu.Lock()
		l := sess.legs[legID]
		sess.mu.Unlock()
		l.mu.Lock()
		n := len(l.outboundTracks)
		_, self := l.outboundTracks[legID]
		l.mu.Unlock()
		if n != 2 {
			t.Errorf("%s has %d outbound tracks, want 2 (one per other peer)", legID, n)
		}
		if self {
			t.Errorf("%s unexpectedly has an outbound track keyed to itself", legID)
		}
	}

	pkt := &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 1, Timestamp: 10000, SSRC: 0xAAAA},
		Payload: []byte{0xfc, 0x01, 0x02},
	}
	sess.onInboundRTP("leg_alice", pkt)

	for _, legID := range []string{"leg_bob", "leg_carol"} {
		sess.mu.Lock()
		l := sess.legs[legID]
		sess.mu.Unlock()
		l.mu.Lock()
		ot := l.outboundTracks["leg_alice"]
		l.mu.Unlock()
		if ot == nil {
			t.Fatalf("%s missing outbound track for leg_alice", legID)
		}
		if got := ot.sentPackets.Load(); got != 1 {
			t.Errorf("%s outbound track for leg_alice: sentPackets = %d, want 1", legID, got)
		}
		if got := ot.sentOctets.Load(); got != uint32(len(pkt.Payload)) {
			t.Errorf("%s outbound track for leg_alice: sentOctets = %d, want %d", legID, got, len(pkt.Payload))
		}
		if !ot.haveLastForwardedRTP.Load() {
			t.Errorf("%s outbound track for leg_alice: haveLastForwardedRTP = false, want true", legID)
		}
	}

	// leg_alice's own outbound tracks (toward bob/carol) must be untouched by its OWN inbound
	// packet — nothing was forwarded back to itself.
	sess.mu.Lock()
	aliceLeg := sess.legs["leg_alice"]
	sess.mu.Unlock()
	aliceLeg.mu.Lock()
	for peerID, ot := range aliceLeg.outboundTracks {
		if ot.sentPackets.Load() != 0 {
			t.Errorf("leg_alice's outbound track for %s: sentPackets = %d, want 0 (alice's own packet must not loop back through her)", peerID, ot.sentPackets.Load())
		}
	}
	aliceLeg.mu.Unlock()
}

// TestAddLegThenRenegotiateOffersNewTrackForJoiner is the end-to-end regression test for the
// add-leg + server-initiated-renegotiation control-plane addition: adding a joiner to a session
// with two ALREADY-connected legs must (1) immediately provision an outbound track for the
// joiner on each existing leg's PeerConnection, (2) have RenegotiateLeg produce a fresh OFFER
// that actually references that new track, and (3) accept the client's real answer via
// AnswerLeg, completing the renegotiation.
func TestAddLegThenRenegotiateOffersNewTrackForJoiner(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	alicePC := dialBrowserLeg(t, sess, "leg_alice")
	_ = dialBrowserLeg(t, sess, "leg_bob")

	if err := sess.AddLeg("leg_carol", "carol"); err != nil {
		t.Fatalf("AddLeg: %v", err)
	}

	// Both already-connected legs must have gained an outbound track for carol immediately —
	// before carol's own client has offered anything.
	for _, legID := range []string{"leg_alice", "leg_bob"} {
		sess.mu.Lock()
		l := sess.legs[legID]
		sess.mu.Unlock()
		l.mu.Lock()
		_, ok := l.outboundTracks["leg_carol"]
		l.mu.Unlock()
		if !ok {
			t.Fatalf("%s missing an outbound track for leg_carol after AddLeg", legID)
		}
	}

	offerSDP, err := sess.RenegotiateLeg("leg_alice")
	if err != nil {
		t.Fatalf("RenegotiateLeg: %v", err)
	}
	if !strings.Contains(offerSDP, "mediad-leg_carol") {
		t.Fatalf("renegotiation offer for leg_alice does not reference the new leg_carol track:\n%s", offerSDP)
	}

	// A second RenegotiateLeg while alice's negotiation is still open (client hasn't answered
	// yet, but negotiating.Lock() was already released — Renegotiate/Answer are two separate
	// control-API calls) is allowed by design; what must NOT be allowed is calling it WHILE the
	// current call is still in flight, which isn't observable at this granularity — covered
	// instead by the ErrLegBusy unit coverage OfferLeg already has for the same negotiating lock.

	// Drive the client side of the renegotiation for real: alice's fake browser accepts the
	// server offer and answers it, then AnswerLeg must apply that answer successfully.
	if err := alicePC.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		t.Fatalf("client SetRemoteDescription(offer): %v", err)
	}
	answer, err := alicePC.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("client CreateAnswer: %v", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(alicePC)
	if err := alicePC.SetLocalDescription(answer); err != nil {
		t.Fatalf("client SetLocalDescription(answer): %v", err)
	}
	select {
	case <-gatherComplete:
	case <-time.After(10 * time.Second):
		t.Fatalf("client ICE gathering did not complete")
	}

	if err := sess.AnswerLeg("leg_alice", alicePC.LocalDescription().SDP); err != nil {
		t.Fatalf("AnswerLeg: %v", err)
	}
}

// TestRenegotiateLegUnconnectedLegIsError covers RenegotiateLeg/AnswerLeg's guard against a leg
// that has never offered (no PeerConnection yet) — there is nothing to renegotiate.
func TestRenegotiateLegUnconnectedLegIsError(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if _, err := sess.RenegotiateLeg("leg_alice"); !errors.Is(err, ErrLegNotConnected) {
		t.Fatalf("RenegotiateLeg on a never-offered leg = %v, want ErrLegNotConnected", err)
	}
	if err := sess.AnswerLeg("leg_alice", "v=0\r\n"); !errors.Is(err, ErrLegNotConnected) {
		t.Fatalf("AnswerLeg on a never-offered leg = %v, want ErrLegNotConnected", err)
	}
}

// TestRemoveLegDropsOutboundTrackFromPeers is the regression test for the remove-leg control
// plane addition: removing a leaver must drop the outbound track every OTHER live leg was using
// for its audio, exclude it from further fan-out (peerLegs), yet keep it in s.legs/legOrder so
// finalize's manifest/mixLegs still cover its already-recorded audio.
func TestRemoveLegDropsOutboundTrackFromPeers(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", threeLegs("alice", "bob", "carol"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	dialBrowserLeg(t, sess, "leg_alice")
	dialBrowserLeg(t, sess, "leg_bob")
	dialBrowserLeg(t, sess, "leg_carol")

	sess.mu.Lock()
	alice := sess.legs["leg_alice"]
	sess.mu.Unlock()

	alice.mu.Lock()
	_, hadTrack := alice.outboundTracks["leg_carol"]
	alice.mu.Unlock()
	if !hadTrack {
		t.Fatalf("expected leg_alice to have an outbound track for leg_carol before removal")
	}

	if err := sess.RemoveLeg("leg_carol"); err != nil {
		t.Fatalf("RemoveLeg: %v", err)
	}

	alice.mu.Lock()
	_, stillHasTrack := alice.outboundTracks["leg_carol"]
	alice.mu.Unlock()
	if stillHasTrack {
		t.Fatalf("expected leg_alice's outbound track for leg_carol to be dropped after RemoveLeg")
	}

	for _, p := range sess.peerLegs("leg_alice") {
		if p.id == "leg_carol" {
			t.Fatalf("expected leg_carol to be excluded from leg_alice's peers after RemoveLeg")
		}
	}

	sess.mu.Lock()
	_, stillInLegs := sess.legs["leg_carol"]
	stillInOrder := false
	for _, id := range sess.legOrder {
		if id == "leg_carol" {
			stillInOrder = true
		}
	}
	sess.mu.Unlock()
	if !stillInLegs || !stillInOrder {
		t.Fatalf("expected leg_carol to remain in s.legs/legOrder (for finalize) after RemoveLeg: inLegs=%v inOrder=%v", stillInLegs, stillInOrder)
	}

	if _, err := sess.RenegotiateLeg("leg_carol"); !errors.Is(err, ErrLegNotConnected) {
		t.Fatalf("RenegotiateLeg(leg_carol) after removal = %v, want ErrLegNotConnected", err)
	}

	// Idempotent — a second removal is a no-op, not an error.
	if err := sess.RemoveLeg("leg_carol"); err != nil {
		t.Fatalf("second RemoveLeg (idempotent) = %v, want nil", err)
	}

	// Removing a leg that was never in the session at all is still ErrLegNotFound.
	if err := sess.RemoveLeg("leg_does_not_exist"); !errors.Is(err, ErrLegNotFound) {
		t.Fatalf("RemoveLeg(unknown leg) = %v, want ErrLegNotFound", err)
	}
}

// TestAddLegEnforcesMaxLegsPerSession covers AddLeg's participant cap (config.MaxLegsPerSession),
// counting only ACTIVE (non-left) legs — the multi-party analogue of
// TestCreateSessionEnforcesSessionCap.
func TestAddLegEnforcesMaxLegsPerSession(t *testing.T) {
	cfg := testConfig(t)
	cfg.MaxLegsPerSession = 2
	mgr, err := NewManager(cfg)
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := sess.AddLeg("leg_carol", "carol"); !errors.Is(err, ErrTooManyLegs) {
		t.Fatalf("AddLeg beyond the cap = %v, want ErrTooManyLegs", err)
	}

	// Removing a leg frees its slot — the cap counts ACTIVE legs, not every leg ever seen.
	if err := sess.RemoveLeg("leg_bob"); err != nil {
		t.Fatalf("RemoveLeg: %v", err)
	}
	if err := sess.AddLeg("leg_carol", "carol"); err != nil {
		t.Fatalf("AddLeg after freeing a slot: %v", err)
	}
}

// TestAddLegDuplicateLegIDIsError covers AddLeg's rejection of a legId already present in the
// session (live or already-left — legIDs are never reused within a session).
func TestAddLegDuplicateLegIDIsError(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := sess.AddLeg("leg_alice", "alice"); !errors.Is(err, ErrLegAlreadyExists) {
		t.Fatalf("AddLeg with a duplicate legId = %v, want ErrLegAlreadyExists", err)
	}
}

// TestMixLegsThreeWay is the regression test for mixLegs' 2-input-to-N-input generalization: it
// must build a valid N-way ffmpeg adelay+amix filter graph (not just the old hand-built 2-input
// one) and produce a real, non-empty mixed output file whose analytically-computed duration
// reflects all three legs' offsets/durations. Uses real Ogg/Opus files written through
// recorder.Leg (same fixture style integration_test.go's sendFrames produces), constructed as
// disk-recovery-shaped *leg values (rec == nil, startOffsetMs/durationMs set directly) — the
// exact same shape remixIfMissing/remixFromDisk feed mixLegs in production.
func TestMixLegsThreeWay(t *testing.T) {
	dir := t.TempDir()
	t0 := time.Now()

	names := []string{"alice", "bob", "carol"}
	offsetsMs := []int64{0, 30, 90} // artificial, deterministic join-time gaps
	legs := make([]*leg, len(names))

	for i, name := range names {
		offset := offsetsMs[i]
		path := filepath.Join(dir, "leg_"+name+".ogg")
		rec, err := recorder.NewLeg(path, t0, recorder.Options{
			Now: func() time.Time { return t0.Add(time.Duration(offset) * time.Millisecond) },
		})
		if err != nil {
			t.Fatalf("recorder.NewLeg(%s): %v", name, err)
		}

		const tsStep = 960
		baseTS := uint32(10000)
		for j := range 20 {
			rec.Push(&rtp.Packet{
				Header:  rtp.Header{SequenceNumber: uint16(j), Timestamp: baseTS + uint32(j)*tsStep, SSRC: uint32(i + 1)}, //nolint:gosec // test fixture
				Payload: []byte{0xfc, 0x01, 0x02},
			})
		}

		durationMs, err := rec.Close()
		if err != nil {
			t.Fatalf("rec.Close(%s): %v", name, err)
		}
		if durationMs <= 0 {
			t.Fatalf("leg %s recorded durationMs = %d, want > 0", name, durationMs)
		}

		legs[i] = &leg{id: "leg_" + name, path: path, durationMs: durationMs, startOffsetMs: rec.StartOffsetMs()}
	}

	outPath := filepath.Join(dir, "mixed.m4a")
	mixedDurationMs, err := mixLegs("ffmpeg", legs, outPath)
	if err != nil {
		t.Fatalf("mixLegs: %v", err)
	}
	if mixedDurationMs <= 0 {
		t.Fatalf("mixLegs duration = %d, want > 0", mixedDurationMs)
	}
	// The mixed output must span at least as long as the latest-starting leg's own duration, and
	// roughly cover the ~90ms spread the three legs' offsets introduce.
	if mixedDurationMs < 300 {
		t.Errorf("mixLegs duration = %dms, want at least ~300ms (20 frames * 20ms) plus offset spread", mixedDurationMs)
	}

	info, err := os.Stat(outPath)
	if err != nil {
		t.Fatalf("stat mixed output: %v", err)
	}
	if info.Size() == 0 {
		t.Fatalf("mixed output %s is empty", outPath)
	}
}

// TestMixLegsRejectsZeroLegs covers mixLegs' input-validation floor — unchanged by the N-way
// generalization (still needs at least one leg to do anything).
func TestMixLegsRejectsZeroLegs(t *testing.T) {
	if _, err := mixLegs("ffmpeg", nil, filepath.Join(t.TempDir(), "out.m4a")); err == nil {
		t.Fatalf("mixLegs with zero legs: expected an error, got nil")
	}
}
