import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../formatting.dart';
import '../models.dart';
import '../platform/daemon_supervisor.dart';
import '../theme.dart';
import 'badges.dart';
import 'brand_mark.dart';
import 'runner_status.dart';

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
    this.runnerState,
    this.onSshKeys,
    this.onWebhooks,
    this.onAdmin,
    this.isLightMode = false,
    this.onToggleTheme,
  });

  final Principal principal;
  final ConnStatus status;
  final VoidCallback onSignOut;
  final VoidCallback? onSearch;

  /// Opens the git SSH-key manager (profile). Null ⇒ hidden from the menu.
  final VoidCallback? onSshKeys;

  /// Opens the global inbound-webhook manager. Null ⇒ hidden from the menu.
  final VoidCallback? onWebhooks;

  /// Opens the admin / audit-review console. Shown in the menu only for a platform admin
  /// ([Principal.isAdmin]); null ⇒ never shown.
  final VoidCallback? onAdmin;

  /// Whether light mode is currently active -- drives the toggle item's label ("Light mode" /
  /// "Dark mode") in the overflow menu.
  final bool isLightMode;

  /// Flips the light/dark theme. Null ⇒ hidden from the menu (not expected in practice).
  final VoidCallback? onToggleTheme;

  /// The bundled runner daemon's live state (desktop). Null ⇒ no runner chip (web/mobile).
  final ValueListenable<RunnerDaemonState>? runnerState;

  /// Opens the @mentions inbox. Null ⇒ no mentions affordance.
  final VoidCallback? onMentions;

  /// Unseen @mention count — shown as a badge on the mentions button (0 ⇒ no badge).
  final int mentionCount;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 18),
      decoration: BoxDecoration(
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
          if (runnerState != null) ...[
            RunnerStatusChip(state: runnerState!),
            const SizedBox(width: 12),
          ],
          _ConnIndicator(status: status),
          const SizedBox(width: 16),
          _UserChip(principal: principal),
          const SizedBox(width: 4),
          _AppMenu(
            isAdmin: principal.isAdmin,
            onSshKeys: onSshKeys,
            onWebhooks: onWebhooks,
            onAdmin: onAdmin,
            isLightMode: isLightMode,
            onToggleTheme: onToggleTheme,
          ),
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

/// The top-bar overflow menu: an expandable list gathering the account/admin actions that used to
/// be separate icons — Git SSH key, the global Webhooks manager, and (admins only) the Admin
/// console. Each entry appears only when its callback is provided (and, for Admin, [isAdmin]).
class _AppMenu extends StatelessWidget {
  const _AppMenu({
    required this.isAdmin,
    this.onSshKeys,
    this.onWebhooks,
    this.onAdmin,
    this.isLightMode = false,
    this.onToggleTheme,
  });

  final bool isAdmin;
  final VoidCallback? onSshKeys;
  final VoidCallback? onWebhooks;
  final VoidCallback? onAdmin;
  final bool isLightMode;
  final VoidCallback? onToggleTheme;

  @override
  Widget build(BuildContext context) {
    final items = <PopupMenuEntry<VoidCallback>>[
      if (onSshKeys != null) _item(Icons.vpn_key, 'Git SSH key', onSshKeys!),
      if (onWebhooks != null) _item(Icons.webhook, 'Webhooks', onWebhooks!),
      if (onAdmin != null && isAdmin) _item(Icons.admin_panel_settings, 'Admin console', onAdmin!),
      if (onToggleTheme != null)
        _item(
          isLightMode ? Icons.dark_mode_outlined : Icons.light_mode_outlined,
          isLightMode ? 'Dark mode' : 'Light mode',
          onToggleTheme!,
        ),
    ];
    if (items.isEmpty) return const SizedBox.shrink();
    return PopupMenuButton<VoidCallback>(
      tooltip: 'Menu',
      icon: Icon(Icons.menu, size: 18, color: AppColors.textMuted),
      color: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        side: BorderSide(color: AppColors.border),
      ),
      onSelected: (action) => action(),
      itemBuilder: (_) => items,
    );
  }

  PopupMenuItem<VoidCallback> _item(IconData icon, String label, VoidCallback action) {
    return PopupMenuItem<VoidCallback>(
      value: action,
      child: Row(
        children: [
          Icon(icon, size: 17, color: AppColors.textMuted),
          const SizedBox(width: 10),
          Text(label, style: TextStyle(color: AppColors.text, fontSize: 13.5)),
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
        Text(label, style: TextStyle(fontSize: 12, color: AppColors.textFaint)),
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
            decoration: BoxDecoration(
              color: AppColors.surfaceRaised,
              shape: BoxShape.circle,
            ),
            child: Text(
              initialsFor(principal.label),
              style: TextStyle(
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
                    principal.label,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: AppColors.text,
                    ),
                  ),
                  if (principal.isAdmin) ...[
                    const SizedBox(width: 6),
                    PillBadge(
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
