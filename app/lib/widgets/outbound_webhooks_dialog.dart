import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../models.dart';
import '../theme.dart';

/// Per-channel OUTBOUND webhook manager body (embedded as the "Outgoing" tab of the webhooks
/// dialog). Lists a channel's subscriptions, mints new ones (URL + event selection + content
/// toggle), sends test deliveries, and revokes. SecChat POSTs a signed payload to each URL when a
/// subscribed event fires; the backend gates create/revoke on the `webhook.create` capability.
class OutboundWebhooksPanel extends StatefulWidget {
  const OutboundWebhooksPanel({super.key, required this.api, required this.channel});

  final ApiClient api;
  final Channel channel;

  @override
  State<OutboundWebhooksPanel> createState() => _OutboundWebhooksPanelState();
}

class _OutboundWebhooksPanelState extends State<OutboundWebhooksPanel> {
  List<OutboundWebhook>? _hooks;
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
      final list = await widget.api.listOutboundWebhooks(widget.channel.id);
      if (!mounted) return;
      setState(() {
        _hooks = list;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = outboundErrorMessage(error);
        _busy = false;
        _hooks ??= const [];
      });
    }
  }

  Future<void> _create() async {
    final created = await showOutboundCreateDialog(context, api: widget.api, channelId: widget.channel.id);
    if (created != null) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return OutboundListBody(
      api: widget.api,
      hooks: _hooks,
      error: _error,
      busy: _busy,
      grouped: false,
      onCreate: _create,
      onChanged: _load,
    );
  }
}

/// Global OUTBOUND manager body — every outbound webhook across the caller's channels, grouped by
/// channel, with a channel-picker create row. Embedded as the "Outgoing" tab of the global dialog.
class GlobalOutboundWebhooksPanel extends StatefulWidget {
  const GlobalOutboundWebhooksPanel({super.key, required this.api, required this.channels});

  final ApiClient api;
  final List<Channel> channels;

  @override
  State<GlobalOutboundWebhooksPanel> createState() => _GlobalOutboundWebhooksPanelState();
}

class _GlobalOutboundWebhooksPanelState extends State<GlobalOutboundWebhooksPanel> {
  List<OutboundWebhook>? _hooks;
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
      final list = await widget.api.listAllOutboundWebhooks();
      if (!mounted) return;
      setState(() {
        _hooks = list;
        _busy = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = outboundErrorMessage(error);
        _busy = false;
        _hooks ??= const [];
      });
    }
  }

  Future<void> _create() async {
    final channelId = _createChannelId;
    if (channelId == null) return;
    final created = await showOutboundCreateDialog(context, api: widget.api, channelId: channelId);
    if (created != null) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return OutboundListBody(
      api: widget.api,
      hooks: _hooks,
      error: _error,
      busy: _busy,
      grouped: true,
      onChanged: _load,
      createPicker: _ChannelPickerRow(
        channels: _targets,
        value: _createChannelId,
        onChanged: _busy ? null : (id) => setState(() => _createChannelId = id),
        onCreate: (_targets.isEmpty || _busy) ? null : _create,
      ),
    );
  }
}

/// Shared list body for both outbound panels — the loading/empty/error/list rendering plus the
/// create affordance (a button for per-channel, a channel-picker row for global).
class OutboundListBody extends StatelessWidget {
  const OutboundListBody({
    super.key,
    required this.api,
    required this.hooks,
    required this.error,
    required this.busy,
    required this.grouped,
    required this.onChanged,
    this.onCreate,
    this.createPicker,
  });

  final ApiClient api;
  final List<OutboundWebhook>? hooks;
  final String? error;
  final bool busy;

  /// Group tiles under channel-name headers (the global view) vs a flat list (per-channel).
  final bool grouped;

  /// Reload callback after a test/revoke mutates state.
  final Future<void> Function() onChanged;

  /// Per-channel create button action (null in the global view, which uses [createPicker]).
  final Future<void> Function()? onCreate;

  /// Global create row (channel picker + button); null in the per-channel view.
  final Widget? createPicker;

