package session

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"secchat-mediad/internal/recorder"
)

const rtcpSenderReportInterval = 5 * time.Second

// leg is the runtime state for one participant of a call: its PeerConnection, one outbound
// track PER remote participant mediad forwards that participant's audio through (see
// outboundTrack — a single mixed track is forbidden by the no-decode design), and this leg's own
// recorder (which records what THIS leg's participant says — the audio mediad receives on its
// inbound track).
type leg struct {
	id  string
	sub string

	// negotiating serializes SDP offer/renegotiate/answer handling for this leg: the FIRST offer
	// creates the PC; any later offer while pc is non-nil is treated as a reconnect and does ICE
	// restart on the SAME PeerConnection (docs/plans/voice-contracts.md §2.2: "mediad detects
	// 'same leg, already-connected' and restarts ICE on the EXISTING PeerConnection ... rather
	// than allocating a new one"). TryLock failing (an offer/renegotiate/answer already being
	// processed for this leg) is what the contract's 409 leg_already_connected covers — see
	// offer.go/multiparty.go.
	negotiating sync.Mutex

	mu       sync.Mutex
	pc       *webrtc.PeerConnection
	iceState webrtc.ICEConnectionState

	// outboundTracks is keyed by SOURCE leg id: outboundTracks["leg_bob"] is the track this leg's
	// PeerConnection uses to carry leg_bob's forwarded audio. One TrackLocalStaticRTP (and one
	// SSRC) per remote source — mediad never decodes, so it can never mix multiple sources onto
	// one track; each stays a distinct RTP stream all the way to the client, which mixes locally.
	outboundTracks map[string]*outboundTrack

	// left marks a leg RemoveLeg has torn down: it stays in Session.legs/legOrder forever (so
	// finalize's manifest/mixLegs still include its already-recorded audio) but is excluded from
	// peerLegs — no further forwarding, and it never receives a fresh outboundTrack for a
	// still-live peer that joins after it left.
	left bool

	rec *recorder.Leg

	path       string // this leg's Ogg file path, absolute
	durationMs int64
	recErr     error

	// startOffsetMs is populated ONLY for legs reconstructed by finalize.go's disk-recovery path
	// (remixFromDisk), which has no live *recorder.Leg to ask — see legStartOffsetMs. Live legs
	// (rec != nil) get this from rec.StartOffsetMs() instead and leave this field zero.
	startOffsetMs int64
}

// outboundTrack is one leg's outbound RTP stream carrying a SINGLE remote source's forwarded
// audio (see leg.outboundTracks). Bundles the track itself with the per-stream RTCP Sender
// Report bookkeeping that used to live directly on leg back when each leg had exactly one
// outbound track (the fixed 2-leg relay) — now there are N of these per leg, one per peer.
type outboundTrack struct {
	track  *webrtc.TrackLocalStaticRTP
	sender *webrtc.RTPSender
	ssrc   webrtc.SSRC

	sentPackets atomic.Uint32
	sentOctets  atomic.Uint32

	// lastForwardedRTPTimestamp/lastForwardedAtUnixNano/haveLastForwardedRTP track the most
	// recent packet mediad forwarded onto this track — the origin client's own RTP timestamp
	// (mediad never rewrites it) plus the wall-clock instant it was forwarded. Read by
	// sendSenderReports to extrapolate a correct RTCP Sender Report RTPTime (v3.1 suggested #4)
	// on this stream's actual 48kHz clock, rather than a Unix-seconds value that has no
	// relationship to the RTP timebase. Lock-free (atomics) — updated from onInboundRTP's hot
	// path, read from the periodic RTCP ticker.
	lastForwardedRTPTimestamp atomic.Uint32
	lastForwardedAtUnixNano   atomic.Int64
	haveLastForwardedRTP      atomic.Bool
}

