/// The SecChat brand: exact colors lifted from
/// `clients/web-minimal/assets/app.css` / `src/admin/console.ts` so this
/// client, the static web-minimal client, and the admin console read as one
/// product.
///
/// Two palettes exist -- dark (the original, still the default) and light
/// (added for the light-mode toggle; values come from Spec A's canonical
/// light tokens, the suite reference -- see the light-mode token-mapping
/// spec for the derivation). [AppColors] itself stays a bare static-field API
/// (`AppColors.text`, `AppColors.bg`, ...) so the ~40 files that already read
/// it don't change at all; only the *values* it returns become swappable.
library;

import 'package:flutter/material.dart';

/// One full set of [AppColors] values. Both [_darkPalette] and
/// [_lightPalette] below are `const` instances of this -- the palette
/// *contents* stay compile-time constants, only the "which one is active"
/// switch is mutable.
class _Palette {
  const _Palette({
    required this.bg,
    required this.surface,
    required this.surfaceAlt,
    required this.surfaceRaised,
    required this.border,
    required this.borderSoft,
    required this.text,
    required this.textMuted,
    required this.textFaint,
    required this.accent,
    required this.accentSoft,
    required this.accentBorder,
    required this.onAccent,
    required this.accentGradientEnd,
    required this.ok,
    required this.okBg,
    required this.okBorder,
    required this.bad,
    required this.badBg,
    required this.badBorder,
    required this.warn,
    required this.warnBg,
    required this.warnBorder,
    required this.onWarn,
    required this.overlay,
    required this.codeBg,
    required this.codeBorder,
    required this.link,
    required this.executeOnce,
    required this.executeOnceBg,
    required this.executeOnceBorder,
    required this.executeCont,
    required this.executeContBg,
    required this.executeContBorder,
  });

  final Color bg;
  final Color surface;
  final Color surfaceAlt;
  final Color surfaceRaised;
  final Color border;
  final Color borderSoft;
  final Color text;
  final Color textMuted;
  final Color textFaint;

  final Color accent;
  final Color accentSoft;
  final Color accentBorder;
  final Color onAccent;
  final Color accentGradientEnd;

  final Color ok;
  final Color okBg;
  final Color okBorder;

  final Color bad;
  final Color badBg;
  final Color badBorder;

  final Color warn;
  final Color warnBg;
  final Color warnBorder;
  final Color onWarn;

  final Color overlay;

  final Color codeBg;
  final Color codeBorder;
  final Color link;

  // Coding-agent execute-mode chips (lib/widgets/coding_strip.dart).
  final Color executeOnce;
  final Color executeOnceBg;
  final Color executeOnceBorder;
  final Color executeCont;
  final Color executeContBg;
  final Color executeContBorder;
}

/// Exact palette values from the CSS custom properties in
/// `clients/web-minimal/assets/app.css`. Keep this list in the same order
/// as the source `:root` block so the two stay easy to diff by eye.
const _darkPalette = _Palette(
  bg: Color(0xFF0B0D11),
  surface: Color(0xFF151822),
  surfaceAlt: Color(0xFF1B1F2B),
  surfaceRaised: Color(0xFF20242F),
  border: Color(0xFF262B38),
  borderSoft: Color(0xFF1D212B),
  text: Color(0xFFE7E9EE),
  textMuted: Color(0xFF8891A3),
  textFaint: Color(0xFF5B6376),

  accent: Color(0xFFAEBB78),
  accentSoft: Color(0x24AEBB78), // rgba(174,187,120,0.14)
  accentBorder: Color(0x66AEBB78), // rgba(174,187,120,0.4)
  onAccent: Color(0xFF14170D),
  accentGradientEnd: Color(0xFF7F9153), // brand-mark gradient

  ok: Color(0xFF3DDC84),
  okBg: Color(0xFF10281C),
  okBorder: Color(0xFF1F6B43),

  bad: Color(0xFFFF6B6B),
  badBg: Color(0xFF2E1414),
  badBorder: Color(0xFF7A2E2E),

  warn: Color(0xFFE8A33D),
  warnBg: Color(0xFF2C2110),
  warnBorder: Color(0xFF7A5620),
  onWarn: Color(0xFF241A05), // .btn-warn color

  overlay: Color(0x99050609), // modal-overlay rgba(5,6,9,.6)

  // Markdown rendering (`lib/widgets/markdown_text.dart`) -- named aliases
  // over the palette above so that widget reads its own semantic names
  // rather than reaching for `surfaceAlt`/`border`/`accent` directly.
  codeBg: Color(0xFF1B1F2B), // = surfaceAlt
  codeBorder: Color(0xFF262B38), // = border
  link: Color(0xFFAEBB78), // = accent

  // Coding-strip execute-mode chips -- previously hardcoded inline.
  executeOnce: Color(0xFFE8D14D), // yellow
  executeOnceBg: Color(0xFF2C2810),
  executeOnceBorder: Color(0xFF7A6E20),
  executeCont: Color(0xFFE8823D), // orange
  executeContBg: Color(0xFF2C1B10),
  executeContBorder: Color(0xFF7A4420),
);

