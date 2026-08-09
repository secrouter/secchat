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

/// A compact classification chip for one message — shown on a bubble only when
/// the channel is unmarked (per-message marking); in a marked channel the banner
/// carries the level for everything, so a per-message chip would be redundant.
class MarkingChip extends StatelessWidget {
  const MarkingChip({super.key, required this.level});

  final String level;

  @override
  Widget build(BuildContext context) {
    final style = markingStyle(level);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: style.bg,
        borderRadius: BorderRadius.circular(3),
      ),
      child: Text(
        level.toUpperCase(),
        style: AppFonts.mono(fontSize: 9.5, color: style.fg).copyWith(fontWeight: FontWeight.w700),
      ),
    );
  }
}
