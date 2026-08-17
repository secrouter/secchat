/// getUserMedia/getDisplayMedia + `RTCPeerConnection` lifecycle for ONE call
/// leg (docs/plans/voice-calls-plan.md §2.2/§3.3, docs/plans/voice-contracts.md
/// §3, and the video-calls addendum for camera/screen).
///
/// No client recording stack (recording moved server-side to secchat-mediad
/// in plan v3 -- no `MediaRecorder`, no Web Audio mix, no `dart:js_interop`
/// audio graph belongs anywhere near this class). The SAME class backs both
/// p2p and relayed calls -- the two modes differ only in who the remote peer
/// is (the other browser vs mediad) and in trickle-vs-non-trickle ICE
/// (voice-contracts.md §2.2), never in the media-session shape itself.
library;

import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart';

/// One inbound remote track, keyed by `"<stream.id>/<track.id>"` in
/// [MediaSession.remoteTracks] -- NOT bare `stream.id` (the old key: fine
/// while every remote source only ever carried one (audio) track, but a
/// collision waiting to happen the moment a second track — camera or screen
/// — shares that same source's stream id). [kind] is the RAW WebRTC kind
/// (`'audio'`/`'video'`), not a camera/screen distinction -- this class has
/// no visibility into the `call_roster`/`call_media` announcements that
/// disambiguate a video track's semantic role (see
/// `CallController`'s `_remoteTrackView`, which does that matching).
class RemoteMediaTrack {
  const RemoteMediaTrack({
    required this.streamId,
    required this.trackId,
    required this.kind,
    required this.renderer,
  });

  final String streamId;
  final String trackId;
  final String kind;
  final RTCVideoRenderer renderer;
}