// legStartOffsetMs returns this leg's startOffsetMs regardless of whether it has a live
// recorder.Leg (the normal finalize path) or was reconstructed from disk after a crash
// (recoverFromDisk/remixFromDisk, using the offsets.json sidecar — v3.1 suggested #6). Letting
// both finalize paths share one mixLegs (finalize.go) is the point of this indirection.
func (l *leg) legStartOffsetMs() int64 {
	if l.rec != nil {
		return l.rec.StartOffsetMs()
	}

	return l.startOffsetMs
}

// Session is one recorded call: two legs, packet-level RTP forwarding between them, and the
// shared session t0 every leg's startOffsetMs is measured against
// (docs/plans/voice-contracts.md §2.1).
type Session struct {
	id        string
	callID    string
	dir       string
	t0        time.Time
	createdAt time.Time

	mgr *Manager

	mu       sync.Mutex
	legs     map[string]*leg
	legOrder []string // stable order: CreateSession's input, then AddLeg appends — manifest/state output
	ended    bool
	manifest *Manifest

	// legsReserved is AddLeg's session-scoped analogue of Manager.reserved: slots claimed against
	// MaxLegsPerSession while AddLeg's real file I/O (opening the new leg's recorder) is in
	// flight, before it lands in `legs` — closes the same TOCTOU gap Manager.CreateSession's
	// `reserved` field closes for SessionCap (two concurrent AddLeg calls could otherwise both
	// observe room and both proceed, exceeding the cap).
	legsReserved int

	// offsetsMu guards the offsets.json sidecar's read-modify-write (offsets.go's
	// recordLegOffset) — a separate mutex from mu since it's disk I/O triggered from a
	// recorder.Leg callback, not session-state bookkeeping.
	offsetsMu sync.Mutex

	stopRTCP chan struct{}
}

func newSession(mgr *Manager, id, callID, dir string, specs []LegSpec, t0 time.Time) (*Session, error) {
	s := &Session{
		id:        id,
		callID:    callID,
		dir:       dir,
		t0:        t0,
		createdAt: t0,
		mgr:       mgr,
		legs:      make(map[string]*leg, len(specs)),
		legOrder:  make([]string, 0, len(specs)),
		stopRTCP:  make(chan struct{}),
	}

	for _, spec := range specs {
		path := filepath.Join(dir, spec.LegID+".ogg")
		legID := spec.LegID
		rec, err := recorder.NewLeg(path, t0, recorder.Options{
			Now: mgr.now,
			OnFirstPacket: func(startOffsetMs int64) {
				s.recordLegOffset(legID, startOffsetMs)
			},
		})
		if err != nil {
			s.closeRecordersLocked()

			return nil, fmt.Errorf("session: open leg recorder %s: %w", spec.LegID, err)
		}
		s.legs[spec.LegID] = &leg{
			id: spec.LegID, sub: spec.Sub, rec: rec, path: path,
			// docs/plans/voice-contracts.md §2.3 documents iceState as one of Pion's actual
			// ICEConnectionState strings ("new", "checking", ...) — "new" until a PC exists
			// (OfferLeg creates it lazily on the first offer), not Go's zero-value "unknown".
			iceState:       webrtc.ICEConnectionStateNew,
			outboundTracks: make(map[string]*outboundTrack),
		}
		s.legOrder = append(s.legOrder, spec.LegID)
	}

	go s.rtcpLoop()

	return s, nil
}

func (s *Session) closeRecordersLocked() {
	for _, l := range s.legs {
		if l.rec != nil {
			_, _ = l.rec.Close()
		}
	}
}

// ID returns the session id.
func (s *Session) ID() string { return s.id }

// peerLegs returns every OTHER leg currently in the call (the forwarding targets) for legID —
// N-1 of them in an N-way session, none for a solo (1-leg) session. A leg that RemoveLeg has
// already torn down (leg.left) is excluded: it forwards nothing further and receives nothing
// further, even though it stays in s.legs/legOrder for finalize's sake.
func (s *Session) peerLegs(legID string) []*leg {
	s.mu.Lock()
	defer s.mu.Unlock()

	peers := make([]*leg, 0, len(s.legs))
	for id, l := range s.legs {
		if id == legID {
			continue
		}
		l.mu.Lock()
		left := l.left
		l.mu.Unlock()
		if left {
			continue
		}
		peers = append(peers, l)
	}

	return peers
}

