import 'package:flutter/material.dart';

import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import 'badges.dart';
import 'brand_mark.dart';

/// Live state of the current channel's WebSocket connection, shown as the
/// small dot + label in the top bar (`.conn-indicator` in `app.css`).
enum ConnStatus { idle, connecting, connected, down }

/// App chrome: brand, connection indicator, signed-in user, sign out.
class AppTopBar extends StatelessWidget {
  const AppTopBar({
    super.key,
    required this.principal,
    required this.status,
    required this.onSignOut,
  });

  final Principal principal;
  final ConnStatus status;
  final VoidCallback onSignOut;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          const BrandMark(small: true),
          const Spacer(),
          _ConnIndicator(status: status),
          const SizedBox(width: 16),
          _UserChip(principal: principal),
          const SizedBox(width: 4),
          IconButton(
            onPressed: onSignOut,
            icon: const Icon(Icons.logout, size: 18),
            tooltip: 'Sign out',
            color: AppColors.textMuted,
          ),
        ],
      ),
    );
  }
}

class _ConnIndicator extends StatelessWidget {
  const _ConnIndicator({required this.status});

  final ConnStatus status;

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (status) {
      ConnStatus.idle => (AppColors.textFaint, 'idle'),
      ConnStatus.connecting => (AppColors.warn, 'connecting…'),
      ConnStatus.connected => (AppColors.ok, 'connected'),
      ConnStatus.down => (AppColors.bad, 'disconnected'),
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 7),
        Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textFaint)),
      ],
    );
  }
}

class _UserChip extends StatelessWidget {
  const _UserChip({required this.principal});

  final Principal principal;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(5, 5, 10, 5),
      decoration: BoxDecoration(
        color: AppColors.surfaceAlt,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: const BoxDecoration(
              color: AppColors.surfaceRaised,
              shape: BoxShape.circle,
            ),
            child: Text(
              initialsFor(principal.sub),
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: AppColors.accent,
              ),
            ),
          ),
          const SizedBox(width: 9),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    principal.sub,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: AppColors.text,
                    ),
                  ),
                  if (principal.isAdmin) ...[
                    const SizedBox(width: 6),
                    const PillBadge(
                      'Admin',
                      color: AppColors.accent,
                      background: AppColors.accentSoft,
                      borderColor: AppColors.accentBorder,
                    ),
                  ],
                ],
              ),
              Text(
                principal.groups.isEmpty ? 'no groups' : principal.groups.join(', '),
                style: AppFonts.mono(fontSize: 10.5, color: AppColors.textFaint),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
