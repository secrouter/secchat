import 'package:flutter/material.dart';

import '../models.dart';
import '../responsive.dart';
import '../theme.dart';

/// Shows the @mentions inbox as a modal and resolves to the mention the user TAPPED (so the caller
/// can jump to its channel), or null if it was dismissed. Pure presentation over an already-fetched
/// list — marking-seen is the caller's concern (it happens when the inbox opens).
Future<Mention?> showMentionsInbox(
  BuildContext context, {
  required List<Mention> mentions,
  required String Function(String channelId) channelLabel,
}) {
  return showDialog<Mention>(
    context: context,
    builder: (_) => _MentionsDialog(mentions: mentions, channelLabel: channelLabel),
  );
}

class _MentionsDialog extends StatelessWidget {
  const _MentionsDialog({required this.mentions, required this.channelLabel});

  final List<Mention> mentions;
  final String Function(String channelId) channelLabel;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: dialogWidth(context, 520), maxHeight: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 18, 10),
              child: Row(
                children: [
                  const Icon(Icons.alternate_email, size: 18, color: AppColors.accent),
                  const SizedBox(width: 8),
                  const Text(
                    'Mentions',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.text),
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close, size: 18),
                    color: AppColors.textMuted,
                    tooltip: 'Close',
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: AppColors.border),
            Flexible(
              child: mentions.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 48),
                      child: Center(
                        child: Text(
                          'No mentions yet.\nYou’ll see it here when someone @mentions you.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: AppColors.textFaint, fontSize: 13),
                        ),
                      ),
                    )
                  : ListView.separated(
                      shrinkWrap: true,
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      itemCount: mentions.length,
                      separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.border),
                      itemBuilder: (context, i) => _MentionRow(
                        mention: mentions[i],
                        channelLabel: channelLabel(mentions[i].channelId),
                        onTap: () => Navigator.of(context).pop(mentions[i]),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MentionRow extends StatelessWidget {
  const _MentionRow({required this.mention, required this.channelLabel, required this.onTap});

  final Mention mention;
  final String channelLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final content = mention.content;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  channelLabel,
                  style: AppFonts.mono(fontSize: 11.5, color: AppColors.accent).copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(width: 8),
                Text('from ${mention.authorSub}', style: const TextStyle(fontSize: 11.5, color: AppColors.textFaint)),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              content == null || content.isEmpty ? 'Message unavailable' : content,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13,
                color: content == null ? AppColors.textFaint : AppColors.textMuted,
                fontStyle: content == null ? FontStyle.italic : FontStyle.normal,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
