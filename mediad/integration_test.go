package main

// End-to-end integration test (docs/plans/voice-calls-plan.md §3.2's "an integration test that
// dials mediad with a second Pion client as a fake browser and asserts per-leg OGG output +
// manifest with start_offset_ms"): drives mediad's REAL control API (HTTP) and TWO real Pion
// PeerConnections standing in for the two browsers, entirely offline over loopback — no
// external network, no real browser.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"secchat-mediad/internal/api"
	"secchat-mediad/internal/config"
	"secchat-mediad/internal/session"
)

const testToken = "test-token-integration"

func startTestMediad(t *testing.T) (baseURL string, recordingsDir string) {
	t.Helper()

	recordingsDir = t.TempDir()
	cfg := config.Config{
		ControlAddr:     "127.0.0.1:0", // unused directly — we drive the api.Handler via httptest
		MediaAddr:       "127.0.0.1:0", // ephemeral UDP+TCP mux ports
		AdvertiseAddr:   "127.0.0.1",
		Token:           testToken,
		RecordingsDir:   recordingsDir,
		FfmpegPath:      ffmpegPathForTest(t),
		SessionCap:      8,
		ActiveDeadline:  time.Hour,
		JanitorInterval: time.Hour,
	}

	mgr, err := session.NewManager(cfg)
	if err != nil {
		t.Fatalf("session.NewManager: %v", err)
	}
	t.Cleanup(func() { _ = mgr.Close() })

	srv := httptest.NewServer(api.New(mgr, testToken))
	t.Cleanup(srv.Close)

	return srv.URL, recordingsDir
}

func ffmpegPathForTest(t *testing.T) string {
	t.Helper()
	for _, candidate := range []string{"/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	return "ffmpeg" // fall back to PATH lookup
}

type controlClient struct {
	baseURL string
	token   string
	http    *http.Client
}

func (c *controlClient) do(t *testing.T, method, path string, body, out any) int {
	t.Helper()

	var reqBody *bytes.Buffer
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		reqBody = bytes.NewBuffer(data)
	} else {
		reqBody = bytes.NewBuffer(nil)
	}

	req, err := http.NewRequest(method, c.baseURL+path, reqBody)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatalf("decode response for %s %s: %v", method, path, err)
		}
	}

	return resp.StatusCode
}

// fakeBrowser is a bare Pion PeerConnection standing in for a browser client: dials mediad's
// control API with a non-trickle (gather-complete-before-offer) offer, exactly as
// docs/plans/voice-contracts.md §2.2 requires of real clients.
type fakeBrowser struct {
	pc    *webrtc.PeerConnection
	track *webrtc.TrackLocalStaticRTP
}

func dialFakeBrowser(t *testing.T, client *controlClient, sessionID, legID string) *fakeBrowser {
	t.Helper()

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "fake-"+legID,
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticRTP: %v", err)
	}
	if _, err := pc.AddTrack(track); err != nil {
		t.Fatalf("AddTrack: %v", err)
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		t.Fatalf("AddTransceiverFromKind: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("CreateOffer: %v", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("SetLocalDescription: %v", err)
	}
	select {
	case <-gatherComplete:
	case <-time.After(10 * time.Second):
		t.Fatalf("client ICE gathering did not complete")
	}

	var resp struct {
		SDP string `json:"sdp"`
	}
	status := client.do(t, http.MethodPost,
		fmt.Sprintf("/sessions/%s/legs/%s/offer", sessionID, legID),
		map[string]string{"sdp": pc.LocalDescription().SDP}, &resp)
	if status != http.StatusOK {
		t.Fatalf("offer for leg %s: status %d", legID, status)
	}

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: resp.SDP}); err != nil {
		t.Fatalf("SetRemoteDescription: %v", err)
	}

	return &fakeBrowser{pc: pc, track: track}
}

