import 'package:flutter/material.dart';

import '../theme.dart';

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
        Container(
          width: markSize,
          height: markSize,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [AppColors.accent, AppColors.accentGradientEnd],
            ),
            borderRadius: BorderRadius.circular(small ? 7 : 10),
          ),
          child: Text(
            'S',
            style: TextStyle(
              color: AppColors.onAccent,
              fontWeight: FontWeight.w800,
              fontSize: small ? 12.5 : 17,
              height: 1,
            ),
          ),
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
            children: const [
              TextSpan(text: 'Sec', style: TextStyle(color: AppColors.accent)),
              TextSpan(text: 'Chat', style: TextStyle(color: AppColors.text)),
            ],
          ),
        ),
      ],
    );
  }
}
