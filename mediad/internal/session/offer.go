package session

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// gatherTimeout bounds how long OfferLeg waits for ICE gathering to complete before giving up —
// non-trickle mediad has no fallback if gathering hangs, so this is a hard ceiling, not a normal
// operating condition (docs/plans/voice-contracts.md §2.2's "single-response SDP answer").
const gatherTimeout = 10 * time.Second

// OfferLeg brokers one leg's client SDP OFFER against mediad's control API
// (docs/plans/voice-contracts.md §2.2): the FIRST offer for a leg creates its PeerConnection;
// a LATER offer while a PC already exists is either (a) an ICE restart from the SAME client
// PeerConnection (same DTLS certificate — its fingerprint is stable across an SDP renegotiation
// by construction) and renegotiates the EXISTING PeerConnection, preserving the SSRC/granule
// continuity the plan's re-attach semantics call for on a same-PC blip, or (b) a re-offer from a
// brand-NEW client PeerConnection (page reload/reconnect — a new DTLS certificate, which WebRTC
// forbids changing across a renegotiation of one PeerConnection: the DTLS association can never
// re-establish if mediad tries to reuse its existing PC). dtlsIdentityChanged tells the two
// apart; case (b) closes the stale PC and allocates a fresh one, so recorder.Leg's new-SSRC
// bridged-segment handling (v3.1 REQUIRED #4) is actually reachable through a real reconnect
// rather than only through direct unit tests. A second offer arriving while one is already being
// processed for the same leg returns ErrLegBusy (409) rather than racing two
// SetRemoteDescription calls (or two PC allocations) for one leg.
//
// mediad is non-trickle: it gathers ICE to completion before returning its answer (no
// candidate trickling ever crosses the control API).
func (s *Session) OfferLeg(legID, offerSDP string) (string, error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()

		return "", ErrSessionEnded
	}
	l, ok := s.legs[legID]
	s.mu.Unlock()
	if !ok {
		return "", ErrLegNotFound
	}

	if !l.negotiating.TryLock() {
		return "", ErrLegBusy
	}
	defer l.negotiating.Unlock()

	l.mu.Lock()
	pc := l.pc
	l.mu.Unlock()

	if pc != nil && dtlsIdentityChanged(pc, offerSDP) {
		slog.Info("mediad: leg re-offer carries a new DTLS identity, replacing the PeerConnection",
			"session", s.id, "leg", legID)
		_ = pc.Close()
		l.mu.Lock()
		l.pc = nil
		l.iceState = webrtc.ICEConnectionStateNew
		l.mu.Unlock()
		pc = nil
	}

	if pc == nil {
		var err error
		pc, err = s.newPeerConnectionForLeg(l)
		if err != nil {
			return "", fmt.Errorf("session: create peer connection for leg %s: %w", legID, err)
		}
		l.mu.Lock()
		l.pc = pc
		l.mu.Unlock()
	}

	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}
	if err := pc.SetRemoteDescription(offer); err != nil {
		return "", fmt.Errorf("session: set remote description: %w", err)
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", fmt.Errorf("session: create answer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return "", fmt.Errorf("session: set local description: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), gatherTimeout)
	defer cancel()
	select {
	case <-gatherComplete:
	case <-ctx.Done():
		return "", fmt.Errorf("session: ICE gathering did not complete within %s", gatherTimeout)
	}

	final := pc.LocalDescription()
	if final == nil {
		return "", fmt.Errorf("session: no local description after gathering")
	}

	return final.SDP, nil
}

// newPeerConnectionForLeg builds a fresh PeerConnection for a leg: a recvonly audio transceiver
// (receives the client's mic — what gets recorded and forwarded to the peer leg) plus an
// outbound track (what this leg's client hears: the OTHER leg's forwarded audio).
func (s *Session) newPeerConnectionForLeg(l *leg) (*webrtc.PeerConnection, error) {
	pc, err := s.mgr.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, err
	}

	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		_ = pc.Close()

		return nil, fmt.Errorf("add recvonly audio transceiver: %w", err)
	}

	outboundTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "mediad-"+l.id,
	)
	if err != nil {
		_ = pc.Close()

		return nil, fmt.Errorf("new outbound track: %w", err)
	}

	sender, err := pc.AddTrack(outboundTrack)
	if err != nil {
		_ = pc.Close()

		return nil, fmt.Errorf("add outbound track: %w", err)
	}
	l.mu.Lock()
	l.outboundTrack = outboundTrack
	if params := sender.GetParameters(); len(params.Encodings) > 0 {
		l.outboundSSRC = params.Encodings[0].SSRC
	}
	l.mu.Unlock()

	// Drain RTCP on the sender (required by Pion so the underlying buffers don't fill and
	// stall) — mediad has nothing to act on here (PLI/FIR are video-only and audio-only mediad
	// ignores them by construction, simply by never inspecting sender RTCP content).
	go drainRTCP(sender)

	legID := l.id
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		l.mu.Lock()
		l.iceState = state
		l.mu.Unlock()
		slog.Info("mediad: leg ICE state", "session", s.id, "leg", legID, "state", state.String())
	})

	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		s.readInboundTrack(legID, track)
	})

	return pc, nil
}

