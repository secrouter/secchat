package session

import (
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

// fakeSDP builds a minimal, real-shaped SDP offer/answer with the given session-level DTLS
// fingerprint and ICE ufrag — enough for pion/sdp to parse and for dtlsIdentityChanged's
// attribute lookups to exercise the same session-then-media path a real browser's SDP takes.
func fakeSDP(fingerprint, ufrag string) string {
	lines := []string{
		"v=0",
		"o=- 4611731400430051336 2 IN IP4 127.0.0.1",
		"s=-",
		"t=0 0",
		"a=group:BUNDLE 0",
		"a=fingerprint:sha-256 " + fingerprint,
		"m=audio 9 UDP/TLS/RTP/SAVPF 111",
		"c=IN IP4 0.0.0.0",
		"a=ice-ufrag:" + ufrag,
		"a=ice-pwd:the-rest-of-a-real-ice-pwd-value000",
		"a=setup:actpass",
		"a=mid:0",
		"a=sendrecv",
		"a=rtcp-mux",
		"a=rtpmap:111 opus/48000/2",
	}

	return strings.Join(lines, "\r\n") + "\r\n"
}

const (
	fingerprintA = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
	fingerprintB = "99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA"
)

func TestSDPFingerprintExtractsSessionLevelAttribute(t *testing.T) {
	sdp := fakeSDP(fingerprintA, "abcd")

	got, ok := sdpFingerprint(sdp)
	if !ok {
		t.Fatalf("sdpFingerprint: not found")
	}
	if got != "sha-256 "+fingerprintA {
		t.Fatalf("sdpFingerprint = %q, want %q", got, "sha-256 "+fingerprintA)
	}
}

func TestSDPICEUfragExtractsMediaLevelAttribute(t *testing.T) {
	sdp := fakeSDP(fingerprintA, "wxyz")

	got, ok := sdpICEUfrag(sdp)
	if !ok {
		t.Fatalf("sdpICEUfrag: not found")
	}
	if got != "wxyz" {
		t.Fatalf("sdpICEUfrag = %q, want %q", got, "wxyz")
	}
}

func TestSDPFingerprintMalformedSDPReturnsNotFound(t *testing.T) {
	if _, ok := sdpFingerprint("this is not sdp at all"); ok {
		t.Fatalf("expected not-found for malformed SDP")
	}
}

// fakePC returns a real *webrtc.PeerConnection whose RemoteDescription is set to sdp — enough to
// drive dtlsIdentityChanged without a live ICE/DTLS handshake (dtlsIdentityChanged only reads
// pc.RemoteDescription().SDP, a plain string field once set).
func fakePC(t *testing.T, sdpText string) *webrtc.PeerConnection {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdpText}); err != nil {
		t.Fatalf("SetRemoteDescription: %v", err)
	}

	return pc
}

func TestDTLSIdentityChangedSameFingerprintIsUnchanged(t *testing.T) {
	pc := fakePC(t, fakeSDP(fingerprintA, "aaaa"))

	// A same-PC ICE restart keeps the same DTLS certificate/fingerprint even though ufrag
	// changes — must NOT be flagged as a new client PeerConnection.
	reoffer := fakeSDP(fingerprintA, "bbbb")

	if dtlsIdentityChanged(pc, reoffer) {
		t.Fatalf("expected same fingerprint to be treated as unchanged (ICE-restart path)")
	}
}

func TestDTLSIdentityChangedDifferentFingerprintIsChanged(t *testing.T) {
	pc := fakePC(t, fakeSDP(fingerprintA, "aaaa"))

	// A brand-new client PeerConnection (page reload/reconnect) mints a new self-signed
	// certificate, so its offer carries a DIFFERENT fingerprint — this is exactly the case
	// OfferLeg must detect and allocate a fresh PeerConnection for (v3.1 REQUIRED #4's
	// re-attach path).
	reoffer := fakeSDP(fingerprintB, "cccc")

	if !dtlsIdentityChanged(pc, reoffer) {
		t.Fatalf("expected a different fingerprint to be treated as a new client PeerConnection")
	}
}

