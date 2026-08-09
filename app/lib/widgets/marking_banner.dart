import 'package:flutter/material.dart';

import '../marking.dart';
import '../theme.dart';

/// A full-width classification banner (the top/bottom bars framing a channel's
/// content, per DoDI 5200.48 marking practice). Solid, high-contrast, centered.
class MarkingBanner extends StatelessWidget {
  const MarkingBanner({super.key, required this.level});

  final String level;

  @override
  Widget build(BuildContext context) {
    final style = markingStyle(level);
    return Container(
      width: double.infinity,
      color: style.bg,
      padding: const EdgeInsets.symmetric(vertical: 3),
      alignment: Alignment.center,
      child: Text(
        level.toUpperCase(),
        style: AppFonts.mono(fontSize: 11.5, color: style.fg).copyWith(
          fontWeight: FontWeight.w800,
          letterSpacing: 1.2,
        ),
      ),
    );
  }
}
