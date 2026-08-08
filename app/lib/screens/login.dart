import 'package:flutter/material.dart';

import '../platform/browser_redirect.dart';
import '../theme.dart';
import '../widgets/brand_mark.dart';

/// The sign-in screen: a primary "Sign in with SecSSO" button plus a
/// secondary developer sign-in form (username + an "admin" checkbox, no
/// password).
///
/// SecSSO is a real login: tapping the button is a full browser navigation
/// to `<origin>/auth/login`, which this screen never sees the outcome of
/// directly -- the backend's OIDC round trip sets the `secchat_session`
/// cookie and 302s back to `/`, reloading the whole app (see
/// `lib/app.dart`'s boot probe, which is what actually notices the new
/// session). The dev form is the opposite: entirely local token synthesis
/// (`dev.<username>.<groups>`) with no password, validated by whoever
/// supplies [onSignIn] via a `GET /me` round trip.
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.onSignIn,
    this.ssoAvailable = false,
    this.ssoError,
  });

  /// Called with the trimmed username and the admin checkbox state.
  /// Returns an error message to display, or `null` on success.
  final Future<String?> Function(String username, bool isAdmin) onSignIn;

  /// Whether the backend reports SSO as configured (`GET /auth/status` ->
  /// `{"sso": true}`). Controls whether the primary "Sign in with SecSSO"
  /// button renders. `false` (the default) is also the safe fallback for a
  /// backend that can't be reached at all -- the dev form always renders
  /// regardless, so the screen is still usable.
  final bool ssoAvailable;

  /// `?auth_error=<reason>` carried back from a just-failed SecSSO round
  /// trip (see `lib/app.dart`). When set, the SecSSO section renders even
  /// if [ssoAvailable] is somehow false, since a non-null error is itself
  /// proof SSO is configured and reachable -- there's no world where this
  /// value is set and SSO *isn't* usable.
  final String? ssoError;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _usernameController = TextEditingController();
  bool _isAdmin = false;
  bool _submitting = false;
  String? _error;

  bool get _showSso => widget.ssoAvailable || widget.ssoError != null;

  @override
  void dispose() {
    _usernameController.dispose();
    super.dispose();
  }

  void _signInWithSso() {
    // A path-absolute target, not a full "<origin>/auth/login" string: the
    // browser resolves a path-absolute navigation against the current
    // origin on its own, which is exactly the backend's origin here (the
    // backend serves this app), so there is nothing to gain by
    // reconstructing that origin by hand -- and doing so via `Uri.base`
    // would blow up outside a real browser (e.g. `Uri.base` under
    // `flutter test`'s VM binding is a `file://` URI, and `Uri.origin`
    // rejects any scheme but http/https).
    redirectBrowserTo('/auth/login');
  }

  Future<void> _submit() async {
    final username = _usernameController.text.trim();
    if (username.isEmpty || _submitting) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    final error = await widget.onSignIn(username, _isAdmin);
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Stack(
        children: [
          const Positioned.fill(child: _BackgroundGlow()),
          SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 380),
                  child: _buildCard(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCard() {
    final showSso = _showSso;
    return Container(
      padding: const EdgeInsets.fromLTRB(34, 38, 34, 30),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.lg),
        boxShadow: const [
          BoxShadow(color: Color(0x80000000), blurRadius: 64, offset: Offset(0, 24)),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          const BrandMark(),
          const SizedBox(height: 10),
          const Text(
            'Secure multi-agent chat, gated by policy.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 13.5),
          ),
          const SizedBox(height: 28),
          if (showSso) ..._buildSsoSection(),
          const _FieldLabel('Username'),
          const SizedBox(height: 7),
          TextField(
            controller: _usernameController,
            autofocus: !showSso,
            style: const TextStyle(color: AppColors.text, fontSize: 14),
            decoration: const InputDecoration(hintText: 'e.g. alice'),
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 16),
          _AdminCheckbox(
            value: _isAdmin,
            onChanged: (value) => setState(() => _isAdmin = value),
          ),
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            height: 44,
            child: ValueListenableBuilder<TextEditingValue>(
              valueListenable: _usernameController,
              builder: (context, value, _) {
                final canSubmit = !_submitting && value.text.trim().isNotEmpty;
                return ElevatedButton(
                  onPressed: canSubmit ? _submit : null,
                  style: AppButtonStyles.primary,
                  child: _submitting
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AppColors.onAccent,
                          ),
                        )
                      : const Text('Sign in'),
                );
              },
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            _ErrorBanner(_error!),
          ],
          const SizedBox(height: 22),
          Container(
            padding: const EdgeInsets.only(top: 18),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: AppColors.border)),
            ),
            child: Text.rich(
              TextSpan(
                style: const TextStyle(
                  color: AppColors.textFaint,
                  fontSize: 12,
                  height: 1.6,
                ),
                children: [
                  const TextSpan(
                    text: 'Dev sign-in only, no password required. Your token '
                        'is generated locally as ',
                  ),
                  TextSpan(
                    text: 'dev.<username>.<groups>',
                    style: AppFonts.mono(fontSize: 11, color: AppColors.textMuted),
                  ),
                  TextSpan(
                    text: showSso
                        ? '. Prefer Sign in with SecSSO above for a real identity.'
                        : '. SecSSO is not configured for this deployment.',
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// The primary SecSSO button, its error banner (if the last attempt
  /// failed), and the divider that demotes the dev form below it to a
  /// clearly-secondary "Developer sign-in" section.
  List<Widget> _buildSsoSection() {
    final ssoError = widget.ssoError;
    return [
      SizedBox(
        width: double.infinity,
        height: 44,
        child: ElevatedButton.icon(
          onPressed: _signInWithSso,
          style: AppButtonStyles.primary,
          icon: const Icon(Icons.shield_outlined, size: 18),
          label: const Text('Sign in with SecSSO'),
        ),
      ),
      if (ssoError != null) ...[
        const SizedBox(height: 12),
        _ErrorBanner(_describeSsoError(ssoError)),
      ],
      const SizedBox(height: 24),
      const _SectionDivider(label: 'Developer sign-in'),
      const SizedBox(height: 20),
    ];
  }
}

/// Turns a short backend-supplied error slug (e.g. `state_mismatch`) into a
/// readable sentence. The backend deliberately keeps this value a safe,
/// generic reason code rather than internal detail (see the SSO contract's
/// "never leak internals" callback note), so there is nothing more specific
/// to surface than a humanized version of the code itself.
String _describeSsoError(String reason) {
  final humanized = reason.replaceAll(RegExp('[_-]+'), ' ').trim();
  return humanized.isEmpty
      ? 'Sign-in with SecSSO failed. Please try again.'
      : 'Sign-in with SecSSO failed: $humanized.';
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.badBg,
        border: Border.all(color: AppColors.badBorder),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Text(
        message,
        style: const TextStyle(color: AppColors.bad, fontSize: 13),
      ),
    );
  }
}

/// A labeled horizontal rule, used to separate the primary SecSSO button
/// from the secondary developer sign-in form beneath it.
class _SectionDivider extends StatelessWidget {
  const _SectionDivider({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Expanded(child: Divider(color: AppColors.border)),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Text(
            label.toUpperCase(),
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.6,
              color: AppColors.textFaint,
            ),
          ),
        ),
        const Expanded(child: Divider(color: AppColors.border)),
      ],
    );
  }
}

