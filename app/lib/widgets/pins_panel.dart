import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../responsive.dart';
import '../theme.dart';

/// Opens the pinned-messages panel for a channel: lists its pins (newest first) with content and
/// author, and an unpin action per row. Self-contained — it loads from [api] and unpins via it; the
/// screen stays in sync through the `pin` WS event.
Future<void> showPinsPanel(
  BuildContext context, {
  required ApiClient api,
  required String channelId,
  required String Function(String sub) labelForSub,
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _PinsDialog(api: api, channelId: channelId, labelForSub: labelForSub),
  );
}

class _PinsDialog extends StatefulWidget {
  const _PinsDialog({required this.api, required this.channelId, required this.labelForSub});

  final ApiClient api;
  final String channelId;
  final String Function(String sub) labelForSub;

  @override
  State<_PinsDialog> createState() => _PinsDialogState();
}

class _PinsDialogState extends State<_PinsDialog> {
  List<PinnedMessage>? _pins;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final pins = await widget.api.getPins(widget.channelId);
      if (!mounted) return;
      setState(() {
        _pins = pins;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : e.toString());
    }
  }

  Future<void> _unpin(String messageId) async {
    setState(() => _busy = true);
    try {
      await widget.api.unpinMessage(messageId);
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e is ApiException ? e.message : e.toString())),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pins = _pins;
    return Dialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: dialogWidth(context, 520), maxHeight: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 12, 10),
              child: Row(
                children: [
                  const Icon(Icons.push_pin_outlined, size: 18, color: AppColors.accent),
                  const SizedBox(width: 8),
                  Text(
                    'Pinned${pins != null ? ' · ${pins.length}' : ''}',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.text),
                  ),
                  const Spacer(),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close, size: 18),
                    color: AppColors.textMuted,
                    tooltip: 'Close',
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: AppColors.border),
            Flexible(child: _body(pins)),
          ],
        ),
      ),
    );
  }

  Widget _body(List<PinnedMessage>? pins) {
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Center(child: Text(_error!, style: const TextStyle(color: AppColors.bad))),
      );
    }
    if (pins == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    if (pins.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(
          child: Text(
            'No pinned messages.\nPin a message from its ⋮ menu.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.textFaint, fontSize: 13),
          ),
        ),
      );
    }
    return ListView.separated(
      shrinkWrap: true,
      padding: const EdgeInsets.symmetric(vertical: 6),
      itemCount: pins.length,
      separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.border),
      itemBuilder: (context, i) => _PinRow(
        pin: pins[i],
        authorLabel: widget.labelForSub(pins[i].authorRef),
        onUnpin: _busy ? null : () => _unpin(pins[i].messageId),
      ),
    );
  }
}

class _PinRow extends StatelessWidget {
  const _PinRow({required this.pin, required this.authorLabel, required this.onUnpin});

  final PinnedMessage pin;
  final String authorLabel;
  final VoidCallback? onUnpin;

  @override
  Widget build(BuildContext context) {
    final content = pin.content;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 11, 8, 11),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(authorLabel, style: AppFonts.mono(fontSize: 11.5, color: AppColors.textFaint)),
                const SizedBox(height: 3),
                Text(
                  content == null || content.isEmpty ? 'Message unavailable' : content,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    color: content == null ? AppColors.textFaint : AppColors.textMuted,
                    fontStyle: content == null ? FontStyle.italic : FontStyle.normal,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            onPressed: onUnpin,
            icon: const Icon(Icons.push_pin, size: 15),
            tooltip: 'Unpin',
            color: AppColors.accent,
            visualDensity: VisualDensity.compact,
          ),
        ],
      ),
    );
  }
}
