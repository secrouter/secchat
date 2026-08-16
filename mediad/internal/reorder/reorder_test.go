package reorder

import (
	"testing"
	"time"

	"github.com/pion/rtp"
)

func pkt(seq uint16) *rtp.Packet {
	return &rtp.Packet{Header: rtp.Header{SequenceNumber: seq}}
}

func TestInOrderPassesThroughImmediately(t *testing.T) {
	var got []uint16
	b := New(8, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	for _, s := range []uint16{1, 2, 3, 4} {
		b.Push(pkt(s))
	}

	want := []uint16{1, 2, 3, 4}
	assertSeqs(t, got, want)
}

func TestOutOfOrderIsReordered(t *testing.T) {
	var got []uint16
	b := New(8, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	// arrival order: 1, 3, 2, 4 — must be emitted in sequence order 1,2,3,4
	b.Push(pkt(1))
	b.Push(pkt(3))
	if len(got) != 1 {
		t.Fatalf("expected only seq 1 emitted while 2 is missing, got %v", got)
	}
	b.Push(pkt(2))
	b.Push(pkt(4))

	assertSeqs(t, got, []uint16{1, 2, 3, 4})
}

func TestDuplicatesAreDropped(t *testing.T) {
	var got []uint16
	b := New(8, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(1))
	b.Push(pkt(1)) // exact duplicate of an already-emitted packet
	b.Push(pkt(2))
	b.Push(pkt(2)) // exact duplicate of an already-emitted packet

	assertSeqs(t, got, []uint16{1, 2})
}

func TestDuplicateWhilePendingIsDropped(t *testing.T) {
	var got []uint16
	b := New(8, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(1))
	b.Push(pkt(3)) // held pending, waiting on 2
	b.Push(pkt(3)) // duplicate of the pending packet — must not double-emit
	b.Push(pkt(2))

	assertSeqs(t, got, []uint16{1, 2, 3})
}

func TestLostPacketIsSkippedOnceWindowFills(t *testing.T) {
	var got []uint16
	// window=2: once 2 packets are held waiting on the gap, give up on the missing one.
	b := New(2, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(1))
	// seq 2 is permanently lost; 3 and 4 arrive and fill the window, forcing a skip of 2.
	b.Push(pkt(3))
	b.Push(pkt(4))

	assertSeqs(t, got, []uint16{1, 3, 4})
}

func TestLostPacketIsSkippedAfterMaxWait(t *testing.T) {
	var got []uint16
	now := time.Unix(0, 0)
	clock := func() time.Time { return now }
	b := New(8, 50*time.Millisecond, clock, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(1))
	b.Push(pkt(3)) // seq 2 missing; window (8) not full, so it's the maxWait backstop that fires
	if len(got) != 1 {
		t.Fatalf("expected seq 2's absence to still be blocking emission, got %v", got)
	}

	now = now.Add(60 * time.Millisecond)
	b.Push(pkt(4)) // any subsequent Push re-checks the wait clock and gives up on seq 2

	assertSeqs(t, got, []uint16{1, 3, 4})
}

func TestSequenceWraparound(t *testing.T) {
	var got []uint16
	b := New(8, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(65534))
	b.Push(pkt(0)) // wrapped around uint16
	b.Push(pkt(65535))

	assertSeqs(t, got, []uint16{65534, 65535, 0})
}

func TestFlushEmitsRemainingHeldPacketsInOrder(t *testing.T) {
	var got []uint16
	b := New(8, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(1))
	b.Push(pkt(4))
	b.Push(pkt(3)) // 2 never arrives (session ends)
	if len(got) != 1 {
		t.Fatalf("expected 3 and 4 still held pending seq 2, got %v", got)
	}

	b.Flush()

	assertSeqs(t, got, []uint16{1, 3, 4})
}

func TestLateArrivalAfterGivingUpIsDropped(t *testing.T) {
	var got []uint16
	b := New(2, 0, nil, func(p *rtp.Packet) { got = append(got, p.SequenceNumber) })

	b.Push(pkt(1))
	b.Push(pkt(3))
	b.Push(pkt(4)) // window fills, seq 2 given up on and skipped
	assertSeqs(t, got, []uint16{1, 3, 4})

	b.Push(pkt(2)) // arrives very late, after the buffer already moved past it
	assertSeqs(t, got, []uint16{1, 3, 4})
}

func assertSeqs(t *testing.T, got, want []uint16) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
