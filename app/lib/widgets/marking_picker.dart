import 'package:flutter/material.dart';

import '../marking.dart';
import '../theme.dart';

/// A dialog that picks a classification level from the ladder. Levels below
/// [current] are disabled unless [allowDowngrade] (downgrading a control is a
/// privileged act — the server enforces this too). Resolves to the chosen level,
/// or null if cancelled.
Future<String?> showMarkingPicker(
  BuildContext context, {
  required List<String> levels,
  required String? current,
  required bool allowDowngrade,
  required MarkingPolicy policy,
}) {
  return showDialog<String>(
    context: context,
    builder: (_) => _MarkingPickerDialog(
      levels: levels,
      current: current,
      allowDowngrade: allowDowngrade,
      policy: policy,
    ),
  );
}

class _MarkingPickerDialog extends StatelessWidget {
  const _MarkingPickerDialog({
    required this.levels,
    required this.current,
    required this.allowDowngrade,
    required this.policy,
  });

  final List<String> levels;
  final String? current;
  final bool allowDowngrade;
  final MarkingPolicy policy;

  @override
  Widget build(BuildContext context) {
    final currentRank = current == null ? -1 : policy.rank(current!);
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      title: const Row(
        children: [
          Icon(Icons.shield_outlined, color: AppColors.accent, size: 20),
          SizedBox(width: 8),
          Text(
            'Channel classification',
            style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ],
      ),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'When a channel is marked, the channel is the portion — every '
              'message inherits this level, and none may exceed it.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
            ),
            const SizedBox(height: 14),
            for (final level in levels)
              _LevelRow(
                level: level,
                selected: level == current,
                // A downgrade (lower rank than current) is admin-only.
                disabled: !allowDowngrade && currentRank >= 0 && policy.rank(level) < currentRank,
                onTap: () => Navigator.of(context).pop(level),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

class _LevelRow extends StatelessWidget {
  const _LevelRow({
    required this.level,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final String level;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final style = markingStyle(level);
    return Opacity(
      opacity: disabled ? 0.4 : 1,
      child: InkWell(
        onTap: disabled ? null : onTap,
        borderRadius: BorderRadius.circular(AppRadius.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
          child: Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(
                  color: style.bg,
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  level,
                  style: AppFonts.mono(fontSize: 11.5, color: style.fg).copyWith(fontWeight: FontWeight.w700),
                ),
              ),
              const Spacer(),
              if (selected)
                const Icon(Icons.check, color: AppColors.accent, size: 18)
              else if (disabled)
                const Icon(Icons.lock_outline, color: AppColors.textFaint, size: 15),
            ],
          ),
        ),
      ),
    );
  }
}
