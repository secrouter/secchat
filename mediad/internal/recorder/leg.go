// Package recorder ties the reorder/dedup buffer (internal/reorder) and the Ogg/Opus writer
// (internal/oggwriter) together per leg, and owns the two remaining v3.1 REQUIRED correctness
// items that live above the writer:
//
//   - Shared cross-leg timebase (REQUIRED #2): each Leg is constructed with the session's t0, and
//     records its own start_offset_ms — its first RTP packet's wall-clock arrival relative to
//     that t0 — for the finalize manifest (docs/plans/voice-contracts.md §2.4).
//   - Leg re-attach semantics (REQUIRED #4): a new SSRC on an already-recording leg means a new
//     PeerConnection (client reconnect, not an ICE-restart-preserving-SSRC blip — those never
//     change the SSRC and so never hit this path). The Leg starts a new internal "segment": the
//     granule mapping is re-based to the real wall-clock elapsed time since the leg's very first
//     packet, bridging the reconnect gap, rather than restarting the file's timeline at zero
//     (which would desync it from the other leg and from this leg's own already-written audio).
package recorder

import (
	"sync"
	"time"

	"github.com/pion/rtp"

	"secchat-mediad/internal/oggwriter"
	"secchat-mediad/internal/reorder"
)

// DefaultPreSkip is the RFC 7845-recommended Opus pre-skip sample count.
const DefaultPreSkip = 3840

// Clock is injectable for deterministic tests (docs/plans convention: "pure + injected clock").
type Clock func() time.Time

// Leg records one participant's RTP Opus stream to one Ogg/Opus file.
type Leg struct {
	now       Clock
	sessionT0 time.Time

	writer *oggwriter.Writer

	reorderWindow  int
	reorderMaxWait time.Duration

	mu sync.Mutex

	// buf is per-SSRC: RTP sequence numbers only mean "ordering" within one SSRC's stream, so a
	// re-attach's new SSRC (which restarts sequence numbering, often near 0) must not be
	// evaluated against the OLD SSRC's sequence-number cursor — reorder.Buffer would otherwise
	// see it as hopelessly "behind" and silently drop the entire reconnected stream. Push
	// recreates buf (flushing the old one first) whenever the incoming SSRC changes.
	buf     *reorder.Buffer
	bufSSRC uint32
	haveBuf bool

	haveFirstEver bool
	firstEverAt   time.Time
	startOffsetMs int64

	// onFirstPacket, if set, fires exactly once — after this leg's first-ever packet establishes
	// startOffsetMs, called OUTSIDE l.mu (see handleOrdered) so a slow sidecar write (v3.1
	// suggested #6: recorder.Leg has no other reason to know about the session directory or
	// manifest conventions, so this stays a plain callback rather than reaching into the session
	// package) never blocks this leg's own subsequent Push calls for longer than the write takes.
	onFirstPacket func(startOffsetMs int64)

	haveSegment bool
	segments    int
	segSSRC     uint32
	segBaseTS   uint32
	segOrigin   int64

	preSkip uint16

	closed         bool
	lastErr        error
	lastDurationMs int64
}

// Options configure a Leg beyond the required (path, sessionT0) pair.
type Options struct {
	// ReorderWindow bounds how many out-of-order packets the reorder buffer holds before giving
	// up on a gap (see internal/reorder). Zero uses a sensible default.
	ReorderWindow int
	// ReorderMaxWait is the wall-clock backstop for the same decision. Zero uses a sensible
	// default; negative disables the time-based check (window-count is then the sole bound).
	ReorderMaxWait time.Duration
	// Channels is the Opus channel count written to the Ogg header (1 or 2). Zero defaults to 1
	// (mono), matching what browsers negotiate for voice calls absent stereo=1).
	Channels uint8
	// PreSkip overrides DefaultPreSkip (tests use this to match fixture Opus streams).
	PreSkip uint16
	// Now overrides time.Now for deterministic tests.
	Now Clock
	// OnFirstPacket, if set, is called exactly once, the first time this leg records a packet —
	// see the Leg.onFirstPacket field doc.
	OnFirstPacket func(startOffsetMs int64)
}

