/// The call UI (docs/plans/voice-calls-plan.md §3.3): a ring screen (accept /
/// accept-without-recording / decline) while ringing, and a compact in-call
/// bar (mute, hang up, ● REC, duration, the mediad-down notice) once
/// connecting/active. Wraps the whole app body in a [Stack] rather than using
/// `showDialog`/`Navigator` so a call rings/stays live across channel
/// switches without fighting the app's own navigation.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../calls/call_controller.dart';
import '../formatting.dart';
import '../responsive.dart';
import '../theme.dart';

/// Wraps [child] with the call UI. Mount ONCE near the root of the
/// authenticated app (not per-channel) -- a call can be ringing/live while
/// the user is looking at an entirely different channel.
class CallOverlay extends StatelessWidget {
  const CallOverlay({
    super.key,
    required this.controller,
    required this.labelForSub,
    required this.child,
  });

  final CallController controller;
  final String Function(String sub) labelForSub;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final snap = controller.snapshot;
        return Stack(
          children: [
            child,
            // Kept mounted (0x0) whenever there's any call state at all so the
            // underlying audio element attaches before negotiation completes
            // rather than being created/destroyed mid-call.
            if (snap.phase != CallPhase.idle) controller.buildRemoteAudioSink(),
            if (snap.isRinging)
              Positioned.fill(
                child: _CallRingScreen(
                  controller: controller,
                  labelForSub: labelForSub,
                ),
              ),
            if (snap.isLive)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: _CallBar(
                  controller: controller,
                  labelForSub: labelForSub,
                ),
              ),
            if (snap.phase == CallPhase.recordingMemo)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: _MemoRecordingBar(controller: controller),
              ),
            if (snap.phase == CallPhase.ended)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: _CallEndedBanner(
                  controller: controller,
                  labelForSub: labelForSub,
                ),
              ),
          ],
        );
      },
    );
  }
}

String _endReasonLabel(CallEndReason reason) => switch (reason) {
  CallEndReason.hangup => 'Call ended',
  CallEndReason.remoteHangup => 'Call ended',
  CallEndReason.disconnect => 'Call dropped — connection lost',
  CallEndReason.declined => 'Call declined',
  CallEndReason.cancelled => 'Call cancelled',
  CallEndReason.missed => 'Missed call',
  CallEndReason.taken => 'Answered on another tab',
  CallEndReason.failed => 'Call failed',
  CallEndReason.none => 'Call ended',
};