/// Light-mode values from Spec A's canonical light palette (the suite
/// reference). SecChat's elevation idiom (bg < surface < surfaceAlt <
/// surfaceRaised, raising by *lightening*) is preserved -- the reference
/// light theme raises surfaces by lightening too.
const _lightPalette = _Palette(
  bg: Color(0xFFE7E3D8),
  surface: Color(0xFFF3F0E8),
  surfaceAlt: Color(0xFFFBFAF4),
  surfaceRaised: Color(0xFFFFFFFF),
  border: Color(0xFFCDC6B2),
  borderSoft: Color(0xFFDAD4C2),
  text: Color(0xFF211F18),
  textMuted: Color(0xFF6C6552),
  // #837D6C: 3.2:1 on the light bg (the derived #8A8474 measured 2.91:1 — under the 3:1 floor).
  textFaint: Color(0xFF837D6C),

  accent: Color(0xFF4F6A2E),
  accentSoft: Color(0x2E4F6A2E), // rgba(79,106,46,.18)
  accentBorder: Color(0x664F6A2E),
  onAccent: Color(0xFFF6F3EA),
  accentGradientEnd: Color(0xFF54672F),

  ok: Color(0xFF2F5A22),
  okBg: Color(0xFFE3EBD7),
  okBorder: Color(0xFFB9C9A8),

  bad: Color(0xFF8A2B1D),
  badBg: Color(0xFFF0DDD7),
  badBorder: Color(0xFFD8B3AA),

  warn: Color(0xFF8A5A12),
  warnBg: Color(0xFFEFE6CF),
  warnBorder: Color(0xFFD8C69A),
  onWarn: Color(0xFF241A05), // unchanged -- dark ink works on the light warn chip too

  overlay: Color(0x99050609), // modal scrim stays dark in both themes

  codeBg: Color(0xFFE2DDCD),
  codeBorder: Color(0xFFCDC6B2), // = border
  link: Color(0xFF4F6A2E), // = accent

  executeOnce: Color(0xFF8A7A12),
  executeOnceBg: Color(0xFFF0EACF),
  executeOnceBorder: Color(0xFFD8CC9A),
  executeCont: Color(0xFF8A4A12),
  executeContBg: Color(0xFFF0E2D3),
  executeContBorder: Color(0xFFD8BA9A),
);

/// Static color-token facade used across the app (`AppColors.text`,
/// `AppColors.bg`, ...). Values are no longer compile-time constants --
/// they read whichever [_Palette] is currently active -- so every field
/// here is a getter, not a `const`.
///
/// Mechanism: a single mutable static field ([_active]), flipped by
/// [setBrightness]. This -- rather than an `InheritedWidget`/`Theme`
/// extension threaded through `BuildContext` -- was chosen because
/// `AppColors.x` is read as a bare static from ~40 files today; making the
/// lookup context-dependent would mean rewriting every one of those call
/// sites to carry a `BuildContext` (or thread the palette through
/// constructors) instead of just swapping the values a static field
/// returns.
///
/// This does mean every widget that reads `AppColors.*` must actually
/// rebuild (i.e. not be `const`, and not be the literal same widget
/// *instance* reused across builds) when the theme flips, since there's no
/// `InheritedWidget` dependency to invalidate them automatically. In
/// practice that already falls out of the const-ness fix this change
/// requires: a `const` widget can't reference a non-const `AppColors.x`
/// getter, so every previously-`const` literal that touched a color had its
/// `const` removed as part of this change, which is exactly what makes it
/// rebuild.
///
/// [setBrightness] is called from [buildSecChatTheme], which
/// `_SecChatAppState.build()` (app.dart) invokes as the very first
/// positional/named argument of the `MaterialApp(...)` it constructs --
/// before building `home:` and the whole widget subtree beneath it -- so
/// the write always happens-before the reads that matter for that frame.
class AppColors {
  AppColors._();

  static _Palette _active = _darkPalette;

  /// Switches the active palette. Idempotent; cheap enough to call on
  /// every theme build without memoizing.
  static void setBrightness(Brightness brightness) {
    _active = brightness == Brightness.light ? _lightPalette : _darkPalette;
  }

