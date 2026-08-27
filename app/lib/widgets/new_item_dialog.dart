import 'package:flutter/material.dart';

import '../responsive.dart';
import '../theme.dart';

/// Shows the small "name this thing" prompt shared by New channel / New
/// assistant / New coding agent, matching `.modal` in `app.css`. Returns
/// the trimmed name, or `null` if the user cancelled.
Future<String?> showNewItemDialog(
  BuildContext context, {
  required String title,
  required String description,
  required String hint,
  String confirmLabel = 'Create',
}) {
  return showDialog<String>(
    context: context,
    barrierColor: AppColors.overlay,
    builder: (dialogContext) => _NewItemDialog(
      title: title,
      description: description,
      hint: hint,
      confirmLabel: confirmLabel,
    ),
  );
}

class _NewItemDialog extends StatefulWidget {
  const _NewItemDialog({
    required this.title,
    required this.description,
    required this.hint,
    required this.confirmLabel,
  });

  final String title;
  final String description;
  final String hint;
  final String confirmLabel;

  @override
  State<_NewItemDialog> createState() => _NewItemDialogState();
}

class _NewItemDialogState extends State<_NewItemDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty) return;
    Navigator.of(context).pop(name);
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(24),
      child: Container(
        width: dialogWidth(context, 360),
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(AppRadius.lg),
          boxShadow: const [
            BoxShadow(
              color: Color(0x80000000),
              blurRadius: 64,
              offset: Offset(0, 24),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.title,
              style: TextStyle(
                color: AppColors.text,
                fontSize: 16,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              widget.description,
              style: TextStyle(
                color: AppColors.textMuted,
                fontSize: 12.5,
                height: 1.4,
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _controller,
              autofocus: true,
              style: TextStyle(color: AppColors.text, fontSize: 14),
              decoration: InputDecoration(hintText: widget.hint),
              onSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 18),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  style: AppButtonStyles.ghost,
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 10),
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: _controller,
                  builder: (context, value, _) {
                    return ElevatedButton(
                      onPressed: value.text.trim().isEmpty ? null : _submit,
                      style: AppButtonStyles.primary,
                      child: Text(widget.confirmLabel),
                    );
                  },
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