  @override
  Widget build(BuildContext context) {
    final list = hooks;
    final byChannel = <String, List<OutboundWebhook>>{};
    for (final w in list ?? const <OutboundWebhook>[]) {
      byChannel.putIfAbsent(w.channelName ?? w.channelId, () => []).add(w);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(22, 12, 22, 0),
          child: Text(
            'SecChat POSTs a signed JSON payload to each URL when a subscribed event fires. Message '
            'content is sent only when "include content" is on.',
            style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
          ),
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 12, 22, 0),
            child: Text(error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
          ),
        const SizedBox(height: 12),
        Flexible(
          child: list == null
              ? const Center(child: Padding(padding: EdgeInsets.all(28), child: CircularProgressIndicator(color: AppColors.accent)))
              : byChannel.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 30, horizontal: 22),
                  child: Text('No outbound webhooks yet.', style: TextStyle(color: AppColors.textFaint, fontStyle: FontStyle.italic)),
                )
              : ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 22),
                  shrinkWrap: true,
                  children: [
                    for (final entry in byChannel.entries) ...[
                      if (grouped)
                        Padding(
                          padding: const EdgeInsets.only(top: 6, bottom: 8),
                          child: Text(entry.key, style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5, fontWeight: FontWeight.w700)),
                        ),
                      for (final w in entry.value) ...[
                        _OutboundTile(api: api, hook: w, busy: busy, onChanged: onChanged),
                        const SizedBox(height: 10),
                      ],
                    ],
                  ],
                ),
        ),
        const Divider(height: 1, color: AppColors.border),
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 14, 22, 20),
          child: createPicker ??
              Row(
                children: [
                  ElevatedButton.icon(
                    onPressed: busy ? null : onCreate,
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('New outbound webhook'),
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
        ),
      ],
    );
  }
}

class _OutboundTile extends StatefulWidget {
  const _OutboundTile({required this.api, required this.hook, required this.busy, required this.onChanged});

  final ApiClient api;
  final OutboundWebhook hook;
  final bool busy;
  final Future<void> Function() onChanged;

  @override
  State<_OutboundTile> createState() => _OutboundTileState();
}

class _OutboundTileState extends State<_OutboundTile> {
  bool _testing = false;

  Future<void> _test() async {
    setState(() => _testing = true);
    OutboundTestResult? result;
    try {
      result = await widget.api.testOutboundWebhook(widget.hook.channelId, widget.hook.id);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Test failed: ${outboundErrorMessage(error)}')));
      }
    }
    if (!mounted) return;
    setState(() => _testing = false);
    if (result != null) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(result.ok ? 'Test delivered (HTTP ${result.status})' : 'Test got HTTP ${result.status}${result.error == null ? '' : ' — ${result.error}'}')),
      );
      await widget.onChanged(); // refresh last-delivery status
    }
  }

  Future<void> _revoke() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text('Revoke outbound webhook?', style: TextStyle(color: AppColors.text, fontSize: 16)),
        content: Text('SecChat will stop POSTing to ${widget.hook.url}.', style: const TextStyle(color: AppColors.textMuted, fontSize: 13)),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted))),
          TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Revoke', style: TextStyle(color: AppColors.bad))),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await widget.api.deleteOutboundWebhook(widget.hook.channelId, widget.hook.id);
      await widget.onChanged();
    } catch (error) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(outboundErrorMessage(error))));
    }
  }

  @override
  Widget build(BuildContext context) {
    final h = widget.hook;
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
                child: Text(h.url, maxLines: 1, overflow: TextOverflow.ellipsis, style: AppFonts.mono(fontSize: 12, color: AppColors.text)),
              ),
              const SizedBox(width: 8),
              if (_testing)
                const Padding(
                  padding: EdgeInsets.all(8),
                  child: SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent)),
                )
              else
                IconButton(
                  onPressed: widget.busy ? null : _test,
                  icon: const Icon(Icons.send, size: 15),
                  color: AppColors.textMuted,
                  tooltip: 'Send test delivery',
                  visualDensity: VisualDensity.compact,
                ),
              IconButton(
                onPressed: () async {
                  await Clipboard.setData(ClipboardData(text: h.secret));
                  if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Signing secret copied')));
                },
                icon: const Icon(Icons.key, size: 15),
                color: AppColors.textMuted,
                tooltip: 'Copy signing secret',
                visualDensity: VisualDensity.compact,
              ),
              IconButton(
                onPressed: widget.busy ? null : _revoke,
                icon: const Icon(Icons.delete_outline, size: 16),
                color: AppColors.bad,
                tooltip: 'Revoke',
                visualDensity: VisualDensity.compact,
              ),
            ],
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              for (final e in h.events) _chip(e, AppColors.accent),
              if (h.includeContent) _chip('content', AppColors.warn),
              _statusChip(h),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(String label, Color color) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: color.withValues(alpha: 0.4)),
    ),
    child: Text(label, style: TextStyle(color: color, fontSize: 10.5, fontWeight: FontWeight.w600)),
  );

  Widget _statusChip(OutboundWebhook h) {
    if (h.lastStatus == null) {
      return Text('never delivered', style: TextStyle(color: AppColors.textFaint, fontSize: 10.5));
    }
    final ok = h.lastStatus! >= 200 && h.lastStatus! < 400;
    final color = ok ? AppColors.ok : AppColors.bad;
    final label = h.lastStatus == 0 ? 'last: network error' : 'last: HTTP ${h.lastStatus}';
    return _chip(label, color);
  }
}

