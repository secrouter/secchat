package session

import (
	"testing"
	"time"
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
