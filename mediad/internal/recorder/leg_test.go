package recorder

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/rtp"

	"secchat-mediad/internal/oggwriter"
)

// oggDataPage is a minimal, from-scratch parse of one Ogg page's granule/payload — independent
// of internal/oggwriter's own implementation, so these tests catch integration bugs between
// recorder's granule computation and what actually lands on disk.
type oggDataPage struct {
	headerType uint8
	granule    uint64
	payload    []byte
}

func parseDataPages(t *testing.T, path string) []oggDataPage {
	t.Helper()

	data, err := os.ReadFile(path) //nolint:gosec
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}

	var pages []oggDataPage
	for len(data) > 0 {
		if len(data) < 27 || string(data[0:4]) != "OggS" {
			t.Fatalf("malformed ogg stream")
		}
		headerType := data[5]
		granule := binary.LittleEndian.Uint64(data[6:14])
		segCount := int(data[26])
		segs := data[27 : 27+segCount]
		payloadLen := 0
		for _, s := range segs {
			payloadLen += int(s)
		}
		payload := data[27+segCount : 27+segCount+payloadLen]
		pages = append(pages, oggDataPage{headerType: headerType, granule: granule, payload: append([]byte(nil), payload...)})
		data = data[27+segCount+payloadLen:]
	}

	// Drop the two header pages (OpusHead, OpusTags) — callers want only data(+EOS) pages.
	if len(pages) < 2 {
		t.Fatalf("expected at least 2 header pages, got %d", len(pages))
	}

	return pages[2:]
}

func rtpOpusPacket(seq uint16, ts uint32, ssrc uint32, payload []byte) *rtp.Packet {
	return &rtp.Packet{
		Header: rtp.Header{
			SequenceNumber: seq,
			Timestamp:      ts,
			SSRC:           ssrc,
		},
		Payload: payload,
	}
}

func newTestLeg(t *testing.T, now Clock) (*Leg, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "leg.ogg")
	l, err := NewLeg(path, now(), Options{Now: now, PreSkip: 3840})
	if err != nil {
		t.Fatalf("NewLeg: %v", err)
	}

	return l, path
}

// 20ms of Opus at 48kHz = 960 samples/frame; a fixed dummy payload is fine since neither
// recorder nor oggwriter decode Opus.
const framePayloadByte = 0xfc

func frame() []byte { return []byte{framePayloadByte, 0x01, 0x02} }

func TestOutOfOrderDuplicateAndLostRTPProducesValidOggWithGranuleGap(t *testing.T) {
	base := time.Unix(1000, 0)
	now := base
	clock := func() Clock { return func() time.Time { return now } }()

	l, path := newTestLeg(t, clock)

	const ssrc = 0xAAAA
	// Sequence 0..4 at 960-sample (20ms) spacing, timestamp base 10000. Seq 2 is permanently
	// lost. Arrival ORDER is scrambled and seq 1 arrives twice (duplicate).
	send := func(seq uint16, tsOffset uint32) {
		l.Push(rtpOpusPacket(seq, 10000+tsOffset, ssrc, frame()))
	}

	send(0, 0)
	send(1, 960)
	send(1, 960) // duplicate — must not double-write
	send(3, 960*3)
	send(4, 960*4) // seq 2 (960*2) never arrives — permanent loss
	// window default is 16; force the buffer to give up on seq 2 by advancing past maxWait.
	now = now.Add(300 * time.Millisecond)
	send(5, 960*5) // triggers the maxWait backstop on re-check

	if _, err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	pages := parseDataPages(t, path)
	// seq 2 was dropped, everything else (0,1,3,4,5) should be one data page each, plus EOS.
	dataPages := pages[:len(pages)-1]
	if len(dataPages) != 5 {
		t.Fatalf("expected 5 data pages (seq 0,1,3,4,5; seq 1 dup + seq 2 loss excluded), got %d", len(dataPages))
	}

	wantGranules := []uint64{
		3840 + 0,
		3840 + 960,
		3840 + 960*3, // the jump from 960*1 to 960*3 IS the granule gap left by lost seq 2
		3840 + 960*4,
		3840 + 960*5,
	}
	for i, g := range wantGranules {
		if dataPages[i].granule != g {
			t.Fatalf("data page %d granule = %d, want %d", i, dataPages[i].granule, g)
		}
	}
	// The gap between page 1 (seq1) and page 2 (seq3) must be exactly two frames' worth of
	// samples (960*2) — the missing seq 2's duration, preserved as silence in the timeline
	// rather than smoothed away.
	if gap := dataPages[2].granule - dataPages[1].granule; gap != 960*2 {
		t.Fatalf("granule gap across the lost packet = %d, want %d", gap, 960*2)
	}
}

func TestDTXTimestampJumpProducesCorrectGranule(t *testing.T) {
	base := time.Unix(2000, 0)
	now := base
	clock := func() time.Time { return now }

	l, path := newTestLeg(t, clock)
	const ssrc = 0xBEEF

	// Two frames, then a long DTX silence (no packets sent at all — usedtx=1), then speech
	// resumes with an RTP timestamp far ahead (the DTX gap, ~2 seconds of silence = 96000
	// samples at 48kHz).
	l.Push(rtpOpusPacket(0, 20000, ssrc, frame()))
	l.Push(rtpOpusPacket(1, 20960, ssrc, frame()))
	const dtxSamples = 96000
	l.Push(rtpOpusPacket(2, 20960+dtxSamples, ssrc, frame()))

	if _, err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	pages := parseDataPages(t, path)
	dataPages := pages[:len(pages)-1]
	if len(dataPages) != 3 {
		t.Fatalf("expected 3 data pages, got %d", len(dataPages))
	}
	gotJump := dataPages[2].granule - dataPages[1].granule
	if gotJump != dtxSamples {
		t.Fatalf("DTX granule jump = %d, want %d (the silence duration must reproduce exactly)", gotJump, dtxSamples)
	}
}

