/// The call UI (docs/plans/voice-calls-plan.md §3.3): a ring screen (accept /
/// accept-without-recording / decline) while ringing, and a brief "call
/// ended" banner. Wraps the whole app body in a [Stack] rather than using
/// `showDialog`/`Navigator` so a call rings/dismisses across channel
/// switches without fighting the app's own navigation.
///
/// The SUSTAINED in-call UI (connecting/active/recordingMemo -- mute, hang
/// up, ● REC, duration, the mic-level meter) used to live here as a compact
/// bottom bar, but has moved to the full-screen [CallScreen] reached via
/// `ChatScreen`'s Call bottom tab (see `call_screen.dart`) -- this overlay
/// only owns the states that are too transient to deserve their own tab.
library;

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
            // isLive/recordingMemo/ended intentionally show NOTHING here anymore
            // -- `ChatScreen` renders [CallScreen] full-screen (behind the Call
            // bottom tab) for the sustained phases AND the terminal "Call Ended"
            // screen (the old auto-dismiss banner is gone; the user closes the
            // ended screen explicitly). A compact bar here would double up the UI
            // and physically overlap `ChatScreen`'s bottomNavigationBar.
          ],
        );
      },
    );
  }
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

