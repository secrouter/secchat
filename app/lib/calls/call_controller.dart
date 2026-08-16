/// The client-side signaling state machine for a 1:1 voice call
/// (docs/plans/voice-calls-plan.md §2.1/§2.2/§3.3), mirroring the server's
/// `CallState` (`ringing → active → ended`, voice-contracts.md §1). Talks the
/// `call_*` frames over the existing global WS socket
/// ([ApiClient.subscribeAll]/`sendCall*`) and drives a [MediaSession] for the
/// actual audio.
///
/// [CallController] is the abstract seam the UI (and widget tests) depend on
/// -- same shape as `DaemonSupervisor`/`RunnerDaemonState`
/// (`lib/platform/daemon_supervisor_api.dart`): a live, listenable
/// [snapshot] plus a small set of user actions. [WebrtcCallController] is the
/// real implementation; tests construct a lightweight subclass overriding
/// only what they need (see `test/calls/fake_call_controller.dart`).
library;

import 'dart:async' show Completer, unawaited;

import 'package:flutter/widgets.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart' show RTCVideoView;

import '../api.dart';
import '../models.dart';
import 'media_session.dart';

/// Local phase of a call. Mirrors the server's `ringing → active → ended`
/// (voice-calls-plan.md §2.1) but splits `ringing` by who rang whom (the UI
/// shows a different screen to each side) and inserts `connecting` between
/// "the callee answered" and "media is actually flowing" -- SDP/ICE
/// negotiation isn't instant, and the ● REC / mute controls shouldn't appear
/// until there's a call to control.
enum CallPhase {
  /// No call in progress on this channel.
  idle,

  /// I placed the call; waiting for the callee to answer.
  ringingOutbound,

  /// Someone is calling me; the ring screen is up.
  ringingInbound,

  /// The callee answered; SDP/ICE negotiation is in flight.
  connecting,

  /// Media is flowing.
  active,

  /// The call just ended -- shown briefly so the reason (missed/declined/
  /// hung up/disconnected) registers, then [CallController.dismiss] returns
  /// to idle.
  ended,
}

/// Why a call reached [CallPhase.ended] (or never got past ringing).
enum CallEndReason {
  none,
  hangup, // I ended it
  remoteHangup, // the peer ended it
  disconnect, // a bound connection dropped (voice-contracts.md §1.1)
  declined, // the callee declined a ringing call
  cancelled, // I cancelled my own outbound ring before it was answered
  missed, // the 45s ringing timeout expired unanswered
  taken, // a different tab of mine answered first
  failed, // local failure (mic denied, negotiation error, ...)
}

/// One immutable snapshot of [CallController]'s state.
@immutable
class CallSnapshot {
  const CallSnapshot({
    this.phase = CallPhase.idle,
    this.channelId,
    this.peerSub,
    this.amCaller = false,
    this.wantRecording = false,
    this.consent,
    this.mode,
    this.recordingUnavailableNotice = false,
    this.recordingDeclinedNotice = false,
    this.recordingOn = false,
    this.muted = false,
    this.connectedAt,
    this.endReason = CallEndReason.none,
    this.errorMessage,
  });

  final CallPhase phase;

  /// The DM channel this call belongs to; null only at [CallPhase.idle].
  final String? channelId;

  /// The other party's sub; null only at [CallPhase.idle].
  final String? peerSub;

  /// Whether *I* am the caller on this call (drives which ring UI shows).
  final bool amCaller;

  /// The caller's recording ask (`call_invite.wantRecording`) -- meaningful
  /// once ringing, either side.
  final bool wantRecording;

  /// The callee's recording-consent decision, once made. Independent of
  /// [wantRecording] (D3/D4) -- `false` always yields an unrecorded call even
  /// if the caller asked to record.
  final bool? consent;

  /// The transport mode, fixed once `call_accept` resolves (null before
  /// then). Drives whether ● REC can ever be true for this call.
  final CallMode? mode;

