import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

/// A small uppercase pill, matching `.badge`/`.pill` in `app.css`. Named
/// `PillBadge` (not `Badge`) to avoid colliding with Material's own
/// notification-badge widget of that name.
class PillBadge extends StatelessWidget {
  const PillBadge(
    this.label, {
    super.key,
    this.color = AppColors.textFaint,
    this.background = AppColors.surfaceAlt,
    this.borderColor = AppColors.border,
  });

  final String label;
  final Color color;
  final Color background;
  final Color borderColor;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: background,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label.toUpperCase(),
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.4,
          height: 1.3,
          color: color,
        ),
      ),
    );
  }
}

/// Badge for a channel's kind, refined by the locally-known agent subtype
/// (assistant vs. coding) when available. `GET /channels` only ever reports
/// `kind: "agent"` -- see the `_agentKindByChannel` note in
/// `lib/screens/chat.dart` for where the finer-grained [agentKind] comes
/// from and why it's sometimes unknown.
class ChannelKindBadge extends StatelessWidget {
  const ChannelKindBadge({super.key, required this.kind, this.agentKind});

  final ChannelKind kind;
  final AgentKind? agentKind;

  @override
  Widget build(BuildContext context) {
    switch (kind) {
      case ChannelKind.dm:
      case ChannelKind.human:
        return PillBadge(kind.label);
      case ChannelKind.agent:
        if (agentKind == AgentKind.coding) {
          return PillBadge(
            AgentKind.coding.label,
            color: AppColors.warn,
            background: AppColors.warnBg,
            borderColor: AppColors.warnBorder,
          );
        }
        return PillBadge(
          AgentKind.assistant.label,
          color: AppColors.accent,
          background: AppColors.accentSoft,
          borderColor: AppColors.accentBorder,
        );
    }
  }
}

/// Icon glyph shown to the left of a channel's name in the sidebar.
IconData iconForChannel(ChannelKind kind, AgentKind? agentKind) {
  switch (kind) {
    case ChannelKind.dm:
      return Icons.alternate_email;
    case ChannelKind.human:
      return Icons.tag;
    case ChannelKind.agent:
      return agentKind == AgentKind.coding
          ? Icons.terminal
          : Icons.auto_awesome;
  }
}
