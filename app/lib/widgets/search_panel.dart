import 'package:flutter/material.dart';

import '../api.dart';
import '../formatting.dart';
import '../models.dart';
import '../responsive.dart';
import '../theme.dart';

/// Opens a message-search dialog. Resolves to the chosen [SearchHit] (whose
/// [SearchHit.channelId] the caller navigates to), or null if dismissed.
/// [channelLabel] renders a hit's channel name in the results.
Future<SearchHit?> showMessageSearch(
  BuildContext context, {
  required ApiClient api,
  required String Function(String channelId) channelLabel,
}) {
  return showDialog<SearchHit>(
    context: context,
    builder: (_) => _SearchDialog(api: api, channelLabel: channelLabel),
  );
}

class _SearchDialog extends StatefulWidget {
  const _SearchDialog({required this.api, required this.channelLabel});

  final ApiClient api;
  final String Function(String channelId) channelLabel;

  @override
  State<_SearchDialog> createState() => _SearchDialogState();
}

class _SearchDialogState extends State<_SearchDialog> {
  final _controller = TextEditingController();
  List<SearchHit> _results = const [];
  bool _searching = false;
  bool _ran = false;
  String? _error;

  Future<void> _run() async {
    final query = _controller.text.trim();
    if (query.isEmpty) {
      setState(() {
        _results = const [];
        _ran = false;
      });
      return;
    }
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final results = await widget.api.search(query);
      if (!mounted) return;
      setState(() {
        _results = results;
        _searching = false;
        _ran = true;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error is ApiException ? error.message : error.toString();
        _searching = false;
        _ran = true;
      });
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: BorderSide(color: AppColors.border),
      ),
      title: Text(
        'Search messages',
        style: TextStyle(
          color: AppColors.text,
          fontSize: 16,
          fontWeight: FontWeight.w700,
        ),
      ),
      content: SizedBox(
        width: dialogWidth(context, 460),
        height: 460,
        child: Column(
          children: [
            TextField(
              controller: _controller,
              autofocus: true,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _run(),
              style: TextStyle(color: AppColors.text, fontSize: 14),
              decoration: InputDecoration(
                hintText: 'Search your channels…',
                prefixIcon: Icon(Icons.search, size: 18, color: AppColors.textFaint),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.arrow_forward, size: 18),
                  tooltip: 'Search',
                  onPressed: _run,
                ),
              ),
            ),
            const SizedBox(height: 12),
            Expanded(child: _body()),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Close'),
        ),
      ],
    );
  }

  Widget _body() {
    if (_searching) {
      return Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(color: AppColors.accent, strokeWidth: 2),
        ),
      );
    }
    if (_error != null) {
      return Center(
        child: Text(
          _error!,
          textAlign: TextAlign.center,
          style: TextStyle(color: AppColors.bad, fontSize: 13),
        ),
      );
    }
    if (!_ran) {
      return const _Hint('Type a query and press Enter. Only messages in channels you belong to are searched.');
    }
    if (_results.isEmpty) {
      return const _Hint('No messages matched.');
    }
    return ListView.builder(
      primary: false,
      itemCount: _results.length,
      itemBuilder: (_, i) {
        final hit = _results[i];
        return _HitRow(
          hit: hit,
          channelLabel: widget.channelLabel(hit.channelId),
          onTap: () => Navigator.of(context).pop(hit),
        );
      },
    );
  }
}

class _HitRow extends StatelessWidget {
  const _HitRow({required this.hit, required this.channelLabel, required this.onTap});

  final SearchHit hit;
  final String channelLabel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // A single-line snippet — search content can be markdown; show it plainly.
    final snippet = hit.content.replaceAll('\n', ' ').trim();
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      channelLabel,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: AppColors.accent,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '${hit.authorRef} · ${formatClockTime(hit.createdAt)}',
                    style: AppFonts.mono(fontSize: 10.5, color: AppColors.textFaint),
                  ),
                ],
              ),
              const SizedBox(height: 2),
              Text(
                snippet,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, color: AppColors.textMuted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: AppColors.textFaint,
            fontSize: 13,
            fontStyle: FontStyle.italic,
          ),
        ),
      ),
    );
  }
}