  static Color get bg => _active.bg;
  static Color get surface => _active.surface;
  static Color get surfaceAlt => _active.surfaceAlt;
  static Color get surfaceRaised => _active.surfaceRaised;
  static Color get border => _active.border;
  static Color get borderSoft => _active.borderSoft;
  static Color get text => _active.text;
  static Color get textMuted => _active.textMuted;
  static Color get textFaint => _active.textFaint;

  static Color get accent => _active.accent;
  static Color get accentSoft => _active.accentSoft;
  static Color get accentBorder => _active.accentBorder;
  static Color get onAccent => _active.onAccent;
  static Color get accentGradientEnd => _active.accentGradientEnd;

  static Color get ok => _active.ok;
  static Color get okBg => _active.okBg;
  static Color get okBorder => _active.okBorder;

  static Color get bad => _active.bad;
  static Color get badBg => _active.badBg;
  static Color get badBorder => _active.badBorder;

  static Color get warn => _active.warn;
  static Color get warnBg => _active.warnBg;
  static Color get warnBorder => _active.warnBorder;
  static Color get onWarn => _active.onWarn;

  static Color get overlay => _active.overlay;

  static Color get codeBg => _active.codeBg;
  static Color get codeBorder => _active.codeBorder;
  static Color get link => _active.link;

  static Color get executeOnce => _active.executeOnce;
  static Color get executeOnceBg => _active.executeOnceBg;
  static Color get executeOnceBorder => _active.executeOnceBorder;
  static Color get executeCont => _active.executeCont;
  static Color get executeContBg => _active.executeContBg;
  static Color get executeContBorder => _active.executeContBorder;
}

class AppRadius {
  AppRadius._();

  static const sm = 7.0;
  static const lg = 16.0;
}

/// System-font stacks (no bundled web fonts, per the CSS `--sans`/`--mono`
/// custom properties) expressed as Flutter fallback lists.
class AppFonts {
  AppFonts._();

  static const sansFallback = <String>[
    '.SF NS Text',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'sans-serif',
  ];

  static const monoFallback = <String>[
    'SFMono-Regular',
    'Menlo',
    'Consolas',
    'Liberation Mono',
    'monospace',
  ];

  /// A monospace [TextStyle] for ids, hashes, and timestamps.
  static TextStyle mono({
    double fontSize = 12.5,
    Color? color,
    FontWeight? fontWeight,
    double? letterSpacing,
  }) => TextStyle(
    fontFamily: monoFallback.first,
    fontFamilyFallback: monoFallback.skip(1).toList(),
    fontSize: fontSize,
    color: color ?? AppColors.textMuted,
    fontWeight: fontWeight,
    letterSpacing: letterSpacing,
  );

  /// A system-font [TextStyle]. Most `Text` widgets get this for free by
  /// inheriting through `DefaultTextStyle` from [buildSecChatTheme]'s
  /// `textTheme`, but a few Material widgets (buttons, snackbars, tooltips)
  /// install their `ButtonStyle`/`*ThemeData` text style as a *new* terminal
  /// `DefaultTextStyle` rather than merging it with the ambient one, so
  /// those need the font stack spelled out explicitly.
  static TextStyle sans({
    double fontSize = 14,
    Color? color,
    FontWeight? fontWeight,
    double? letterSpacing,
  }) => TextStyle(
    fontFamily: sansFallback.first,
    fontFamilyFallback: sansFallback.skip(1).toList(),
    fontSize: fontSize,
    color: color,
    fontWeight: fontWeight,
    letterSpacing: letterSpacing,
  );
}

/// Named [ButtonStyle]s matching the `.btn-primary` / `.btn-secondary` /
/// `.btn-ghost` / `.btn-warn` variants in `app.css`. A single Material
/// `ElevatedButtonThemeData` can't express four visually distinct button
/// families at once, so buttons opt into one of these explicitly instead of
/// relying on ambient theme defaults.
///
/// These are getters, not `static final` fields: a `static final` is
/// computed once (lazily, on first access) and cached forever, which would
/// freeze the button colors at whatever palette was active the first time
/// any of them was touched. A getter recomputes on every access, so it
/// always reflects [AppColors]'s current palette.
class AppButtonStyles {
  AppButtonStyles._();

