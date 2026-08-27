import 'package:flutter/material.dart';

import '../responsive.dart';
import '../theme.dart';
import 'brand_icon.dart';

/// Confirms a step-up re-authentication before a privileged action the server
/// gated on freshness. Resolves to true if the user chooses to re-authenticate.
/// (The actual proof is minted by [ApiClient.stepUp]; in an SSO deployment this
/// is where an interactive OIDC re-auth would run.)
Future<bool?> showStepUpDialog(BuildContext context, {String? action}) {
  return showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: BorderSide(color: AppColors.border),
      ),
      title: Row(
        children: [
          BrandIcon('secure', color: AppColors.accent, size: 20),
          SizedBox(width: 8),
          Text(
            'Re-authentication required',
            style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ],
      ),
      content: SizedBox(
        width: dialogWidth(context, 400),
        child: Text(
          'This is a privileged action${action == null ? '' : ' ($action)'} and needs a fresh '
          'confirmation of your identity. Re-authenticate to continue.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13, height: 1.45),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        ElevatedButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.accent,
            foregroundColor: Colors.white,
            elevation: 0,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
            textStyle: AppFonts.sans(fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
          child: const Text('Re-authenticate'),
        ),
      ],
    ),
  );
}