  /// True when recording was expected (I asked for it as caller, or I
  /// consented to it as callee) but the resolved [mode] came back `p2p` --
  /// the mediad-down downgrade case (voice-calls-plan.md §2.3,
  /// voice-contracts.md §1.2). Shown as an explicit banner, not just a
  /// missing ● REC (too subtle for a consent-relevant change). Mutually
  /// exclusive with [recordingDeclinedNotice] -- this one is specifically the
  /// infrastructure-failure case (consent was `true`), not the callee simply
  /// saying no (D4).
  final bool recordingUnavailableNotice;

  /// True when *I* asked for recording (as caller) but the callee's
  /// consent decision came back `false` -- a normal D4 outcome (plan §D4:
  /// "call proceeds unrecorded"), not a failure. Kept distinct from
  /// [recordingUnavailableNotice] so the caller sees "they said no" rather
  /// than the infrastructure-failure "recording unavailable" copy for what
  /// is, from the server's point of view, a perfectly healthy call.
  final bool recordingDeclinedNotice;

  /// mediad's ACTUAL recording-writer state, as pushed live by the server
  /// (`call_recording`, voice-contracts.md §1.2, plan §2.3/finding #7) --
  /// truthful ● REC by construction, not a client-side guess. Always `false`
  /// for a p2p call (mediad is never involved) and before the first push for
  /// a relayed one.
  final bool recordingOn;

  final bool muted;

  /// When the call became [CallPhase.active] -- the in-call bar's duration
  /// timer reads this (`DateTime.now().difference(connectedAt)`).
  final DateTime? connectedAt;

  final CallEndReason endReason;

  /// A human-readable failure detail, set alongside [CallEndReason.failed].
  final String? errorMessage;

  /// True while a ring screen should be showing.
  bool get isRinging => phase == CallPhase.ringingOutbound || phase == CallPhase.ringingInbound;

  /// True while the in-call bar should be showing (negotiating or live).
  bool get isLive => phase == CallPhase.connecting || phase == CallPhase.active;

  /// Truthful ● REC (finding #7): the server-pushed [recordingOn] value
  /// directly -- mediad's actual writer state, not a client-side guess.
  bool get recordingIndicatorOn => recordingOn;

  CallSnapshot copyWith({
    CallPhase? phase,
    Object? channelId = _unset,
    Object? peerSub = _unset,
    bool? amCaller,
    bool? wantRecording,
    Object? consent = _unset,
    Object? mode = _unset,
    bool? recordingUnavailableNotice,
    bool? recordingDeclinedNotice,
    bool? recordingOn,
    bool? muted,
    Object? connectedAt = _unset,
    CallEndReason? endReason,
    Object? errorMessage = _unset,
  }) => CallSnapshot(
    phase: phase ?? this.phase,
    channelId: identical(channelId, _unset) ? this.channelId : channelId as String?,
    peerSub: identical(peerSub, _unset) ? this.peerSub : peerSub as String?,
    amCaller: amCaller ?? this.amCaller,
    wantRecording: wantRecording ?? this.wantRecording,
    consent: identical(consent, _unset) ? this.consent : consent as bool?,
    mode: identical(mode, _unset) ? this.mode : mode as CallMode?,
    recordingUnavailableNotice: recordingUnavailableNotice ?? this.recordingUnavailableNotice,
    recordingDeclinedNotice: recordingDeclinedNotice ?? this.recordingDeclinedNotice,
    recordingOn: recordingOn ?? this.recordingOn,
    muted: muted ?? this.muted,
    connectedAt: identical(connectedAt, _unset) ? this.connectedAt : connectedAt as DateTime?,
    endReason: endReason ?? this.endReason,
    errorMessage: identical(errorMessage, _unset) ? this.errorMessage : errorMessage as String?,
  );
}

const Object _unset = Object();

/// Abstract seam: the live call state + the actions a UI can take.
/// [WebrtcCallController] is the real implementation; a widget test builds a
/// small subclass that overrides [snapshot] and the action methods instead
/// of touching WebRTC/network at all.
abstract class CallController extends ChangeNotifier {
  CallSnapshot get snapshot;

