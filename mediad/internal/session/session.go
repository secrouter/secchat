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

// leg is the runtime state for one side of a call: its PeerConnection, the outbound track
// mediad forwards the OTHER leg's audio through, and this leg's own recorder (which records
// what THIS leg's participant says — the audio mediad receives on its inbound track).
type leg struct {
	id  string
	sub string

	// negotiating serializes SDP offer handling for this leg: the FIRST offer creates the PC;
	// any later offer while pc is non-nil is treated as a reconnect and does ICE restart on the
	// SAME PeerConnection (docs/plans/voice-contracts.md §2.2: "mediad detects 'same leg,
	// already-connected' and restarts ICE on the EXISTING PeerConnection ... rather than
	// allocating a new one"). TryLock failing (an offer already being processed for this leg)
	// is what the contract's 409 leg_already_connected covers — see offer.go.
	negotiating sync.Mutex

	mu       sync.Mutex
	pc       *webrtc.PeerConnection
	iceState webrtc.ICEConnectionState

	outboundTrack *webrtc.TrackLocalStaticRTP
	outboundSSRC  webrtc.SSRC
	sentPackets   atomic.Uint32
	sentOctets    atomic.Uint32

	// lastForwardedRTPTimestamp/lastForwardedAtUnixNano/haveLastForwardedRTP track the most
	// recent packet mediad forwarded onto this leg's outboundTrack — the origin client's own RTP
	// timestamp (mediad never rewrites it) plus the wall-clock instant it was forwarded. Read by
	// sendSenderReports to extrapolate a correct RTCP Sender Report RTPTime (v3.1 suggested #4)
	// on this stream's actual 48kHz clock, rather than a Unix-seconds value that has no
	// relationship to the RTP timebase. Lock-free (atomics), same style as sentPackets/sentOctets
	// above — updated from onInboundRTP's hot path, read from the periodic RTCP ticker.
	lastForwardedRTPTimestamp atomic.Uint32
	lastForwardedAtUnixNano   atomic.Int64
	haveLastForwardedRTP      atomic.Bool

	rec *recorder.Leg

	path       string // this leg's Ogg file path, absolute
	durationMs int64
	recErr     error

	// startOffsetMs is populated ONLY for legs reconstructed by finalize.go's disk-recovery path
	// (remixFromDisk), which has no live *recorder.Leg to ask — see legStartOffsetMs. Live legs
	// (rec != nil) get this from rec.StartOffsetMs() instead and leave this field zero.
	startOffsetMs int64
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
	legOrder [2]string // stable order matching CreateSession's input, for manifest/state output
	ended    bool
	manifest *Manifest

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
		legs:      make(map[string]*leg, 2),
		stopRTCP:  make(chan struct{}),
	}

	for i, spec := range specs {
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
			iceState: webrtc.ICEConnectionStateNew,
		}
		s.legOrder[i] = spec.LegID
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

// peerLeg returns the OTHER leg (the forwarding target) for legID, or nil if unknown/absent.
func (s *Session) peerLeg(legID string) *leg {
	s.mu.Lock()
	defer s.mu.Unlock()

	for id, l := range s.legs {
		if id != legID {
			return l
		}
	}

	return nil
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
// packet-level (no decode) to the OTHER leg's outbound track, and feeds it to this leg's own
// recorder. Order matches docs/plans/voice-calls-plan.md §2.3: the reorder/dedup buffer sits in
// front of the OGG writer ONLY — forwarding is real-time and unbuffered.
func (s *Session) onInboundRTP(legID string, pkt *rtp.Packet) {
	s.mu.Lock()
	self, ok := s.legs[legID]
	s.mu.Unlock()
	if !ok {
		return
	}

	if peer := s.peerLeg(legID); peer != nil {
		peer.mu.Lock()
		track := peer.outboundTrack
		peer.mu.Unlock()
		if track != nil {
			if err := track.WriteRTP(pkt); err != nil && !errors.Is(err, io.ErrClosedPipe) {
				slog.Debug("mediad: forward RTP failed", "session", s.id, "leg", legID, "err", err)
			} else if err == nil {
				peer.sentPackets.Add(1)
				peer.sentOctets.Add(uint32(len(pkt.Payload))) //nolint:gosec // Opus payloads are small
				// pkt.Timestamp rides straight through onto peer's outboundTrack unmodified — it
				// IS this stream's RTP timebase from here on, so record it (+ when) for
				// sendSenderReports' RTPTime extrapolation (v3.1 suggested #4).
				peer.lastForwardedRTPTimestamp.Store(pkt.Timestamp)
				peer.lastForwardedAtUnixNano.Store(s.mgr.now().UnixNano())
				peer.haveLastForwardedRTP.Store(true)
			}
		}
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
		ssrc := l.outboundSSRC
		l.mu.Unlock()
		if pc == nil || ssrc == 0 {
			continue
		}

		// Nothing forwarded onto this leg's outbound stream yet — no RTP timebase exists to map
		// NTPTime onto. Omit the SR rather than emit a fabricated RTPTime (v3.1 suggested #4's
		// documented alternative to a wrong mapping); the next tick picks it up once forwarding
		// starts.
		if !l.haveLastForwardedRTP.Load() {
			continue
		}

		sr := &rtcp.SenderReport{
			SSRC:        uint32(ssrc),
			NTPTime:     ntp,
			RTPTime:     l.extrapolatedRTPTime(now),
			PacketCount: l.sentPackets.Load(),
			OctetCount:  l.sentOctets.Load(),
		}
		if err := pc.WriteRTCP([]rtcp.Packet{sr}); err != nil {
			slog.Debug("mediad: write RTCP SR failed", "session", s.id, "leg", l.id, "err", err)
		}
	}
}

// rtpClockRate is the Opus/RTP clock rate mediad registers for every leg (manager.go's
// RTPCodecCapability{ClockRate: 48000}) — the rate extrapolatedRTPTime advances samples on.
const rtpClockRate = 48000

// extrapolatedRTPTime derives this leg's outbound SR RTPTime by extrapolating forward from the
// last packet mediad actually forwarded onto its outbound track: that packet's own RTP
// timestamp (the origin client's 48kHz Opus clock, forwarded verbatim — see onInboundRTP) plus
// the real elapsed wall-clock time since it was forwarded, converted to samples on the SAME
// clock. This is the timebase a receiver doing SR-based RTP/NTP correlation actually needs;
// wall-clock Unix seconds (the prior implementation) has no relationship to it at all. Callers
// must check haveLastForwardedRTP first — this method assumes it's true.
func (l *leg) extrapolatedRTPTime(now time.Time) uint32 {
	base := l.lastForwardedRTPTimestamp.Load()
	firedAt := time.Unix(0, l.lastForwardedAtUnixNano.Load())
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
