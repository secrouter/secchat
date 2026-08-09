import 'package:flutter/material.dart';

/// The deployment's classification-marking ladder, delivered by `GET /me`. An
/// ordered list (low → high sensitivity) plus the fail-safe default level. The
/// client renders + compares locally; the server remains the enforcement
/// authority (it blocks over-marked posts and gates downgrades regardless).
class MarkingPolicy {
  const MarkingPolicy({required this.levels, required this.defaultLevel});

  final List<String> levels;
  final String defaultLevel;

  /// Used before `/me` resolves, and if the server omitted the policy — matches
  /// the backend's default (dod-cui) profile: up to CUI, no CLASSIFIED.
  static const MarkingPolicy fallback = MarkingPolicy(
    levels: ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
    defaultLevel: 'UNCLASSIFIED',
  );

  int rank(String level) => levels.indexOf(level.toUpperCase());
  bool known(String level) => rank(level) >= 0;

  /// The baseline (the default/floor). Everything is implicitly this unless labelled;
  /// its display is suppressed (no baseline chrome).
  String get baseline => defaultLevel;

  /// Whether [level] is ABOVE the baseline and so warrants a visible marking + masking.
  /// Baseline (and below/unknown) is never elevated.
  bool isElevated(String level) => rank(level) > rank(defaultLevel);

  /// True when [a] is no more sensitive than [b] (rank(a) ≤ rank(b)); unknown
  /// levels never compare true.
  bool atMost(String a, String b) {
    final ra = rank(a);
    final rb = rank(b);
    return ra >= 0 && rb >= 0 && ra <= rb;
  }

  factory MarkingPolicy.fromJson(Map<String, dynamic> json) => MarkingPolicy(
    levels: (json['levels'] as List<dynamic>?)?.map((e) => e.toString()).toList() ?? fallback.levels,
    defaultLevel: json['default'] as String? ?? fallback.defaultLevel,
  );
}

/// The colors for a classification banner/chip at [level]. Keyed by the level
/// NAME so a custom deployment ladder still gets sensible, conventional colors,
/// with a neutral fallback for anything unrecognized. Always high-contrast
/// (solid bar, near-white text) — a marking must never be ambiguous.
({Color bg, Color fg}) markingStyle(String level) {
  switch (level.toUpperCase()) {
    case 'UNCLASSIFIED':
    case 'PUBLIC':
      return (bg: const Color(0xFF1E7A34), fg: Colors.white); // green
    case 'PROPRIETARY':
    case 'INTERNAL':
    case 'CONTROLLED':
      return (bg: const Color(0xFF8A6D00), fg: Colors.white); // amber/olive
    case 'CUI':
      return (bg: const Color(0xFF522398), fg: Colors.white); // CUI purple
    case 'CONFIDENTIAL':
      return (bg: const Color(0xFF1457B0), fg: Colors.white); // blue
    case 'SECRET':
      return (bg: const Color(0xFFB00020), fg: Colors.white); // red
    case 'TOP SECRET':
    case 'TOPSECRET':
      return (bg: const Color(0xFFCF6A00), fg: Colors.white); // orange
    default:
      return (bg: const Color(0xFF444A54), fg: Colors.white); // neutral slate
  }
}
