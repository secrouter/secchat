/// getUserMedia + `RTCPeerConnection` lifecycle for ONE call leg
/// (docs/plans/voice-calls-plan.md §2.2/§3.3, docs/plans/voice-contracts.md §3).
///
/// Deliberately minimal: audio only, one send/recv audio transceiver, no
/// client recording stack (recording moved server-side to secchat-mediad in
/// plan v3 -- no `MediaRecorder`, no Web Audio mix, no `dart:js_interop`
/// audio graph belongs anywhere near this class). The SAME class backs both
/// p2p and relayed calls -- the two modes differ only in who the remote peer
/// is (the other browser vs mediad) and in trickle-vs-non-trickle ICE
/// (voice-contracts.md §2.2), never in the media-session shape itself.
library;

import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

/// One call leg's WebRTC state: local mic capture, the (single) peer
/// connection, and every remote track sunk to a live audio element (via
/// [remoteRenderers] -- on web, `flutter_webrtc` backs an `RTCVideoRenderer`
/// with a hidden `<video>`/`<audio>` element regardless of whether video is
/// used, which is what actually plays a remote party's audio; there is no
/// separate "audio-only renderer" type). Still exactly ONE `RTCPeerConnection`
/// per instance even for a group call -- mediad's SFU relays every other
/// participant's audio to us over that single PC's multiple inbound
/// transceivers, so `pc.onTrack` just fires more than once instead of the
/// class needing a PC per remote party.
class MediaSession {
  MediaSession({this.stunUrls = const []});

  /// STUN server URLs the deployment configures (plan A3/§2.5,
  /// `SECCHAT_CALL_STUN`) -- e.g. `stun:stun.example.org:3478`. Empty ⇒ no ICE
  /// servers configured at all; the connection then relies entirely on
  /// host/peer-reflexive candidates (may still work on a LAN/VPN, per plan
  /// §2.2's note on relayed mode never needing STUN in the first place).
  /// Sourced from `GET /me`'s `callStunUrls` (finding #4) -- see
  /// `Principal.callStunUrls` in models.dart and `ChatScreen`'s
  /// `debugCallControllerFactory` call for the wiring from there to here.
  final List<String> stunUrls;

  RTCPeerConnection? _pc;
  MediaStream? _localStream;

  /// True once [start] has actually created the peer connection -- i.e. every
  /// other method on this class besides [start]/[dispose] is safe to call.
  /// [CallController] checks this before applying a remote offer that might
  /// have arrived while [start]'s `getUserMedia` (a first-time permission
  /// prompt can take seconds) was still in flight, instead of letting
  /// [createAnswerFor]'s [_requirePc] throw.
  bool get isStarted => _pc != null;

  /// Every remote party's audio, sunk here — one [RTCVideoRenderer] per
  /// remote track, keyed by that track's source id (`MediaStream.id`, or the
  /// track's own id for a streamless track). A 1:1/solo call only ever has
  /// one entry; a group (SFU) call gets one per OTHER participant the server
  /// relays to us (`pc.onTrack` fires once per inbound track -- N−1 of them
  /// in an N-party call). Mount ALL of these in (0x0, invisible)
  /// `RTCVideoRenderer` widgets so the platform actually plays them (see the
  /// class doc) -- [CallController.buildRemoteAudioSink] does this. Callers
  /// own the widget lifecycle; this class owns each renderer's `srcObject`
  /// and disposal.
  final Map<String, RTCVideoRenderer> remoteRenderers = {};

  /// Fired whenever [remoteRenderers] gains or loses an entry, so
  /// [CallController] can rebuild [CallController.buildRemoteAudioSink].
  /// Never fired for an in-place `srcObject` update on an existing renderer
  /// (nothing visible changes -- the sink widget doesn't care).
  void Function()? onRemoteRenderersChanged;

  /// Fired for each locally-gathered ICE candidate — **p2p mode only**
  /// (voice-contracts.md §2.2/§2.2 of the plan: relayed mode is non-trickle,
  /// so a relayed [CallController] must never wire this up).
  void Function(RTCIceCandidate candidate)? onLocalCandidate;

  /// Fired once when the peer connection actually establishes media
  /// (`RTCPeerConnectionState.RTCPeerConnectionStateConnected`) — what
  /// [CallController] waits for before flipping a p2p call from
  /// "connecting" to "active" (relayed mode doesn't get an equivalent signal
  /// from the client side today; see the TODO on `CallController._onSdp`).
  void Function()? onConnectionEstablished;

  MediaStreamTrack? get _localAudioTrack {
    final tracks = _localStream?.getAudioTracks() ?? const <MediaStreamTrack>[];
    return tracks.isEmpty ? null : tracks.first;
  }

  bool get isMuted => !(_localAudioTrack?.enabled ?? true);

