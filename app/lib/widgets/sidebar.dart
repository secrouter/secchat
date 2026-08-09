import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';
import 'badges.dart';

/// Left rail: New channel / assistant / coding agent / DM actions, plus the
/// channel list split into a channels section and a direct-messages section
/// (`#sidebar` in `app.css`).
class ChatSidebar extends StatelessWidget {
  const ChatSidebar({
    super.key,
    required this.channels,
    required this.selectedChannelId,
    required this.loading,
    required this.agentKindByChannel,
    required this.currentUserSub,
    required this.usersBySub,
    required this.unreadByChannel,
    required this.onSelect,
    required this.onNewChannel,
    required this.onNewAssistant,
    required this.onNewCodingAgent,
    required this.onNewDm,
    this.errorText,
  });

  final List<Channel> channels;
  final String? selectedChannelId;
  final bool loading;
  final String? errorText;
  final Map<String, AgentKind> agentKindByChannel;

  /// The signed-in user's sub — used to pick the *other* participant of a DM.
  final String currentUserSub;

  /// Directory (sub -> user) for resolving a DM peer's display name.
  final Map<String, User> usersBySub;

  /// Per-channel unread counts (channelId -> count); rendered as a badge.
  final Map<String, int> unreadByChannel;

  final ValueChanged<Channel> onSelect;
  final VoidCallback onNewChannel;
  final VoidCallback onNewAssistant;
  final VoidCallback onNewCodingAgent;
  final VoidCallback onNewDm;

  /// The label a DM shows in the rail: the other participant's display name
  /// (from the directory), falling back to their sub, then the channel name.
  String _dmLabel(Channel channel) {
    final peer = channel.peer(currentUserSub);
    if (peer == null) return channel.name.isEmpty ? 'Direct message' : channel.name;
    return usersBySub[peer]?.label ?? peer;
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 258,
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(right: BorderSide(color: AppColors.border)),
      ),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 14, 12, 8),
            child: Column(
              children: [
                _SidebarActionButton(
                  icon: Icons.tag,
                  label: 'New channel',
                  onPressed: onNewChannel,
                ),
                const SizedBox(height: 6),
                _SidebarActionButton(
                  icon: Icons.alternate_email,
                  label: 'New direct message',
                  onPressed: onNewDm,
                ),
                const SizedBox(height: 6),
                _SidebarActionButton(
                  icon: Icons.auto_awesome,
                  label: 'New assistant',
                  onPressed: onNewAssistant,
                ),
                const SizedBox(height: 6),
                _SidebarActionButton(
                  icon: Icons.terminal,
                  label: 'New coding agent',
                  onPressed: onNewCodingAgent,
                ),
              ],
            ),
          ),
          Expanded(child: _buildList()),
        ],
      ),
    );
  }

  Widget _buildList() {
    if (loading) {
      return const Center(
        child: SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(color: AppColors.accent, strokeWidth: 2),
        ),
      );
    }
    if (errorText != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Text(
          errorText!,
          style: const TextStyle(color: AppColors.bad, fontSize: 12.5),
        ),
      );
    }
    if (channels.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(AppRadius.sm),
          ),
          child: const Text(
            'No channels yet',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: AppColors.textFaint,
              fontSize: 12.5,
              fontStyle: FontStyle.italic,
            ),
          ),
        ),
      );
    }

    final dms = channels.where((c) => c.kind == ChannelKind.dm).toList();
    final rest = channels.where((c) => c.kind != ChannelKind.dm).toList();

    Widget item(Channel channel, {String? labelOverride}) => _ChannelListItem(
      channel: channel,
      label: labelOverride ?? (channel.name.isEmpty ? '(unnamed)' : channel.name),
      isSelected: channel.id == selectedChannelId,
      agentKind: agentKindByChannel[channel.id],
      unread: unreadByChannel[channel.id] ?? 0,
      onTap: () => onSelect(channel),
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
      children: [
        if (rest.isNotEmpty) ...[
          const _SectionHeader('CHANNELS'),
          for (final channel in rest) item(channel),
        ],
        if (dms.isNotEmpty) ...[
          const _SectionHeader('DIRECT MESSAGES'),
          for (final channel in dms) item(channel, labelOverride: _dmLabel(channel)),
        ],
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 12, 10, 6),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.6,
            color: AppColors.textFaint,
          ),
        ),
      ),
    );
  }
}

class _SidebarActionButton extends StatelessWidget {
  const _SidebarActionButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton.icon(
        onPressed: onPressed,
        style: AppButtonStyles.secondary,
        icon: Icon(icon, size: 16, color: AppColors.accent),
        label: Text(label),
      ),
    );
  }
}

class _UnreadBadge extends StatelessWidget {
  const _UnreadBadge({required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minWidth: 18),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
      decoration: BoxDecoration(
        color: AppColors.accent,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        count > 99 ? '99+' : '$count',
        textAlign: TextAlign.center,
        style: const TextStyle(
          fontSize: 10.5,
          fontWeight: FontWeight.w700,
          color: AppColors.onAccent,
        ),
      ),
    );
  }
}

class _ChannelListItem extends StatelessWidget {
  const _ChannelListItem({
    required this.channel,
    required this.label,
    required this.isSelected,
    required this.agentKind,
    required this.unread,
    required this.onTap,
  });

  final Channel channel;
  final String label;
  final bool isSelected;
  final AgentKind? agentKind;
  final int unread;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadius.sm),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            decoration: BoxDecoration(
              color: isSelected ? AppColors.accentSoft : Colors.transparent,
              border: Border.all(
                color: isSelected ? AppColors.accentBorder : Colors.transparent,
              ),
              borderRadius: BorderRadius.circular(AppRadius.sm),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 18,
                  child: Icon(
                    iconForChannel(channel.kind, agentKind),
                    size: 14,
                    color: isSelected ? AppColors.accent : AppColors.textFaint,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    label,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: unread > 0 ? FontWeight.w700 : FontWeight.w400,
                      color: unread > 0
                          ? AppColors.text
                          : (isSelected ? AppColors.text : AppColors.textMuted),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                if (unread > 0) ...[
                  _UnreadBadge(count: unread),
                  const SizedBox(width: 6),
                ],
                ChannelKindBadge(kind: channel.kind, agentKind: agentKind),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