// State backs GET /sessions/:id.
func (s *Session) State() SessionState {
	s.mu.Lock()
	defer s.mu.Unlock()

	recording := "none"
	states := make([]LegState, 0, len(s.legs))
	for _, legID := range s.legOrder {
		l, ok := s.legs[legID]
		if !ok {
			continue
		}
		l.mu.Lock()
		ice := l.iceState.String()
		l.mu.Unlock()
		states = append(states, LegState{LegID: legID, ICEState: ice})

		if l.hasRecordedAny() {
			recording = "on"
		}
	}

	return SessionState{SessionID: s.id, Legs: states, Recording: recording}
}

// hasRecordedAny reports whether this leg has written at least one packet — mediad's ACTUAL
// writer state for the "recording" field's truthfulness requirement (docs/plans/voice-calls-
// plan.md §2.3: "recording state is mediad's actual writer state").
func (l *leg) hasRecordedAny() bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.rec != nil && l.rec.Segments() > 0
}

// onInboundRTP is called for every RTP packet read from legID's inbound track: forwards it
// packet-level (no decode) to every OTHER live leg's outbound track keyed by legID (its
// per-source track carrying THIS leg's audio), and feeds it to this leg's own recorder. Order
// matches docs/plans/voice-calls-plan.md §2.3: the reorder/dedup buffer sits in front of the OGG
// writer ONLY — forwarding is real-time and unbuffered.
func (s *Session) onInboundRTP(legID string, pkt *rtp.Packet) {
	s.mu.Lock()
	self, ok := s.legs[legID]
	s.mu.Unlock()
	if !ok {
		return
	}

	for _, peer := range s.peerLegs(legID) {
		peer.mu.Lock()
		ot := peer.outboundTracks[legID]
		peer.mu.Unlock()
		if ot == nil {
			// Not wired up yet — shouldn't normally happen (ensureOutboundTrack provisions this
			// before either side's SDP exchange completes), but RTP arriving ahead of it is just
			// dropped rather than panicking.
			continue
		}

		if err := ot.track.WriteRTP(pkt); err != nil {
			if !errors.Is(err, io.ErrClosedPipe) {
				slog.Debug("mediad: forward RTP failed", "session", s.id, "leg", legID, "peer", peer.id, "err", err)
			}

			continue
		}

		ot.sentPackets.Add(1)
		ot.sentOctets.Add(uint32(len(pkt.Payload))) //nolint:gosec // Opus payloads are small
		// pkt.Timestamp rides straight through onto ot unmodified — it IS this stream's RTP
		// timebase from here on, so record it (+ when) for sendSenderReports' RTPTime
		// extrapolation (v3.1 suggested #4).
		ot.lastForwardedRTPTimestamp.Store(pkt.Timestamp)
		ot.lastForwardedAtUnixNano.Store(s.mgr.now().UnixNano())
		ot.haveLastForwardedRTP.Store(true)
	}

	self.rec.Push(pkt)
}

// rtcpLoop periodically emits a Sender Report per leg's outbound stream
// (docs/plans/voice-calls-plan.md §2.3: "RTCP: generate a Sender Report per leg (timebase +
// loss feedback); ignore PLI/FIR"). mediad never handles PLI/FIR: it's audio-only, and simply
// not registering a handler for them IS "ignore".
func (s *Session) rtcpLoop() {
	ticker := time.NewTicker(rtcpSenderReportInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopRTCP:
			return
		case <-ticker.C:
			s.sendSenderReports()
		}
	}
}

