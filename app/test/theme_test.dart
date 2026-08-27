import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/theme.dart';

void main() {
  // AppColors's ~30 fields are getters over a mutable "active palette"
  // (see lib/theme.dart) rather than compile-time constants, so the app can
  // flip between the dark (default) and light palettes at runtime. These
  // tests cover the two things that mechanism could get wrong: (1) a
  // getter that doesn't actually track the switch (e.g. because it was
  // memoized somewhere), and (2) the two palettes silently drifting apart
  // (a field present in one but not the other) -- which can't happen at
  // compile time here since both are const instances of one `_Palette`
  // class with `required` named parameters (a missing field on either side
  // would fail to compile), but is worth pinning down at the AppColors
  // call-site level too, since that's what the rest of the app actually
  // reads.
  group('AppColors palette switching', () {
    setUp(() {
      // Tests run in undefined order within the process; always start from
      // the documented default so each test is self-contained.
      AppColors.setBrightness(Brightness.dark);
    });

    test('setBrightness(dark) is the default and matches the dark spec values', () {
      expect(AppColors.bg, const Color(0xFF0B0D11));
      expect(AppColors.accent, const Color(0xFFAEBB78));
    });

    test('setBrightness(light) flips every color-scheme token except the two documented as shared', () {
      // Read every field pair (dark, light). Two are deliberately identical
      // across palettes per the spec (onWarn: dark ink still reads fine on
      // the light warn chip; overlay: the modal scrim stays dark in both
      // themes) -- everything else must actually change, or the toggle
      // isn't doing anything for that token.
      final darkValues = _snapshot();
      AppColors.setBrightness(Brightness.light);
      final lightValues = _snapshot();

      const sharedByDesign = {'onWarn', 'overlay'};
      for (final field in darkValues.keys) {
        if (sharedByDesign.contains(field)) {
          expect(
            lightValues[field],
            darkValues[field],
            reason: '$field is documented as identical in both palettes',
          );
        } else {
          expect(
            lightValues[field],
            isNot(darkValues[field]),
            reason: '$field did not change when the palette switched to light',
          );
        }
      }
    });

    test('light palette matches the spec values for a representative sample', () {
      AppColors.setBrightness(Brightness.light);
      expect(AppColors.bg, const Color(0xFFE7E3D8));
      expect(AppColors.surface, const Color(0xFFF3F0E8));
      expect(AppColors.surfaceAlt, const Color(0xFFFBFAF4));
      expect(AppColors.surfaceRaised, const Color(0xFFFFFFFF));
      expect(AppColors.text, const Color(0xFF211F18));
      expect(AppColors.accent, const Color(0xFF4F6A2E));
      expect(AppColors.onWarn, const Color(0xFF241A05)); // unchanged by design
      expect(AppColors.overlay, const Color(0x99050609)); // unchanged by design
      // Aliases stay aliases in the light palette too.
      expect(AppColors.link, AppColors.accent);
      expect(AppColors.codeBorder, AppColors.border);
    });

    test('setBrightness back to dark restores the original values (round-trips cleanly)', () {
      final before = _snapshot();
      AppColors.setBrightness(Brightness.light);
      AppColors.setBrightness(Brightness.dark);
      expect(_snapshot(), before);
    });
  });

  group('buildSecChatTheme + a real widget tree', () {
    testWidgets('toggling the theme flips a token-derived Container color', (tester) async {
      Future<Color> surfaceColorFor(Brightness brightness) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: buildSecChatTheme(brightness),
            home: Container(key: const Key('probe'), color: AppColors.surface),
          ),
        );
        final container = tester.widget<Container>(find.byKey(const Key('probe')));
        return (container.color)!;
      }

      final darkSurface = await surfaceColorFor(Brightness.dark);
      expect(darkSurface, const Color(0xFF151822));

      final lightSurface = await surfaceColorFor(Brightness.light);
      expect(lightSurface, const Color(0xFFF3F0E8));

      expect(lightSurface, isNot(darkSurface));

      // And flipping back one more time (the actual toggle direction a user
      // hits) lands back on the dark value -- not stuck on light.
      final darkAgain = await surfaceColorFor(Brightness.dark);
      expect(darkAgain, darkSurface);
    });

    testWidgets('buildSecChatTheme(brightness) drives ThemeData.brightness + colorScheme.brightness', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildSecChatTheme(Brightness.light),
          home: const Scaffold(),
        ),
      );
      final context = tester.element(find.byType(Scaffold));
      final theme = Theme.of(context);
      expect(theme.brightness, Brightness.light);
      expect(theme.colorScheme.brightness, Brightness.light);
    });
  });
}

/// A snapshot of every AppColors field, keyed by name, at whatever palette
/// is currently active.
Map<String, Color> _snapshot() => {
  'bg': AppColors.bg,
  'surface': AppColors.surface,
  'surfaceAlt': AppColors.surfaceAlt,
  'surfaceRaised': AppColors.surfaceRaised,
  'border': AppColors.border,
  'borderSoft': AppColors.borderSoft,
  'text': AppColors.text,
  'textMuted': AppColors.textMuted,
  'textFaint': AppColors.textFaint,
  'accent': AppColors.accent,
  'accentSoft': AppColors.accentSoft,
  'accentBorder': AppColors.accentBorder,
  'onAccent': AppColors.onAccent,
  'accentGradientEnd': AppColors.accentGradientEnd,
  'ok': AppColors.ok,
  'okBg': AppColors.okBg,
  'okBorder': AppColors.okBorder,
  'bad': AppColors.bad,
  'badBg': AppColors.badBg,
  'badBorder': AppColors.badBorder,
  'warn': AppColors.warn,
  'warnBg': AppColors.warnBg,
  'warnBorder': AppColors.warnBorder,
  'onWarn': AppColors.onWarn,
  'overlay': AppColors.overlay,
  'codeBg': AppColors.codeBg,
  'codeBorder': AppColors.codeBorder,
  'link': AppColors.link,
  'executeOnce': AppColors.executeOnce,
  'executeOnceBg': AppColors.executeOnceBg,
  'executeOnceBorder': AppColors.executeOnceBorder,
  'executeCont': AppColors.executeCont,
  'executeContBg': AppColors.executeContBg,
  'executeContBorder': AppColors.executeContBorder,
};
