package oggwriter

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// rawPage is a structural (non-semantic) view of one parsed Ogg page, used only by tests to
// assert what Writer actually put on disk.
type rawPage struct {
	headerType uint8
	granule    uint64
	serial     uint32
	pageIndex  uint32
	checksum   uint32
	payload    []byte
}

// parsePages does an independent, from-spec re-implementation of Ogg page parsing (not reusing
// any Writer code) so the test can catch checksum/format bugs Writer itself would not.
func parsePages(t *testing.T, data []byte) []rawPage {
	t.Helper()

	table := generateChecksumTable()
	var pages []rawPage

	for len(data) > 0 {
		if len(data) < pageHeaderSize {
			t.Fatalf("trailing %d bytes too short for a page header", len(data))
		}
		if string(data[0:4]) != pageSignature {
			t.Fatalf("bad page signature %q", data[0:4])
		}

		headerType := data[5]
		granule := binary.LittleEndian.Uint64(data[6:14])
		serial := binary.LittleEndian.Uint32(data[14:18])
		pageIndex := binary.LittleEndian.Uint32(data[18:22])
		checksum := binary.LittleEndian.Uint32(data[22:26])
		segCount := int(data[26])

		if len(data) < pageHeaderSize+segCount {
			t.Fatalf("truncated segment table")
		}
		segs := data[pageHeaderSize : pageHeaderSize+segCount]

		payloadLen := 0
		for _, s := range segs {
			payloadLen += int(s)
		}

		total := pageHeaderSize + segCount + payloadLen
		if len(data) < total {
			t.Fatalf("truncated page payload: need %d, have %d", total, len(data))
		}
		payload := data[pageHeaderSize+segCount : total]

		// Recompute the checksum with the checksum field zeroed, as the spec requires.
		pageCopy := make([]byte, total)
		copy(pageCopy, data[:total])
		pageCopy[22], pageCopy[23], pageCopy[24], pageCopy[25] = 0, 0, 0, 0
		want := oggChecksum(&table, pageCopy)
		if want != checksum {
			t.Fatalf("page %d: checksum mismatch: header says %#x, computed %#x", pageIndex, checksum, want)
		}

		pages = append(pages, rawPage{
			headerType: headerType,
			granule:    granule,
			serial:     serial,
			pageIndex:  pageIndex,
			checksum:   checksum,
			payload:    payload,
		})

		data = data[total:]
	}

	return pages
}

func TestHeaderPages(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "leg.ogg")

	w, err := New(path, 1, 3840)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := w.WritePacket([]byte{0xf8, 0xff, 0xfe}, 4000); err != nil {
		t.Fatalf("WritePacket: %v", err)
	}
	if _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	data, err := os.ReadFile(path) //nolint:gosec
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	pages := parsePages(t, data)

	if len(pages) != 4 {
		t.Fatalf("expected 4 pages (id, comment, one data page, EOS), got %d", len(pages))
	}
	if pages[0].headerType != headerTypeBOS {
		t.Fatalf("page 0 should be BOS, got header type %#x", pages[0].headerType)
	}
	if string(pages[0].payload[0:8]) != idSignature {
		t.Fatalf("page 0 payload should start with OpusHead, got %q", pages[0].payload[0:8])
	}
	if string(pages[1].payload[0:8]) != commentSig {
		t.Fatalf("page 1 payload should start with OpusTags, got %q", pages[1].payload[0:8])
	}
	if pages[3].headerType != headerTypeEOS {
		t.Fatalf("final page should be EOS, got header type %#x", pages[3].headerType)
	}
	// All pages for one track share one serial number.
	for i, p := range pages {
		if p.serial != pages[0].serial {
			t.Fatalf("page %d has serial %d, want %d", i, p.serial, pages[0].serial)
		}
	}
}

func TestGranulePositionsAreWrittenVerbatimAndMonotonic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "leg.ogg")

	w, err := New(path, 1, 3840)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Simulate a granule gap (loss/DTX): 4000 -> 4960 -> 40000 (big jump).
	granules := []uint64{4000, 4960, 40000}
	for _, g := range granules {
		if err := w.WritePacket([]byte{0xf8, 0xff, 0xfe}, g); err != nil {
			t.Fatalf("WritePacket: %v", err)
		}
	}
	durationMs, err := w.Close()
	if err != nil {
		t.Fatalf("Close: %v", err)
	}

	data, err := os.ReadFile(path) //nolint:gosec
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	pages := parsePages(t, data)

	// pages[0]=id, [1]=comment, [2..4]=data, [5]=EOS
	if len(pages) != 6 {
		t.Fatalf("expected 6 pages, got %d", len(pages))
	}
	gotGranules := []uint64{pages[2].granule, pages[3].granule, pages[4].granule}
	for i, want := range granules {
		if gotGranules[i] != want {
			t.Fatalf("data page %d: granule = %d, want %d", i, gotGranules[i], want)
		}
	}
	// The gap between the second and third packet (4960 -> 40000) is the granule gap a lost
	// run of packets or a DTX silence produces — assert it actually shows up as a big jump,
	// not smoothed away.
	if gap := gotGranules[2] - gotGranules[1]; gap < 30000 {
		t.Fatalf("expected a large granule gap reflecting the skip, got %d", gap)
	}

	wantDurationMs := int64((40000 - 3840) * 1000 / SampleRate)
	if durationMs != wantDurationMs {
		t.Fatalf("durationMs = %d, want %d", durationMs, wantDurationMs)
	}
}

func TestWritePacketAfterCloseErrors(t *testing.T) {
	dir := t.TempDir()
	w, err := New(filepath.Join(dir, "leg.ogg"), 1, 3840)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := w.WritePacket([]byte{1, 2, 3}, 5000); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed, got %v", err)
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	w, err := New(filepath.Join(dir, "leg.ogg"), 1, 3840)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := w.WritePacket([]byte{1, 2, 3}, 5000); err != nil {
		t.Fatalf("WritePacket: %v", err)
	}
	d1, err := w.Close()
	if err != nil {
		t.Fatalf("Close 1: %v", err)
	}
	d2, err := w.Close()
	if err != nil {
		t.Fatalf("Close 2: %v", err)
	}
	if d1 != d2 {
		t.Fatalf("Close is not idempotent: %d != %d", d1, d2)
	}
}

func TestLargePacketSpansSegmentTable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "leg.ogg")
	w, err := New(path, 2, 3840)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Opus packets can run up to ~1275 bytes at high bitrate; make sure a payload spanning
	// multiple 255-byte lacing segments round-trips.
	payload := make([]byte, 600)
	for i := range payload {
		payload[i] = byte(i)
	}
	if err := w.WritePacket(payload, 5000); err != nil {
		t.Fatalf("WritePacket: %v", err)
	}
	if _, err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	data, err := os.ReadFile(path) //nolint:gosec
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	pages := parsePages(t, data)
	if len(pages[2].payload) != len(payload) {
		t.Fatalf("payload length = %d, want %d", len(pages[2].payload), len(payload))
	}
	for i := range payload {
		if pages[2].payload[i] != payload[i] {
			t.Fatalf("payload byte %d mismatch", i)
		}
	}
}
