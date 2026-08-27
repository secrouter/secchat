// Package oggwriter implements an incremental Ogg/Opus container writer with an
// explicit, caller-supplied granule position per packet (RFC 3533 pages, RFC 7845 Opus-in-Ogg
// mapping).
//
// Pion's own webrtc/pkg/media/oggwriter accumulates the granule position internally, by summing
// each written packet's OWN decoded sample count in call order — it has no public hook to advance
// the granule by anything other than "the packet I was just given." That shape assumes in-order,
// gap-free delivery: feed it packets out of order and the accumulated granule no longer
// corresponds to wall-clock/RTP time; feed it a stream with a lost packet and the gap is silently
// absorbed (total duration just comes out short) rather than represented as a gap in the file.
//
// docs/plans/voice-calls-plan.md (v3.1 REQUIRED #1) calls for exactly the opposite: loss should
// show up as a granule gap, and Opus DTX silence gaps must reproduce correctly. Both fall out for
// free if the granule position is derived from the RTP timestamp instead of accumulated
// packet-by-packet — RTP timestamps run on Opus's own 48 kHz clock, a 1:1 match with Ogg's Opus
// granule rate, so "elapsed samples since this segment's first packet" is just a timestamp
// subtraction, and it doesn't care whether packets in between were lost or simply never sent
// (DTX). See internal/recorder for the granule computation itself; this package only writes
// pages for whatever granule position it's given, in the "one packet, one page" shape described
// in the plan (page-level flush — a crash loses at most the last, unflushed page).
package oggwriter

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"sync"
)

const (
	pageHeaderSize = 27
	maxSegmentSize = 255

	pageSignature = "OggS"
	idSignature   = "OpusHead"
	commentSig    = "OpusTags"
	vendorString  = "secchat-mediad"

	headerTypeNone = 0x00
	headerTypeBOS  = 0x02 // beginning of stream
	headerTypeEOS  = 0x04 // end of stream

	// SampleRate is the fixed Opus/Ogg granule clock — always 48 kHz regardless of the
	// negotiated encoding sample rate (RFC 7845 §4).
	SampleRate = 48000
)

var (
	// ErrClosed is returned by WritePacket after Close.
	ErrClosed = errors.New("oggwriter: writer is closed")
	// ErrEmptyPayload is returned by WritePacket for a zero-length payload.
	ErrEmptyPayload = errors.New("oggwriter: empty payload")
)

// Writer is a single-track (single logical Opus stream) incremental Ogg writer. One Writer per
// recorded leg's file.
type Writer struct {
	mu sync.Mutex
	f  *os.File

	serial    uint32
	pageIndex uint32
	closed    bool

	haveFirst    bool
	firstGranule uint64
	lastGranule  uint64

	preSkip uint16

	checksumTable [256]uint32
}

// New creates the file at path and writes the OpusHead/OpusTags header pages. channels is the
// Opus channel count (1 or 2); preSkip is the RFC 7845 pre-skip sample count (the Opus encoder's
// standard priming delay — 3840 samples is the RFC-recommended default and what browsers emit).
func New(path string, channels uint8, preSkip uint16) (*Writer, error) {
	if channels != 1 && channels != 2 {
		return nil, fmt.Errorf("oggwriter: unsupported channel count %d", channels)
	}

	f, err := os.Create(path) //nolint:gosec // path is server-controlled (session dir), not user input
	if err != nil {
		return nil, fmt.Errorf("oggwriter: create %s: %w", path, err)
	}

	w := &Writer{
		f:             f,
		serial:        randSerial(),
		preSkip:       preSkip,
		checksumTable: generateChecksumTable(),
	}

	if err := w.writeHeaderPages(channels); err != nil {
		_ = f.Close()

		return nil, err
	}

	return w, nil
}

func randSerial() uint32 {
	// Cryptographic randomness isn't needed for an Ogg bitstream serial — it only needs to be
	// distinct across concurrent tracks, which per-session file naming already guarantees.
	return rand.Uint32() //nolint:gosec
}

func (w *Writer) writeHeaderPages(channels uint8) error {
	id := buildIDHeader(channels, w.preSkip)
	if err := w.writePage(id, headerTypeBOS, 0); err != nil {
		return err
	}

	comment := buildCommentHeader()

	return w.writePage(comment, headerTypeNone, 0)
}

// WritePacket writes one Opus packet (the RTP payload, already stripped of the RTP header) as an
// Ogg page at the given absolute granule position. granule MUST be monotonically
// non-decreasing across calls (the caller — internal/recorder — guarantees this by deriving it
// from RTP timestamps within an always-advancing segment); a caller bug that violates this is
// clamped rather than corrupting the file (Ogg page order must not un-advance).
//
// Each call flushes to disk before returning (page-level durability, per the plan: a crash loses
// at most this call's page, not the file).
func (w *Writer) WritePacket(payload []byte, granule uint64) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return ErrClosed
	}
	if len(payload) == 0 {
		return ErrEmptyPayload
	}

	if !w.haveFirst {
		w.haveFirst = true
		w.firstGranule = granule
	}
	if granule < w.lastGranule {
		granule = w.lastGranule
	}

	if err := w.writePage(payload, headerTypeNone, granule); err != nil {
		return err
	}
	w.lastGranule = granule

	return w.f.Sync()
}

