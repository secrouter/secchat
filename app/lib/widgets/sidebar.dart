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
    this.onlineSubs = const {},
    required this.onSelect,
    required this.onNewChannel,
    required this.onNewAssistant,
    required this.onNewCodingAgent,
    required this.onNewDm,
    this.onArchive,
    this.showArchived = false,
    this.onToggleShowArchived,
    this.sortByUnread = false,
    this.onToggleSort,
    this.errorText,
    this.compact = false,
    this.header,
    this.footer,
  });

  /// Compact (phone) layout: the rail is presented as a drawer, so it fills the
  /// width it is given instead of the fixed desktop 258 and drops its right
  /// border (the drawer edge already provides one).
  final bool compact;

  /// Compact only: content pinned ABOVE the create actions — search, mentions
  /// and connection status, which live in the top bar on desktop.
  final Widget? header;

  /// Compact only: content pinned to the BOTTOM — the signed-in user, SSH keys
  /// and sign out, which live in the top bar on desktop.
  final Widget? footer;

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

  /// The subs currently online — drives the presence dot on a DM's rail entry.
  final Set<String> onlineSubs;

  final ValueChanged<Channel> onSelect;
  final VoidCallback onNewChannel;
  final VoidCallback onNewAssistant;
  final VoidCallback onNewCodingAgent;
  final VoidCallback onNewDm;

  /// Archive (or restore, when `channel.archived`) a channel. Null hides the action.
  final void Function(Channel channel, bool archived)? onArchive;

  /// When true, archived channels are shown (dimmed) instead of hidden.
  final bool showArchived;

  /// Toggle [showArchived]. Null hides the toggle.
  final VoidCallback? onToggleShowArchived;

  /// When true, each section is ordered by unread count (most unread first, then
  /// by name) instead of alphabetically — so channels needing attention rise.
  final bool sortByUnread;

  /// Toggle [sortByUnread]. Null hides the sort control.
  final VoidCallback? onToggleSort;

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
      // Compact: fill the drawer. Wide: the desktop rail, unchanged.
      width: compact ? null : 258,
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: compact
            ? null
            : const Border(right: BorderSide(color: AppColors.border)),
      ),
      child: Column(
        children: [
          if (header != null) header!,
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
          if (footer != null) footer!,
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

    // Hide archived channels unless the toggle is on. The currently-open channel always stays
    // visible so archiving it doesn't yank it out from under you.
    bool visible(Channel c) => showArchived || !c.archived || c.id == selectedChannelId;
    final shown = channels.where(visible).toList();

    // Categorise: team channels, agents (assistant + coding), and DMs — each its own section.
    // A channel's sort key is its rail label (a DM's is the peer's name). In unread mode the primary
    // key is the unread count (descending) so channels needing attention rise to the top of each
    // section, with the label as the tie-breaker; otherwise it's purely alphabetical.
    String sortLabel(Channel c) => (c.kind == ChannelKind.dm ? _dmLabel(c) : c.name).toLowerCase();
    int cmp(Channel a, Channel b) {
      if (sortByUnread) {
        final byUnread = (unreadByChannel[b.id] ?? 0).compareTo(unreadByChannel[a.id] ?? 0);
        if (byUnread != 0) return byUnread;
      }
      return sortLabel(a).compareTo(sortLabel(b));
    }
    final teamChannels = shown.where((c) => c.kind == ChannelKind.human).toList()..sort(cmp);
    final agents = shown.where((c) => c.kind == ChannelKind.agent).toList()..sort(cmp);
    final dms = shown.where((c) => c.kind == ChannelKind.dm).toList()..sort(cmp);

    Widget item(Channel channel, {String? labelOverride, bool present = false}) => _ChannelListItem(
      channel: channel,
      label: labelOverride ?? (channel.name.isEmpty ? '(unnamed)' : channel.name),
      isSelected: channel.id == selectedChannelId,
      agentKind: agentKindByChannel[channel.id],
      unread: unreadByChannel[channel.id] ?? 0,
      present: present,
      onTap: () => onSelect(channel),
      onArchive: onArchive == null ? null : () => onArchive!(channel, !channel.archived),
    );

    // A DM peer's online state → the rail dot.
    bool dmPresent(Channel channel) {
      final peer = channel.peer(currentUserSub);
      return peer != null && onlineSubs.contains(peer);
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 12),
      children: [
        if (onToggleSort != null) _SortControl(sortByUnread: sortByUnread, onToggle: onToggleSort!),
        if (teamChannels.isNotEmpty) ...[
          const _SectionHeader('CHANNELS'),
          for (final channel in teamChannels) item(channel),
        ],
        if (agents.isNotEmpty) ...[
          const _SectionHeader('AGENTS'),
          for (final channel in agents) item(channel),
        ],
        if (dms.isNotEmpty) ...[
          const _SectionHeader('DIRECT MESSAGES'),
          for (final channel in dms) item(channel, labelOverride: _dmLabel(channel), present: dmPresent(channel)),
        ],
        if (onToggleShowArchived != null) ...[
          const SizedBox(height: 8),
          _ShowArchivedToggle(showArchived: showArchived, onTap: onToggleShowArchived!),
        ],
      ],
    );
  }
}

