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
