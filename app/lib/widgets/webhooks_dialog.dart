import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import 'outbound_webhooks_dialog.dart';

/// Opens the per-channel webhook manager for [channel] as a two-tab dialog: **Incoming** (external
/// systems post into the channel via `/hooks/<token>`) and **Outgoing** (SecChat POSTs to an
/// external URL on events). Minting/revoking either needs the `webhook.create` capability
/// server-side; denials surface inline.
Future<void> showWebhooksDialog(BuildContext context, {required ApiClient api, required Channel channel}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _WebhooksTabsDialog(
      incoming: InboundWebhooksPanel(api: api, channel: channel),
      outgoing: OutboundWebhooksPanel(api: api, channel: channel),
    ),
  );
}

/// Opens the GLOBAL webhook manager (top-bar menu / mobile drawer): the same two tabs, but each
/// aggregates across every channel the caller is a member of.
Future<void> showGlobalWebhooksDialog(
  BuildContext context, {
  required ApiClient api,
  required List<Channel> channels,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _WebhooksTabsDialog(
      incoming: GlobalInboundWebhooksPanel(api: api, channels: channels),
      outgoing: GlobalOutboundWebhooksPanel(api: api, channels: channels),
    ),
  );
}

/// The shared dialog chrome: a titled header + an Incoming/Outgoing [TabBar] over the two panels.
class _WebhooksTabsDialog extends StatelessWidget {
  const _WebhooksTabsDialog({required this.incoming, required this.outgoing});

  final Widget incoming;
  final Widget outgoing;

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: AppColors.surface,
      insetPadding: const EdgeInsets.all(16),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 600, maxHeight: 640),
        child: DefaultTabController(
          length: 2,
          child: Column(
            mainAxisSize: MainAxisSize.max,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 18, 14, 4),
                child: Row(
                  children: [
                    const Icon(Icons.webhook, size: 18, color: AppColors.accent),
                    const SizedBox(width: 10),
                    const Expanded(
                      child: Text('Webhooks', style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w600)),
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
              const TabBar(
                labelColor: AppColors.accent,
                unselectedLabelColor: AppColors.textMuted,
                indicatorColor: AppColors.accent,
                labelStyle: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                tabs: [Tab(text: 'Incoming'), Tab(text: 'Outgoing')],
              ),
              Expanded(child: TabBarView(children: [incoming, outgoing])),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Incoming (inbound) panels ────────────────────────────────────────────────────────────────

/// Per-channel inbound-webhook manager body: list existing webhooks, mint one, copy its post URL,
/// and revoke.
class InboundWebhooksPanel extends StatefulWidget {
  const InboundWebhooksPanel({super.key, required this.api, required this.channel});

  final ApiClient api;
  final Channel channel;

  @override
  State<InboundWebhooksPanel> createState() => _InboundWebhooksPanelState();
}

class _InboundWebhooksPanelState extends State<InboundWebhooksPanel> {
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
    final ok = await _confirmRevoke(context, 'The post URL stops working immediately.');
    if (!ok) return;
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

  @override
  Widget build(BuildContext context) {
    final webhooks = _webhooks;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(22, 12, 22, 0),
          child: Text(
            'An external system POSTs {"text": "…"} to a webhook URL to post into this channel as a '
            'bot. Treat each URL like a password.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
          ),
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
            child: Text(_error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
          ),
        const SizedBox(height: 12),
        Expanded(
          child: webhooks == null
              ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
              : webhooks.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 30, horizontal: 22),
                  child: Align(alignment: Alignment.topLeft, child: Text('No webhooks yet.', style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic))),
                )
              : ListView.separated(
                  padding: const EdgeInsets.symmetric(horizontal: 22),
                  itemCount: webhooks.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 10),
                  itemBuilder: (_, i) => _WebhookTile(webhook: webhooks[i], origin: widget.api.origin, onRevoke: _busy ? null : () => _revoke(webhooks[i])),
                ),
        ),
        _FooterButton(label: 'New webhook', busy: _busy, onPressed: _create),
      ],
    );
  }
}

/// Global inbound manager body — every inbound webhook across the caller's channels, grouped by
/// channel, with a channel-picker create row.
class GlobalInboundWebhooksPanel extends StatefulWidget {
  const GlobalInboundWebhooksPanel({super.key, required this.api, required this.channels});

