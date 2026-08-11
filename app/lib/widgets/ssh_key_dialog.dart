import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../theme.dart';

/// Profile dialog for a user's git SSH identity (`/me/ssh-key`). SecChat generates
/// an ed25519 keypair, holds the private half encrypted, and injects it into the
/// user's coding-agent runtimes (the online pool pod / their desktop daemon) so
/// `git` authenticates as them. This dialog manages that key: generate/rotate,
/// copy the public key to add to the enclave git host, and revoke. The private
/// key is never shown — the server never returns it.
Future<void> showSshKeyDialog(BuildContext context, {required ApiClient api}) {
  return showDialog<void>(
    context: context,
    barrierColor: AppColors.overlay,
    builder: (_) => _SshKeyDialog(api: api),
  );
}

class _SshKeyDialog extends StatefulWidget {
  const _SshKeyDialog({required this.api});

  final ApiClient api;

  @override
  State<_SshKeyDialog> createState() => _SshKeyDialogState();
}

enum _Phase { loading, notEnabled, ready }

class _SshKeyDialogState extends State<_SshKeyDialog> {
  _Phase _phase = _Phase.loading;
  SshKeyInfo? _key; // null in the "ready" phase ⇒ no key yet
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final key = await widget.api.getSshKey();
      if (!mounted) return;
      setState(() {
        _key = key;
        _phase = _Phase.ready;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      // 503 ⇒ the deployment hasn't configured a master key, so the feature is off.
      setState(() => _phase = e.statusCode == 503 ? _Phase.notEnabled : _Phase.ready);
    } catch (_) {
      if (!mounted) return;
      setState(() => _phase = _Phase.ready);
    }
  }

  Future<void> _generate({required bool regenerate}) async {
    if (regenerate) {
      final ok = await _confirmRegenerate();
      if (ok != true) return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final key = await widget.api.generateSshKey();
      if (!mounted) return;
      setState(() => _key = key);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _messageFor(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool?> _confirmRegenerate() {
    return showDialog<bool>(
      context: context,
      barrierColor: AppColors.overlay,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Regenerate SSH key?', style: TextStyle(color: AppColors.text, fontSize: 16)),
        content: const Text(
          'This replaces your current key. The old key stops working everywhere you added it — '
          'remove it from your git host and add the new one.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogCtx).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AppColors.bad),
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: const Text('Regenerate'),
          ),
        ],
      ),
    );
  }

  Future<void> _delete() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.deleteSshKey();
      if (!mounted) return;
      setState(() => _key = null);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = _messageFor(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _copyPublicKey() async {
    final key = _key;
    if (key == null) return;
    // A PUBLIC key is not sensitive — a plain copy (no marking guard needed).
    await Clipboard.setData(ClipboardData(text: key.publicKey));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Public key copied'), duration: Duration(seconds: 2)),
    );
  }

  String _messageFor(Object e) => e is ApiException ? e.message : 'Something went wrong';

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      title: Row(
        children: const [
          Icon(Icons.vpn_key, size: 18, color: AppColors.accent),
          SizedBox(width: 8),
          Text('Git SSH key', style: TextStyle(color: AppColors.text, fontSize: 16)),
        ],
      ),
      content: SizedBox(width: 460, child: _body()),
      actions: _actions(),
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.loading:
        return const SizedBox(height: 80, child: Center(child: CircularProgressIndicator(strokeWidth: 2)));
      case _Phase.notEnabled:
        return const Text(
          'Git SSH keys are not enabled on this deployment. An operator sets SECCHAT_SECRET_KEY to '
          'turn on server-managed keys for the agent pool.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13),
        );
      case _Phase.ready:
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'A key SecChat generates and injects into your coding agents (the online pool and your '
              'desktop) so git authenticates as you. Add the public key to your git host once.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
            ),
            const SizedBox(height: 14),
            if (_key == null)
              const Text('No key yet.', style: TextStyle(color: AppColors.textFaint, fontSize: 13))
            else
              _keyView(_key!),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
            ],
          ],
        );
    }
  }

  Widget _keyView(SshKeyInfo key) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _fieldLabel('Public key'),
        const SizedBox(height: 4),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: AppColors.surfaceAlt,
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(6),
          ),
          child: SelectableText(
            key.publicKey,
            style: AppFonts.mono(fontSize: 11.5, color: AppColors.text),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(
              child: Text(
                key.fingerprint,
                style: AppFonts.mono(fontSize: 10.5, color: AppColors.textFaint),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            TextButton.icon(
              onPressed: _busy ? null : _copyPublicKey,
              icon: const Icon(Icons.copy, size: 15),
              label: const Text('Copy'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _fieldLabel(String text) => Text(
        text.toUpperCase(),
        style: AppFonts.mono(fontSize: 10, color: AppColors.textFaint),
      );

  List<Widget> _actions() {
    if (_phase != _Phase.ready) {
      return [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close'))];
    }
    final hasKey = _key != null;
    return [
      if (hasKey)
        TextButton(
          onPressed: _busy ? null : _delete,
          style: TextButton.styleFrom(foregroundColor: AppColors.bad),
          child: const Text('Revoke'),
        ),
      TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
      FilledButton(
        onPressed: _busy ? null : () => _generate(regenerate: hasKey),
        child: Text(hasKey ? 'Regenerate' : 'Generate'),
      ),
    ];
  }
}