/// The header control that switches channel ordering between name and unread.
class _SortControl extends StatelessWidget {
  const _SortControl({required this.sortByUnread, required this.onToggle});

  final bool sortByUnread;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 2, 6, 2),
      child: Row(
        children: [
          const Text(
            'SORT',
            style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: AppColors.textFaint),
          ),
          const Spacer(),
          _SortChip(label: 'Name', active: !sortByUnread, onTap: sortByUnread ? onToggle : null),
          const SizedBox(width: 4),
          _SortChip(label: 'Unread', active: sortByUnread, onTap: sortByUnread ? null : onToggle),
        ],
      ),
    );
  }
}

class _SortChip extends StatelessWidget {
  const _SortChip({required this.label, required this.active, required this.onTap});

  final String label;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: active ? AppColors.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 12,
            fontWeight: active ? FontWeight.w700 : FontWeight.w500,
            color: active ? AppColors.accent : AppColors.textMuted,
          ),
        ),
      ),
    );
  }
}

/// The footer toggle that reveals/hides archived channels.
class _ShowArchivedToggle extends StatelessWidget {
  const _ShowArchivedToggle({required this.showArchived, required this.onTap});

  final bool showArchived;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(
          children: [
            Icon(showArchived ? Icons.unarchive_outlined : Icons.archive_outlined,
                size: 15, color: AppColors.textMuted),
            const SizedBox(width: 8),
            Text(showArchived ? 'Hide archived' : 'Show archived',
                style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          ],
        ),
      ),
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

class _ChannelListItem extends StatefulWidget {
  const _ChannelListItem({
    required this.channel,
    required this.label,
    required this.isSelected,
    required this.agentKind,
    required this.unread,
    required this.onTap,
    this.onArchive,
    this.present = false,
  });

  final Channel channel;
  final String label;
  final bool isSelected;
  final AgentKind? agentKind;
  final int unread;
  final VoidCallback onTap;

  /// Archive (or restore) this channel. Null hides the action.
  final VoidCallback? onArchive;

  /// A DM peer who's online — shows a small presence dot on the channel icon.
  final bool present;

  @override
  State<_ChannelListItem> createState() => _ChannelListItemState();
}

class _ChannelListItemState extends State<_ChannelListItem> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final channel = widget.channel;
    final isSelected = widget.isSelected;
    final agentKind = widget.agentKind;
    final unread = widget.unread;
    final present = widget.present;
    // An archived item is dimmed; its archive control is the "restore" direction.
    final archived = channel.archived;
    final showArchiveBtn = widget.onArchive != null && (_hovering || archived);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovering = true),
      onExit: (_) => setState(() => _hovering = false),
      child: Opacity(
        opacity: archived ? 0.55 : 1,
        child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: widget.onTap,
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
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Icon(
                        iconForChannel(channel.kind, agentKind),
                        size: 14,
                        color: isSelected ? AppColors.accent : AppColors.textFaint,
                      ),
                      if (present)
                        Positioned(
                          right: -1,
                          bottom: -2,
                          child: Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: AppColors.ok,
                              shape: BoxShape.circle,
                              border: Border.all(color: AppColors.surface, width: 1.5),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    widget.label,
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
                if (showArchiveBtn)
                  _IconAction(
                    icon: archived ? Icons.unarchive_outlined : Icons.archive_outlined,
                    tooltip: archived ? 'Restore' : 'Archive',
                    onTap: widget.onArchive!,
                  )
                else ...[
                  if (unread > 0) ...[
                    _UnreadBadge(count: unread),
                    const SizedBox(width: 6),
                  ],
                  ChannelKindBadge(kind: channel.kind, agentKind: agentKind),
                ],
              ],
            ),
          ),
        ),
      ),
        ),
      ),
    );
  }
}

/// A small, low-emphasis icon button used inline in a sidebar row (archive/restore).
class _IconAction extends StatelessWidget {
  const _IconAction({required this.icon, required this.tooltip, required this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(4),
        child: Padding(
          padding: const EdgeInsets.all(3),
          child: Icon(icon, size: 15, color: AppColors.textMuted),
        ),
      ),
    );
  }
}
