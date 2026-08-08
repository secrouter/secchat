import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';
import 'badges.dart';

/// Left rail: New channel / New assistant / New coding agent actions, plus
/// the channel list (`#sidebar` in `app.css`).
class ChatSidebar extends StatelessWidget {
  const ChatSidebar({
    super.key,
    required this.channels,
    required this.selectedChannelId,
    required this.loading,
    required this.agentKindByChannel,
    required this.onSelect,
    required this.onNewChannel,
    required this.onNewAssistant,
    required this.onNewCodingAgent,
    this.errorText,
  });

  final List<Channel> channels;
  final String? selectedChannelId;
  final bool loading;
  final String? errorText;
  final Map<String, AgentKind> agentKindByChannel;
  final ValueChanged<Channel> onSelect;
  final VoidCallback onNewChannel;
  final VoidCallback onNewAssistant;
  final VoidCallback onNewCodingAgent;

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
          const Padding(
            padding: EdgeInsets.fromLTRB(18, 16, 18, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'CHANNELS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                  color: AppColors.textFaint,
                ),
              ),
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
    return ListView.builder(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
      itemCount: channels.length,
      itemBuilder: (context, index) {
        final channel = channels[index];
        return _ChannelListItem(
          channel: channel,
          isSelected: channel.id == selectedChannelId,
          agentKind: agentKindByChannel[channel.id],
          onTap: () => onSelect(channel),
        );
      },
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

class _ChannelListItem extends StatelessWidget {
  const _ChannelListItem({
    required this.channel,
    required this.isSelected,
    required this.agentKind,
    required this.onTap,
  });

  final Channel channel;
  final bool isSelected;
  final AgentKind? agentKind;
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
                    channel.name.isEmpty ? '(unnamed)' : channel.name,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      color: isSelected ? AppColors.text : AppColors.textMuted,
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                ChannelKindBadge(kind: channel.kind, agentKind: agentKind),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
