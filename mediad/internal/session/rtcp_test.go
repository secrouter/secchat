package session

import (
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// TestExtrapolatedRTPTimeAdvancesOnThe48kHzClock is the regression test for v3.1 suggested #4:
// the RTCP Sender Report's RTPTime must extrapolate from the last packet actually forwarded onto
// this outbound track's stream, on THAT stream's 48kHz clock — not wall-clock Unix seconds (which
// has no relationship to the RTP timebase at all).
func TestExtrapolatedRTPTimeAdvancesOnThe48kHzClock(t *testing.T) {
	ot := &outboundTrack{}
	base := time.Unix(1_700_000_000, 0)
	ot.lastForwardedRTPTimestamp.Store(50000)
	ot.lastForwardedAtUnixNano.Store(base.UnixNano())
	ot.haveLastForwardedRTP.Store(true)

	// 100ms later at 48kHz = 4800 samples further along the SAME RTP timeline the forwarded
	// packet was on.
	got := ot.extrapolatedRTPTime(base.Add(100 * time.Millisecond))
	want := uint32(50000 + 4800)
	if got != want {
		t.Fatalf("extrapolatedRTPTime = %d, want %d", got, want)
	}
}

func TestExtrapolatedRTPTimeNoElapsedTimeReturnsBaseTimestamp(t *testing.T) {
	ot := &outboundTrack{}
	base := time.Unix(1_700_000_000, 0)
	ot.lastForwardedRTPTimestamp.Store(12345)
	ot.lastForwardedAtUnixNano.Store(base.UnixNano())
	ot.haveLastForwardedRTP.Store(true)

	if got := ot.extrapolatedRTPTime(base); got != 12345 {
		t.Fatalf("extrapolatedRTPTime at zero elapsed = %d, want 12345 (the base timestamp unchanged)", got)
	}
}

// TestExtrapolatedRTPTimeWrapsAroundUint32 exercises the same wraparound RTP timestamps
// themselves must handle (RFC 3550) — extrapolatedRTPTime must not clamp or error, just wrap.
func TestExtrapolatedRTPTimeWrapsAroundUint32(t *testing.T) {
	ot := &outboundTrack{}
	base := time.Unix(1_700_000_000, 0)
	nearMax := ^uint32(0) - 100
	ot.lastForwardedRTPTimestamp.Store(nearMax)
	ot.lastForwardedAtUnixNano.Store(base.UnixNano())
	ot.haveLastForwardedRTP.Store(true)

	got := ot.extrapolatedRTPTime(base.Add(10 * time.Millisecond)) // 480 samples at 48kHz
	want := nearMax + 480                                          // wraps past uint32 max naturally
	if got != want {
		t.Fatalf("extrapolatedRTPTime = %d, want %d (uint32 wraparound)", got, want)
	}
}

// setupOriginLegWithVideoTrack builds a session with a single leg, gives it a real (but never
// ICE/DTLS-connected — WriteRTCP against an unconnected pc is exercised for its side effects on
// mediad's OWN bookkeeping, not for anything actually reaching a wire) PeerConnection, and admits
// one video track with a known SSRC — the shape forwardPLIToOrigin/handleOutboundVideoRTCP need:
// a live pc plus a leg.inboundTracks entry to route the PLI's MediaSSRC from.
func setupOriginLegWithVideoTrack(t *testing.T, ssrc webrtc.SSRC) (*Session, string) {
	t.Helper()

	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", oneLeg("alice"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	sess.mu.Lock()
	alice := sess.legs["leg_alice"]
	sess.mu.Unlock()

	pc, err := sess.newPeerConnectionForLeg(alice)
	if err != nil {
		t.Fatalf("newPeerConnectionForLeg: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	trackKey := videoTrackKey("alice-cam")
	if !sess.admitInboundTrack(alice, trackKey, webrtc.RTPCodecTypeVideo, ssrc) {
		t.Fatalf("admitInboundTrack: rejected, want admitted")
	}

	return sess, trackKey
}

// lastPLISentAt reads back the origin track's rate-limit bookkeeping — the only externally
// observable effect of a (successful-or-not, WriteRTCP-wise) forwardPLIToOrigin call against an
// unconnected test PeerConnection, so it stands in for "a PLI was attempted" below.
func lastPLISentAt(t *testing.T, sess *Session, legID, trackKey string) int64 {
	t.Helper()

	sess.mu.Lock()
	l, ok := sess.legs[legID]
	sess.mu.Unlock()
	if !ok {
		t.Fatalf("lastPLISentAt: unknown leg %s", legID)
	}

	l.mu.Lock()
	info, ok := l.inboundTracks[trackKey]
	l.mu.Unlock()
	if !ok {
		t.Fatalf("lastPLISentAt: leg %s has no inbound track %s", legID, trackKey)
	}

	return info.lastPLISentAtUnixNano.Load()
}

// TestForwardPLIToOriginReachesOriginTrack is the regression test for PLI reverse-routing
// (offer.go's forwardPLIToOrigin): given a viewer's PLI for one outbound video track, mediad must
// attempt to send a PictureLossIndication to the ORIGINATING leg's pc, using that track's
// persisted origin inbound SSRC (recorded by admitInboundTrack/OnTrack) as MediaSSRC — observed
// here via the rate-limit bookkeeping actually advancing from "never sent".
func TestForwardPLIToOriginReachesOriginTrack(t *testing.T) {
	const originSSRC = webrtc.SSRC(0xC0FFEE)
	sess, trackKey := setupOriginLegWithVideoTrack(t, originSSRC)

	if got := lastPLISentAt(t, sess, "leg_alice", trackKey); got != 0 {
		t.Fatalf("lastPLISentAtUnixNano before any PLI = %d, want 0", got)
	}

	sess.forwardPLIToOrigin("leg_alice", trackKey)

	if got := lastPLISentAt(t, sess, "leg_alice", trackKey); got == 0 {
		t.Fatalf("expected forwardPLIToOrigin to record an attempt (lastPLISentAtUnixNano still 0)")
	}
}

// TestForwardPLIToOriginRateLimits is the regression test for the required rate limit: N viewers
// losing a frame around the same time must collapse to at most one forwarded PLI per
// pliMinInterval, not N. Uses the Manager's injectable clock (mgr.now) to control elapsed time
// deterministically rather than racing real wall-clock sleeps against a 500ms window.
func TestForwardPLIToOriginRateLimits(t *testing.T) {
	const originSSRC = webrtc.SSRC(0xFEED)
	sess, trackKey := setupOriginLegWithVideoTrack(t, originSSRC)

	now := time.Unix(1_700_000_000, 0)
	sess.mgr.now = func() time.Time { return now }

	sess.forwardPLIToOrigin("leg_alice", trackKey)
	first := lastPLISentAt(t, sess, "leg_alice", trackKey)
	if first == 0 {
		t.Fatalf("expected the first forwardPLIToOrigin call to record an attempt")
	}

	// A second viewer's PLI arrives 100ms later — well within pliMinInterval (500ms) — must be
	// suppressed, not forwarded again.
	now = now.Add(100 * time.Millisecond)
	sess.forwardPLIToOrigin("leg_alice", trackKey)
	if got := lastPLISentAt(t, sess, "leg_alice", trackKey); got != first {
		t.Fatalf("a PLI within pliMinInterval must be rate-limited: lastPLISentAtUnixNano changed from %d to %d", first, got)
	}

	// A third PLI arrives after pliMinInterval has elapsed — must be forwarded.
	now = now.Add(pliMinInterval + time.Millisecond)
	sess.forwardPLIToOrigin("leg_alice", trackKey)
	if got := lastPLISentAt(t, sess, "leg_alice", trackKey); got == first {
		t.Fatalf("expected a PLI after pliMinInterval has elapsed to be forwarded (lastPLISentAtUnixNano unchanged)")
	}
}

// TestForwardPLIToOriginUnknownLegOrTrackIsNoop covers forwardPLIToOrigin's defensive guards: an
// unknown legID, or a legID whose leg has no inbound track for the given trackKey, must return
// without panicking (a peer's outbound track can theoretically outlive its origin's bookkeeping
// during a concurrent RemoveLeg — see multiparty.go).
func TestForwardPLIToOriginUnknownLegOrTrackIsNoop(t *testing.T) {
	sess, trackKey := setupOriginLegWithVideoTrack(t, webrtc.SSRC(1))

	sess.forwardPLIToOrigin("leg_does_not_exist", trackKey)      // must not panic
	sess.forwardPLIToOrigin("leg_alice", videoTrackKey("other")) // must not panic
}

// TestHandleOutboundVideoRTCPTriggersOnPLIAndFIR is the regression test for drainRTCP's video
// branch (split into handleOutboundVideoRTCP for testability without a real connected sender):
// both PictureLossIndication and FullIntraRequest packets read off a video outbound track's
// sender RTCP must trigger a forwarded PLI to the origin.
func TestHandleOutboundVideoRTCPTriggersOnPLIAndFIR(t *testing.T) {
	for _, tc := range []struct {
		name string
		pkt  rtcp.Packet
	}{
		{"PLI", &rtcp.PictureLossIndication{MediaSSRC: 0xAAAA}},
		{"FIR", &rtcp.FullIntraRequest{MediaSSRC: 0xAAAA, FIR: []rtcp.FIREntry{{SSRC: 0xAAAA, SequenceNumber: 1}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sess, trackKey := setupOriginLegWithVideoTrack(t, webrtc.SSRC(0xAAAA))

			raw, err := tc.pkt.Marshal()
			if err != nil {
				t.Fatalf("Marshal %s: %v", tc.name, err)
			}

			sess.handleOutboundVideoRTCP(raw, "leg_alice", trackKey)

			if got := lastPLISentAt(t, sess, "leg_alice", trackKey); got == 0 {
				t.Fatalf("%s: expected handleOutboundVideoRTCP to forward a PLI to the origin", tc.name)
			}
		})
	}
}

// TestHandleOutboundVideoRTCPIgnoresOtherPacketTypes confirms non-PLI/FIR sender RTCP (e.g. a
// ReceiverEstimatedMaximumBitrate, which video's registered RTCPFeedback also advertises via
// goog-remb) does NOT trigger a forwarded PLI — only loss/keyframe-request packets should.
func TestHandleOutboundVideoRTCPIgnoresOtherPacketTypes(t *testing.T) {
	sess, trackKey := setupOriginLegWithVideoTrack(t, webrtc.SSRC(0xBBBB))

	sr := &rtcp.SenderReport{SSRC: 0xBBBB}
	raw, err := sr.Marshal()
	if err != nil {
		t.Fatalf("Marshal SenderReport: %v", err)
	}

	sess.handleOutboundVideoRTCP(raw, "leg_alice", trackKey)

	if got := lastPLISentAt(t, sess, "leg_alice", trackKey); got != 0 {
		t.Fatalf("expected a non-PLI/FIR packet to NOT forward a PLI, but lastPLISentAtUnixNano = %d", got)
	}
}

// TestSendSenderReportsSkipsLegsWithNothingForwardedYet confirms a leg with a live PC but no
// outbound tracks/forwarded audio yet doesn't crash sendSenderReports (WriteRTCP is never reached
// for it — nothing meaningful to report, v3.1 suggested #4's "omit the SR rather than emit a
// wrong timestamp mapping").
func TestSendSenderReportsSkipsLegsWithNothingForwardedYet(t *testing.T) {
	mgr := newTestManager(t)

	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Neither leg has a PC yet (no offer sent), so neither has any outbound tracks — must be a
	// no-op, not a panic.
	sess.sendSenderReports()
}