func (s *Session) sendSenderReports() {
	s.mu.Lock()
	legs := make([]*leg, 0, len(s.legs))
	for _, l := range s.legs {
		legs = append(legs, l)
	}
	s.mu.Unlock()

	now := s.mgr.now()
	ntp := ntpTimestamp(now)

	for _, l := range legs {
		l.mu.Lock()
		pc := l.pc
		tracks := make([]*outboundTrack, 0, len(l.outboundTracks))
		for _, ot := range l.outboundTracks {
			tracks = append(tracks, ot)
		}
		l.mu.Unlock()
		if pc == nil || len(tracks) == 0 {
			continue
		}

		// One Sender Report per outbound track (per remote source) on this leg's PC, batched into
		// a single WriteRTCP call. A track with nothing forwarded on it yet has no RTP timebase to
		// map NTPTime onto — omit it rather than emit a fabricated RTPTime (v3.1 suggested #4's
		// documented alternative to a wrong mapping); the next tick picks it up once forwarding
		// starts on that stream.
		srs := make([]rtcp.Packet, 0, len(tracks))
		for _, ot := range tracks {
			if !ot.haveLastForwardedRTP.Load() || ot.ssrc == 0 {
				continue
			}
			srs = append(srs, &rtcp.SenderReport{
				SSRC:        uint32(ot.ssrc),
				NTPTime:     ntp,
				RTPTime:     ot.extrapolatedRTPTime(now),
				PacketCount: ot.sentPackets.Load(),
				OctetCount:  ot.sentOctets.Load(),
			})
		}
		if len(srs) == 0 {
			continue
		}

		if err := pc.WriteRTCP(srs); err != nil {
			slog.Debug("mediad: write RTCP SR failed", "session", s.id, "leg", l.id, "err", err)
		}
	}
}

// rtpClockRate is the Opus/RTP clock rate mediad registers for every leg (manager.go's
// RTPCodecCapability{ClockRate: 48000}) — the rate extrapolatedRTPTime advances samples on.
const rtpClockRate = 48000

// extrapolatedRTPTime derives this outbound track's SR RTPTime by extrapolating forward from the
// last packet mediad actually forwarded onto it: that packet's own RTP timestamp (the origin
// client's 48kHz Opus clock, forwarded verbatim — see onInboundRTP) plus the real elapsed
// wall-clock time since it was forwarded, converted to samples on the SAME clock. This is the
// timebase a receiver doing SR-based RTP/NTP correlation actually needs; wall-clock Unix seconds
// (the prior implementation) has no relationship to it at all. Callers must check
// haveLastForwardedRTP first — this method assumes it's true.
func (ot *outboundTrack) extrapolatedRTPTime(now time.Time) uint32 {
	base := ot.lastForwardedRTPTimestamp.Load()
	firedAt := time.Unix(0, ot.lastForwardedAtUnixNano.Load())
	elapsed := now.Sub(firedAt)
	if elapsed < 0 {
		elapsed = 0
	}

	samples := uint32(elapsed.Seconds() * float64(rtpClockRate)) //nolint:gosec // bounded by the SR ticker interval, no realistic overflow

	return base + samples // uint32 wraparound is the correct RTP-timestamp arithmetic here
}

// ntpTimestamp converts a wall-clock time to a 64-bit NTP timestamp (seconds since 1900-01-01
// in the high 32 bits, fractional seconds in the low 32).
func ntpTimestamp(t time.Time) uint64 {
	const ntpEpochOffset = 2208988800 // seconds between 1900-01-01 and the Unix epoch
	sec := uint64(t.Unix()+ntpEpochOffset) & 0xffffffff
	frac := uint64(float64(t.Nanosecond()) / 1e9 * (1 << 32))

	return sec<<32 | frac
}

// closePeerConnections tears down every leg's PeerConnection without touching the recorders or
// running finalize — used by Manager.Close() (process shutdown) and by the janitor's
// force-finalize path (which calls finalizeLocked, itself calling this).
func (s *Session) closePeerConnections() {
	s.mu.Lock()
	legs := make([]*leg, 0, len(s.legs))
	for _, l := range s.legs {
		legs = append(legs, l)
	}
	s.mu.Unlock()

	for _, l := range legs {
		l.mu.Lock()
		pc := l.pc
		l.mu.Unlock()
		if pc != nil {
			_ = pc.Close()
		}
	}
}