// TestNewPeerConnectionForLegAddsAudioAndTwoVideoTransceivers is the regression test for the
// live-only video forwarding transceiver pre-add (offer.go's newPeerConnectionForLeg): every
// leg's PeerConnection must carry exactly one recvonly audio transceiver plus TWO recvonly video
// transceivers (camera + screen share) from the moment it's created — added upfront so a client
// can start sending video mid-call without needing to renegotiate its OWN PeerConnection first.
func TestNewPeerConnectionForLegAddsAudioAndTwoVideoTransceivers(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", oneLeg("alice"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	sess.mu.Lock()
	l := sess.legs["leg_alice"]
	sess.mu.Unlock()

	pc, err := sess.newPeerConnectionForLeg(l)
	if err != nil {
		t.Fatalf("newPeerConnectionForLeg: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	transceivers := pc.GetTransceivers()
	if len(transceivers) != 3 {
		t.Fatalf("got %d transceivers, want 3 (1 audio + 2 video)", len(transceivers))
	}

	var audioCount, videoCount int
	for _, tr := range transceivers {
		if tr.Direction() != webrtc.RTPTransceiverDirectionRecvonly {
			t.Errorf("transceiver kind %s has direction %s, want recvonly", tr.Kind(), tr.Direction())
		}
		switch tr.Kind() {
		case webrtc.RTPCodecTypeAudio:
			audioCount++
		case webrtc.RTPCodecTypeVideo:
			videoCount++
		}
	}
	if audioCount != 1 {
		t.Errorf("audio transceiver count = %d, want 1", audioCount)
	}
	if videoCount != 2 {
		t.Errorf("video transceiver count = %d, want 2", videoCount)
	}
}

// TestEnsureOutboundTrackNamingContract is the regression test for the LOCKED outbound track
// naming contract the Flutter app parses (offer.go's ensureOutboundTrack doc comment): the
// stream ID is always "mediad-"+sourceLegID regardless of kind, the audio track's ID is exactly
// "audio", and a video track's ID is exactly "video-<inboundTrackID>" using the origin
// TrackRemote's ID() verbatim — plus the codec capability actually handed out must be Opus for
// audio and VP8 for video (ensureOutboundTrack derives kind from sourceTrackKey, not a
// separately-passed parameter — this also proves that derivation is correct).
func TestEnsureOutboundTrackNamingContract(t *testing.T) {
	mgr := newTestManager(t)
	sess, err := mgr.CreateSession("call1", twoLegs("alice", "bob"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	sess.mu.Lock()
	alice := sess.legs["leg_alice"]
	sess.mu.Unlock()

	if _, err := sess.newPeerConnectionForLeg(alice); err != nil {
		t.Fatalf("newPeerConnectionForLeg: %v", err)
	}
	t.Cleanup(func() {
		alice.mu.Lock()
		pc := alice.pc
		alice.mu.Unlock()
		if pc != nil {
			_ = pc.Close()
		}
	})

	audioOT, err := sess.ensureOutboundTrack(alice, "leg_bob", audioTrackKey)
	if err != nil {
		t.Fatalf("ensureOutboundTrack(audio): %v", err)
	}
	if got := audioOT.track.ID(); got != "audio" {
		t.Errorf("audio outbound track ID = %q, want %q", got, "audio")
	}
	if got := audioOT.track.StreamID(); got != "mediad-leg_bob" {
		t.Errorf("audio outbound track StreamID = %q, want %q", got, "mediad-leg_bob")
	}
	if got := audioOT.track.Codec().MimeType; !strings.EqualFold(got, webrtc.MimeTypeOpus) {
		t.Errorf("audio outbound track MimeType = %q, want %s", got, webrtc.MimeTypeOpus)
	}
	if audioOT.kind != webrtc.RTPCodecTypeAudio {
		t.Errorf("audio outboundTrack.kind = %s, want audio", audioOT.kind)
	}

	videoOT, err := sess.ensureOutboundTrack(alice, "leg_bob", videoTrackKey("camXYZ"))
	if err != nil {
		t.Fatalf("ensureOutboundTrack(video): %v", err)
	}
	if got := videoOT.track.ID(); got != "video-camXYZ" {
		t.Errorf("video outbound track ID = %q, want %q", got, "video-camXYZ")
	}
	if got := videoOT.track.StreamID(); got != "mediad-leg_bob" {
		t.Errorf("video outbound track StreamID = %q, want %q (must match the audio track's stream ID — same participant identity)", got, "mediad-leg_bob")
	}
	if got := videoOT.track.Codec().MimeType; !strings.EqualFold(got, webrtc.MimeTypeVP8) {
		t.Errorf("video outbound track MimeType = %q, want %s", got, webrtc.MimeTypeVP8)
	}
	if videoOT.kind != webrtc.RTPCodecTypeVideo {
		t.Errorf("video outboundTrack.kind = %s, want video", videoOT.kind)
	}

	// A second video track from the SAME source leg (e.g. a screen share alongside the camera)
	// must be a DISTINCT outbound track, not collide with the camera's.
	videoOT2, err := sess.ensureOutboundTrack(alice, "leg_bob", videoTrackKey("screenABC"))
	if err != nil {
		t.Fatalf("ensureOutboundTrack(video 2): %v", err)
	}
	if got := videoOT2.track.ID(); got != "video-screenABC" {
		t.Errorf("second video outbound track ID = %q, want %q", got, "video-screenABC")
	}
	if videoOT2 == videoOT {
		t.Fatalf("camera and screen-share outbound tracks must be distinct instances")
	}
}

func TestDTLSIdentityChangedNoPriorRemoteDescriptionIsUnchanged(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	if dtlsIdentityChanged(pc, fakeSDP(fingerprintA, "aaaa")) {
		t.Fatalf("expected no prior remote description to be treated as unchanged")
	}
}
