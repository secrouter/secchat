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
            side: const BorderSide(color: AppColors.border),
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
            const PopupMenuItem<bool>(
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

class _CallMenuRow extends StatelessWidget {
  const _CallMenuRow({
    required this.icon,
    required this.label,
    required this.detail,
    this.iconColor = AppColors.textMuted,
  });

  final IconData icon;
  final Color iconColor;
  final String label;
  final String detail;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 15, color: iconColor),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(label, style: const TextStyle(color: AppColors.text, fontSize: 13.5)),
              Text(
                detail,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: AppColors.textFaint, fontSize: 11),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