  /// Route one `call_*` WS event here. [WebrtcCallController]'s caller
  /// (`ChatScreen`) forwards every `WsCallInviteEvent`/`WsCallAcceptEvent`/
  /// `WsCallTakenEvent`/`WsCallSdpEvent`/`WsCallCandidateEvent`/
  /// `WsCallEndEvent`/`WsCallMissedEvent`/`WsCallRecordingEvent`/
  /// `WsCallErrorEvent` it receives on the global socket.
  void handleEvent(WsEvent event);

  /// Start a call to [peerSub] in [channelId] (`call_invite`).
  Future<void> startCall({
    required String channelId,
    required String peerSub,
    required bool wantRecording,
  });

  /// Answer a ringing INBOUND call (`call_accept`). [consent] is the
  /// recording-consent decision.
  Future<void> accept({required bool consent});

  /// Decline a ringing inbound call, or cancel my own not-yet-answered
  /// outbound call.
  void declineOrCancel();

  /// End a connecting/active call.
  void hangUp();

  void toggleMute();

  /// Dismiss a just-[CallPhase.ended] call's banner, returning to idle.
  void dismiss();

  /// A widget that must stay mounted (even off-screen) while
  /// [CallSnapshot.isLive] is true -- it's what actually plays the remote
  /// party's audio (see [MediaSession]'s class doc). The base/fake
  /// implementation renders nothing.
  Widget buildRemoteAudioSink() => const SizedBox.shrink();
}

/// The real [CallController]: drives [MediaSession] and the `call_*` frames
/// on [api].
class WebrtcCallController extends CallController {
  WebrtcCallController({required this.api, required this.mySub, this.stunUrls = const []});

  final ApiClient api;
  final String mySub;

  /// STUN server URLs (see [MediaSession.stunUrls] — sourced from `GET /me`'s
  /// `callStunUrls`, threaded in by `ChatScreen`).
  final List<String> stunUrls;

  CallSnapshot _snapshot = const CallSnapshot();
  @override
  CallSnapshot get snapshot => _snapshot;

  MediaSession? _media;

  /// Non-null while [accept] is waiting for the server's OWN `call_accept`
  /// echo to this connection (registry.ts's `accept()` always sends one to
  /// the winning callee connection, not just the caller -- voice-contracts.md
  /// §1.2 / src/calls/registry.ts). [accept] awaits this instead of deriving
  /// `mode` locally: guessing risked racing the mediad-down downgrade echo
  /// (`consent: true` but `mode` resolves to `p2p`) against a [_beginMedia]
  /// that already read the guessed `mode`, producing offer-glare (finding
  /// #4). Completed by [_onAccept] with the confirmed `(consent, mode)`, or
  /// by any code path that ends the call while we're still waiting (taken /
  /// call_error / hangup / disconnect) with `null` so [accept] doesn't sit
  /// out its full timeout for no reason.
  Completer<(bool, CallMode)?>? _pendingAcceptEcho;

  /// True once THIS connection's own accept win is server-confirmed (i.e.
  /// [_pendingAcceptEcho] resolved with a real value, or we're the caller
  /// processing the caller-side `call_accept`). Because [accept] no longer
  /// advances [CallPhase.connecting] until that confirmation lands, a
  /// [CallPhase.connecting] snapshot always has this true in practice --
  /// [_onTaken] still checks it explicitly (rather than assuming) as
  /// defense-in-depth against ever tearing down a call we've actually won.
  bool _acceptConfirmed = false;

  /// A remote SDP offer that arrived (via `call_sdp`) before [MediaSession]
  /// finished [MediaSession.start] -- almost always the p2p callee: the
  /// caller's offer can beat a first-time `getUserMedia` permission prompt,
  /// which the browser/OS can hold open for several seconds (finding #3).
  /// [_onSdp] buffers it here instead of letting [MediaSession.createAnswerFor]
  /// hit [MediaSession.isStarted]'s precondition; [_beginMedia] replays it
  /// once `start()` resolves. Cleared on replay or on any [_endLocally].
  String? _pendingRemoteOffer;

  void _emit(CallSnapshot next) {
    _snapshot = next;
    notifyListeners();
  }

