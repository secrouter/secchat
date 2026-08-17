/// The full-screen call view (voice-calls-plan.md §3.3's UI polish pass): the
/// SUSTAINED call phases (`connecting`/`active`/`recordingMemo`) get a
/// prominent, tab-bar-reachable screen instead of just [CallOverlay]'s
/// compact bottom bar -- big controls, a live duration, and a mic-level
/// meter so "is my mic actually working?" has an obvious visual answer
/// instead of silence-and-hope. [ChatScreen] hosts this behind the "Call"
/// bottom tab (see [CallTabBar]) once a call reaches one of those phases;
/// [CallOverlay] still owns the transient ring/ended UI, which doesn't need
/// (and shouldn't get) a whole screen to itself.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../calls/call_controller.dart';
import '../formatting.dart';
import '../theme.dart';

String _fmtDuration(Duration d) {
  final m = d.inMinutes.toString().padLeft(2, '0');
  final s = (d.inSeconds % 60).toString().padLeft(2, '0');
  return '$m:$s';
}

/// True for the phases [CallScreen]/[CallTabBar] treat as "a call is
/// actually up" -- long enough to be worth a dedicated screen and a bottom
/// tab, as opposed to the transient ringing/ended states [CallOverlay]
/// handles with a dialog-like overlay instead.
bool isSustainedCallPhase(CallPhase phase) =>
    phase == CallPhase.connecting || phase == CallPhase.active || phase == CallPhase.recordingMemo;

/// Full-screen call UI for a live/connecting/recording call. Rebuilds via
/// [AnimatedBuilder] on [controller], same pattern as [CallOverlay].
class CallScreen extends StatefulWidget {
  const CallScreen({super.key, required this.controller, required this.labelForSub});

  final CallController controller;
  final String Function(String sub) labelForSub;

  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    // The controller only notifies on state CHANGES; the duration display
    // needs to advance every second regardless (same pattern as
    // `call_overlay.dart`'s `_CallBarState`/`_MemoRecordingBarState`).
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
    return AnimatedBuilder(
      animation: widget.controller,
      builder: (context, _) {
        final snap = widget.controller.snapshot;
        final isMemo = snap.phase == CallPhase.recordingMemo;
        final peer = snap.peerSub == null ? '' : widget.labelForSub(snap.peerSub!);
        final title = isMemo ? 'Voice memo' : peer;
        final elapsed = snap.connectedAt == null ? null : DateTime.now().difference(snap.connectedAt!);
        final statusText = snap.phase == CallPhase.connecting
            ? 'Connecting…'
            : isMemo
            ? (elapsed == null ? 'Starting…' : 'Recording…')
            : (elapsed == null ? 'Connecting…' : 'Connected');
        // Truthful ● REC (finding #7, call_overlay.dart): the server-pushed
        // value for a 2-party call; always on for a solo memo (that's the
        // whole point of the phase -- there's no separate "recording"
        // sub-phase to gate on, see `CallPhase.recordingMemo`'s doc).
        final recOn = isMemo || snap.recordingIndicatorOn;

        return Material(
          color: AppColors.bg,
          child: SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 20),
              child: Column(
                children: [
                  const Spacer(flex: 2),
                  Container(
                    width: 96,
                    height: 96,
                    alignment: Alignment.center,
                    decoration: const BoxDecoration(
                      color: AppColors.surfaceRaised,
                      shape: BoxShape.circle,
                    ),
                    child: isMemo
                        ? const Icon(Icons.mic, size: 40, color: AppColors.accent)
                        : Text(
                            initialsFor(peer),
                            style: const TextStyle(
                              fontSize: 30,
                              fontWeight: FontWeight.w700,
                              color: AppColors.accent,
                            ),
                          ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    title,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                      color: AppColors.text,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (recOn) ...[
                        Container(
                          width: 10,
                          height: 10,
                          decoration: const BoxDecoration(color: AppColors.bad, shape: BoxShape.circle),
                        ),
                        const SizedBox(width: 6),
                        const Text(
                          'REC',
                          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.bad),
                        ),
                        const SizedBox(width: 12),
                      ],
                      Text(statusText, style: const TextStyle(fontSize: 14, color: AppColors.textMuted)),
                    ],
                  ),
                  if (elapsed != null) ...[
                    const SizedBox(height: 6),
                    Text(_fmtDuration(elapsed), style: AppFonts.mono(fontSize: 18, color: AppColors.textFaint)),
                  ],
                  if (snap.recordingUnavailableNotice)
                    _Notice(
                      text: 'Recording unavailable — this call will NOT be recorded.',
                    ),
                  if (snap.recordingDeclinedNotice)
                    _Notice(
                      text: 'The other party declined recording — this call will NOT be recorded.',
                    ),
                  const Spacer(flex: 2),
                  MicLevelMeter(level: snap.micLevel),
                  const Spacer(flex: 3),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      // No peer to mute FOR on a solo memo -- mediad records
                      // this connection's mic regardless of the local mute
                      // toggle's UI existing or not, so hide a control that
                      // would just be confusing.
                      if (!isMemo) ...[
                        _BigControlButton(
                          icon: snap.muted ? Icons.mic_off : Icons.mic,
                          label: snap.muted ? 'Unmute' : 'Mute',
                          background: snap.muted ? AppColors.warn : AppColors.surfaceRaised,
                          foreground: snap.muted ? AppColors.onWarn : AppColors.text,
                          onTap: widget.controller.toggleMute,
                        ),
                        const SizedBox(width: 28),
                      ],
                      _BigControlButton(
                        icon: Icons.call_end,
                        label: isMemo ? 'Stop' : 'End call',
                        background: AppColors.bad,
                        foreground: Colors.white,
                        onTap: widget.controller.hangUp,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// Live horizontal mic-level meter (0.0–1.0) -- the debug aid: if the user
/// is visibly speaking but this bar stays flat, the mic isn't capturing
/// anything (wrong input device, OS-level mute, permission silently
/// revoked, ...). Fed by [CallSnapshot.micLevel], which
/// [WebrtcCallController] samples from [MediaSession.pollInputLevel] every
/// ~150ms while the call is live.
class MicLevelMeter extends StatelessWidget {
  const MicLevelMeter({super.key, required this.level});

  /// 0.0 (silent) – 1.0 (full scale). Values outside that range are clamped.
  final double level;

  @override
  Widget build(BuildContext context) {
    final clamped = level.clamp(0.0, 1.0);
    // Green under normal speech levels, warm at a level that's likely
    // clipping -- a second, coarser signal alongside the bar's length itself.
    final fillColor = clamped > 0.85 ? AppColors.warn : AppColors.accent;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          children: [
            const Icon(Icons.graphic_eq, size: 14, color: AppColors.textMuted),
            const SizedBox(width: 6),
            const Text('Mic', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
          ],
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.sm),
          child: Container(
            height: 14,
            width: double.infinity,
            color: AppColors.surfaceRaised,
            alignment: Alignment.centerLeft,
            child: AnimatedFractionallySizedBox(
              key: const Key('mic-level-fill'),
              duration: const Duration(milliseconds: 120),
              curve: Curves.easeOut,
              widthFactor: clamped,
              alignment: Alignment.centerLeft,
              child: DecoratedBox(decoration: BoxDecoration(color: fillColor)),
            ),
          ),
        ),
      ],
    );
  }
}

class _BigControlButton extends StatelessWidget {
  const _BigControlButton({
    required this.icon,
    required this.label,
    required this.background,
    required this.foreground,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final Color background;
  final Color foreground;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(40),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: background, shape: BoxShape.circle),
              child: Icon(icon, color: foreground, size: 30),
            ),
            const SizedBox(height: 8),
            Text(label, style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          ],
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: AppColors.warnBg,
          border: Border.all(color: AppColors.warnBorder),
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.mic_off, size: 13, color: AppColors.warn),
            const SizedBox(width: 6),
            Flexible(
              child: Text(text, style: const TextStyle(fontSize: 11.5, color: AppColors.warn)),
            ),
          ],
        ),
      ),
    );
  }
}