// Close writes the end-of-stream page (carrying the final granule position, so players compute
// the correct duration) and closes the file. Idempotent. Returns the recorded duration in
// milliseconds (samples since the first packet, i.e. the pre-skip-adjusted decodable length).
func (w *Writer) Close() (durationMs int64, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return w.durationMsLocked(), nil
	}

	err = w.writePage(nil, headerTypeEOS, w.lastGranule)
	w.closed = true

	if cerr := w.f.Close(); cerr != nil {
		err = errors.Join(err, cerr)
	}

	return w.durationMsLocked(), err
}

func (w *Writer) durationMsLocked() int64 {
	if w.lastGranule <= uint64(w.preSkip) {
		return 0
	}

	samples := w.lastGranule - uint64(w.preSkip)

	return int64(samples * 1000 / SampleRate) //nolint:gosec // bounded by session activeDeadline
}

// writePage assembles and writes a single Ogg page. Every packet this writer ever handles
// (Opus frames are at most 1275 bytes) fits in one page's segment table (max 255 * 255 bytes),
// so pages never need to span a packet across a continuation — one call, one page.
func (w *Writer) writePage(payload []byte, headerType uint8, granule uint64) error {
	segments := lacingValues(len(payload))
	if len(segments) > 255 {
		return fmt.Errorf("oggwriter: payload too large for a single Ogg page (%d bytes)", len(payload))
	}

	page := make([]byte, pageHeaderSize+len(segments)+len(payload))
	copy(page[0:], pageSignature)
	page[4] = 0 // version
	page[5] = headerType
	binary.LittleEndian.PutUint64(page[6:], granule)
	binary.LittleEndian.PutUint32(page[14:], w.serial)
	binary.LittleEndian.PutUint32(page[18:], w.pageIndex)
	// page[22:26] checksum, filled below
	page[26] = uint8(len(segments)) //nolint:gosec // <= 255, checked above

	copy(page[pageHeaderSize:], segments)
	copy(page[pageHeaderSize+len(segments):], payload)

	checksum := oggChecksum(&w.checksumTable, page)
	binary.LittleEndian.PutUint32(page[22:], checksum)

	if _, err := w.f.Write(page); err != nil {
		return fmt.Errorf("oggwriter: write page: %w", err)
	}
	w.pageIndex++

	return nil
}

// lacingValues builds the Ogg segment (lacing) table for a payload of length n: as many 255
// entries as needed, then a final entry < 255 (0 if n is an exact multiple of 255) that marks
// the packet complete within this page.
func lacingValues(n int) []byte {
	segs := make([]byte, 0, n/maxSegmentSize+1)
	for n >= maxSegmentSize {
		segs = append(segs, maxSegmentSize)
		n -= maxSegmentSize
	}

	return append(segs, byte(n)) //nolint:gosec // n < 255 here
}

func buildIDHeader(channels uint8, preSkip uint16) []byte {
	h := make([]byte, 19)
	copy(h[0:], idSignature)
	h[8] = 1 // version
	h[9] = channels
	binary.LittleEndian.PutUint16(h[10:], preSkip)
	binary.LittleEndian.PutUint32(h[12:], SampleRate) // input sample rate (informational)
	binary.LittleEndian.PutUint16(h[16:], 0)          // output gain
	h[18] = 0                                         // channel mapping family 0 (mono/stereo, no table)

	return h
}

func buildCommentHeader() []byte {
	payload := make([]byte, 0, len(commentSig)+4+len(vendorString)+4)
	payload = append(payload, commentSig...)

	vendorLen := make([]byte, 4)
	binary.LittleEndian.PutUint32(vendorLen, uint32(len(vendorString))) //nolint:gosec // constant, short
	payload = append(payload, vendorLen...)
	payload = append(payload, vendorString...)

	// Zero user comments.
	commentCount := make([]byte, 4)
	payload = append(payload, commentCount...)

	return payload
}

// generateChecksumTable builds the CRC-32 lookup table for Ogg's specified polynomial
// (0x04c11db7, MSB-first / non-reflected — RFC 3533 §5). Distinct from the common
// reflected CRC-32 (zip/ethernet); Ogg readers reject pages checksummed with the wrong variant.
func generateChecksumTable() [256]uint32 {
	var table [256]uint32
	const poly = 0x04c11db7

	for i := range table {
		remainder := uint32(i) << 24
		for range 8 {
			if remainder&0x80000000 != 0 {
				remainder = (remainder << 1) ^ poly
			} else {
				remainder <<= 1
			}
		}
		table[i] = remainder
	}

	return table
}

func oggChecksum(table *[256]uint32, page []byte) uint32 {
	var checksum uint32
	for _, b := range page {
		checksum = (checksum << 8) ^ table[byte(checksum>>24)^b]
	}

	return checksum
}
