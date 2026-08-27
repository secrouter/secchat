import 'package:flutter/material.dart';

import '../theme.dart';
import '../version.dart';

/// The SecChat wordmark: a gradient glyph tile plus "SecChat" with "Sec" in
/// the brand accent. Used on the login card and, at [small] size, in the
/// chat top bar.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.small = false});

  final bool small;

  @override
  Widget build(BuildContext context) {
    final markSize = small ? 26.0 : 38.0;
    final wordSize = small ? 15.5 : 23.0;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        // The SecChat brand mark (hexagon speech-badge, reversed for the dark UI).
        Image.asset(
          'assets/secchat-mark.png',
          height: markSize,
          filterQuality: FilterQuality.medium,
        ),
        SizedBox(width: small ? 8 : 12),
        Text.rich(
          TextSpan(
            style: TextStyle(
              fontSize: wordSize,
              fontWeight: FontWeight.w700,
              letterSpacing: -0.2,
              height: 1,
            ),
            children: [
              TextSpan(text: 'Sec', style: TextStyle(color: AppColors.accent)),
              TextSpan(text: 'Chat', style: TextStyle(color: AppColors.text)),
            ],
          ),
        ),
        // Version tag in a muted, monospace font just after the wordmark.
        SizedBox(width: small ? 6 : 8),
        Padding(
          padding: EdgeInsets.only(top: small ? 3 : 5),
          child: Text(
            'v$kAppVersion',
            style: AppFonts.mono(
              fontSize: small ? 10 : 12,
              color: AppColors.textFaint,
            ),
          ),
        ),
      ],
    );
  }
}
