/// The DM header's call button (docs/plans/voice-calls-plan.md §3.3): starts
/// a 1:1 voice call with the channel's peer. Presence-aware -- disabled while
/// the peer is offline (nobody to ring) or a call is already in progress
/// anywhere in the app (single-flight, mirroring the server's per-user rule,
/// voice-calls-plan.md §2.1).
library;

import 'package:flutter/material.dart';

import '../calls/call_controller.dart';
import '../theme.dart';

class CallButton extends StatelessWidget {
  const CallButton({
    super.key,
    required this.controller,
    required this.channelId,
    required this.peerSub,
    required this.peerLabel,
    required this.peerOnline,
  });

  final CallController controller;
  final String channelId;
  final String peerSub;
  final String peerLabel;
  final bool peerOnline;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final busy = controller.snapshot.phase != CallPhase.idle;
        final enabled = peerOnline && !busy;
        return PopupMenuButton<bool>(
          enabled: enabled,
          tooltip: !peerOnline
              ? '$peerLabel is offline'
              : busy
              ? 'Already on a call'
              : 'Call $peerLabel',
          icon: Icon(
            Icons.call_outlined,
            size: 17,
            color: enabled ? AppColors.textMuted : AppColors.textFaint,
          ),
          color: AppColors.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.sm),
            side: BorderSide(color: AppColors.border),
          ),
          onSelected: (wantRecording) => controller.startCall(
            channelId: channelId,
            peerSub: peerSub,
            wantRecording: wantRecording,
          ),
          itemBuilder: (_) => [
            const PopupMenuItem<bool>(
              value: false,
              child: _CallMenuRow(
                icon: Icons.call,
                label: 'Call',
                detail: 'Not recorded',
              ),
            ),
            PopupMenuItem<bool>(
              value: true,
              child: _CallMenuRow(
                icon: Icons.fiber_manual_record,
                iconColor: AppColors.bad,
                label: 'Call and record',
                detail: 'Needs the other side\'s consent',
              ),
            ),
          ],
        );
      },
    );
  }
}

/// The self-DM header's solo-record button (voice-memo UX): starts a one-leg
/// relayed recording of just your own mic (`call_solo_start`) with no peer
/// involved. Unlike [CallButton] this is NOT presence-gated -- you're always
/// reachable to yourself -- it only disables while a call/memo is already in
/// progress anywhere in the app (the same single-flight rule).
class SoloRecordButton extends StatelessWidget {
  const SoloRecordButton({super.key, required this.controller, required this.channelId});

  final CallController controller;
  final String channelId;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final busy = controller.snapshot.phase != CallPhase.idle;
        return PopupMenuButton<bool>(
          enabled: !busy,
          tooltip: busy ? 'Already on a call' : 'Record a voice memo',
          icon: Icon(
            Icons.mic_none,
            size: 17,
            color: busy ? AppColors.textFaint : AppColors.textMuted,
          ),
          color: AppColors.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.sm),
            side: BorderSide(color: AppColors.border),
          ),
          // The popup's `bool` value is `enroll` — whether to also save this
          // recording as a voiceprint. `wantRecording` is always true here:
          // there's no point to a solo memo the server doesn't record.
          onSelected: (enroll) => controller.startSoloRecord(
            channelId: channelId,
            wantRecording: true,
            enroll: enroll,
          ),
          itemBuilder: (_) => [
            PopupMenuItem<bool>(
              value: false,
              child: _CallMenuRow(
                icon: Icons.fiber_manual_record,
                iconColor: AppColors.bad,
                label: 'Record memo',
                detail: 'Transcribed into this chat',
              ),
            ),
            const PopupMenuItem<bool>(
              value: true,
              child: _CallMenuRow(
                icon: Icons.fingerprint,
                label: 'Record & save my voiceprint',
                detail: 'Also enrolls your voice for ID',
              ),
            ),
          ],
        );
      },
    );
  }
}

/// The group-channel header's call control (multi-party SFU calls,
/// voice-contracts.md's `call_start`/`call_join`): lets anyone either start a
/// fresh call or join one already live. Unlike [CallButton] there's no ring/
/// invite for a group call and so no wire signal telling a client whether a
/// call is already in progress in this channel before it tries -- this
/// offers BOTH actions explicitly (join-on-demand) rather than guessing
/// which one applies; picking the wrong one is a harmless server-side
/// rejection, not a real failure mode. Single-flight gated like every other
/// call control -- disabled while already on a call/memo anywhere in the app.
class GroupCallButton extends StatelessWidget {
  const GroupCallButton({super.key, required this.controller, required this.channelId});

  final CallController controller;
  final String channelId;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final busy = controller.snapshot.phase != CallPhase.idle;
        // 'start'/'join' rather than an enum -- keeps the popup's value type
        // (`String`, like [SoloRecordButton]'s `enroll` bool) something a
        // widget test can name via `PopupMenuButton<String>` without needing
        // access to a private type.
        return PopupMenuButton<String>(
          enabled: !busy,
          tooltip: busy ? 'Already on a call' : 'Start or join a group call',
          icon: Icon(
            Icons.groups_outlined,
            size: 17,
            color: busy ? AppColors.textFaint : AppColors.textMuted,
          ),
          color: AppColors.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.sm),
            side: BorderSide(color: AppColors.border),
          ),
          onSelected: (action) {
            switch (action) {
              case 'start':
                controller.startGroupCall(channelId);
              case 'join':
                controller.joinGroupCall(channelId);
            }
          },
          itemBuilder: (_) => [
            const PopupMenuItem<String>(
              value: 'start',
              child: _CallMenuRow(icon: Icons.call, label: 'Start call', detail: 'Begin a new group call'),
            ),
            const PopupMenuItem<String>(
              value: 'join',
              child: _CallMenuRow(
                icon: Icons.login,
                label: 'Join call',
                detail: 'Join a call already in progress',
              ),
            ),
          ],
        );
      },
    );
  }
}

class _CallMenuRow extends StatelessWidget {
  const _CallMenuRow({
    required this.icon,
    required this.label,
    required this.detail,
    this.iconColor,
  });

  final IconData icon;
  final Color? iconColor;
  final String label;
  final String detail;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 15, color: iconColor ?? AppColors.textMuted),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label, style: TextStyle(color: AppColors.text, fontSize: 13.5)),
              Text(
                detail,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: AppColors.textFaint, fontSize: 11),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
