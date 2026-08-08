/// The SecChat brand: exact colors lifted from
/// `clients/web-minimal/assets/app.css` / `src/admin/console.ts` so this
/// client, the static web-minimal client, and the admin console read as one
/// product. Dark-only by design (`color-scheme: dark` in the source CSS) --
/// there is no light theme to switch to.
library;

import 'package:flutter/material.dart';

/// Exact palette values from the CSS custom properties in
/// `clients/web-minimal/assets/app.css`. Keep this list in the same order
/// as the source `:root` block so the two stay easy to diff by eye.
class AppColors {
  AppColors._();

  static const bg = Color(0xFF0B0D11);
  static const surface = Color(0xFF151822);
  static const surfaceAlt = Color(0xFF1B1F2B);
  static const surfaceRaised = Color(0xFF20242F);
  static const border = Color(0xFF262B38);
  static const borderSoft = Color(0xFF1D212B);
  static const text = Color(0xFFE7E9EE);
  static const textMuted = Color(0xFF8891A3);
  static const textFaint = Color(0xFF5B6376);

  static const accent = Color(0xFFAEBB78);
  static const accentSoft = Color(0x24AEBB78); // rgba(174,187,120,0.14)
  static const accentBorder = Color(0x66AEBB78); // rgba(174,187,120,0.4)
  static const onAccent = Color(0xFF14170D);
  static const accentGradientEnd = Color(0xFF7F9153); // brand-mark gradient

  static const ok = Color(0xFF3DDC84);
  static const okBg = Color(0xFF10281C);
  static const okBorder = Color(0xFF1F6B43);

  static const bad = Color(0xFFFF6B6B);
  static const badBg = Color(0xFF2E1414);
  static const badBorder = Color(0xFF7A2E2E);

  static const warn = Color(0xFFE8A33D);
  static const warnBg = Color(0xFF2C2110);
  static const warnBorder = Color(0xFF7A5620);
  static const onWarn = Color(0xFF241A05); // .btn-warn color

  static const overlay = Color(0x99050609); // modal-overlay rgba(5,6,9,.6)
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
    Color color = AppColors.textMuted,
    FontWeight? fontWeight,
    double? letterSpacing,
  }) => TextStyle(
    fontFamily: monoFallback.first,
    fontFamilyFallback: monoFallback.skip(1).toList(),
    fontSize: fontSize,
    color: color,
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
class AppButtonStyles {
  AppButtonStyles._();

  static final ButtonStyle primary = ElevatedButton.styleFrom(
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

  static final ButtonStyle secondary = ElevatedButton.styleFrom(
    backgroundColor: AppColors.surfaceAlt,
    foregroundColor: AppColors.text,
    disabledForegroundColor: AppColors.textFaint,
    elevation: 0,
    alignment: Alignment.centerLeft,
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
    side: const BorderSide(color: AppColors.border),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadius.sm),
    ),
    textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
  );

  static final ButtonStyle ghost = OutlinedButton.styleFrom(
    foregroundColor: AppColors.textMuted,
    disabledForegroundColor: AppColors.textFaint,
    side: const BorderSide(color: AppColors.border),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppRadius.sm),
    ),
    textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
  );

  static final ButtonStyle warn = ElevatedButton.styleFrom(
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

ThemeData buildSecChatTheme() {
  const colorScheme = ColorScheme(
    brightness: Brightness.dark,
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
    brightness: Brightness.dark,
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
    iconTheme: const IconThemeData(color: AppColors.textMuted, size: 20),
    dividerTheme: const DividerThemeData(
      color: AppColors.border,
      thickness: 1,
      space: 1,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColors.accent,
    ),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: AppColors.accent,
      selectionColor: AppColors.accentSoft,
      selectionHandleColor: AppColors.accent,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surfaceAlt,
      hintStyle: const TextStyle(color: AppColors.textFaint, fontSize: 14),
      labelStyle: const TextStyle(color: AppColors.textMuted, fontSize: 13),
      contentPadding: const EdgeInsets.symmetric(
        horizontal: 12,
        vertical: 10,
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: const BorderSide(color: AppColors.accent, width: 1.5),
      ),
      errorBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.sm),
        borderSide: const BorderSide(color: AppColors.bad),
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
        side: const BorderSide(color: AppColors.border),
      ),
    ),
    tooltipTheme: TooltipThemeData(
      textStyle: AppFonts.sans(color: AppColors.text, fontSize: 12),
      decoration: const BoxDecoration(
        color: AppColors.surfaceRaised,
        borderRadius: BorderRadius.all(Radius.circular(AppRadius.sm)),
      ),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor: const WidgetStatePropertyAll(AppColors.border),
      trackColor: const WidgetStatePropertyAll(Colors.transparent),
      trackBorderColor: const WidgetStatePropertyAll(Colors.transparent),
      radius: const Radius.circular(8),
      thickness: const WidgetStatePropertyAll(8),
    ),
  );
}
