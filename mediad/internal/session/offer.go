package session

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// pliMinInterval rate-limits PLIs mediad forwards to one originating leg's inbound video track
// (forwardPLIToOrigin): N viewers all losing a frame around the same time must collapse to at
// most one PLI per this interval, not N — a misbehaving/large viewer set must never be able to
// storm one sender with keyframe requests.
const pliMinInterval = 500 * time.Millisecond

// maxVideoTracksPerLeg + audio cap of 1 is the per-leg inbound track cap (defense against a
// misbehaving client sending more tracks than the UI ever offers): one microphone, plus at most
// two video tracks (camera + screen share).
const maxVideoTracksPerLeg = 2

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

// videoCapability is the outbound RTP capability handed to VP8 outbound tracks — the SAME
// PayloadType/ClockRate manager.go registers on the shared MediaEngine (payload type 96, 90kHz).
var videoCapability = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}

// audioCapability is the outbound RTP capability handed to Opus outbound tracks — unchanged from
// before video existed.
var audioCapability = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}

// newPeerConnectionForLeg builds a fresh PeerConnection for a leg: a recvonly audio transceiver
// plus TWO recvonly video transceivers (camera + screen share — pre-added so a client can start
// sending video mid-call without needing to renegotiate its OWN PeerConnection first), receiving
// the client's mic/camera/screen — what gets forwarded (audio also recorded) to every OTHER live
// leg — plus outbound tracks toward this leg for every already-present peer's ALREADY-ACTIVE
// inbound tracks (what this leg's client hears/sees; see provisionPeerOutboundTracks and
// leg.outboundTracks). A peer that joins LATER, or whose video track starts flowing LATER, gets
// its outbound track added on-demand by AddLeg / fanOutNewVideoTrack instead, once this PC
// already exists.
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

	// Two recvonly video transceivers: camera + screen share. A leg may send zero, one, or both —
	// the per-leg inbound cap (admitInboundTrack) rejects anything beyond that.
	for range maxVideoTracksPerLeg {
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			_ = pc.Close()

			return nil, fmt.Errorf("add recvonly video transceiver: %w", err)
		}
	}

	legID := l.id
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		l.mu.Lock()
		l.iceState = state
		l.mu.Unlock()
		slog.Info("mediad: leg ICE state", "session", s.id, "leg", legID, "state", state.String())
	})

	pc.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		s.readInboundTrack(l, track)
	})

	// l.pc must be set BEFORE provisioning outbound tracks below — ensureOutboundTrack requires a
	// non-nil l.pc to add a track against.
	l.mu.Lock()
	l.pc = pc
	l.mu.Unlock()

	for _, peer := range s.peerLegs(legID) {
		if err := s.provisionPeerOutboundTracks(l, peer); err != nil {
			_ = pc.Close()
			l.mu.Lock()
			l.pc = nil
			l.mu.Unlock()

			return nil, fmt.Errorf("provision outbound tracks for peer %s: %w", peer.id, err)
		}
	}

	return pc, nil
}

// provisionPeerOutboundTracks ensures dst's PeerConnection carries an outbound track for every
// track sourceLeg is (or is assumed to be) sending: unconditionally audioTrackKey (every leg is
// assumed to eventually send audio — the original one-outbound-track-per-peer contract, now
// generalized to a helper both newPeerConnectionForLeg's peer loop and AddLeg's existing-peer
// loop share), plus whichever of sourceLeg's VIDEO tracks are already active
// (sourceLeg.inboundTracks, populated by admitInboundTrack) at the time this is called. A video
// track that starts on sourceLeg AFTER dst's PC already exists is instead picked up by
// fanOutNewVideoTrack, called from readInboundTrack when that track is admitted.
func (s *Session) provisionPeerOutboundTracks(dst, sourceLeg *leg) error {
	if _, err := s.ensureOutboundTrack(dst, sourceLeg.id, audioTrackKey); err != nil {
		return err
	}

	sourceLeg.mu.Lock()
	videoKeys := make([]string, 0, maxVideoTracksPerLeg)
	for trackKey, info := range sourceLeg.inboundTracks {
		if info.kind == webrtc.RTPCodecTypeVideo {
			videoKeys = append(videoKeys, trackKey)
		}
	}
	sourceLeg.mu.Unlock()

	for _, trackKey := range videoKeys {
		if _, err := s.ensureOutboundTrack(dst, sourceLeg.id, trackKey); err != nil {
			return err
		}
	}

	return nil
}

