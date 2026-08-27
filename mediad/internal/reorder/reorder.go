// Package reorder implements the sequence-number reorder/dedup buffer required in front of the
// OGG/Opus writer (docs/plans/voice-calls-plan.md §2.3/§3.2, v3.1 REQUIRED #1). RTP arrives over
// UDP with no ordering guarantee; feeding out-of-order packets straight into an incremental,
// granule-accumulating Ogg writer corrupts pages. Buffer holds a small bounded window of
// out-of-order arrivals and emits them to the caller in RTP sequence-number order, dropping exact
// duplicates. A permanently missing packet (genuine loss) is given up on — once the window fills
// or it's been missing too long — and the sequence simply advances past it: the caller (the
// recorder) sees a gap in sequence numbers, which is exactly what turns into a granule gap
// (docs/plans/voice-calls-plan.md: "loss policy: skip -> granule gap (no PLC; we never decode)").
package reorder

import (
	"sort"
	"time"

	"github.com/pion/rtp"
)

// Buffer reorders and dedups RTP packets for one RTP stream (one SSRC's worth of sequence
// numbers at a time — see the recorder package for how a new SSRC after a re-attach is handled;
// this Buffer itself is SSRC-agnostic and just tracks sequence numbers as they arrive).
//
// Not safe for concurrent Push calls from multiple goroutines (RTP for a single track is read by
// one goroutine in mediad's session package); Push may call the emit callback synchronously and
// reentrantly is NOT supported (emit must not call back into Push).
type Buffer struct {
	window  int
	maxWait time.Duration
	now     func() time.Time
	emit    func(*rtp.Packet)

	haveNext bool
	nextSeq  uint16
	pending  map[uint16]*rtp.Packet

	waitStart time.Time
}

// New builds a Buffer. window bounds how many out-of-order packets it will hold before giving up
// on the oldest missing sequence number and advancing past it (packet-count based backstop).
// maxWait is a wall-clock backstop for the same decision (0 disables the time-based check,
// leaving window as the sole bound) — useful because a small window sized for typical Opus
// 20 ms framing could otherwise wait indefinitely if the stream stalls with few packets in
// flight. now is injectable for deterministic tests; nil defaults to time.Now.
func New(window int, maxWait time.Duration, now func() time.Time, emit func(*rtp.Packet)) *Buffer {
	if window < 1 {
		window = 1
	}
	if now == nil {
		now = time.Now
	}
	return &Buffer{
		window:  window,
		maxWait: maxWait,
		now:     now,
		emit:    emit,
		pending: make(map[uint16]*rtp.Packet, window),
	}
}

// seqDiff returns seq-of a minus seq-of b as a signed delta, wraparound-aware per RFC 3550's
// convention for comparing 16-bit RTP sequence numbers.
func seqDiff(a, b uint16) int32 {
	return int32(int16(a - b))
}

// Push admits one packet. Packets at or behind the already-emitted point (duplicates, or
// arriving so late the buffer already gave up and moved past their sequence number) are dropped
// silently. In-order packets are emitted immediately (and may then drain further packets already
// held pending); out-of-order packets are held until the gap closes or the buffer gives up.
func (b *Buffer) Push(pkt *rtp.Packet) {
	if pkt == nil {
		return
	}
	seq := pkt.SequenceNumber
	if !b.haveNext {
		b.haveNext = true
		b.nextSeq = seq
	}
	if seqDiff(seq, b.nextSeq) < 0 {
		return // duplicate or already-passed — drop
	}
	if _, dup := b.pending[seq]; dup {
		return
	}
	b.pending[seq] = pkt
	b.drain()
}

// Flush emits every packet still held, in ascending sequence order relative to the current
// expected sequence number, without further waiting — for use at leg/session end so no buffered
// audio is silently lost. It does not attempt to fill remaining gaps.
func (b *Buffer) Flush() {
	if len(b.pending) == 0 {
		return
	}
	seqs := make([]uint16, 0, len(b.pending))
	for s := range b.pending {
		seqs = append(seqs, s)
	}
	sort.Slice(seqs, func(i, j int) bool { return seqDiff(seqs[i], b.nextSeq) < seqDiff(seqs[j], b.nextSeq) })
	for _, s := range seqs {
		pkt := b.pending[s]
		delete(b.pending, s)
		b.nextSeq = s + 1
		b.waitStart = time.Time{}
		b.emit(pkt)
	}
}

func (b *Buffer) drain() {
	for {
		if pkt, ok := b.pending[b.nextSeq]; ok {
			delete(b.pending, b.nextSeq)
			b.nextSeq++
			b.waitStart = time.Time{}
			b.emit(pkt)

			continue
		}
		if len(b.pending) == 0 {
			return // nothing held ahead of the gap — just wait for more Pushes
		}
		if b.waitStart.IsZero() {
			b.waitStart = b.now()
		}
		if len(b.pending) >= b.window || (b.maxWait > 0 && b.now().Sub(b.waitStart) >= b.maxWait) {
			// Give up on nextSeq: treat it as permanently lost and advance past it. The
			// resulting sequence-number gap is exactly what the recorder turns into a granule
			// gap (RTP-timestamp-derived granule naturally reflects the real elapsed time).
			b.nextSeq++
			b.waitStart = time.Time{}

			continue
		}

		return
	}
}