  /// Acquires the mic and opens the peer connection. Call once per call leg
  /// before creating/receiving an offer.
  Future<void> start() async {
    _localStream = await navigator.mediaDevices.getUserMedia(<String, dynamic>{
      // Echo/noise mitigation (plan R2) -- verified across BOTH p2p and
      // relayed modes per the plan's testing strategy (the relay adds
      // latency the echo canceller has to track).
      'audio': const {'echoCancellation': true, 'noiseSuppression': true},
      'video': false,
    });

    final pc = await createPeerConnection(<String, dynamic>{
      'iceServers': [for (final url in stunUrls) {'urls': url}],
      // Audio-only call: no bundle/rtcp-mux surprises from a video m-line
      // that's never negotiated.
      'sdpSemantics': 'unified-plan',
    });
    _pc = pc;

    pc.onTrack = (RTCTrackEvent event) {
      if (event.streams.isEmpty) return;
      final stream = event.streams.first;
      // The stream id is stable per remote source for the life of that
      // source's track (mediad/the browser mint a fresh one per m-line) --
      // good enough as the renderer key even though it's opaque (no sub
      // travels with the track itself; the roster's identity comes from
      // `call_roster`/`call_participant_joined`, matched by [CallController]
      // separately, not by this id).
      unawaited(_attachRemoteTrack(stream.id, stream));
    };
    pc.onRemoveTrack = (MediaStream stream, MediaStreamTrack track) {
      unawaited(_detachRemoteTrack(stream.id));
    };
    pc.onConnectionState = (RTCPeerConnectionState state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        onConnectionEstablished?.call();
      }
    };
    pc.onIceCandidate = (RTCIceCandidate candidate) {
      // The empty-string candidate is the platform's end-of-candidates
      // sentinel -- p2p mode has no use for it (there's no "end" frame; the
      // peer just stops receiving new ones), so drop it here.
      if (candidate.candidate == null || candidate.candidate!.isEmpty) return;
      onLocalCandidate?.call(candidate);
    };

