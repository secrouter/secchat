import 'package:flutter/material.dart';

import '../marking.dart';
import '../responsive.dart';
import '../theme.dart';
import 'brand_icon.dart';

/// A dialog that picks a channel classification — a level from the ladder plus,
/// for a level that has them, optional CUI categories (caveats). Levels below
/// [current] are disabled unless [allowDowngrade] (downgrading a control is a
/// privileged act — the server enforces this too, and dropping a category is a
/// downgrade all the same). Resolves to the canonical banner marking (e.g.
/// "CUI" or "CUI//SP-PRVCY"), or null if cancelled.
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

class _MarkingPickerDialog extends StatefulWidget {
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
  State<_MarkingPickerDialog> createState() => _MarkingPickerDialogState();
}

class _MarkingPickerDialogState extends State<_MarkingPickerDialog> {
  // Seed the selection from the channel's current marking (level + categories).
  late String? _level = widget.current == null ? null : markingLevelOf(widget.current!);
  late final Set<String> _categories =
      widget.current == null ? <String>{} : markingCategoriesOf(widget.current!).toSet();

  List<MarkingCategory> get _availableCategories =>
      _level == null ? const [] : widget.policy.categoriesFor(_level!);

  /// The canonical banner for the current selection, or null if no level is chosen.
  String? get _result {
    final level = _level;
    if (level == null) return null;
    final codes = _availableCategories.map((c) => c.code).where(_categories.contains).toList()..sort();
    return codes.isEmpty ? level : '$level//${codes.join('/')}';
  }

  void _selectLevel(String level) => setState(() {
        _level = level;
        // Drop any selected categories that don't apply to the new level.
        final legal = widget.policy.categoriesFor(level).map((c) => c.code).toSet();
        _categories.removeWhere((c) => !legal.contains(c));
      });

  void _toggleCategory(String code) =>
      setState(() => _categories.contains(code) ? _categories.remove(code) : _categories.add(code));

  @override
  Widget build(BuildContext context) {
    final currentRank = widget.current == null ? -1 : widget.policy.rank(widget.current!);
    final available = _availableCategories;
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      title: const Row(
        children: [
          BrandIcon('secure', color: AppColors.accent, size: 20),
          SizedBox(width: 8),
          Text(
            'Channel classification',
            style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ],
      ),
      content: SizedBox(
        width: dialogWidth(context, 360),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'When a channel is marked, the channel is the portion — every '
              'message inherits this marking, and none may exceed it.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.4),
            ),
            const SizedBox(height: 14),
            for (final level in widget.levels)
              _LevelRow(
                level: level,
                selected: level == _level,
                // A downgrade (lower rank than current) is admin-only.
                disabled: !widget.allowDowngrade && currentRank >= 0 && widget.policy.rank(level) < currentRank,
                onTap: () => _selectLevel(level),
              ),
            if (available.isNotEmpty) ...[
              const SizedBox(height: 14),
              Text(
                'CATEGORIES',
                style: AppFonts.mono(fontSize: 9.5, color: AppColors.textFaint)
                    .copyWith(fontWeight: FontWeight.w700, letterSpacing: 0.6),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final c in available)
                    _CategoryChip(
                      category: c,
                      level: _level!,
                      selected: _categories.contains(c.code),
                      onTap: () => _toggleCategory(c.code),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: _level == null ? null : () => Navigator.of(context).pop(_result),
          child: const Text('Set marking'),
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

class _CategoryChip extends StatelessWidget {
  const _CategoryChip({
    required this.category,
    required this.level,
    required this.selected,
    required this.onTap,
  });

  final MarkingCategory category;
  final String level;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final style = markingStyle(level);
    return Tooltip(
      message: category.name,
      child: InkWell(
        borderRadius: BorderRadius.circular(3),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: selected ? style.bg : AppColors.surfaceRaised,
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: selected ? style.bg : AppColors.border),
          ),
          child: Text(
            category.code,
            style: AppFonts.mono(fontSize: 10.5, color: selected ? style.fg : AppColors.textMuted)
                .copyWith(fontWeight: FontWeight.w700),
          ),
        ),
      ),
    );
  }
}