/// The create form (URL + event checkboxes + content toggle). Mints the webhook on submit and pops
/// with it (null on cancel). Shared by both outbound panels.
Future<OutboundWebhook?> showOutboundCreateDialog(
  BuildContext context, {
  required ApiClient api,
  required String channelId,
}) {
  return showDialog<OutboundWebhook>(
    context: context,
    builder: (_) => _OutboundCreateDialog(api: api, channelId: channelId),
  );
}

class _OutboundCreateDialog extends StatefulWidget {
  const _OutboundCreateDialog({required this.api, required this.channelId});

  final ApiClient api;
  final String channelId;

  @override
  State<_OutboundCreateDialog> createState() => _OutboundCreateDialogState();
}

class _OutboundCreateDialogState extends State<_OutboundCreateDialog> {
  final _url = TextEditingController();
  final Set<String> _events = {'message.created'};
  bool _includeContent = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final url = _url.text.trim();
    if (url.isEmpty || _events.isEmpty) {
      setState(() => _error = 'A URL and at least one event are required.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final wh = await widget.api.createOutboundWebhook(
        widget.channelId,
        url: url,
        events: _events.toList(),
        includeContent: _includeContent,
      );
      if (mounted) Navigator.of(context).pop(wh);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = outboundErrorMessage(error);
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      title: const Text('New outbound webhook', style: TextStyle(color: AppColors.text, fontSize: 16)),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _url,
              autofocus: true,
              style: const TextStyle(color: AppColors.text, fontSize: 13.5),
              decoration: const InputDecoration(
                hintText: 'https://receiver.example/webhook',
                hintStyle: TextStyle(color: AppColors.textFaint),
                labelText: 'Destination URL',
                labelStyle: TextStyle(color: AppColors.textMuted),
              ),
            ),
            const SizedBox(height: 14),
            const Align(alignment: Alignment.centerLeft, child: Text('Events', style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, fontWeight: FontWeight.w600))),
            for (final e in kOutboundEvents)
              CheckboxListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                activeColor: AppColors.accent,
                title: Text(e, style: const TextStyle(color: AppColors.text, fontSize: 13)),
                value: _events.contains(e),
                onChanged: _busy ? null : (v) => setState(() => v == true ? _events.add(e) : _events.remove(e)),
              ),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              activeThumbColor: AppColors.warn,
              title: const Text('Include message content', style: TextStyle(color: AppColors.text, fontSize: 13)),
              subtitle: const Text('Egresses content, not just metadata', style: TextStyle(color: AppColors.textFaint, fontSize: 11)),
              value: _includeContent,
              onChanged: _busy ? null : (v) => setState(() => _includeContent = v),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_error!, style: const TextStyle(color: AppColors.bad, fontSize: 12.5)),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('Cancel', style: TextStyle(color: AppColors.textMuted))),
        ElevatedButton(
          onPressed: _busy ? null : _submit,
          style: ElevatedButton.styleFrom(backgroundColor: AppColors.accent, foregroundColor: AppColors.onAccent, elevation: 0),
          child: _busy
              ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.onAccent))
              : const Text('Create'),
        ),
      ],
    );
  }
}

/// The channel-picker + create button row for the global outbound view.
class _ChannelPickerRow extends StatelessWidget {
  const _ChannelPickerRow({required this.channels, required this.value, required this.onChanged, required this.onCreate});

  final List<Channel> channels;
  final String? value;
  final ValueChanged<String?>? onChanged;
  final Future<void> Function()? onCreate;

  @override
  Widget build(BuildContext context) {
    if (channels.isEmpty) {
      return const Text('No channels to add a webhook to.', style: TextStyle(color: AppColors.textFaint, fontSize: 12.5));
    }
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
                  for (final c in channels)
                    DropdownMenuItem(value: c.id, child: Text(c.name.isEmpty ? c.id : c.name, overflow: TextOverflow.ellipsis)),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        ElevatedButton.icon(
          onPressed: onCreate,
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

/// One place to turn an error into a human message for the outbound UI.
String outboundErrorMessage(Object error) => error is ApiException ? error.message : 'Something went wrong.';
