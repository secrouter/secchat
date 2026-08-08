import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/brand_mark.dart';

/// Dev sign-in: username + an "admin" checkbox, no password. The actual
/// token synthesis (`dev.<username>.<groups>`) and the `GET /me` round trip
/// that validates it live in whoever supplies [onSignIn] (see
/// `lib/app.dart`) -- this screen only owns the form.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onSignIn});

  /// Called with the trimmed username and the admin checkbox state.
  /// Returns an error message to display, or `null` on success.
  final Future<String?> Function(String username, bool isAdmin) onSignIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _usernameController = TextEditingController();
  bool _isAdmin = false;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _usernameController.dispose();
    super.dispose();
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
          const _FieldLabel('Username'),
          const SizedBox(height: 7),
          TextField(
            controller: _usernameController,
            autofocus: true,
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
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: AppColors.badBg,
                border: Border.all(color: AppColors.badBorder),
                borderRadius: BorderRadius.circular(AppRadius.sm),
              ),
              child: Text(
                _error!,
                style: const TextStyle(color: AppColors.bad, fontSize: 13),
              ),
            ),
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
                  const TextSpan(
                    text: '. Real SecSSO login arrives in a later milestone.',
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
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
