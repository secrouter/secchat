import 'package:flutter/material.dart';

/// The bare LEVEL of a (possibly category-qualified) marking string — the part
/// before the first `//`. "CUI//SP-PRVCY" → "CUI"; "CUI" → "CUI". Rank, color,
/// and elevation all key off this so a composite marking behaves like its level.
String markingLevelOf(String marking) => marking.split('//').first.trim().toUpperCase();

/// The category codes carried by a marking string (after the first `//`), or
/// empty for a bare level. "CUI//SP-EXPT/SP-PRVCY" → ["SP-EXPT", "SP-PRVCY"].
List<String> markingCategoriesOf(String marking) {
  final i = marking.indexOf('//');
  if (i < 0) return const [];
  return marking
      .substring(i + 2)
      .split('/')
      .map((s) => s.trim().toUpperCase())
      .where((s) => s.isNotEmpty)
      .toList();
}

/// A CUI category (an optional, UNRANKED caveat qualifying a level) offered by
/// the deployment — delivered by `GET /me`. Categories attach to a specific
/// [level] (a category qualifies exactly that level, e.g. CUI).
class MarkingCategory {
  const MarkingCategory({required this.code, required this.name, required this.level});

  final String code;
  final String name;
  final String level;

  factory MarkingCategory.fromJson(Map<String, dynamic> json) => MarkingCategory(
    code: (json['code'] ?? '').toString().toUpperCase(),
    name: (json['name'] ?? json['code'] ?? '').toString(),
    level: (json['level'] ?? 'CUI').toString().toUpperCase(),
  );
}

/// The deployment's classification-marking policy, delivered by `GET /me`. An
/// ordered ladder of levels (low → high sensitivity) plus the fail-safe default,
/// and the enabled CUI [categories] (optional caveats). The client renders +
/// compares locally; the server remains the enforcement authority (it blocks
/// over-marked posts and gates downgrades regardless).
class MarkingPolicy {
  const MarkingPolicy({required this.levels, required this.defaultLevel, this.categories = const []});

  final List<String> levels;
  final String defaultLevel;
  final List<MarkingCategory> categories;

  /// Used before `/me` resolves, and if the server omitted the policy — matches
  /// the backend's default (dod-cui) profile: up to CUI, no CLASSIFIED.
  static const MarkingPolicy fallback = MarkingPolicy(
    levels: ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
    defaultLevel: 'UNCLASSIFIED',
  );

  /// Rank of a marking by its LEVEL (categories don't affect rank). -1 if unknown.
  int rank(String level) => levels.indexOf(markingLevelOf(level));
  bool known(String level) => rank(level) >= 0;

  /// The baseline (the default/floor). Everything is implicitly this unless labelled;
  /// its display is suppressed (no baseline chrome).
  String get baseline => defaultLevel;

  /// Whether [level] is ABOVE the baseline and so warrants a visible marking + masking.
  /// Baseline (and below/unknown) is never elevated.
  bool isElevated(String level) => rank(level) > rank(defaultLevel);

  /// True when [a] is no more sensitive than [b] by LEVEL (rank(a) ≤ rank(b));
  /// unknown levels never compare true. (Caveat dominance is enforced server-side.)
  bool atMost(String a, String b) {
    final ra = rank(a);
    final rb = rank(b);
    return ra >= 0 && rb >= 0 && ra <= rb;
  }

  /// The enabled categories that qualify [level] (e.g. the CUI categories offered on a CUI message).
  List<MarkingCategory> categoriesFor(String level) {
    final lvl = markingLevelOf(level);
    return categories.where((c) => c.level == lvl).toList();
  }

  factory MarkingPolicy.fromJson(Map<String, dynamic> json) => MarkingPolicy(
    levels: (json['levels'] as List<dynamic>?)?.map((e) => e.toString()).toList() ?? fallback.levels,
    defaultLevel: json['default'] as String? ?? fallback.defaultLevel,
    categories: (json['categories'] as List<dynamic>?)
            ?.map((e) => MarkingCategory.fromJson(e as Map<String, dynamic>))
            .toList() ??
        const [],
  );
}

/// The colors for a classification banner/chip at [level] (a bare level or a
/// composite marking string — the color keys off the LEVEL part). Keyed by the
/// level NAME so a custom deployment ladder still gets sensible, conventional
/// colors, with a neutral fallback for anything unrecognized. Always high-contrast
/// (solid bar, near-white text) — a marking must never be ambiguous.
({Color bg, Color fg}) markingStyle(String level) {
  switch (markingLevelOf(level)) {
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
