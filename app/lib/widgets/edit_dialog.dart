import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../responsive.dart';
import '../theme.dart';

/// Dialog for editing a message. Pre-filled with [initialContent]; resolves to
/// the new text, or null if cancelled or left unchanged/empty. An edit is a
/// tracked revision — the original is kept and the change is audited — so the
/// copy tells the author their prior text is retained, not overwritten.
///
/// [isCorrection] swaps the title/copy for the "Correct transcript" case — a
/// channel member fixing a voice-call transcript or "📝 Summary" system
/// message rather than editing their own message. The save mechanics (and the
/// revision history they produce) are identical either way.
Future<String?> showEditDialog(
  BuildContext context,
  String initialContent, {
  bool isCorrection = false,
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _EditDialog(initialContent: initialContent, isCorrection: isCorrection),
  );
}

class _EditDialog extends StatefulWidget {
  const _EditDialog({required this.initialContent, this.isCorrection = false});

  final String initialContent;
  final bool isCorrection;

  @override
  State<_EditDialog> createState() => _EditDialogState();
}

class _EditDialogState extends State<_EditDialog> {
  late final TextEditingController _content =
      TextEditingController(text: widget.initialContent);

  @override
  void initState() {
    super.initState();
    _content.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _content.dispose();
    super.dispose();
  }

  bool get _canSave {
    final next = _content.text.trim();
    return next.isNotEmpty && next != widget.initialContent.trim();
  }

  void _save() {
    if (_canSave) Navigator.of(context).pop(_content.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      title: Row(
        children: [
          const Icon(Icons.edit_outlined, color: AppColors.accent, size: 20),
          const SizedBox(width: 8),
          Text(
            widget.isCorrection ? 'Correct transcript' : 'Edit message',
            style: const TextStyle(
              color: AppColors.text,
              fontSize: 16,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
      content: SizedBox(
        width: dialogWidth(context, 460),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.isCorrection
                  ? 'This is a shared record any channel member can correct. The original text '
                      'is kept in the message history, and the correction — who and when — is '
                      'recorded in the audit trail.'
                  : 'Your original text is kept in the message history, and the edit — '
                      'who and when — is recorded in the audit trail.',
              style: const TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.45),
            ),
            const SizedBox(height: 14),
            // Cmd/Ctrl+Enter saves; plain Enter inserts a newline (this is a body editor).
            CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.enter, meta: true): _save,
                const SingleActivator(LogicalKeyboardKey.enter, control: true): _save,
              },
              child: TextField(
                controller: _content,
                autofocus: true,
                minLines: 2,
                maxLines: 10,
                style: const TextStyle(color: AppColors.text, fontSize: 14, height: 1.4),
                decoration: const InputDecoration(hintText: 'Message text'),
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
          onPressed: _canSave ? _save : null,
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.accent,
            foregroundColor: Colors.white,
            disabledBackgroundColor: AppColors.accent.withValues(alpha: 0.4),
            disabledForegroundColor: Colors.white70,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadius.sm),
            ),
            textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
          child: const Text('Save changes'),
        ),
      ],
    );
  }
}