class _FieldLabel extends StatelessWidget {
  const _FieldLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text.toUpperCase(),
    style: const TextStyle(
      fontSize: 12.5,
      fontWeight: FontWeight.w600,
      color: AppColors.textMuted,
      letterSpacing: 0.6,
    ),
  );
}

class _AdminCheckbox extends StatelessWidget {
  const _AdminCheckbox({required this.value, required this.onChanged});

  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => onChanged(!value),
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            SizedBox(
              width: 20,
              height: 20,
              child: Checkbox(
                value: value,
                onChanged: (v) => onChanged(v ?? false),
                activeColor: AppColors.accent,
                checkColor: AppColors.onAccent,
                side: const BorderSide(color: AppColors.border),
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
            ),
            const SizedBox(width: 10),
            const Expanded(
              child: Text(
                'Sign in as admin (secchat-admins)',
                style: TextStyle(color: AppColors.textMuted, fontSize: 13.5),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BackgroundGlow extends StatelessWidget {
  const _BackgroundGlow();

  @override
  Widget build(BuildContext context) {
    return const IgnorePointer(
      child: Stack(
        children: [
          Align(
            alignment: Alignment(-0.64, -0.6),
            child: _Glow(color: Color(0x14AEBB78)),
          ),
          Align(
            alignment: Alignment(0.64, 0.56),
            child: _Glow(color: Color(0x0DAEBB78)),
          ),
        ],
      ),
    );
  }
}

class _Glow extends StatelessWidget {
  const _Glow({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 480,
      height: 480,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(colors: [color, color.withValues(alpha: 0)]),
      ),
    );
  }
}