const (
	defaultReorderWindow  = 16 // ~320ms of 20ms Opus frames — generous for LAN/VPN jitter
	defaultReorderMaxWait = 200 * time.Millisecond
)

// NewLeg creates the Ogg/Opus file at path and wires up its reorder buffer. sessionT0 is the
// session-wide origin (docs/plans/voice-contracts.md §2.1's "session's shared t0") that
// StartOffsetMs is measured against.
func NewLeg(path string, sessionT0 time.Time, opts Options) (*Leg, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	channels := opts.Channels
	if channels == 0 {
		channels = 1
	}
	preSkip := opts.PreSkip
	if preSkip == 0 {
		preSkip = DefaultPreSkip
	}
	window := opts.ReorderWindow
	if window == 0 {
		window = defaultReorderWindow
	}
	maxWait := opts.ReorderMaxWait
	switch {
	case opts.ReorderMaxWait == 0:
		maxWait = defaultReorderMaxWait
	case opts.ReorderMaxWait < 0:
		maxWait = 0
	}

	w, err := oggwriter.New(path, channels, preSkip)
	if err != nil {
		return nil, err
	}

	l := &Leg{
		now:            now,
		sessionT0:      sessionT0,
		writer:         w,
		preSkip:        preSkip,
		reorderWindow:  window,
		reorderMaxWait: maxWait,
		onFirstPacket:  opts.OnFirstPacket,
	}

	return l, nil
}

// Push admits one RTP packet (already DTLS/SRTP-decrypted). It may synchronously write to the
// Ogg file (if this packet closes an ordering gap) or hold it briefly for reordering. Not safe
// for concurrent calls — mediad reads each leg's inbound track from a single goroutine.
func (l *Leg) Push(pkt *rtp.Packet) {
	buf := l.bufForSSRC(pkt.SSRC)
	buf.Push(pkt)
}

// bufForSSRC returns the reorder buffer for pkt's SSRC, swapping in a fresh one (after flushing
// whatever the previous SSRC's buffer was still holding) whenever the SSRC changes — see the
// Leg.buf field doc.
func (l *Leg) bufForSSRC(ssrc uint32) *reorder.Buffer {
	l.mu.Lock()
	if l.haveBuf && ssrc == l.bufSSRC {
		buf := l.buf
		l.mu.Unlock()

		return buf
	}
	old := l.buf
	l.buf = reorder.New(l.reorderWindow, l.reorderMaxWait, l.now, l.handleOrdered)
	l.bufSSRC = ssrc
	l.haveBuf = true
	buf := l.buf
	l.mu.Unlock()

	if old != nil {
		old.Flush() // drain whatever the previous SSRC's stream still had pending before switching
	}

	return buf
}

// handleOrdered is the reorder buffer's emit callback: packets arrive here already in RTP
// sequence-number order with duplicates removed (internal/reorder), so every correctness
// decision left is granule/segment bookkeeping. The one-time onFirstPacket notification fires
// AFTER releasing l.mu (see recordOrdered) so a slow callback (disk I/O) can't stall this leg's
// own subsequent Push calls.
func (l *Leg) handleOrdered(pkt *rtp.Packet) {
	isFirst, startOffsetMs := l.recordOrdered(pkt)
	if isFirst && l.onFirstPacket != nil {
		l.onFirstPacket(startOffsetMs)
	}
}