// ensureOutboundTrack lazily creates (or returns the already-existing) outbound
// TrackLocalStaticRTP on l's PeerConnection carrying sourceLegID's forwarded media for
// sourceTrackKey (audioTrackKey or a videoTrackKey(...)) — the "one outbound track PER (remote
// source, remote source's track)" no-decode SFU design (a single mixed track would require
// decoding, which mediad forbids by construction). l.pc must already be non-nil; callers only
// invoke this against a leg that HAS a PeerConnection.
//
// LOCKED NAMING CONTRACT (the Flutter app parses these — do not change): outbound track streamID
// is always "mediad-"+sourceLegID (participant identity); outbound track ID is "audio" for audio,
// or "video-<inboundTrackID>" for video — sourceTrackKey already IS that ID verbatim by
// construction (audioTrackKey == "audio", videoTrackKey(id) == "video-"+id), so it's reused
// directly as the track ID below.
func (s *Session) ensureOutboundTrack(l *leg, sourceLegID, sourceTrackKey string) (*outboundTrack, error) {
	key := outboundTrackKey{legID: sourceLegID, trackKey: sourceTrackKey}

	l.mu.Lock()
	pc := l.pc
	if ot, ok := l.outboundTracks[key]; ok {
		l.mu.Unlock()

		return ot, nil
	}
	l.mu.Unlock()

	if pc == nil {
		return nil, fmt.Errorf("session: leg %s has no PeerConnection yet", l.id)
	}

	kind := webrtc.RTPCodecTypeAudio
	capability := audioCapability
	if sourceTrackKey != audioTrackKey {
		kind = webrtc.RTPCodecTypeVideo
		capability = videoCapability
	}

	track, err := webrtc.NewTrackLocalStaticRTP(capability, sourceTrackKey, "mediad-"+sourceLegID)
	if err != nil {
		return nil, fmt.Errorf("new outbound track for %s/%s: %w", sourceLegID, sourceTrackKey, err)
	}

	sender, err := pc.AddTrack(track)
	if err != nil {
		return nil, fmt.Errorf("add outbound track for %s/%s: %w", sourceLegID, sourceTrackKey, err)
	}
	// Drain RTCP on the sender (required by Pion so the underlying buffers don't fill and
	// stall). Audio tracks keep the original discard-only behavior (mediad ignores audio PLI/FIR
	// by construction). Video tracks additionally inspect what's read for PLI/FIR and reverse-
	// route it to the originating leg's inbound track — see forwardPLIToOrigin.
	go drainRTCP(s, sender, sourceLegID, sourceTrackKey, kind)

	ot := &outboundTrack{track: track, sender: sender, kind: kind}
	if params := sender.GetParameters(); len(params.Encodings) > 0 {
		ot.ssrc = params.Encodings[0].SSRC
	}

	l.mu.Lock()
	// Re-check under lock: a concurrent caller (e.g. AddLeg racing this leg's own OfferLeg) may
	// have provisioned the same source's track first. Keep whichever won rather than
	// last-writer-wins overwriting a track Pion already attached to the PC (that would orphan the
	// loser's sender/goroutine with nothing referencing it).
	if existing, ok := l.outboundTracks[key]; ok {
		l.mu.Unlock()
		_ = pc.RemoveTrack(sender)

		return existing, nil
	}
	l.outboundTracks[key] = ot
	l.mu.Unlock()

	return ot, nil
}

// drainRTCP reads sender RTCP for one outbound track until its sender/PC closes. For AUDIO
// outbound tracks this stays discard-only, unchanged from before video existed (mediad ignores
// audio PLI/FIR by construction). For VIDEO outbound tracks, each read is unmarshaled and
// PictureLossIndication/FullIntraRequest packets are reverse-routed to the ORIGINATING leg's
// inbound track (forwardPLIToOrigin) — required for usable video: without this, a receiver's loss
// recovery request never reaches the sender and quality only degrades from there.
func drainRTCP(s *Session, sender *webrtc.RTPSender, sourceLegID, sourceTrackKey string, kind webrtc.RTPCodecType) {
	buf := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		if kind != webrtc.RTPCodecTypeVideo {
			continue
		}
		s.handleOutboundVideoRTCP(buf[:n], sourceLegID, sourceTrackKey)
	}
}

// handleOutboundVideoRTCP unmarshals raw RTCP read off a video outbound track's sender and
// forwards a PLI to the originating leg's inbound track for any PictureLossIndication or
// FullIntraRequest packet found — split out from drainRTCP's read loop so it's a plain,
// independently-testable function (rtcp_test.go feeds it pre-marshaled bytes rather than needing
// a real connected sender).
func (s *Session) handleOutboundVideoRTCP(raw []byte, sourceLegID, sourceTrackKey string) {
	pkts, err := rtcp.Unmarshal(raw)
	if err != nil {
		return
	}
	for _, pkt := range pkts {
		switch pkt.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			s.forwardPLIToOrigin(sourceLegID, sourceTrackKey)
		}
	}
}