/// One call leg's WebRTC state: local mic/camera/screen capture, the
/// (single) peer connection, and every remote track sunk to a live
/// renderer (via [remoteTracks] -- on web, `flutter_webrtc` backs an
/// `RTCVideoRenderer` with a hidden or visible `<video>`/`<audio>` element
/// regardless of whether video is used, which is what actually plays a
/// remote party's audio; there is no separate "audio-only renderer" type).
/// Still exactly ONE `RTCPeerConnection` per instance even for a group call
/// -- mediad's SFU relays every other participant's tracks to us over that
/// single PC's multiple inbound transceivers, so `pc.onTrack` just fires
/// more than once instead of the class needing a PC per remote party.
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

  /// The mic (+ camera video track, when [start] was called with
  /// `cameraOn: true`) -- see [start]'s doc for why the camera track can
  /// live here OR be added later via [enableCamera] with its own dedicated
  /// stream; either way it ends up referenced by [_cameraTrack].
  MediaStream? _localStream;

  MediaStreamTrack? _cameraTrack;
  RTCRtpSender? _cameraSender;

  MediaStream? _screenStream;
  MediaStreamTrack? _screenTrack;
  RTCRtpSender? _screenSender;

  /// True once the FIRST offer/answer round (this class's own
  /// [createOffer]/[createAnswerFor], driven by [CallController]) has
  /// begun -- guards [onRenegotiationNeeded] against firing for the native
  /// `negotiationneeded` event [start]'s own initial `addTrack` calls
  /// trigger (there is nothing to "renegotiate" yet; [CallController]
  /// drives that first round explicitly). Only real MID-CALL renegotiations
  /// (a camera/screen toggle after the call is already live) reach the
  /// callback.
  bool _initialNegotiationStarted = false;

  /// True once [start] has actually created the peer connection -- i.e. every
  /// other method on this class besides [start]/[dispose] is safe to call.
  /// [CallController] checks this before applying a remote offer that might
  /// have arrived while [start]'s `getUserMedia` (a first-time permission
  /// prompt can take seconds) was still in flight, instead of letting
  /// [createAnswerFor]'s [_requirePc] throw.
  bool get isStarted => _pc != null;

  bool get isCameraOn => _cameraTrack != null;
  bool get isScreenShareOn => _screenTrack != null;

  /// This connection's own LOCAL camera/screen track ids -- what
  /// [CallController] sends verbatim on `call_media` (the locked wire
  /// contract's `cameraTrackId`/`screenTrackId`), and what every OTHER
  /// participant's client matches mediad's relayed `video-<originTrackID>`
  /// track ids against.
  String? get localCameraTrackId => _cameraTrack?.id;
  String? get localScreenTrackId => _screenTrack?.id;

  /// Every remote party's tracks, sunk here — one [RTCVideoRenderer] per
  /// remote TRACK (not per source; see [RemoteMediaTrack]'s doc), keyed by
  /// `"<stream.id>/<track.id>"`. A 1:1/solo audio-only call still only ever
  /// gets one entry; a group (SFU) call gets one per OTHER participant's
  /// track mediad relays to us (`pc.onTrack` fires once per inbound track).
  /// Mount ALL of these in (0x0, invisible) `RTCVideoRenderer` widgets so
  /// the platform actually plays every one's audio (see the class doc) --
  /// [CallController.buildRemoteAudioSink] does this; it's harmless to also
  /// mount a video-kind entry there since each renderer here is wired to a
  /// single-track wrapper stream (see [_attachRemoteTrack]), never the
  /// shared multi-track stream mediad/the browser hands to [RTCTrackEvent]
  /// (which WOULD double-play a leg's audio across its audio- and
  /// video-kind renderers otherwise). Callers own the widget lifecycle;
  /// this class owns each renderer's `srcObject` and disposal.
  final Map<String, RemoteMediaTrack> remoteTracks = {};

  /// Fired whenever [remoteTracks] gains or loses an entry, so
  /// [CallController] can rebuild [CallController.buildRemoteAudioSink].
  /// Never fired for an in-place `srcObject` update on an existing renderer
  /// (nothing visible changes -- the sink widget doesn't care).
  void Function()? onRemoteTracksChanged;

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

  /// Fired for a REAL mid-call renegotiation need (a camera/screen track
  /// added/removed after the call is already live) -- see
  /// [_initialNegotiationStarted]. [CallController] only actually acts on
  /// this in p2p mode (send a fresh offer, `onnegotiationneeded` →
  /// `createOffer` — the same shape the initial p2p caller offer already
  /// uses); a group call's renegotiation is server-orchestrated instead
  /// (mediad notices the `call_media` announcement and pushes its own fresh
  /// offer, answered generically by the existing [createAnswerFor] path) --
  /// see `WebrtcCallController._beginMedia`'s wiring of this callback for
  /// why group mode ignores it rather than also offering (that would race
  /// mediad's own re-offer).
  void Function()? onRenegotiationNeeded;

  /// This side's own camera/screen preview -- NOT sent anywhere, just
  /// mirrored locally so the user can see what they're sharing (mirrored
  /// video like every camera app; screen share is not, so it reads
  /// correctly). Lazily initialized the first time [enableCamera]/
  /// [enableScreenShare] (or [start] with `cameraOn: true`) actually
  /// acquires a track — an unused renderer costs a live platform resource
  /// for nothing.
  final RTCVideoRenderer localCameraRenderer = RTCVideoRenderer();
  final RTCVideoRenderer localScreenRenderer = RTCVideoRenderer();
  bool _camRendererReady = false;
  bool _screenRendererReady = false;

  /// Fired whenever [localCameraRenderer]/[localScreenRenderer] gains or
  /// loses its `srcObject` (camera/screen turned on/off) -- mirrors
  /// [onRemoteTracksChanged]'s "something to rebuild" role for the LOCAL
  /// preview widgets.
  void Function()? onLocalPreviewChanged;

  MediaStreamTrack? get _localAudioTrack {
    final tracks = _localStream?.getAudioTracks() ?? const <MediaStreamTrack>[];
    return tracks.isEmpty ? null : tracks.first;
  }

  bool get isMuted => !(_localAudioTrack?.enabled ?? true);

  /// Acquires the mic (and, if [cameraOn], the camera in the SAME
  /// `getUserMedia` call -- an optional `video` constraints object instead
  /// of the old hardcoded `false`) and opens the peer connection. Call once
  /// per call leg before creating/receiving an offer. A camera NOT
  /// requested here can still be turned on mid-call via [enableCamera] --
  /// that path acquires its own dedicated getUserMedia stream instead of
  /// reusing this one, since by then the PC may already be fully
  /// negotiated and there's no "redo start()" available.
  Future<void> start({bool cameraOn = false}) async {
    _localStream = await navigator.mediaDevices.getUserMedia(<String, dynamic>{
      // Echo/noise mitigation (plan R2) -- verified across BOTH p2p and
      // relayed modes per the plan's testing strategy (the relay adds
      // latency the echo canceller has to track).
      'audio': const {'echoCancellation': true, 'noiseSuppression': true},
      'video': cameraOn ? const {'facingMode': 'user'} : false,
    });

    final pc = await createPeerConnection(<String, dynamic>{
      'iceServers': [for (final url in stunUrls) {'urls': url}],
      'sdpSemantics': 'unified-plan',
    });
    _pc = pc;

    pc.onTrack = (RTCTrackEvent event) {
      if (event.streams.isEmpty) return;
      unawaited(_attachRemoteTrack(event.streams.first, event.track));
    };
    pc.onRemoveTrack = (MediaStream stream, MediaStreamTrack track) {
      unawaited(_detachRemoteTrack('${stream.id}/${track.id ?? ''}'));
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
    pc.onRenegotiationNeeded = () {
      if (!_initialNegotiationStarted) return; // see the field's doc
      onRenegotiationNeeded?.call();
    };

    // Unified-plan transceivers (NOT the legacy offerToReceive*) -- plan
    // §2.2. addTrack on a fresh PC creates exactly these.
    for (final track in _localStream!.getAudioTracks()) {
      await pc.addTrack(track, _localStream!);
    }
    final initialVideo = _localStream!.getVideoTracks();
    if (initialVideo.isNotEmpty) {
      final track = initialVideo.first;
      _cameraSender = await pc.addTrack(track, _localStream!);
      _cameraTrack = track;
      await _syncLocalPreview(localCameraRenderer, track, isCamera: true);
    }
  }

  /// Turns the camera on -- a FRESH, video-only `getUserMedia` capture
  /// (distinct from [start]'s combined stream, since by the time this is
  /// called the PC may already be fully negotiated and mid-call is a
  /// different acquisition moment) added to the already-open PC via
  /// [RTCPeerConnection.addTrack]. No-op if the camera is already on. The
  /// resulting `addTrack` fires the PC's native `negotiationneeded` event —
  /// see [onRenegotiationNeeded].
  Future<void> enableCamera() async {
    if (_cameraTrack != null) return;
    final pc = _requirePc();
    final stream = await navigator.mediaDevices.getUserMedia(<String, dynamic>{
      'audio': false,
      'video': const {'facingMode': 'user'},
    });
    final tracks = stream.getVideoTracks();
    if (tracks.isEmpty) {
      for (final t in stream.getTracks()) {
        await t.stop();
      }
      return;
    }
    final track = tracks.first;
    _cameraSender = await pc.addTrack(track, stream);
    _cameraTrack = track;
    await _syncLocalPreview(localCameraRenderer, track, isCamera: true);
  }

  /// Turns the camera off -- removes its sender from the PC (triggering
  /// renegotiation same as [enableCamera]), stops the track, and clears the
  /// local preview. No-op if the camera is already off.
  Future<void> disableCamera() async {
    final track = _cameraTrack;
    if (track == null) return;
    final sender = _cameraSender;
    _cameraTrack = null;
    _cameraSender = null;
    if (sender != null) {
      try {
        await _pc?.removeTrack(sender);
      } catch (_) {
        // Best-effort -- a closing/closed PC can't remove a sender; the
        // track is still stopped below regardless of whether this landed.
      }
    }
    await track.stop();
    if (_camRendererReady) localCameraRenderer.srcObject = null;
    onLocalPreviewChanged?.call();
  }

  /// Turns screen sharing on -- `getDisplayMedia` (triggers the OS
  /// screen-picker / macOS Screen Recording permission prompt), added to
  /// the PC the same way [enableCamera] adds the camera. Independent
  /// lifecycle from the camera (both can be on at once). No-op if already
  /// sharing.
  Future<void> enableScreenShare() async {
    if (_screenTrack != null) return;
    final pc = _requirePc();
    final stream = await navigator.mediaDevices.getDisplayMedia(<String, dynamic>{
      'video': true,
      'audio': false,
    });
    final tracks = stream.getVideoTracks();
    if (tracks.isEmpty) {
      for (final t in stream.getTracks()) {
        await t.stop();
      }
      return;
    }
    final track = tracks.first;
    _screenStream = stream;
    _screenSender = await pc.addTrack(track, stream);
    _screenTrack = track;
    // The OS's own "Stop Sharing" control (menu bar pill / Control Center on
    // macOS) ends the track directly, bypassing our button entirely --
    // surface that the same way a user-initiated toggle would so
    // [CallController]'s snapshot (and the `call_media` broadcast) stay
    // truthful instead of claiming screen share is still on.
    track.onEnded = () => unawaited(disableScreenShare());
    await _syncLocalPreview(localScreenRenderer, track, isCamera: false);
  }

  /// Turns screen sharing off. No-op if already off. Safe to call from
  /// [MediaStreamTrack.onEnded] (the OS-initiated stop path) as well as a
  /// direct user toggle.
  Future<void> disableScreenShare() async {
    final track = _screenTrack;
    if (track == null) return;
    final sender = _screenSender;
    _screenTrack = null;
    _screenSender = null;
    if (sender != null) {
      try {
        await _pc?.removeTrack(sender);
      } catch (_) {
        // See [disableCamera]'s matching catch.
      }
    }
    track.onEnded = null;
    await track.stop();
    final stream = _screenStream;
    _screenStream = null;
    if (stream != null) {
      for (final t in stream.getTracks()) {
        if (!identical(t, track)) await t.stop();
      }
    }
    if (_screenRendererReady) localScreenRenderer.srcObject = null;
    onLocalPreviewChanged?.call();
  }

  /// Wires [renderer] to a single-track wrapper stream around [track] --
  /// NOT [track]'s originating stream directly, which for the `start()`-time
  /// camera case also carries the mic's audio track; feeding that straight
  /// into the preview `<video>` element would risk echoing the user's own
  /// mic back through their own speakers. Lazily initializes [renderer] the
  /// first time it's used (mirrors [_attachRemoteTrack]'s pattern).
  Future<void> _syncLocalPreview(
    RTCVideoRenderer renderer,
    MediaStreamTrack track, {
    required bool isCamera,
  }) async {
    final ready = isCamera ? _camRendererReady : _screenRendererReady;
    if (!ready) {
      await renderer.initialize();
      if (isCamera) {
        _camRendererReady = true;
      } else {
        _screenRendererReady = true;
      }
    }
    final wrapper = await createLocalMediaStream(isCamera ? 'local-camera' : 'local-screen');
    await wrapper.addTrack(track);
    renderer.srcObject = wrapper;
    onLocalPreviewChanged?.call();
  }

  /// Routes one inbound remote track to its own renderer, creating that
  /// renderer (and initializing it -- async, unlike the old eager
  /// [start]-time init) the first time [stream]/[track]'s key is seen. A
  /// group call's `pc.onTrack` fires once per remote track (audio AND video
  /// separately, even from the same participant's leg -- see
  /// [RemoteMediaTrack]'s doc on why the key includes the track id); a
  /// 1:1/solo audio-only call's fires exactly once, so this degrades to the
  /// old single-renderer behavior for those callers.
  Future<void> _attachRemoteTrack(MediaStream stream, MediaStreamTrack track) async {
    final trackId = track.id ?? '';
    final key = '${stream.id}/$trackId';
    final existing = remoteTracks[key];
    final isNew = existing == null;
    final renderer = existing?.renderer ?? RTCVideoRenderer();
    if (isNew) await renderer.initialize();
    // A single-track wrapper, not [stream] itself (which may carry a
    // participant's OTHER tracks too, e.g. their audio alongside this video
    // track) -- see [_syncLocalPreview]'s matching doc for why: mounting
    // every renderer here (including a video-kind one) in the invisible
    // audio sink (`CallController.buildRemoteAudioSink`) would otherwise
    // double-play that participant's audio once per renderer sharing the
    // same underlying stream.
    final wrapper = await createLocalMediaStream('remote-${key.replaceAll('/', '-')}');
    await wrapper.addTrack(track);
    renderer.srcObject = wrapper;
    remoteTracks[key] = RemoteMediaTrack(
      streamId: stream.id,
      trackId: trackId,
      kind: track.kind ?? 'audio',
      renderer: renderer,
    );
    if (isNew) onRemoteTracksChanged?.call();
  }

  /// Tears down and drops the renderer for a remote track that just ended
  /// (`pc.onRemoveTrack` -- a participant left / their leg was renegotiated
  /// away, or they turned their camera/screen off). No-op if [key] never
  /// had a renderer (or was already removed by [dispose]).
  Future<void> _detachRemoteTrack(String key) async {
    final entry = remoteTracks.remove(key);
    if (entry == null) return;
    entry.renderer.srcObject = null;
    await entry.renderer.dispose();
    onRemoteTracksChanged?.call();
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
  ///
  /// Also the MID-CALL RENEGOTIATION path for p2p (a camera/screen toggle
  /// after the call is already live, driven by [onRenegotiationNeeded]) --
  /// the same operation, just called again on an already-connected PC.
  Future<String> createOffer() async {
    _initialNegotiationStarted = true;
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
  /// offer on an already-connected PC whenever the roster OR a
  /// participant's camera/screen state changes (a participant joining/
  /// leaving/toggling adds/drops an m-line) -- `setRemoteDescription`
  /// / `createAnswer` / `setLocalDescription` behave identically for a
  /// renegotiation as for the initial offer, so this same method (called
  /// again) IS "apply a server-initiated offer, create an answer, return it"
  /// with no separate method needed. [CallController._applyRemoteSdp] is the
  /// one call site for both cases.
  Future<String> createAnswerFor(String remoteOfferSdp) async {
    _initialNegotiationStarted = true;
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

  /// Tears down the peer connection, stops all local capture (mic, camera,
  /// screen), and releases every renderer (remote + local preview). Safe to
  /// call multiple times / before [start].
  Future<void> dispose() async {
    onLocalCandidate = null;
    onConnectionEstablished = null;
    onRemoteTracksChanged = null;
    onRenegotiationNeeded = null;
    onLocalPreviewChanged = null;
    final pc = _pc;
    _pc = null;
    pc?.onTrack = null;
    pc?.onRemoveTrack = null;
    pc?.onIceCandidate = null;
    pc?.onIceGatheringState = null;
    pc?.onConnectionState = null;
    pc?.onRenegotiationNeeded = null;
    await pc?.close();

    final stream = _localStream;
    _localStream = null;
    if (stream != null) {
      for (final track in stream.getTracks()) {
        await track.stop();
      }
    }
    _cameraTrack = null;
    _cameraSender = null;
    if (_camRendererReady) {
      localCameraRenderer.srcObject = null;
      await localCameraRenderer.dispose();
    }

    final screenTrack = _screenTrack;
    _screenTrack = null;
    _screenSender = null;
    if (screenTrack != null) {
      screenTrack.onEnded = null;
      await screenTrack.stop();
    }
    final screenStream = _screenStream;
    _screenStream = null;
    if (screenStream != null) {
      for (final t in screenStream.getTracks()) {
        if (!identical(t, screenTrack)) await t.stop();
      }
    }
    if (_screenRendererReady) {
      localScreenRenderer.srcObject = null;
      await localScreenRenderer.dispose();
    }

    final entries = remoteTracks.values.toList();
    remoteTracks.clear();
    for (final entry in entries) {
      entry.renderer.srcObject = null;
      await entry.renderer.dispose();
    }
  }
}
