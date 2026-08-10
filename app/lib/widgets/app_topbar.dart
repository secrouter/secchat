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
    this.onSearch,
    this.onMentions,
    this.mentionCount = 0,
  });

  final Principal principal;
  final ConnStatus status;
  final VoidCallback onSignOut;
  final VoidCallback? onSearch;

  /// Opens the @mentions inbox. Null ⇒ no mentions affordance.
  final VoidCallback? onMentions;

  /// Unseen @mention count — shown as a badge on the mentions button (0 ⇒ no badge).
  final int mentionCount;

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
          if (onSearch != null) ...[
            IconButton(
              onPressed: onSearch,
              icon: const Icon(Icons.search, size: 18),
              tooltip: 'Search messages',
              color: AppColors.textMuted,
            ),
            const SizedBox(width: 6),
          ],
          if (onMentions != null) ...[
            _MentionsButton(count: mentionCount, onPressed: onMentions!),
            const SizedBox(width: 6),
          ],
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

/// The @mentions bell with an unseen-count badge overlaid on its top-right.
class _MentionsButton extends StatelessWidget {
  const _MentionsButton({required this.count, required this.onPressed});

  final int count;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        IconButton(
          onPressed: onPressed,
          icon: const Icon(Icons.alternate_email, size: 18),
          tooltip: 'Mentions',
          color: count > 0 ? AppColors.accent : AppColors.textMuted,
        ),
        if (count > 0)
          Positioned(
            right: 2,
            top: 2,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
              constraints: const BoxConstraints(minWidth: 16),
              decoration: BoxDecoration(
                color: AppColors.bad,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: AppColors.surface, width: 1.5),
              ),
              child: Text(
                count > 99 ? '99+' : '$count',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.w700, color: Colors.white),
              ),
            ),
          ),
      ],
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