// recordOrdered does the actual granule/segment bookkeeping under l.mu and reports whether pkt
// was this leg's first-ever packet (and, if so, the startOffsetMs that established) so
// handleOrdered can fire onFirstPacket outside the lock.
func (l *Leg) recordOrdered(pkt *rtp.Packet) (isFirst bool, startOffsetMs int64) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.closed {
		return false, 0
	}

	now := l.now()

	if !l.haveFirstEver {
		isFirst = true
		l.haveFirstEver = true
		l.firstEverAt = now
		l.startOffsetMs = now.Sub(l.sessionT0).Milliseconds()
		if l.startOffsetMs < 0 {
			l.startOffsetMs = 0
		}
	}
	startOffsetMs = l.startOffsetMs

	if !l.haveSegment || pkt.SSRC != l.segSSRC {
		l.startNewSegmentLocked(pkt, now)
	}

	if len(pkt.Payload) == 0 {
		return isFirst, startOffsetMs // RTP keepalive/padding-only packet; nothing to write
	}

	// RTP timestamps run on Opus's 48kHz clock — the same rate as the Ogg granule position —
	// so "samples since this segment's first packet" is a direct, rate-conversion-free
	// subtraction. int32 wraparound handles a single RTP timestamp wrap within the (deadline-
	// bounded, see session package) call duration.
	delta := int64(int32(pkt.Timestamp - l.segBaseTS)) //nolint:gosec // intentional wraparound-safe diff
	granule := l.segOrigin + delta
	if granule < 0 {
		granule = l.segOrigin // defensive: never write a negative/underflowing granule
	}

	if err := l.writer.WritePacket(pkt.Payload, uint64(granule)); err != nil { //nolint:gosec // granule >= 0 above
		l.lastErr = err
	}

	return isFirst, startOffsetMs
}

// startNewSegmentLocked begins a new granule-mapping segment for a (possibly new) SSRC. Called
// with mu held.
func (l *Leg) startNewSegmentLocked(pkt *rtp.Packet, now time.Time) {
	var origin int64
	if l.haveSegment {
		// Re-attach: a different SSRC than the one we were recording means a new
		// PeerConnection (ICE-restart-on-the-same-PC blips never change the SSRC and so never
		// reach here). Bridge the gap at the real wall-clock offset since this leg's very
		// first packet, so the file's timeline keeps matching reality instead of resetting.
		elapsed := now.Sub(l.firstEverAt)
		origin = int64(l.preSkip) + elapsed.Milliseconds()*oggwriter.SampleRate/1000
		l.segments++
	} else {
		origin = int64(l.preSkip)
		l.segments = 1
	}

	l.segSSRC = pkt.SSRC
	l.segBaseTS = pkt.Timestamp
	l.segOrigin = origin
	l.haveSegment = true
}

// StartOffsetMs is this leg's first-RTP-packet time relative to the session's t0 — the
// docs/plans-required value for the finalize manifest's per-leg startOffsetMs, used by the
// backend's transcript merge to place segments at leg.startOffsetMs + segment.start_ms.
// Zero until the first packet has been recorded.
func (l *Leg) StartOffsetMs() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.startOffsetMs
}

// Segments returns how many re-attach segments this leg has recorded (1 once any audio has been
// written, incrementing on each new-SSRC re-attach) — exposed for tests/observability, not part
// of the wire contract.
func (l *Leg) Segments() int {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.segments
}

// Close flushes any packets still held in the reorder buffer (so a session end never silently
// drops the last few hundred ms of audio) and closes the underlying Ogg file. Returns the
// recorded duration in milliseconds. Idempotent.
func (l *Leg) Close() (durationMs int64, err error) {
	l.mu.Lock()
	buf := l.buf
	l.mu.Unlock()
	if buf != nil {
		buf.Flush() // may synchronously call handleOrdered, which takes l.mu itself — do this unlocked
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.closed {
		return l.lastDurationMs, l.lastErr
	}

	dur, cerr := l.writer.Close()
	l.closed = true
	l.lastDurationMs = dur
	if l.lastErr == nil {
		l.lastErr = cerr
	}

	return dur, l.lastErr
}