func waitConnected(t *testing.T, pc *webrtc.PeerConnection) {
	t.Helper()

	deadline := time.After(15 * time.Second)
	for {
		if pc.ICEConnectionState() == webrtc.ICEConnectionStateConnected {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("ICE never reached connected (last state: %s)", pc.ICEConnectionState())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// waitDTLSConnected waits for the AGGREGATE PeerConnectionState (ICE + DTLS) to reach Connected
// — unlike waitConnected's ICEConnectionState, this actually requires the DTLS handshake to
// succeed. That distinction matters for TestIntegration_LegReattachWithNewPeerConnectionSucceeds
// below: ICE connectivity checks alone don't prove mediad's PeerConnection re-negotiated against
// the RIGHT (new) client certificate — only a completed DTLS handshake does.
func waitDTLSConnected(t *testing.T, pc *webrtc.PeerConnection) {
	t.Helper()

	deadline := time.After(15 * time.Second)
	for {
		if pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("PeerConnection never reached connected (last state: %s)", pc.ConnectionState())
		case <-time.After(50 * time.Millisecond):
		}
	}
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}

	return info.Size()
}

// sendFrames writes n synthetic 20ms Opus-shaped RTP frames (mediad never decodes Opus, so the
// payload bytes are arbitrary) at 960-sample spacing starting at a random base timestamp/seq,
// pacing them 20ms apart to look like a real call.
func sendFrames(t *testing.T, track *webrtc.TrackLocalStaticRTP, n int) {
	t.Helper()

	const tsStep = 960
	baseTS := uint32(10000) //nolint:gosec // test fixture value
	for i := range n {
		pkt := &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				SequenceNumber: uint16(i), //nolint:gosec // n is small in tests
				Timestamp:      baseTS + uint32(i)*tsStep,
			},
			Payload: []byte{0xfc, 0x01, 0x02},
		}
		if err := track.WriteRTP(pkt); err != nil {
			t.Fatalf("WriteRTP frame %d: %v", i, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestIntegration_TwoLegCallProducesPerLegOggAndManifest(t *testing.T) {
	baseURL, recordingsDir := startTestMediad(t)
	client := &controlClient{baseURL: baseURL, token: testToken, http: &http.Client{Timeout: 20 * time.Second}}

	var createResp struct {
		SessionID string `json:"sessionId"`
	}
	status := client.do(t, http.MethodPost, "/sessions", map[string]any{
		"callId": "call_test_1",
		"legs": []map[string]string{
			{"legId": "leg_caller", "sub": "alice"},
			{"legId": "leg_callee", "sub": "bob"},
		},
	}, &createResp)
	if status != http.StatusCreated {
		t.Fatalf("POST /sessions: status %d", status)
	}
	sessionID := createResp.SessionID
	if sessionID == "" {
		t.Fatalf("empty sessionId")
	}

	callerBrowser := dialFakeBrowser(t, client, sessionID, "leg_caller")
	waitConnected(t, callerBrowser.pc)

	// The callee dials in ~150ms later — a real dial-jitter gap that must show up as leg_callee's
	// startOffsetMs in the finalize manifest (docs/plans/voice-contracts.md §2.1/§2.4's shared
	// t0/startOffsetMs requirement).
	time.Sleep(150 * time.Millisecond)
	calleeBrowser := dialFakeBrowser(t, client, sessionID, "leg_callee")
	waitConnected(t, calleeBrowser.pc)

	// Confirm the control API reports both legs connected before sending audio.
	var state struct {
		Legs []struct {
			LegID    string `json:"legId"`
			ICEState string `json:"iceState"`
		} `json:"legs"`
		Recording string `json:"recording"`
	}
	client.do(t, http.MethodGet, "/sessions/"+sessionID, nil, &state)
	if len(state.Legs) != 2 {
		t.Fatalf("expected 2 legs in state, got %d", len(state.Legs))
	}

	sendFrames(t, callerBrowser.track, 10)
	sendFrames(t, calleeBrowser.track, 8)

	// Give mediad's OnTrack goroutines a moment to drain the last packets (async read loop).
	time.Sleep(300 * time.Millisecond)

	client.do(t, http.MethodGet, "/sessions/"+sessionID, nil, &state)
	if state.Recording != "on" {
		t.Fatalf("expected recording=on after audio flowed, got %q", state.Recording)
	}

	var manifest struct {
		SessionID string `json:"sessionId"`
		Files     []struct {
			LegID         string `json:"legId,omitempty"`
			Path          string `json:"path"`
			StartOffsetMs int64  `json:"startOffsetMs"`
			DurationMs    int64  `json:"durationMs"`
		} `json:"files"`
		Truncated bool `json:"truncated"`
	}
	status = client.do(t, http.MethodDelete, "/sessions/"+sessionID, nil, &manifest)
	if status != http.StatusOK {
		t.Fatalf("DELETE /sessions/%s: status %d", sessionID, status)
	}
	if manifest.Truncated {
		t.Fatalf("expected a clean (non-truncated) finalize")
	}

	byLegID := map[string]struct {
		Path          string
		StartOffsetMs int64
		DurationMs    int64
	}{}
	var mixedFound bool
	for _, f := range manifest.Files {
		if f.LegID == "" {
			mixedFound = true
			if f.Path != "mixed.m4a" {
				t.Errorf("mixed file path = %q, want mixed.m4a", f.Path)
			}

			continue
		}
		byLegID[f.LegID] = struct {
			Path          string
			StartOffsetMs int64
			DurationMs    int64
		}{f.Path, f.StartOffsetMs, f.DurationMs}
	}

	caller, ok := byLegID["leg_caller"]
	if !ok {
		t.Fatalf("manifest missing leg_caller entry: %+v", manifest.Files)
	}
	callee, ok := byLegID["leg_callee"]
	if !ok {
		t.Fatalf("manifest missing leg_callee entry: %+v", manifest.Files)
	}
	if !mixedFound {
		t.Errorf("manifest missing the mixed playback file entry")
	}

	if caller.DurationMs <= 0 {
		t.Errorf("leg_caller durationMs = %d, want > 0", caller.DurationMs)
	}
	if callee.DurationMs <= 0 {
		t.Errorf("leg_callee durationMs = %d, want > 0", callee.DurationMs)
	}

	// The REQUIRED shared-timebase check (v3.1 REQUIRED #2): leg_callee was dialed ~150ms after
	// leg_caller (both legs additionally take some real ICE-negotiation time before their first
	// RTP packet lands, which is why neither offset is asserted near zero in absolute terms —
	// what matters is that the ~150ms REAL gap between the two legs joining survives into their
	// respective startOffsetMs, for the backend's transcript merge to place segments correctly).
	if caller.StartOffsetMs < 0 {
		t.Errorf("leg_caller startOffsetMs = %d, want >= 0", caller.StartOffsetMs)
	}
	gap := callee.StartOffsetMs - caller.StartOffsetMs
	if gap < 75 || gap > 600 {
		t.Errorf("callee-caller startOffsetMs gap = %dms, want roughly 150ms (75-600 given test/ICE scheduling slack); caller=%d callee=%d",
			gap, caller.StartOffsetMs, callee.StartOffsetMs)
	}

	// The actual per-leg OGG files must exist on the shared recordings volume layout
	// (docs/plans/voice-contracts.md §4: <volume-root>/<sessionId>/leg_*.ogg).
	sessionDir := filepath.Join(recordingsDir, sessionID)
	for _, name := range []string{"leg_caller.ogg", "leg_callee.ogg", "mixed.m4a", "manifest.json"} {
		p := filepath.Join(sessionDir, name)
		info, err := os.Stat(p)
		if err != nil {
			t.Errorf("expected %s to exist: %v", p, err)

			continue
		}
		if info.Size() == 0 {
			t.Errorf("%s is empty", p)
		}
	}

	// Idempotent re-DELETE (docs/plans/voice-contracts.md §2.4): same manifest, no error, works
	// even though the in-memory Session was already forgotten.
	var manifest2 struct {
		SessionID string `json:"sessionId"`
	}
	status = client.do(t, http.MethodDelete, "/sessions/"+sessionID, nil, &manifest2)
	if status != http.StatusOK {
		t.Fatalf("idempotent re-DELETE: status %d", status)
	}
	if manifest2.SessionID != sessionID {
		t.Fatalf("idempotent re-DELETE returned a different sessionId")
	}
}

// TestIntegration_LegReattachWithNewPeerConnectionSucceeds is the end-to-end regression test for
// v3.1 REQUIRED #1 (the finding this fix addresses): a re-offer for an already-connected leg from
// a BRAND-NEW client PeerConnection (page reload/reconnect — dialFakeBrowser mints a fresh Pion
// PeerConnection, and so a fresh self-signed DTLS certificate, every call) must actually
// reconnect. Before the fix, OfferLeg always renegotiated mediad's EXISTING PeerConnection for
// the leg — whose DTLS association is pinned to the FIRST browser's certificate — so the second
// browser's real DTLS handshake could never complete: this is why the test asserts
// PeerConnectionStateConnected (which requires DTLS to finish), not just ICEConnectionState
// (which Pion can reach via connectivity checks alone, independent of DTLS, and so would NOT
// have caught this bug).
func TestIntegration_LegReattachWithNewPeerConnectionSucceeds(t *testing.T) {
	baseURL, recordingsDir := startTestMediad(t)
	client := &controlClient{baseURL: baseURL, token: testToken, http: &http.Client{Timeout: 20 * time.Second}}

	var createResp struct {
		SessionID string `json:"sessionId"`
	}
	status := client.do(t, http.MethodPost, "/sessions", map[string]any{
		"callId": "call_reattach",
		"legs": []map[string]string{
			{"legId": "leg_caller", "sub": "alice"},
			{"legId": "leg_callee", "sub": "bob"},
		},
	}, &createResp)
	if status != http.StatusCreated {
		t.Fatalf("POST /sessions: status %d", status)
	}
	sessionID := createResp.SessionID

	// First "browser": dial leg_caller, let DTLS actually complete, send some audio.
	browser1 := dialFakeBrowser(t, client, sessionID, "leg_caller")
	waitDTLSConnected(t, browser1.pc)
	sendFrames(t, browser1.track, 5)
	time.Sleep(200 * time.Millisecond)

	legPath := filepath.Join(recordingsDir, sessionID, "leg_caller.ogg")
	sizeAfterFirst := fileSize(t, legPath)
	if sizeAfterFirst == 0 {
		t.Fatalf("leg_caller.ogg is empty after the first browser's frames")
	}

	// Simulate a page reload: the first browser's PeerConnection goes away entirely.
	_ = browser1.pc.Close()

	// Re-offer the SAME leg from a brand-new PeerConnection/certificate.
	browser2 := dialFakeBrowser(t, client, sessionID, "leg_caller")
	waitDTLSConnected(t, browser2.pc) // would time out pre-fix

	sendFrames(t, browser2.track, 5)
	time.Sleep(300 * time.Millisecond)

	sizeAfterSecond := fileSize(t, legPath)
	if sizeAfterSecond <= sizeAfterFirst {
		t.Fatalf("leg_caller.ogg did not grow after the reconnected browser's frames (audio never actually flowed post-reattach): before=%d after=%d",
			sizeAfterFirst, sizeAfterSecond)
	}

	var manifest struct {
		Files []struct {
			LegID string `json:"legId,omitempty"`
			Path  string `json:"path"`
		} `json:"files"`
	}
	status = client.do(t, http.MethodDelete, "/sessions/"+sessionID, nil, &manifest)
	if status != http.StatusOK {
		t.Fatalf("DELETE /sessions/%s: status %d", sessionID, status)
	}
}

func TestHealthEndpointRequiresNoAuth(t *testing.T) {
	baseURL, _ := startTestMediad(t)

	resp, err := http.Get(baseURL + "/health") //nolint:gosec // test-local httptest server, fixed URL
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /health: status %d", resp.StatusCode)
	}

	var body struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode /health: %v", err)
	}
	if body.Status != "ok" {
		t.Fatalf("health status = %q, want ok", body.Status)
	}
}

func TestUnauthorizedWithoutBearerToken(t *testing.T) {
	baseURL, _ := startTestMediad(t)

	resp, err := http.Post(baseURL+"/sessions", "application/json", bytes.NewBufferString("{}")) //nolint:gosec,noctx
	if err != nil {
		t.Fatalf("POST /sessions: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}
