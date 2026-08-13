import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../formatting.dart';
import '../models.dart';
import '../theme.dart';

/// Opens the inbound-webhook manager for [channel]: list existing webhooks, mint a new one, copy
/// its post URL, and revoke. An inbound webhook lets an external system POST
/// `{ "text": "..." }` to `<origin>/hooks/<token>` to drop a message into the channel as a bot
/// author. Minting/revoking needs the `webhook.create` capability server-side (the backend
/// enforces it; a denial surfaces as an inline error here).
Future<void> showWebhooksDialog(BuildContext context, {required ApiClient api, required Channel channel}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _WebhooksDialog(api: api, channel: channel),
  );
}

class _WebhooksDialog extends StatefulWidget {
  const _WebhooksDialog({required this.api, required this.channel});

  final ApiClient api;
  final Channel channel;

  @override
  State<_WebhooksDialog> createState() => _WebhooksDialogState();
}

class _WebhooksDialogState extends State<_WebhooksDialog> {
  List<Webhook>? _webhooks;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final list = await widget.api.listWebhooks(widget.channel.id);
      if (!mounted) return;
      setState(() {
        _webhooks = list;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _msg(error);
        _busy = false;
        _webhooks ??= const [];
      });
    }
  }

  Future<void> _create() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final wh = await widget.api.createWebhook(widget.channel.id);
      if (!mounted) return;
      setState(() {
        _webhooks = [wh, ...?_webhooks];
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _msg(error);
        _busy = false;
      });
    }
  }

  Future<void> _revoke(Webhook wh) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Revoke webhook?', style: TextStyle(color: AppColors.text, fontSize: 16)),
        content: const Text(
          'The post URL stops working immediately. Any external system using it will start getting 401s.',
          style: TextStyle(color: AppColors.textMuted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Revoke', style: TextStyle(color: AppColors.bad)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.deleteWebhook(widget.channel.id, wh.id);
      if (!mounted) return;
      setState(() {
        _webhooks = [...?_webhooks]..removeWhere((w) => w.id == wh.id);
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _msg(error);
        _busy = false;
      });
    }
  }

  String _msg(Object error) => error is ApiException ? error.message : 'Something went wrong.';

  @override
  Widget build(BuildContext context) {
    final webhooks = _webhooks;
    return Dialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560, maxHeight: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 20, 14, 12),
              child: Row(
                children: [
                  const Icon(Icons.webhook, size: 18, color: AppColors.accent),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Inbound webhooks',
                      style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close, size: 18),
                    color: AppColors.textMuted,
                    tooltip: 'Close',
                  ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 22),
              child: Text(
                'An external system POSTs {"text": "…"} to a webhook URL to post into this channel as a bot. '
                'Treat each URL like a password.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
                child: Text(_error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
              ),
            const SizedBox(height: 12),
            Flexible(
              child: webhooks == null
                  ? const Center(child: Padding(padding: EdgeInsets.all(28), child: CircularProgressIndicator(color: AppColors.accent)))
                  : webhooks.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 30, horizontal: 22),
                      child: Text('No webhooks yet.', style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic)),
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.symmetric(horizontal: 22),
                      shrinkWrap: true,
                      itemCount: webhooks.length,
                      separatorBuilder: (_, _) => const SizedBox(height: 10),
                      itemBuilder: (_, i) => _WebhookTile(
                        webhook: webhooks[i],
                        origin: widget.api.origin,
                        onRevoke: _busy ? null : () => _revoke(webhooks[i]),
                      ),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 14, 22, 20),
              child: Row(
                children: [
                  ElevatedButton.icon(
                    onPressed: _busy ? null : _create,
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('New webhook'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.accent,
                      foregroundColor: AppColors.onAccent,
                      elevation: 0,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    ),
                  ),
                  const Spacer(),
                  if (_busy) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _WebhookTile extends StatelessWidget {
  const _WebhookTile({required this.webhook, required this.origin, required this.onRevoke});

  final Webhook webhook;
  final Uri origin;
  final VoidCallback? onRevoke;

  @override
  Widget build(BuildContext context) {
    final url = webhook.postUrl(origin).toString();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceAlt,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  url,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppFonts.mono(fontSize: 12, color: AppColors.text),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: url));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Webhook URL copied'), duration: Duration(seconds: 2)),
                    );
                  }
                },
                icon: const Icon(Icons.copy, size: 16),
                color: AppColors.textMuted,
                tooltip: 'Copy URL',
                visualDensity: VisualDensity.compact,
              ),
              IconButton(
                onPressed: onRevoke,
                icon: const Icon(Icons.delete_outline, size: 16),
                color: AppColors.bad,
                tooltip: 'Revoke',
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            'Created by ${webhook.createdBy}${webhook.createdAt.isEmpty ? '' : ' · ${shortId(webhook.id)}'}',
            style: const TextStyle(color: AppColors.textFaint, fontSize: 11),
          ),
        ],
      ),
    );
  }
}

/// Opens the GLOBAL inbound-webhook manager (from the top-bar menu): every webhook across the
/// channels the caller is a member of (`GET /webhooks`), grouped by channel, with copy + revoke,
/// plus a create row that mints one into a chosen channel. Same `webhook.create` capability as the
/// per-channel manager — a denial surfaces inline. [channels] are the create targets (non-DM).
Future<void> showGlobalWebhooksDialog(
  BuildContext context, {
  required ApiClient api,
  required List<Channel> channels,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _GlobalWebhooksDialog(api: api, channels: channels),
  );
}