/// The bottom tab bar shown alongside [CallScreen] while
/// [isSustainedCallPhase] is true -- lets the user hop back to Chat while
/// the call keeps running (the call itself isn't torn down; only the tab
/// selection changes), and back to Call to check on it. Rebuilds via
/// [AnimatedBuilder] on [controller] so the ● REC dot / label track the live
/// call state independent of whatever triggers `ChatScreen`'s own rebuilds.
class CallTabBar extends StatelessWidget {
  const CallTabBar({super.key, required this.controller, required this.selected, required this.onSelect});

  final CallController controller;

  /// 0 = Chat, 1 = Call.
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final snap = controller.snapshot;
        final recording = snap.phase == CallPhase.recordingMemo || snap.recordingIndicatorOn;
        return Material(
          color: AppColors.surfaceRaised,
          child: SafeArea(
            top: false,
            child: SizedBox(
              height: 56,
              child: Row(
                children: [
                  Expanded(
                    child: _TabItem(
                      icon: Icons.chat_bubble_outline,
                      label: 'Chat',
                      selected: selected == 0,
                      onTap: () => onSelect(0),
                    ),
                  ),
                  Expanded(
                    child: _TabItem(
                      icon: snap.phase == CallPhase.recordingMemo ? Icons.mic : Icons.call,
                      label: snap.phase == CallPhase.recordingMemo ? 'Recording' : 'Call',
                      selected: selected == 1,
                      showDot: recording,
                      onTap: () => onSelect(1),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _TabItem extends StatelessWidget {
  const _TabItem({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.showDot = false,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final bool showDot;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = selected ? AppColors.accent : AppColors.textMuted;
    return InkWell(
      onTap: onTap,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Stack(
            clipBehavior: Clip.none,
            children: [
              Icon(icon, size: 20, color: color),
              if (showDot)
                Positioned(
                  right: -5,
                  top: -3,
                  child: Container(
                    width: 8,
                    height: 8,
                    decoration: const BoxDecoration(color: AppColors.bad, shape: BoxShape.circle),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 3),
          Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color)),
        ],
      ),
    );
  }
}