  @override
  Future<void> startCall({
    required String channelId,
    required String peerSub,
    required bool wantRecording,
  }) async {
    if (_snapshot.phase != CallPhase.idle) return; // already on a call — the UI gates this too
    _acceptConfirmed = false;
    _emit(
      CallSnapshot(
        phase: CallPhase.ringingOutbound,
        channelId: channelId,
        peerSub: peerSub,
        amCaller: true,
        wantRecording: wantRecording,
      ),
    );
    api.sendCallInvite(channelId, wantRecording: wantRecording);
  }

  @override
  Future<void> accept({required bool consent}) async {
    final channelId = _snapshot.channelId;
    if (_snapshot.phase != CallPhase.ringingInbound || channelId == null) return;
    if (_pendingAcceptEcho != null) return; // already accepting — ignore a duplicate tap
    api.sendCallAccept(channelId, consent: consent);

    // Wait for the server's OWN `call_accept` echo to this connection rather
    // than deriving `mode` locally (finding #4) — see [_pendingAcceptEcho]'s
    // doc comment. A 5s safety timeout guards a socket that never gets a
    // reply (matching [MediaSession.waitForIceGatheringComplete]'s pattern).
    final completer = Completer<(bool, CallMode)?>();
    _pendingAcceptEcho = completer;
    (bool, CallMode)? echoed;
    try {
      echoed = await completer.future.timeout(const Duration(seconds: 5), onTimeout: () => null);
    } finally {
      if (identical(_pendingAcceptEcho, completer)) _pendingAcceptEcho = null;
    }

    // While we were waiting, the call may already have been resolved another
    // way (a `call_taken`/`call_error`/hangup/disconnect all end the call
    // locally and settle the completer with `null` — see [_endLocally]). Only
    // apply the echo if we're still exactly where we left off.
    if (_snapshot.channelId != channelId || _snapshot.phase != CallPhase.ringingInbound) return;
    if (echoed == null) {
      // The `call_accept` we sent above may have taken hold server-side even
      // though we never saw its echo back (a dropped/delayed reply, not a
      // dropped request) -- registry.ts's accept() runs synchronously with
      // the send, so by the time our 5s wait times out the server may
      // already consider this connection the bound, active callee. Tell it
      // we're bailing regardless of local phase (finding #2) so it doesn't
      // leave the call parked "active"/"ringing" against a callee that's
      // already given up; `registry.ts`'s `end()` no-ops harmlessly if
      // nothing turns out to be live. [_fail] itself only re-sends this for
      // the connecting/active phases, which we never reached here.
      api.sendCallEnd(channelId);
      _fail('No response from the server while accepting the call');
      return;
    }
    final (confirmedConsent, mode) = echoed;
    _acceptConfirmed = true;
    _emit(
      _snapshot.copyWith(
        phase: CallPhase.connecting,
        consent: confirmedConsent,
        mode: mode,
        // No recordingDeclinedNotice here: I'm the callee, so if consent is
        // false it's because I JUST tapped "Accept (no recording)" myself --
        // that banner exists to tell the CALLER the other party said no, not
        // to tell myself what I just chose.
        recordingUnavailableNotice: confirmedConsent && mode == CallMode.p2p,
      ),
    );
    await _beginMedia();
  }

  @override
  void declineOrCancel() {
    final channelId = _snapshot.channelId;
    final wasInbound = _snapshot.phase == CallPhase.ringingInbound;
    if (channelId != null) api.sendCallEnd(channelId);
    _endLocally(wasInbound ? CallEndReason.declined : CallEndReason.cancelled);
  }

  @override
  void hangUp() {
    final channelId = _snapshot.channelId;
    if (channelId != null) api.sendCallEnd(channelId);
    _endLocally(CallEndReason.hangup);
  }

  @override
  void toggleMute() {
    if (!_snapshot.isLive) return;
    final muted = !_snapshot.muted;
    _media?.setMuted(muted);
    _emit(_snapshot.copyWith(muted: muted));
  }

  @override
  void dismiss() {
    if (_snapshot.phase != CallPhase.ended) return;
    _emit(const CallSnapshot());
  }