class _GlobalWebhooksDialog extends StatefulWidget {
  const _GlobalWebhooksDialog({required this.api, required this.channels});

  final ApiClient api;
  final List<Channel> channels;

  @override
  State<_GlobalWebhooksDialog> createState() => _GlobalWebhooksDialogState();
}

class _GlobalWebhooksDialogState extends State<_GlobalWebhooksDialog> {
  List<Webhook>? _webhooks;
  String? _error;
  bool _busy = false;
  String? _createChannelId;

  List<Channel> get _targets =>
      widget.channels.where((c) => c.kind != ChannelKind.dm).toList(growable: false);

  @override
  void initState() {
    super.initState();
    final targets = _targets;
    _createChannelId = targets.isEmpty ? null : targets.first.id;
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final list = await widget.api.listAllWebhooks();
      if (!mounted) return;
      setState(() {
        _webhooks = list;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _msg(error);
        _busy = false;
        _webhooks ??= const [];
      });
    }
  }

  Future<void> _create() async {
    final channelId = _createChannelId;
    if (channelId == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.createWebhook(channelId);
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _msg(error);
        _busy = false;
      });
    }
  }

  Future<void> _revoke(Webhook wh) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Revoke webhook?', style: TextStyle(color: AppColors.text, fontSize: 16)),
        content: Text(
          'The post URL for "${wh.channelName ?? wh.channelId}" stops working immediately.',
          style: const TextStyle(color: AppColors.textMuted, fontSize: 13),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted)),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Revoke', style: TextStyle(color: AppColors.bad)),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.deleteWebhook(wh.channelId, wh.id);
      await _load();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = _msg(error);
        _busy = false;
      });
    }
  }

  String _msg(Object error) => error is ApiException ? error.message : 'Something went wrong.';

  @override
  Widget build(BuildContext context) {
    final webhooks = _webhooks;
    // Group by channel for display, preserving the server's order.
    final byChannel = <String, List<Webhook>>{};
    for (final w in webhooks ?? const <Webhook>[]) {
      byChannel.putIfAbsent(w.channelName ?? w.channelId, () => []).add(w);
    }
    final targets = _targets;
    return Dialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 600, maxHeight: 620),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 20, 14, 8),
              child: Row(
                children: [
                  const Icon(Icons.webhook, size: 18, color: AppColors.accent),
                  const SizedBox(width: 10),
                  const Expanded(
                    child: Text(
                      'Webhooks',
                      style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close, size: 18),
                    color: AppColors.textMuted,
                    tooltip: 'Close',
                  ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 22),
              child: Text(
                'Every inbound webhook across your channels. An external system POSTs {"text": "…"} '
                'to a URL to post as a bot — treat each URL like a password.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
                child: Text(_error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
              ),
            const SizedBox(height: 12),
            Flexible(
              child: webhooks == null
                  ? const Center(child: Padding(padding: EdgeInsets.all(28), child: CircularProgressIndicator(color: AppColors.accent)))
                  : byChannel.isEmpty
                  ? const Padding(
                      padding: EdgeInsets.symmetric(vertical: 30, horizontal: 22),
                      child: Text('No webhooks yet.', style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic)),
                    )
                  : ListView(
                      padding: const EdgeInsets.symmetric(horizontal: 22),
                      shrinkWrap: true,
                      children: [
                        for (final entry in byChannel.entries) ...[
                          Padding(
                            padding: const EdgeInsets.only(top: 6, bottom: 8),
                            child: Text(
                              entry.key,
                              style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5, fontWeight: FontWeight.w700),
                            ),
                          ),
                          for (final w in entry.value) ...[
                            _WebhookTile(webhook: w, origin: widget.api.origin, onRevoke: _busy ? null : () => _revoke(w)),
                            const SizedBox(height: 10),
                          ],
                        ],
                      ],
                    ),
            ),
            const Divider(height: 1, color: AppColors.border),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 14, 22, 20),
              child: Row(
                children: [
                  Expanded(
                    child: targets.isEmpty
                        ? const Text('No channels to add a webhook to.', style: TextStyle(color: AppColors.textFaint, fontSize: 12.5))
                        : _ChannelPicker(
                            channels: targets,
                            value: _createChannelId,
                            onChanged: _busy ? null : (id) => setState(() => _createChannelId = id),
                          ),
                  ),
                  const SizedBox(width: 12),
                  ElevatedButton.icon(
                    onPressed: (_busy || targets.isEmpty) ? null : _create,
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('New'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.accent,
                      foregroundColor: AppColors.onAccent,
                      elevation: 0,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The channel dropdown for the global manager's "create webhook in…" row.
class _ChannelPicker extends StatelessWidget {
  const _ChannelPicker({required this.channels, required this.value, required this.onChanged});

  final List<Channel> channels;
  final String? value;
  final ValueChanged<String?>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceAlt,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: value,
          isExpanded: true,
          isDense: true,
          dropdownColor: AppColors.surfaceAlt,
          borderRadius: BorderRadius.circular(AppRadius.sm),
          style: const TextStyle(color: AppColors.text, fontSize: 13),
          icon: const Icon(Icons.arrow_drop_down, color: AppColors.textMuted),
          onChanged: onChanged,
          items: [
            for (final c in channels)
              DropdownMenuItem(
                value: c.id,
                child: Text(c.name.isEmpty ? c.id : c.name, overflow: TextOverflow.ellipsis),
              ),
          ],
        ),
      ),
    );
  }
}