// TestOnFirstPacketFiresOnceOutsideLock is the regression test for v3.1 suggested #6's
// recorder.Options.OnFirstPacket hook: it must fire EXACTLY once (the very first packet this leg
// ever records, not on every re-attach segment) with the correct startOffsetMs, and it must fire
// OUTSIDE l.mu — calling back into the Leg's own exported methods (which also take l.mu) from
// inside the callback must not deadlock.
func TestOnFirstPacketFiresOnceOutsideLock(t *testing.T) {
	base := time.Unix(4000, 0)
	now := base
	clock := func() time.Time { return now }

	sessionT0 := base.Add(-250 * time.Millisecond) // this leg answered 250ms after session t0
	path := filepath.Join(t.TempDir(), "leg.ogg")

	l, err := NewLeg(path, sessionT0, Options{Now: clock, PreSkip: 3840})
	if err != nil {
		t.Fatalf("NewLeg: %v", err)
	}

	var calls []int64
	l.onFirstPacket = func(startOffsetMs int64) {
		calls = append(calls, startOffsetMs)
		// Would deadlock here if handleOrdered still held l.mu when firing this callback.
		_ = l.StartOffsetMs()
		_ = l.Segments()
	}

	const ssrcA = 0x9999
	l.Push(rtpOpusPacket(0, 10000, ssrcA, frame()))
	l.Push(rtpOpusPacket(1, 10960, ssrcA, frame()))

	// A re-attach (new SSRC) must NOT fire onFirstPacket again — it already fired for this leg's
	// very first packet ever.
	now = now.Add(2 * time.Second)
	const ssrcB = 0x8888
	l.Push(rtpOpusPacket(0, 1000, ssrcB, frame()))

	if _, err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	if len(calls) != 1 {
		t.Fatalf("onFirstPacket called %d times, want exactly 1: %v", len(calls), calls)
	}
	if calls[0] != 250 {
		t.Fatalf("onFirstPacket startOffsetMs = %d, want 250", calls[0])
	}
}

func TestReattachNewSSRCStartsNewSegment(t *testing.T) {
	base := time.Unix(3000, 0)
	now := base
	clock := func() time.Time { return now }

	sessionT0 := base.Add(-500 * time.Millisecond) // this leg answered 500ms after session t0
	path := filepath.Join(t.TempDir(), "leg.ogg")
	l, err := NewLeg(path, sessionT0, Options{Now: clock, PreSkip: 3840})
	if err != nil {
		t.Fatalf("NewLeg: %v", err)
	}

	const ssrcA = 0x1111
	l.Push(rtpOpusPacket(0, 50000, ssrcA, frame()))
	now = now.Add(20 * time.Millisecond)
	l.Push(rtpOpusPacket(1, 50960, ssrcA, frame()))

	if got := l.StartOffsetMs(); got != 500 {
		t.Fatalf("StartOffsetMs = %d, want 500", got)
	}
	if got := l.Segments(); got != 1 {
		t.Fatalf("Segments = %d, want 1 before any re-attach", got)
	}

	// Simulate an ICE blip + reconnect: 3 real seconds pass, a brand-new PeerConnection means a
	// brand-new SSRC and a RESET RTP timestamp base (starts back near 0, not continuing from
	// 50960+).
	now = now.Add(3 * time.Second)
	const ssrcB = 0x2222
	l.Push(rtpOpusPacket(0, 1000, ssrcB, frame())) // new PC's own sequence/timestamp numbering

	if got := l.Segments(); got != 2 {
		t.Fatalf("Segments after re-attach = %d, want 2", got)
	}
	// StartOffsetMs must NOT change on re-attach — it's the leg's original join time.
	if got := l.StartOffsetMs(); got != 500 {
		t.Fatalf("StartOffsetMs after re-attach = %d, want unchanged 500", got)
	}

	if _, err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	pages := parseDataPages(t, path)
	dataPages := pages[:len(pages)-1]
	if len(dataPages) != 3 {
		t.Fatalf("expected 3 data pages (2 pre-reattach + 1 post), got %d", len(dataPages))
	}

	// Granule must be monotonically non-decreasing across the SSRC change — no backward jump,
	// no collision with segment 1's granules, even though segment 2's own RTP timestamp
	// restarted near zero.
	if dataPages[2].granule <= dataPages[1].granule {
		t.Fatalf("granule went non-monotonic across re-attach: %d -> %d", dataPages[1].granule, dataPages[2].granule)
	}
	// The bridge should land close to "3 seconds after segment 1's last granule" (roughly
	// 3*48000 = 144000 samples further along), not reset to near 3840 (which would silently
	// overlap segment 1's audio in the merged timeline).
	gap := dataPages[2].granule - dataPages[1].granule
	const wantApprox = 3 * oggwriter.SampleRate
	if gap < wantApprox-oggwriter.SampleRate/2 || gap > wantApprox+oggwriter.SampleRate/2 {
		t.Fatalf("re-attach granule bridge = %d samples, want roughly %d (the real reconnect gap)", gap, wantApprox)
	}
}