func drainRTCP(sender *webrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := sender.Read(buf); err != nil {
			return
		}
	}
}

// readInboundTrack is the OnTrack read loop for one leg's inbound audio: one RTP packet at a
// time, forwarded packet-level to onInboundRTP (no decode — docs/plans/voice-calls-plan.md
// §2.3's "no decode in the hot path"). Returns when the track/PC closes.
func (s *Session) readInboundTrack(legID string, track *webrtc.TrackRemote) {
	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		s.onInboundRTP(legID, pkt)
	}
}

// dtlsIdentityChanged reports whether offerSDP was minted by a DIFFERENT client PeerConnection
// than the one pc's current remote description came from — the signal that this is a page-
// reload/reconnect (new cert) rather than an ICE restart from the same client PC (stable cert).
// It compares DTLS fingerprints first (the actual identity WebRTC pins per-PeerConnection and
// forbids changing across a renegotiation); if a fingerprint is missing from either side (not
// expected for a DTLS-SRTP offer, but don't mask it by guessing) it falls back to the ICE ufrag,
// which a browser also mints fresh for every new RTCPeerConnection. current==nil (no prior
// remote description — shouldn't happen for a leg whose pc is already non-nil, but handled
// defensively) is treated as "unchanged" so callers fall through to the existing same-PC path
// rather than closing a PC that was never actually negotiated against anything.
func dtlsIdentityChanged(pc *webrtc.PeerConnection, offerSDP string) bool {
	current := pc.RemoteDescription()
	if current == nil {
		return false
	}

	if oldFP, oldOK := sdpFingerprint(current.SDP); oldOK {
		if newFP, newOK := sdpFingerprint(offerSDP); newOK {
			return !strings.EqualFold(oldFP, newFP)
		}
	}

	oldUfrag, oldOK := sdpICEUfrag(current.SDP)
	newUfrag, newOK := sdpICEUfrag(offerSDP)
	if oldOK && newOK {
		return oldUfrag != newUfrag
	}

	return false
}

// sdpFingerprint extracts the "a=fingerprint" attribute value (e.g. "sha-256 AB:CD:...") from
// raw SDP text, checking session-level attributes first and falling back to the first media
// section that carries one (browsers commonly put it at session level under BUNDLE, but the
// attribute is technically media-level in the SDP grammar).
func sdpFingerprint(raw string) (string, bool) {
	return sdpAttribute(raw, "fingerprint")
}

// sdpICEUfrag extracts the "a=ice-ufrag" attribute value, same session-then-media lookup as
// sdpFingerprint.
func sdpICEUfrag(raw string) (string, bool) {
	return sdpAttribute(raw, "ice-ufrag")
}

func sdpAttribute(raw, key string) (string, bool) {
	desc := &sdp.SessionDescription{}
	if err := desc.UnmarshalString(raw); err != nil {
		return "", false
	}

	if v, ok := desc.Attribute(key); ok {
		return v, true
	}
	for _, media := range desc.MediaDescriptions {
		if v, ok := media.Attribute(key); ok {
			return v, true
		}
	}

	return "", false
}
