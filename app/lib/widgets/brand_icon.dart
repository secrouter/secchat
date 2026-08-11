import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../theme.dart';

/// One of the SecChat brand interface icons (24×24 stroke SVGs, `currentColor`).
/// A drop-in for [Icon] on the brand-relevant actions — chat, secure, lock,
/// history, audit, send, … — tinted to [color] (defaults to the current text
/// color). Names match the files in `assets/ui-icons/`.
class BrandIcon extends StatelessWidget {
  const BrandIcon(this.name, {super.key, this.size = 18, this.color});

  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SvgPicture.asset(
      'assets/ui-icons/$name.svg',
      width: size,
      height: size,
      colorFilter: ColorFilter.mode(color ?? AppColors.text, BlendMode.srcIn),
    );
  }
}
