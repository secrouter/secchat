import 'package:flutter/material.dart';

import '../emoji.dart';
import '../theme.dart';

/// The emoji picker body — curated groups from `lib/emoji.dart` in a scrollable
/// grid — shown inside a [MenuAnchor]. Shared by the composer (insert emoji at
/// the cursor) and message reactions (toggle a reaction on a message).
class EmojiPickerBody extends StatelessWidget {
  const EmojiPickerBody({super.key, required this.onPick});

  final void Function(String emoji) onPick;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 320,
      height: 260,
      child: SingleChildScrollView(
        primary: false,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final group in kEmojiGroups) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(2, 6, 2, 4),
                child: Text(
                  group.label.toUpperCase(),
                  style: AppFonts.mono(
                    fontSize: 9.5,
                    color: AppColors.textFaint,
                    letterSpacing: 0.6,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Wrap(
                children: [
                  for (final emoji in group.emoji)
                    InkWell(
                      onTap: () => onPick(emoji),
                      borderRadius: BorderRadius.circular(6),
                      child: Padding(
                        padding: const EdgeInsets.all(5),
                        child: Text(emoji, style: const TextStyle(fontSize: 20)),
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
