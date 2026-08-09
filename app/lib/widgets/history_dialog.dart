import 'package:flutter/material.dart';

import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import 'markdown_text.dart';

/// Read-only viewer for a message's edit history (from `GET
/// /messages/:id/revisions`). Revision 1 is the original; the last is the
/// current text. Content is null on every revision once the message is redacted
/// — shown as a tombstone. Purely informational: no actions.
Future<void> showHistoryDialog(
  BuildContext context,
  List<MessageRevision> revisions,
) {
  return showDialog<void>(
    context: context,
    builder: (_) => _HistoryDialog(revisions: revisions),
  );
}

class _HistoryDialog extends StatelessWidget {
  const _HistoryDialog({required this.revisions});

  final List<MessageRevision> revisions;

  @override
  Widget build(BuildContext context) {
    final latest = revisions.isEmpty ? -1 : revisions.last.revision;
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      title: const Row(
        children: [
          Icon(Icons.history, color: AppColors.accent, size: 20),
          SizedBox(width: 8),
          Text(
            'Edit history',
            style: TextStyle(
              color: AppColors.text,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
      content: SizedBox(
        width: 480,
        child: revisions.isEmpty
            ? const Text(
                'No history available.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13),
              )
            : ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 420),
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final r in revisions)
                        _RevisionTile(
                          revision: r,
                          isOriginal: r.revision == 1,
                          isCurrent: r.revision == latest,
                        ),
                    ],
                  ),
                ),
              ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    );
  }
}

class _RevisionTile extends StatelessWidget {
  const _RevisionTile({
    required this.revision,
    required this.isOriginal,
    required this.isCurrent,
  });

  final MessageRevision revision;
  final bool isOriginal;
  final bool isCurrent;

  @override
  Widget build(BuildContext context) {
    final String label = isOriginal ? 'Original' : 'Revision ${revision.revision}';
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: AppColors.surfaceRaised,
        borderRadius: BorderRadius.circular(AppRadius.sm),
        border: Border.all(
          color: isCurrent ? AppColors.accent : AppColors.border,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                label,
                style: const TextStyle(
                  color: AppColors.text,
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                ),
              ),
              if (isCurrent) ...[
                const SizedBox(width: 6),
                const _Pill(text: 'current'),
              ],
              const Spacer(),
              Text(
                formatTimestamp(revision.at),
                style: AppFonts.mono(fontSize: 10.5, color: AppColors.textFaint),
              ),
            ],
          ),
          const SizedBox(height: 6),
          revision.content == null
              ? const Text(
                  'content redacted',
                  style: TextStyle(
                    fontStyle: FontStyle.italic,
                    color: AppColors.textFaint,
                    fontSize: 13,
                  ),
                )
              : MarkdownText(
                  revision.content!,
                  baseStyle: const TextStyle(
                    color: AppColors.text,
                    fontSize: 13.5,
                    height: 1.4,
                  ),
                ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: AppColors.accentSoft,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: AppFonts.mono(fontSize: 9.5, color: AppColors.accent),
      ),
    );
  }
}