  @override
  Widget buildRemoteAudioSink() {
    final media = _media;
    if (media == null || !_snapshot.isLive) return const SizedBox.shrink();
    // Zero-size but mounted: on web this keeps the underlying `<audio>`/
    // `<video>` element attached to the DOM so the remote track actually
    // plays (see [MediaSession]'s class doc) without taking any layout space.
    return SizedBox(width: 0, height: 0, child: RTCVideoView(media.remoteRenderer));
  }

  // ── Wire events ─────────────────────────────────────────────────────

  @override
  void handleEvent(WsEvent event) {
    switch (event) {
      case WsCallInviteEvent(:final channelId, :final from, :final wantRecording):
        _onInvite(channelId, from, wantRecording);
      case WsCallAcceptEvent(:final channelId, :final consent, :final mode):
        _onAccept(channelId, consent, mode);
      case WsCallTakenEvent(:final channelId):
        _onTaken(channelId);
      case WsCallSdpEvent(:final channelId, :final sdpType, :final sdp):
        unawaited(_onSdp(channelId, sdpType, sdp));
      case WsCallCandidateEvent(:final channelId, :final candidate, :final sdpMid, :final sdpMLineIndex):
        unawaited(_onCandidate(channelId, candidate, sdpMid, sdpMLineIndex));
      case WsCallEndEvent(:final channelId, :final byDisconnect):
        _onRemoteEnd(channelId, byDisconnect);
      case WsCallMissedEvent(:final channelId):
        _onMissed(channelId);
      case WsCallRecordingEvent(:final channelId, :final recording):
        _onRecording(channelId, recording);
      case WsCallErrorEvent(:final channelId, :final error, :final detail):
        _onCallError(channelId, error, detail);
      default:
        break; // not a call event
    }
  }

  void _onInvite(String channelId, String from, bool wantRecording) {
    // Glare (finding #3): I'm already ringingOutbound to the SAME peer on the SAME channel, and an
    // invite just arrived FROM them. The server's deterministic tiebreak (lower sub wins,
    // registry.ts's `invite()`) silently superseded MY ringing call and fanned THEIRS out to me
    // instead -- voice-contracts.md never echoes an explicit "you won"/"you lost" signal to the
    // loser's original invite; the loser just receives a fresh `call_invite` like any other callee.
    // Treat it as the glare-winner's incoming call rather than dropping it under the single-flight
    // guard below (which would otherwise strand me ringingOutbound forever -- mic never opened, the
    // peer's phone visibly ringing for a call I can never answer).
    final isGlareWinnerInvite =
        _snapshot.phase == CallPhase.ringingOutbound &&
        _snapshot.channelId == channelId &&
        _snapshot.peerSub == from;
    if (_snapshot.phase != CallPhase.idle && !isGlareWinnerInvite) return; // single-flight (server enforces this too)
    _acceptConfirmed = false;
    _emit(
      CallSnapshot(
        phase: CallPhase.ringingInbound,
        channelId: channelId,
        peerSub: from,
        amCaller: false,
        wantRecording: wantRecording,
      ),
    );
  }

  void _onAccept(String channelId, bool consent, CallMode mode) {
    if (_snapshot.channelId != channelId) return;

    // The callee's OWN accept echo -- [accept] is awaiting exactly this (see
    // [_pendingAcceptEcho]'s doc comment); hand it the confirmed value and
    // let IT apply the [CallPhase.connecting] transition + start media. Never
    // reached for the caller (only [accept] sets this).
    final pending = _pendingAcceptEcho;
    if (pending != null && !pending.isCompleted) {
      pending.complete((consent, mode));
      return;
    }

    // Otherwise this is the CALLER's confirmation that the callee accepted
    // (voice-contracts.md §1.2's documented `call_accept` -> caller frame) --
    // the caller was ringing and never started media yet.
    if (_snapshot.phase != CallPhase.ringingOutbound) return;
    _acceptConfirmed = true;
    _emit(
      _snapshot.copyWith(
        phase: CallPhase.connecting,
        consent: consent,
        mode: mode,
        // Two DISTINCT downgrade-to-unrecorded reasons, per voice-calls-plan.md
        // §D3/§D4 -- conflating them showed the caller the infrastructure-
        // failure banner for what's actually a normal "they said no":
        //  - recordingUnavailableNotice: the callee CONSENTED but mediad was
        //    down, so the server itself fell back to `p2p` (§2.3). An
        //    infra failure worth calling out distinctly.
        //  - recordingDeclinedNotice: the callee simply declined (D4, "call
        //    proceeds unrecorded") -- `mode` here is whatever the server
        //    resolves for a non-consenting call (p2p), not a failure at all.
        recordingUnavailableNotice: consent && mode == CallMode.p2p,
        recordingDeclinedNotice: _snapshot.wantRecording && !consent,
      ),
    );
    unawaited(_beginMedia());
  }

