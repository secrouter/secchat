import 'package:flutter/material.dart';

import '../theme.dart';

/// The message composer: a multiline text field plus a Send button. Owns
/// its own submit-in-flight state so double-taps can't double-send.
class MessageComposer extends StatefulWidget {
  const MessageComposer({super.key, required this.onSend, this.enabled = true});

  /// Invoked with the trimmed message text. May throw -- the composer
  /// surfaces that as a [SnackBar] and leaves the text in place so the user
  /// can retry.
  final Future<void> Function(String text) onSend;

  final bool enabled;

  @override
  State<MessageComposer> createState() => _MessageComposerState();
}

class _MessageComposerState extends State<MessageComposer> {
  final _controller = TextEditingController();
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    _controller.removeListener(_onTextChanged);
    _controller.dispose();
    super.dispose();
  }

  void _onTextChanged() => setState(() {});

  bool get _canSend =>
      widget.enabled && !_sending && _controller.text.trim().isNotEmpty;

  Future<void> _handleSend() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    _controller.clear();
    try {
      await widget.onSend(text);
    } catch (error) {
      if (!mounted) return;
      _controller.text = text;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not send: $error')),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 18),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 140),
              child: TextField(
                controller: _controller,
                enabled: widget.enabled,
                minLines: 1,
                maxLines: 6,
                textInputAction: TextInputAction.newline,
                style: const TextStyle(color: AppColors.text, fontSize: 14),
                decoration: const InputDecoration(
                  hintText: 'Message…',
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            height: 42,
            child: ElevatedButton(
              onPressed: _canSend ? _handleSend : null,
              style: AppButtonStyles.primary,
              child: _sending
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: AppColors.onAccent,
                      ),
                    )
                  : const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('Send'),
                        SizedBox(width: 6),
                        Icon(Icons.send, size: 15),
                      ],
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