String _fmtDuration(Duration d) {
  final m = d.inMinutes.toString().padLeft(2, '0');
  final s = (d.inSeconds % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

/// Full-screen ring UI: outbound ("Calling…", cancel) or inbound (accept /
/// accept-without-recording / decline, plus the consent explainer when the
/// caller asked to record).
class _CallRingScreen extends StatelessWidget {
  const _CallRingScreen({required this.controller, required this.labelForSub});

  final CallController controller;
  final String Function(String) labelForSub;

  @override
  Widget build(BuildContext context) {
    final snap = controller.snapshot;
    final peer = snap.peerSub == null ? '' : labelForSub(snap.peerSub!);
    // This overlay is a Stack SIBLING of the app's Scaffold (see [CallOverlay]),
    // not a descendant of it, so it needs its own Material ancestor for the
    // ring actions' InkWell ink response to find (Material.transparency keeps
    // it invisible -- the actual background comes from the Container below).
    return Material(
      type: MaterialType.transparency,
      child: Container(
        color: AppColors.overlay,
        // Center normally; on a short viewport (a small phone with the consent
        // explainer + 3 ring actions all showing) scroll instead of overflowing.
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Container(
              width: dialogWidth(context, 380),
              padding: const EdgeInsets.all(26),
              decoration: BoxDecoration(
                color: AppColors.surface,
                border: Border.all(color: AppColors.border),
                borderRadius: BorderRadius.circular(AppRadius.lg),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 56,
                    height: 56,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(
                      color: AppColors.surfaceRaised,
                      shape: BoxShape.circle,
                    ),
                    child: Text(
                      initialsFor(peer),
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        color: AppColors.accent,
                      ),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    peer,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color: AppColors.text,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    snap.amCaller ? 'Calling…' : 'Incoming call',
                    style: const TextStyle(
                      fontSize: 13,
                      color: AppColors.textMuted,
                    ),
                  ),
                  if (!snap.amCaller && snap.wantRecording) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppColors.warnBg,
                        border: Border.all(color: AppColors.warnBorder),
                        borderRadius: BorderRadius.circular(AppRadius.sm),
                      ),
                      child: Text(
                        '$peer wants to record this call. Recording only happens with your '
                        'consent — decline to keep it unrecorded, or accept without recording.',
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.warn,
                          height: 1.4,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 24),
                  if (snap.amCaller)
                    OutlinedButton.icon(
                      onPressed: controller.declineOrCancel,
                      style: AppButtonStyles.ghost,
                      icon: const Icon(Icons.call_end, size: 16),
                      label: const Text('Cancel'),
                    )
                  else
                    Wrap(
                      alignment: WrapAlignment.center,
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        _RingAction(
                          icon: Icons.call_end,
                          label: 'Decline',
                          color: AppColors.bad,
                          onTap: controller.declineOrCancel,
                        ),
                        if (snap.wantRecording)
                          _RingAction(
                            icon: Icons.mic_off,
                            label: 'Accept\n(no recording)',
                            color: AppColors.warn,
                            onTap: () => controller.accept(consent: false),
                          ),
                        _RingAction(
                          icon: Icons.call,
                          label: snap.wantRecording
                              ? 'Accept &\nrecord'
                              : 'Accept',
                          color: AppColors.ok,
                          onTap: () =>
                              controller.accept(consent: snap.wantRecording),
                        ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _RingAction extends StatelessWidget {
  const _RingAction({
    required this.icon,
    required this.label,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // The whole column (icon + label) is tappable, not just the circle --
    // otherwise a tap on the label text below it (which is what widget tests
    // naturally target via `find.text`) would silently do nothing.
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              child: Icon(icon, color: Colors.white, size: 22),
            ),
            const SizedBox(height: 6),
            Text(
              label,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 10.5,
                color: AppColors.textMuted,
                height: 1.2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The connecting/active in-call bar, pinned to the bottom of the screen.
class _CallBar extends StatefulWidget {
  const _CallBar({required this.controller, required this.labelForSub});

  final CallController controller;
  final String Function(String) labelForSub;

  @override
  State<_CallBar> createState() => _CallBarState();
}

class _CallBarState extends State<_CallBar> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // The controller only notifies on state CHANGES; the duration display
    // needs a tick every second while live regardless of whether anything
    // else changed.
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final snap = widget.controller.snapshot;
    final peer = snap.peerSub == null ? '' : widget.labelForSub(snap.peerSub!);
    final compact = isCompact(context);
    final elapsed = snap.connectedAt == null
        ? null
        : DateTime.now().difference(snap.connectedAt!);

    return Material(
      color: AppColors.surfaceRaised,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 12 : 20,
            vertical: 10,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (snap.recordingUnavailableNotice)
                const _NoticeLine(
                  icon: Icons.mic_off,
                  text:
                      'Recording unavailable — this call will NOT be recorded.',
                  color: AppColors.warn,
                ),
              if (snap.recordingDeclinedNotice)
                const _NoticeLine(
                  icon: Icons.mic_off,
                  text:
                      'The other party declined recording — this call will NOT be recorded.',
                  color: AppColors.warn,
                ),
              Row(
                children: [
                  const Icon(Icons.call, size: 16, color: AppColors.ok),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      snap.phase == CallPhase.connecting
                          ? 'Connecting to $peer…'
                          : peer,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: AppColors.text,
                      ),
                    ),
                  ),
                  if (snap.recordingIndicatorOn) ...[
                    Container(
                      width: 8,
                      height: 8,
                      decoration: const BoxDecoration(
                        color: AppColors.bad,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 5),
                    const Text(
                      'REC',
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        color: AppColors.bad,
                      ),
                    ),
                    const SizedBox(width: 12),
                  ],
                  if (elapsed != null) ...[
                    Text(
                      _fmtDuration(elapsed),
                      style: AppFonts.mono(
                        fontSize: 12,
                        color: AppColors.textFaint,
                      ),
                    ),
                    const SizedBox(width: 10),
                  ],
                  IconButton(
                    onPressed: widget.controller.toggleMute,
                    icon: Icon(
                      snap.muted ? Icons.mic_off : Icons.mic,
                      size: 18,
                    ),
                    tooltip: snap.muted ? 'Unmute' : 'Mute',
                    color: snap.muted ? AppColors.warn : AppColors.textMuted,
                    visualDensity: VisualDensity.compact,
                  ),
                  IconButton(
                    onPressed: widget.controller.hangUp,
                    icon: const Icon(Icons.call_end, size: 18),
                    tooltip: 'Hang up',
                    color: AppColors.bad,
                    visualDensity: VisualDensity.compact,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Minimal in-progress bar for a self-DM voice memo ([CallPhase.recordingMemo]):
/// just the ● REC indicator, elapsed duration, and a Stop button (`call_end`)
/// -- no peer name, no mute, no remote-audio UI (there's no peer to mute for
/// or hear back from; [MediaSession] records server-side and sends nothing
/// back, per [WebrtcCallController.buildRemoteAudioSink]'s `isLive` gate).
class _MemoRecordingBar extends StatefulWidget {
  const _MemoRecordingBar({required this.controller});

  final CallController controller;

  @override
  State<_MemoRecordingBar> createState() => _MemoRecordingBarState();
}

class _MemoRecordingBarState extends State<_MemoRecordingBar> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // Same per-second tick as [_CallBarState] -- the duration display needs
    // to advance even though the controller only notifies on state changes.
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final snap = widget.controller.snapshot;
    final compact = isCompact(context);
    final elapsed = snap.connectedAt == null
        ? null
        : DateTime.now().difference(snap.connectedAt!);

    return Material(
      color: AppColors.surfaceRaised,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 12 : 20,
            vertical: 10,
          ),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: const BoxDecoration(
                  color: AppColors.bad,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 8),
              const Expanded(
                child: Text(
                  'Recording voice memo…',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                    color: AppColors.text,
                  ),
                ),
              ),
              if (elapsed != null) ...[
                Text(
                  _fmtDuration(elapsed),
                  style: AppFonts.mono(fontSize: 12, color: AppColors.textFaint),
                ),
                const SizedBox(width: 10),
              ],
              TextButton.icon(
                onPressed: widget.controller.hangUp,
                style: TextButton.styleFrom(foregroundColor: AppColors.bad),
                icon: const Icon(Icons.stop_circle_outlined, size: 18),
                label: const Text('Stop'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A brief "call ended" / "missed call" / failure banner shown once, then
/// dismissed (tap or [CallController.dismiss]).
class _CallEndedBanner extends StatelessWidget {
  const _CallEndedBanner({required this.controller, required this.labelForSub});

  final CallController controller;
  final String Function(String) labelForSub;

  @override
  Widget build(BuildContext context) {
    final snap = controller.snapshot;
    final peer = snap.peerSub == null ? '' : labelForSub(snap.peerSub!);
    final failed = snap.endReason == CallEndReason.failed;
    return Material(
      color: failed ? AppColors.badBg : AppColors.surfaceRaised,
      child: SafeArea(
        top: false,
        child: InkWell(
          onTap: controller.dismiss,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
            child: Row(
              children: [
                Icon(
                  failed ? Icons.error_outline : Icons.call_end,
                  size: 16,
                  color: failed ? AppColors.bad : AppColors.textMuted,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    failed && snap.errorMessage != null
                        ? snap.errorMessage!
                        // A solo memo has no peer (voice-memo UX) -- drop the " — <peer>" suffix
                        // rather than showing it dangling empty.
                        : peer.isEmpty
                        ? _endReasonLabel(snap.endReason)
                        : '${_endReasonLabel(snap.endReason)} — $peer',
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      color: failed ? AppColors.bad : AppColors.textMuted,
                    ),
                  ),
                ),
                const Icon(Icons.close, size: 15, color: AppColors.textFaint),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NoticeLine extends StatelessWidget {
  const _NoticeLine({
    required this.icon,
    required this.text,
    required this.color,
  });

  final IconData icon;
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          Icon(icon, size: 13, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 11.5, color: color)),
          ),
        ],
      ),
    );
  }
}