  void _onTaken(String channelId) {
    if (_snapshot.channelId != channelId) return;
    // Normal case: still on the ring screen, never accepted (or a different
    // tab of mine is what accepted). Defensive case (finding #2): parked in
    // [CallPhase.connecting] but NOT yet confirmed as the winning connection
    // -- can't happen given [accept]'s wait-for-echo redesign (a confirmed
    // echo is what enters [CallPhase.connecting] in the first place), but
    // checked explicitly rather than assumed so a losing tab can never be
    // left stuck in 'connecting' with the mic captured.
    final stillContestable =
        _snapshot.phase == CallPhase.ringingInbound ||
        (_snapshot.phase == CallPhase.connecting && !_acceptConfirmed);
    if (!stillContestable) return;
    _endLocally(CallEndReason.taken);
  }

  /// A `call_*` frame this connection sent was rejected (finding #1):
  /// `user_busy`/`glare_lost`/`call_active` reject an invite (I'm stuck
  /// [CallPhase.ringingOutbound]); `not_ringing`/`mediad_broker_failed`
  /// reject an accept/relay (I'm stuck [CallPhase.connecting] with the mic
  /// already open). Either way, end the call locally so the phase advances
  /// and [MediaSession] gets disposed -- never leave the user parked.
  void _onCallError(String channelId, String error, String? detail) {
    if (_snapshot.channelId != channelId) return;
    if (_snapshot.phase == CallPhase.idle || _snapshot.phase == CallPhase.ended) return;
    // Finding #3 pairing: `glare_lost` rejects MY OWN doomed invite attempt -- but by the time it
    // arrives, [_onInvite]'s glare-conversion fix may have ALREADY turned this same outbound ring
    // into a legitimate INBOUND one (the winner's invite; voice-contracts.md never sends an explicit
    // "you lost" signal separate from this error, so the ordering vs. the winner's `call_invite`
    // isn't guaranteed). Once that conversion has happened, this error refers to an attempt that's
    // already moot -- failing the call now would tear down the very call the conversion just set up.
    // Only fail on `glare_lost` while STILL in the outbound ring it was rejecting.
    if (error == 'glare_lost' && _snapshot.phase != CallPhase.ringingOutbound) return;
    _fail(_describeCallError(error, detail));
  }

  /// A human-readable message for a `call_error` code (voice-contracts.md
  /// §1.3, src/calls/registry.ts's `CallSignalError` codes + ws/hub.ts's own
  /// `*_failed` codes) -- the error code itself is always included so it's
  /// surfaced even for a code this client doesn't have friendly copy for yet
  /// (the server can add new ones without a client update breaking).
  static String _describeCallError(String error, String? detail) {
    final friendly = switch (error) {
      'user_busy' => 'The other person is already on a call',
      'glare_lost' => 'You were already being called — answer that call instead',
      'call_active' => 'A call is already active on this channel',
      'not_ringing' => 'That call is no longer ringing',
      'mediad_broker_failed' => 'Call setup failed',
      'frame_too_large' => 'Call signaling error',
      _ => 'Call error',
    };
    return detail == null ? '$friendly ($error)' : '$friendly: $detail ($error)';
  }

  Future<void> _onSdp(String channelId, String sdpType, String sdp) async {
    final media = _media;
    if (media == null || _snapshot.channelId != channelId) return;
    if (sdpType == 'offer' && !media.isStarted) {
      // The caller's offer beat our own `MediaSession.start()` (getUserMedia
      // -- a first-time mic-permission prompt can take seconds) to arrive
      // (finding #3): applying it now would hit `createAnswerFor`'s
      // `_requirePc()` precondition and fail the call out from under a
      // callee who's still looking at the permission prompt. Buffer it;
      // [_beginMedia] replays it once `start()` resolves.
      _pendingRemoteOffer = sdp;
      return;
    }
    await _applyRemoteSdp(channelId, sdpType, sdp);
  }