  final ApiClient api;
  final List<Channel> channels;

  @override
  State<GlobalInboundWebhooksPanel> createState() => _GlobalInboundWebhooksPanelState();
}

class _GlobalInboundWebhooksPanelState extends State<GlobalInboundWebhooksPanel> {
  List<Webhook>? _webhooks;
  String? _error;
  bool _busy = false;
  String? _createChannelId;

  List<Channel> get _targets => widget.channels.where((c) => c.kind != ChannelKind.dm).toList(growable: false);

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
    final ok = await _confirmRevoke(context, 'The post URL for "${wh.channelName ?? wh.channelId}" stops working immediately.');
    if (!ok) return;
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

  @override
  Widget build(BuildContext context) {
    final webhooks = _webhooks;
    final byChannel = <String, List<Webhook>>{};
    for (final w in webhooks ?? const <Webhook>[]) {
      byChannel.putIfAbsent(w.channelName ?? w.channelId, () => []).add(w);
    }
    final targets = _targets;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
            child: Text(_error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
          ),
        const SizedBox(height: 12),
        Expanded(
          child: webhooks == null
              ? const Center(child: CircularProgressIndicator(color: AppColors.accent))
              : byChannel.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 30, horizontal: 22),
                  child: Align(alignment: Alignment.topLeft, child: Text('No webhooks yet.', style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic))),
                )
              : ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 22),
                  children: [
                    for (final entry in byChannel.entries) ...[
                      Padding(
                        padding: const EdgeInsets.only(top: 6, bottom: 8),
                        child: Text(entry.key, style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5, fontWeight: FontWeight.w700)),
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
          child: targets.isEmpty
              ? const Text('No channels to add a webhook to.', style: TextStyle(color: AppColors.textFaint, fontSize: 12.5))
              : _ChannelPicker(
                  channels: targets,
                  value: _createChannelId,
                  busy: _busy,
                  onChanged: _busy ? null : (id) => setState(() => _createChannelId = id),
                  onCreate: _create,
                ),
        ),
      ],
    );
  }
}

Future<bool> _confirmRevoke(BuildContext context, String detail) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      backgroundColor: AppColors.surface,
      title: const Text('Revoke webhook?', style: TextStyle(color: AppColors.text, fontSize: 16)),
      content: Text('$detail Any external system using it will start getting 401s.', style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted))),
        TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Revoke', style: TextStyle(color: AppColors.bad))),
      ],
    ),
  );
  return confirmed == true;
}

String _msg(Object error) => error is ApiException ? error.message : 'Something went wrong.';

class _FooterButton extends StatelessWidget {
  const _FooterButton({required this.label, required this.busy, required this.onPressed});

  final String label;
  final bool busy;
  final Future<void> Function() onPressed;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 20),
      child: Row(
        children: [
          ElevatedButton.icon(
            onPressed: busy ? null : onPressed,
            icon: const Icon(Icons.add, size: 16),
            label: Text(label),
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.accent,
              foregroundColor: AppColors.onAccent,
              elevation: 0,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            ),
          ),
          const Spacer(),
          if (busy) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent)),
        ],
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
              Expanded(child: Text(url, maxLines: 1, overflow: TextOverflow.ellipsis, style: AppFonts.mono(fontSize: 12, color: AppColors.text))),
              const SizedBox(width: 8),
              IconButton(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: url));
                  if (context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Webhook URL copied'), duration: Duration(seconds: 2)));
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

/// The channel dropdown + create button for the global inbound manager's "create webhook in…" row.
class _ChannelPicker extends StatelessWidget {
  const _ChannelPicker({required this.channels, required this.value, required this.busy, required this.onChanged, required this.onCreate});

  final List<Channel> channels;
  final String? value;
  final bool busy;
  final ValueChanged<String?>? onChanged;
  final Future<void> Function() onCreate;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Container(
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
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                icon: const Icon(Icons.arrow_drop_down, color: AppColors.textMuted),
                onChanged: onChanged,
                items: [
                  for (final c in channels) DropdownMenuItem(value: c.id, child: Text(c.name.isEmpty ? c.id : c.name, overflow: TextOverflow.ellipsis)),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        ElevatedButton.icon(
          onPressed: busy ? null : onCreate,
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
    );
  }
}
