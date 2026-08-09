import 'package:flutter/material.dart';

import '../theme.dart';

/// Confirmation dialog for redacting (purging) a message — a destructive,
/// audited action. Requires a reason (the audit record). Resolves to the
/// reason, or null if cancelled.
Future<String?> showRedactDialog(BuildContext context) {
  return showDialog<String>(context: context, builder: (_) => const _RedactDialog());
}

class _RedactDialog extends StatefulWidget {
  const _RedactDialog();

  @override
  State<_RedactDialog> createState() => _RedactDialogState();
}

class _RedactDialogState extends State<_RedactDialog> {
  final _reason = TextEditingController();

  @override
  void initState() {
    super.initState();
    _reason.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reason = _reason.text.trim();
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      title: const Row(
        children: [
          Icon(Icons.gpp_bad_outlined, color: AppColors.bad, size: 20),
          SizedBox(width: 8),
          Text(
            'Redact message',
            style: TextStyle(
              color: AppColors.text,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'This permanently removes the message content for everyone and '
              'cannot be undone. The message becomes a "redacted" tombstone, and '
              'the action — who, when, and why — is recorded in the audit trail.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.45),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _reason,
              autofocus: true,
              minLines: 1,
              maxLines: 2,
              style: const TextStyle(color: AppColors.text, fontSize: 14),
              decoration: const InputDecoration(
                hintText: 'Reason (required) — e.g. CUI spillage, wrong channel',
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: reason.isEmpty ? null : () => Navigator.of(context).pop(reason),
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.bad,
            foregroundColor: Colors.white,
            disabledBackgroundColor: AppColors.bad.withValues(alpha: 0.4),
            disabledForegroundColor: Colors.white70,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadius.sm),
            ),
            textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
          child: const Text('Redact'),
        ),
      ],
    );
  }
}