  /// The actual offer/answer application -- split out of [_onSdp] so
  /// [_beginMedia] can replay a buffered offer ([_pendingRemoteOffer]) once
  /// [MediaSession] has actually started (finding #3).
  Future<void> _applyRemoteSdp(String channelId, String sdpType, String sdp) async {
    final media = _media;
    if (media == null) return;
    try {
      if (sdpType == 'offer') {
        var answer = await media.createAnswerFor(sdp);
        if (_snapshot.mode == CallMode.relayed) {
          await media.waitForIceGatheringComplete();
          // Re-read the local description post-gathering (finding #3):
          // [MediaSession.createAnswerFor]'s returned SDP was captured at
          // `setLocalDescription` time, BEFORE ICE candidates land. The
          // relayed/non-trickle contract (voice-contracts.md §1.2/§2.2) needs
          // mediad to receive the gather-complete answer, not the empty one.
          answer = await media.currentLocalSdp();
        }
        api.sendCallSdp(channelId, sdpType: 'answer', sdp: answer);
        // p2p: ICE was already trickling via onLocalCandidate; nothing else to do here.
        // relayed: this leg is now fully negotiated (mediad's answer flow is one-shot, so an
        // "offer" only ever reaches us in p2p mode in practice — kept generic for symmetry).
      } else {
        await media.applyAnswer(sdp);
        if (_snapshot.mode == CallMode.relayed) {
          // TODO(voice): no client-visible "leg connected" signal exists for relayed mode today
          // (mediad reports leg ICE state to the BACKEND, voice-contracts.md §2.3, not to clients).
          // Flip to active on answer application as the v1 approximation; revisit if the backend
          // contract grows a live per-leg connected push.
          _markActive();
        }
      }
    } catch (error) {
      _fail('Call setup failed: $error');
    }
  }

  Future<void> _onCandidate(
    String channelId,
    String candidate,
    String? sdpMid,
    int? sdpMLineIndex,
  ) async {
    if (_snapshot.channelId != channelId || _snapshot.mode != CallMode.p2p) return;
    await _media?.addRemoteCandidate(candidate, sdpMid, sdpMLineIndex);
  }

  void _onRemoteEnd(String channelId, bool byDisconnect) {
    if (_snapshot.channelId != channelId) return;
    // Idempotent, like [_onMissed]'s `isRinging` guard below (ws/hub.ts finding #2): a ringing
    // call's dismissal now fans out via `deliverToUser` to EVERY live connection of BOTH parties --
    // including the tab that itself just declined/cancelled and already transitioned locally to
    // [CallPhase.ended] with a specific [CallEndReason] before this echo of its own action arrives.
    // Without this guard that echo would re-run [_endLocally] and overwrite e.g. `declined`/
    // `cancelled` with the generic `remoteHangup`/`disconnect` this handler always applies.
    if (_snapshot.phase == CallPhase.idle || _snapshot.phase == CallPhase.ended) return;
    _endLocally(byDisconnect ? CallEndReason.disconnect : CallEndReason.remoteHangup);
  }

  void _onMissed(String channelId) {
    if (_snapshot.channelId != channelId || !_snapshot.isRinging) return;
    _endLocally(CallEndReason.missed);
  }

  /// Truthful ● REC (finding #7): mirror mediad's actual writer state as pushed by the server.
  void _onRecording(String channelId, bool recording) {
    if (_snapshot.channelId != channelId) return;
    _emit(_snapshot.copyWith(recordingOn: recording));
  }

  // ── Media lifecycle ─────────────────────────────────────────────────