  static ButtonStyle get primary => ElevatedButton.styleFrom(
    backgroundColor: AppColors.accent,
    foregroundColor: AppColors.onAccent,
    disabledBackgroundColor: AppColors.accent.withValues(alpha: 0.5),
    disabledForegroundColor: AppColors.onAccent.withValues(alpha: 0.7),
    elevation: 0,
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadius.sm),
    ),
    textStyle: AppFonts.sans(
      fontSize: 13.5,
      fontWeight: FontWeight.w600,
      letterSpacing: 0.2,
    ),
  );

  static ButtonStyle get secondary => ElevatedButton.styleFrom(
    backgroundColor: AppColors.surfaceAlt,
    foregroundColor: AppColors.text,
    disabledForegroundColor: AppColors.textFaint,
    elevation: 0,
    alignment: Alignment.centerLeft,
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
    side: BorderSide(color: AppColors.border),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadius.sm),
    ),
    textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
  );

  static ButtonStyle get ghost => OutlinedButton.styleFrom(
    foregroundColor: AppColors.textMuted,
    disabledForegroundColor: AppColors.textFaint,
    side: BorderSide(color: AppColors.border),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadius.sm),
    ),
    textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
  );

  static ButtonStyle get warn => ElevatedButton.styleFrom(
    backgroundColor: AppColors.warn,
    foregroundColor: AppColors.onWarn,
    disabledBackgroundColor: AppColors.warn.withValues(alpha: 0.5),
    disabledForegroundColor: AppColors.onWarn.withValues(alpha: 0.7),
    elevation: 0,
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadius.sm),
    ),
    textStyle: AppFonts.sans(fontSize: 13, fontWeight: FontWeight.w700),
  );
}

/// Builds the app's [ThemeData] for the given [brightness]. Also flips
/// [AppColors]'s active palette as a side effect (see [AppColors] doc) --
/// callers don't need to call [AppColors.setBrightness] separately.
ThemeData buildSecChatTheme(Brightness brightness) {
  AppColors.setBrightness(brightness);

  final colorScheme = ColorScheme(
    brightness: brightness,
    primary: AppColors.accent,
    onPrimary: AppColors.onAccent,
    secondary: AppColors.accent,
    onSecondary: AppColors.onAccent,
    error: AppColors.bad,
    onError: Colors.white,
    surface: AppColors.surface,
    onSurface: AppColors.text,
    surfaceContainerHighest: AppColors.surfaceRaised,
    surfaceContainerHigh: AppColors.surfaceAlt,
    surfaceContainer: AppColors.surface,
    outline: AppColors.border,
    outlineVariant: AppColors.borderSoft,
    inverseSurface: AppColors.text,
    onInverseSurface: AppColors.bg,
  );

  // `fontFamily`/`fontFamilyFallback` only take effect as constructor
  // arguments (they seed the default text theme at construction time) --
  // `ThemeData.copyWith` doesn't expose them, so the font has to be set
  // here, up front, rather than layered on below.
  final base = ThemeData(
    brightness: brightness,
    useMaterial3: true,
    colorScheme: colorScheme,
    fontFamily: AppFonts.sansFallback.first,
    fontFamilyFallback: AppFonts.sansFallback.skip(1).toList(),
  );

  final textTheme = base.textTheme.apply(
    bodyColor: AppColors.text,
    displayColor: AppColors.text,
  );

  return base.copyWith(
    scaffoldBackgroundColor: AppColors.bg,
    canvasColor: AppColors.bg,
    textTheme: textTheme,
    splashFactory: InkRipple.splashFactory,
    iconTheme: IconThemeData(color: AppColors.textMuted, size: 20),
    dividerTheme: DividerThemeData(
      color: AppColors.border,
      thickness: 1,
      space: 1,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: AppColors.accent,
    ),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: AppColors.accent,
      selectionColor: AppColors.accentSoft,
      selectionHandleColor: AppColors.accent,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surfaceAlt,
      hintStyle: TextStyle(color: AppColors.textFaint, fontSize: 14),
      labelStyle: TextStyle(color: AppColors.textMuted, fontSize: 13),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: BorderSide(color: AppColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: BorderSide(color: AppColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: BorderSide(color: AppColors.accent, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: BorderSide(color: AppColors.bad),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: AppButtonStyles.primary,
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(style: AppButtonStyles.ghost),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColors.textMuted,
        textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.surfaceRaised,
      contentTextStyle: AppFonts.sans(color: AppColors.text, fontSize: 13),
      actionTextColor: AppColors.accent,
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        side: BorderSide(color: AppColors.border),
      ),
    ),
    tooltipTheme: TooltipThemeData(
      textStyle: AppFonts.sans(color: AppColors.text, fontSize: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceRaised,
        borderRadius: const BorderRadius.all(Radius.circular(AppRadius.sm)),
      ),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor: WidgetStatePropertyAll(AppColors.border),
      trackColor: const WidgetStatePropertyAll(Colors.transparent),
      trackBorderColor: const WidgetStatePropertyAll(Colors.transparent),
      radius: const Radius.circular(8),
      thickness: const WidgetStatePropertyAll(8),
    ),
  );
}