    // Unified-plan audio transceiver (NOT the legacy offerToReceiveAudio) --
    // plan §2.2. addTrack on a fresh PC creates exactly this.
    for (final track in _localStream!.getAudioTracks()) {
      await pc.addTrack(track, _localStream!);
    }
  }

  /// Routes one inbound remote track to its own renderer, creating that
  /// renderer (and initializing it -- async, unlike the old eager
  /// [start]-time init) the first time [sourceId] is seen. A group call's
  /// `pc.onTrack` fires once per remote participant's track; a 1:1/solo
  /// call's fires exactly once, so this degrades to the old single-renderer
  /// behavior for those callers.
  Future<void> _attachRemoteTrack(String sourceId, MediaStream stream) async {
    var renderer = remoteRenderers[sourceId];
    final isNew = renderer == null;
    if (isNew) {
      renderer = RTCVideoRenderer();
      await renderer.initialize();
      remoteRenderers[sourceId] = renderer;
    }
    renderer.srcObject = stream;
    if (isNew) onRemoteRenderersChanged?.call();
  }

  /// Tears down and drops the renderer for a remote track that just ended
  /// (`pc.onRemoveTrack` -- a participant left / their leg was renegotiated
  /// away). No-op if [sourceId] never had a renderer (or was already
  /// removed by [dispose]).
  Future<void> _detachRemoteTrack(String sourceId) async {
    final renderer = remoteRenderers.remove(sourceId);
    if (renderer == null) return;
    renderer.srcObject = null;
    await renderer.dispose();
    onRemoteRenderersChanged?.call();
  }

  /// Creates an offer, sets it as the local description, and returns the SDP
  /// AS OF THAT MOMENT -- before ICE gathering has necessarily produced any
  /// candidates. p2p-mode callers use this return value directly (candidates
  /// trickle separately via [onLocalCandidate]). Relayed-mode callers MUST
  /// await [waitForIceGatheringComplete] and then read [currentLocalSdp] --
  /// NOT this method's return value -- before sending anything to mediad
  /// (voice-contracts.md §2.2's non-trickle requirement: mediad needs every
  /// candidate embedded in the SDP itself, since there's no candidate
  /// exchange in that mode).
  Future<String> createOffer() async {
    final pc = _requirePc();
    final desc = await pc.createOffer(const <String, dynamic>{});
    await pc.setLocalDescription(desc);
    return desc.sdp ?? '';
  }

  /// Applies a remote offer and returns an answer's SDP (the new local
  /// description) as of that moment. Same non-trickle caveat as [createOffer]
  /// for relayed mode -- use [currentLocalSdp] after
  /// [waitForIceGatheringComplete], not this return value.
  ///
  /// Also the RENEGOTIATION path: a group call's server can send a fresh
  /// offer on an already-connected PC whenever the roster changes (a
  /// participant joining/leaving adds/drops an m-line) -- `setRemoteDescription`
  /// / `createAnswer` / `setLocalDescription` behave identically for a
  /// renegotiation as for the initial offer, so this same method (called
  /// again) IS "apply a server-initiated offer, create an answer, return it"
  /// with no separate method needed. [CallController._applyRemoteSdp] is the
  /// one call site for both cases.
  Future<String> createAnswerFor(String remoteOfferSdp) async {
    final pc = _requirePc();
    await pc.setRemoteDescription(RTCSessionDescription(remoteOfferSdp, 'offer'));
    final desc = await pc.createAnswer(const <String, dynamic>{});
    await pc.setLocalDescription(desc);
    return desc.sdp ?? '';
  }

  /// The peer connection's CURRENT local description SDP, freshly re-read
  /// rather than the value captured at [createOffer]/[createAnswerFor] time.
  /// `flutter_webrtc` (like every WebRTC stack) mutates the local
  /// description in place as ICE candidates are gathered -- calling this
  /// AFTER [waitForIceGatheringComplete] is what actually picks up the
  /// gathered candidates for relayed mode's non-trickle offer/answer
  /// (voice-contracts.md §1.2/§2.2). Calling [createOffer]/[createAnswerFor]
  /// again here would be wrong (it would renegotiate); this only re-reads.
  Future<String> currentLocalSdp() async {
    final desc = await _requirePc().getLocalDescription();
    return desc?.sdp ?? '';
  }

  /// Applies a remote answer to an offer we sent earlier.
  Future<void> applyAnswer(String remoteAnswerSdp) async {
    await _requirePc().setRemoteDescription(RTCSessionDescription(remoteAnswerSdp, 'answer'));
  }

  /// **p2p mode only** — applies one trickled remote ICE candidate.
  Future<void> addRemoteCandidate(String candidate, String? sdpMid, int? sdpMLineIndex) async {
    await _pc?.addCandidate(RTCIceCandidate(candidate, sdpMid, sdpMLineIndex));
  }

  /// Blocks until local ICE gathering completes — relayed mode's non-trickle
  /// requirement (voice-contracts.md §2.2): both mediad's answer AND the
  /// client's own offer/answer must be gather-complete before they cross the
  /// control API, since there's no `call_candidate` exchange in that mode.
  /// A 10s safety timeout guards against a network that never completes
  /// gathering (e.g. no reachable STUN) — the offer/answer still goes out
  /// with whatever candidates were gathered by then rather than hanging the
  /// call forever.
  Future<void> waitForIceGatheringComplete() async {
    final pc = _pc;
    if (pc == null) return;
    if (pc.iceGatheringState == RTCIceGatheringState.RTCIceGatheringStateComplete) {
      return;
    }
    final completer = Completer<void>();
    pc.onIceGatheringState = (RTCIceGatheringState state) {
      if (state == RTCIceGatheringState.RTCIceGatheringStateComplete && !completer.isCompleted) {
        completer.complete();
      }
    };
    await completer.future.timeout(const Duration(seconds: 10), onTimeout: () {});
  }

  void setMuted(bool muted) {
    final track = _localAudioTrack;
    if (track != null) track.enabled = !muted;
  }

  /// The LOCAL mic's current input level, 0.0–1.0 -- the standard
  /// `flutter_webrtc`/WebRTC-stats way to read it: `getStats()`'s
  /// `media-source` report (kind `audio`) carries a live `audioLevel` value
  /// sourced directly from the capture device, independent of whether
  /// anything has been negotiated/sent yet. Some platforms only populate
  /// `audioLevel` on the `outbound-rtp` report instead (once a track is
  /// actually being sent), so that's the fallback. Returns `0.0` if neither
  /// is present, or on any error -- this drives a debug meter
  /// ([CallScreen]'s mic-level bar), so it must never throw.
  Future<double> pollInputLevel() async {
    final pc = _pc;
    if (pc == null) return 0.0;
    try {
      final reports = await pc.getStats();
      double? outboundLevel;
      for (final report in reports) {
        final values = report.values;
        if (report.type == 'media-source' && values['kind'] == 'audio') {
          final level = values['audioLevel'];
          if (level is num) return level.toDouble();
        } else if (report.type == 'outbound-rtp' && outboundLevel == null) {
          final level = values['audioLevel'];
          if (level is num) outboundLevel = level.toDouble();
        }
      }
      return outboundLevel ?? 0.0;
    } catch (_) {
      return 0.0;
    }
  }

  RTCPeerConnection _requirePc() {
    final pc = _pc;
    if (pc == null) {
      throw StateError('MediaSession.start() must complete before signaling');
    }
    return pc;
  }

  /// Tears down the peer connection, stops local capture, and releases the
  /// renderer. Safe to call multiple times / before [start].
  Future<void> dispose() async {
    onLocalCandidate = null;
    onConnectionEstablished = null;
    onRemoteRenderersChanged = null;
    final pc = _pc;
    _pc = null;
    pc?.onTrack = null;
    pc?.onRemoveTrack = null;
    pc?.onIceCandidate = null;
    pc?.onIceGatheringState = null;
    pc?.onConnectionState = null;
    await pc?.close();

    final stream = _localStream;
    _localStream = null;
    if (stream != null) {
      for (final track in stream.getTracks()) {
        await track.stop();
      }
    }

    final renderers = remoteRenderers.values.toList();
    remoteRenderers.clear();
    for (final renderer in renderers) {
      renderer.srcObject = null;
      await renderer.dispose();
    }
  }
}