  Future<void> _beginMedia() async {
    final channelId = _snapshot.channelId;
    if (channelId == null) return;
    final media = MediaSession(stunUrls: stunUrls);
    _media = media;
    try {
      await media.start();
    } catch (error) {
      _fail('Could not access the microphone: $error');
      return;
    }
    media.onConnectionEstablished = () {
      if (_snapshot.mode == CallMode.p2p) _markActive();
    };

    final mode = _snapshot.mode;
    if (mode == CallMode.p2p) {
      media.onLocalCandidate = (candidate) {
        api.sendCallCandidate(
          channelId,
          candidate: candidate.candidate ?? '',
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        );
      };
      if (_snapshot.amCaller) {
        try {
          final offer = await media.createOffer();
          api.sendCallSdp(channelId, sdpType: 'offer', sdp: offer);
        } catch (error) {
          _fail('Could not start the call: $error');
        }
      }
      // Callee: wait for the caller's offer via `call_sdp` (_onSdp above).
    } else if (mode == CallMode.relayed) {
      // Both legs independently offer to mediad (voice-contracts.md §2.2) —
      // non-trickle: gather ICE to completion, then send the POST-gathering
      // description (finding #3) -- `createOffer()`'s return value was
      // captured at `setLocalDescription` time, before any candidate landed;
      // sending that would hand mediad a zero-candidate offer and the wait
      // below would accomplish nothing.
      try {
        await media.createOffer();
        await media.waitForIceGatheringComplete();
        final offer = await media.currentLocalSdp();
        api.sendCallSdp(channelId, sdpType: 'offer', sdp: offer);
      } catch (error) {
        _fail('Could not start the call: $error');
      }
    }

    // Replay an offer that arrived (and was buffered by [_onSdp]) while
    // `media.start()` above was still in flight (finding #3). Only the p2p
    // callee ever has one buffered — the caller sends its own offer instead
    // of receiving one, and relayed mode's "offer" is mediad-directed, not
    // routed through this buffer.
    final pendingOffer = _pendingRemoteOffer;
    _pendingRemoteOffer = null;
    if (pendingOffer != null && _snapshot.channelId == channelId) {
      await _applyRemoteSdp(channelId, 'offer', pendingOffer);
    }
  }

  void _markActive() {
    if (_snapshot.phase != CallPhase.connecting) return;
    _emit(_snapshot.copyWith(phase: CallPhase.active, connectedAt: DateTime.now()));
  }

  /// A local-only failure (mic permission denied, negotiation error,
  /// accept-echo timeout, a relayed answer that couldn't be applied, ...).
  /// Tells the server about it -- via the same `call_end` frame [hangUp]
  /// sends -- whenever the call had actually reached the server's `active`
  /// registry entry (`connecting`/`active`; voice-contracts.md §1.1's
  /// `registry.end()`), not just torn down locally. Without this the server
  /// kept the call "active" and the peer sat in "Connecting…" with their mic
  /// open until they manually hung up or their socket dropped.
  void _fail(String message) {
    final channelId = _snapshot.channelId;
    if (channelId != null &&
        (_snapshot.phase == CallPhase.connecting || _snapshot.phase == CallPhase.active)) {
      api.sendCallEnd(channelId);
    }
    _endLocally(CallEndReason.failed, errorMessage: message);
  }

  void _endLocally(CallEndReason reason, {String? errorMessage}) {
    // Unblock a still-in-flight [accept] wait (finding #2/#4): whatever just
    // ended the call locally means the echo it's waiting for either isn't
    // coming or no longer matters.
    final pendingAccept = _pendingAcceptEcho;
    if (pendingAccept != null && !pendingAccept.isCompleted) pendingAccept.complete(null);
    _acceptConfirmed = false;
    _pendingRemoteOffer = null; // don't leak a buffered offer (finding #3) into the next call
    final media = _media;
    _media = null;
    if (media != null) unawaited(media.dispose());
    if (_snapshot.phase == CallPhase.idle) return;
    _emit(
      CallSnapshot(
        phase: CallPhase.ended,
        channelId: _snapshot.channelId,
        peerSub: _snapshot.peerSub,
        amCaller: _snapshot.amCaller,
        mode: _snapshot.mode,
        endReason: reason,
        errorMessage: errorMessage,
      ),
    );
  }

  @override
  void dispose() {
    final media = _media;
    _media = null;
    if (media != null) unawaited(media.dispose());
    super.dispose();
  }
}