// forwardPLIToOrigin sends a PictureLossIndication to sourceLegID's live PeerConnection for its
// inbound track sourceTrackKey, using that track's ORIGIN inbound SSRC (persisted in
// leg.inboundTracks by admitInboundTrack — see offer.go's OnTrack region) as PLI's MediaSSRC.
// Rate-limited to at most one forwarded PLI per pliMinInterval per origin track: N viewers losing
// a frame around the same time must collapse to one PLI, not N (a CompareAndSwap on the origin
// track's lastPLISentAtUnixNano makes concurrent callers from different viewers' drainRTCP
// goroutines cooperate rather than each independently sending one).
func (s *Session) forwardPLIToOrigin(sourceLegID, sourceTrackKey string) {
	s.mu.Lock()
	origin, ok := s.legs[sourceLegID]
	s.mu.Unlock()
	if !ok {
		return
	}

	origin.mu.Lock()
	pc := origin.pc
	left := origin.left
	info, hasTrack := origin.inboundTracks[sourceTrackKey]
	origin.mu.Unlock()
	if pc == nil || left || !hasTrack {
		return
	}

	now := s.mgr.now()
	last := info.lastPLISentAtUnixNano.Load()
	if last != 0 && now.Sub(time.Unix(0, last)) < pliMinInterval {
		return
	}
	if !info.lastPLISentAtUnixNano.CompareAndSwap(last, now.UnixNano()) {
		// Lost a race against a concurrent forwardPLIToOrigin call for the same origin track
		// (another viewer's drainRTCP goroutine) — that call is sending (or just sent) the PLI
		// this call would have sent; don't double up.
		return
	}

	if err := pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(info.ssrc)}}); err != nil {
		slog.Debug("mediad: forward PLI to origin failed", "session", s.id, "leg", sourceLegID, "trackKey", sourceTrackKey, "err", err)
	}
}

// readInboundTrack is the OnTrack read loop for one of leg l's inbound tracks (audio, or one of
// up to two video tracks): admits it against the per-leg cap, fans a newly-admitted video track
// out to already-connected peers, then forwards one RTP packet at a time to onInboundRTP (no
// decode — docs/plans/voice-calls-plan.md §2.3's "no decode in the hot path"). Returns when the
// track/PC closes, or immediately if the per-leg cap rejects this track.
func (s *Session) readInboundTrack(l *leg, track *webrtc.TrackRemote) {
	kind := track.Kind()
	trackKey := audioTrackKey
	if kind == webrtc.RTPCodecTypeVideo {
		trackKey = videoTrackKey(track.ID())
	}

	if !s.admitInboundTrack(l, trackKey, kind, track.SSRC()) {
		slog.Warn("mediad: rejecting inbound track over the per-leg cap (1 audio + 2 video)",
			"session", s.id, "leg", l.id, "kind", kind.String(), "trackId", track.ID())

		return
	}

	if kind == webrtc.RTPCodecTypeVideo {
		s.fanOutNewVideoTrack(l, trackKey)
	}

	for {
		pkt, _, err := track.ReadRTP()
		if err != nil {
			return
		}
		s.onInboundRTP(l.id, trackKey, kind, pkt)
	}
}

// admitInboundTrack enforces the per-leg inbound cap (1 audio + 2 video — defense against a
// misbehaving client sending more tracks than the UI ever offers) and, if admitted, records the
// track's kind/SSRC in l.inboundTracks. Returns false for a track that would exceed the cap;
// callers must not read RTP from a rejected track's TrackRemote (readInboundTrack returns
// immediately instead).
func (s *Session) admitInboundTrack(l *leg, trackKey string, kind webrtc.RTPCodecType, ssrc webrtc.SSRC) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.inboundTracks == nil {
		l.inboundTracks = make(map[string]*inboundTrackInfo)
	}
	if _, exists := l.inboundTracks[trackKey]; exists {
		// A track ID is unique per OnTrack firing in practice — this is defensive, not expected.
		return true
	}

	audioCount, videoCount := 0, 0
	for _, info := range l.inboundTracks {
		switch info.kind {
		case webrtc.RTPCodecTypeAudio:
			audioCount++
		case webrtc.RTPCodecTypeVideo:
			videoCount++
		}
	}

	switch kind {
	case webrtc.RTPCodecTypeAudio:
		if audioCount >= 1 {
			return false
		}
	case webrtc.RTPCodecTypeVideo:
		if videoCount >= maxVideoTracksPerLeg {
			return false
		}
	default:
		return false
	}

	l.inboundTracks[trackKey] = &inboundTrackInfo{kind: kind, ssrc: ssrc}

	return true
}

// fanOutNewVideoTrack provisions an outbound track carrying l's newly-admitted video trackKey
// onto every OTHER leg that already has a live PeerConnection — mirroring AddLeg's "give every
// currently-live OTHER leg a fresh outbound track" for the join case, but triggered by a video
// track starting mid-call (e.g. a client turning its camera on after already being connected)
// rather than by a leg joining. Does NOT renegotiate anything itself — mediad never pushes an
// offer on its own (multiparty.go's package doc); the next RenegotiateLeg call for each affected
// peer (secchat-driven, same trigger as any other track-set mutation) is what actually surfaces
// the new m-line to that peer's client.
func (s *Session) fanOutNewVideoTrack(l *leg, trackKey string) {
	for _, peer := range s.peerLegs(l.id) {
		peer.mu.Lock()
		pc := peer.pc
		peer.mu.Unlock()
		if pc == nil {
			continue
		}
		if _, err := s.ensureOutboundTrack(peer, l.id, trackKey); err != nil {
			slog.Debug("mediad: provision outbound video track on existing peer failed",
				"session", s.id, "leg", l.id, "peer", peer.id, "trackKey", trackKey, "err", err)
		}
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
