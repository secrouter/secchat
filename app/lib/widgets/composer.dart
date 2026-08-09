import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../commands.dart';
import '../emoji.dart';
import '../theme.dart';
import 'markdown_text.dart';

/// The message composer: a formatting toolbar, a multiline text field with a
/// send-on-Enter keyboard model, an optional live markdown preview, an emoji
/// picker, and a `/`-command suggestion strip — plus a Send button. Owns its
/// own submit-in-flight state so double-taps can't double-send.
///
/// Keyboard model (desktop/web):
///  - **Enter** sends.
///  - **Shift+Enter** inserts a newline.
///  - **Ctrl/Cmd+Enter** toggles a sticky *edit mode* in which Enter inserts a
///    newline like an ordinary editor (Send is then the only way to submit),
///    until Ctrl/Cmd+Enter toggles it back off.
class MessageComposer extends StatefulWidget {
  const MessageComposer({super.key, required this.onSend, this.enabled = true});

  /// Invoked with the trimmed message text. May throw -- the composer
  /// surfaces that as a [SnackBar] and leaves the text in place so the user
  /// can retry. Slash commands are passed through verbatim; the chat screen
  /// interprets them (it has the channel/session context).
  final Future<void> Function(String text) onSend;

  final bool enabled;

  @override
  State<MessageComposer> createState() => _MessageComposerState();
}

class _MessageComposerState extends State<MessageComposer> {
  final _controller = TextEditingController();
  late final FocusNode _fieldFocus;
  final _emojiMenu = MenuController();
  bool _sending = false;
  bool _editMode = false;
  bool _showPreview = false;

  @override
  void initState() {
    super.initState();
    _fieldFocus = FocusNode(onKeyEvent: _onKeyEvent);
    _controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    _controller.removeListener(_onTextChanged);
    _controller.dispose();
    _fieldFocus.dispose();
    super.dispose();
  }

  void _onTextChanged() => setState(() {});

  bool get _canSend =>
      widget.enabled && !_sending && _controller.text.trim().isNotEmpty;

  // ── Keyboard ──────────────────────────────────────────────────────────

  /// Handled at the field's own focus node so it runs before the field's
  /// default newline insertion: returning [KeyEventResult.handled] consumes
  /// the Enter (we send / toggle instead), while [KeyEventResult.ignored]
  /// lets the field insert a newline as usual.
  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    final isEnter = key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter;
    if (!isEnter) return KeyEventResult.ignored;

    final keys = HardwareKeyboard.instance;
    final ctrl = keys.isControlPressed || keys.isMetaPressed;
    final shift = keys.isShiftPressed;

    if (ctrl) {
      setState(() => _editMode = !_editMode);
      return KeyEventResult.handled;
    }
    if (shift || _editMode) {
      return KeyEventResult.ignored; // let the field insert a newline
    }
    _handleSend();
    return KeyEventResult.handled;
  }

  Future<void> _handleSend() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending || !widget.enabled) return;
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

  // ── Text editing helpers (toolbar / emoji / suggestions) ──────────────

  TextSelection get _selection {
    final selection = _controller.selection;
    return selection.isValid
        ? selection
        : TextSelection.collapsed(offset: _controller.text.length);
  }

  /// Wraps the current selection in [left]…[right]; with no selection, inserts
  /// [placeholder] between them and selects it so the user can type over it.
  void _wrap(String left, String right, {String placeholder = ''}) {
    final text = _controller.text;
    final selection = _selection;
    final start = selection.start;
    final end = selection.end;
    final hasSelection = end > start;
    final middle = hasSelection ? text.substring(start, end) : placeholder;
    final replacement = '$left$middle$right';
    final TextSelection newSelection;
    if (!hasSelection && placeholder.isNotEmpty) {
      final placeholderStart = start + left.length;
      newSelection = TextSelection(
        baseOffset: placeholderStart,
        extentOffset: placeholderStart + placeholder.length,
      );
    } else {
      newSelection = TextSelection.collapsed(offset: start + replacement.length);
    }
    _controller.value = TextEditingValue(
      text: text.replaceRange(start, end, replacement),
      selection: newSelection,
    );
    _fieldFocus.requestFocus();
  }

  /// Inserts [prefix] at the start of the line the caret is on (for lists,
  /// quotes, headings).
  void _linePrefix(String prefix) {
    final text = _controller.text;
    final selection = _selection;
    final lineStart = text.lastIndexOf('\n', selection.start - 1) + 1;
    _controller.value = TextEditingValue(
      text: text.replaceRange(lineStart, lineStart, prefix),
      selection: TextSelection.collapsed(offset: selection.end + prefix.length),
    );
    _fieldFocus.requestFocus();
  }

  /// Inserts [snippet] over the current selection (emoji, suggestions).
  void _insertText(String snippet) {
    final text = _controller.text;
    final selection = _selection;
    _controller.value = TextEditingValue(
      text: text.replaceRange(selection.start, selection.end, snippet),
      selection:
          TextSelection.collapsed(offset: selection.start + snippet.length),
    );
    _fieldFocus.requestFocus();
  }

  /// Replaces the field with `/<name> ` when a suggestion is chosen.
  void _applySuggestion(SlashCommand command) {
    final text = '/${command.name} ';
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _fieldFocus.requestFocus();
  }

  // ── Build ─────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final suggestions = suggestCommands(_controller.text);
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 14),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (suggestions.isNotEmpty) _SuggestionStrip(
            commands: suggestions,
            onPick: _applySuggestion,
          ),
          _toolbar(),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(child: _editor()),
              const SizedBox(width: 10),
              _sendButton(),
            ],
          ),
          if (_showPreview) _preview(),
        ],
      ),
    );
  }

  Widget _toolbar() {
    return Row(
      children: [
        Expanded(
          child: Wrap(
            spacing: 1,
            runSpacing: 1,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _toolButton(Icons.format_bold, 'Bold',
                  () => _wrap('**', '**', placeholder: 'bold')),
              _toolButton(Icons.format_italic, 'Italic',
                  () => _wrap('*', '*', placeholder: 'italic')),
              _toolButton(Icons.format_strikethrough, 'Strikethrough',
                  () => _wrap('~~', '~~', placeholder: 'strikethrough')),
              _toolButton(Icons.code, 'Inline code',
                  () => _wrap('`', '`', placeholder: 'code')),
              _toolButton(Icons.data_object, 'Code block',
                  () => _wrap('\n```\n', '\n```\n', placeholder: 'code')),
              _toolButton(Icons.link, 'Link',
                  () => _wrap('[', '](url)', placeholder: 'text')),
              _toolButton(Icons.format_list_bulleted, 'Bulleted list',
                  () => _linePrefix('- ')),
              _toolButton(Icons.format_quote, 'Quote',
                  () => _linePrefix('> ')),
              _emojiButton(),
            ],
          ),
        ),
        _toggleButton(
          Icons.visibility_outlined,
          'Toggle preview',
          _showPreview,
          () => setState(() => _showPreview = !_showPreview),
        ),
        const SizedBox(width: 6),
        _keyboardHint(),
      ],
    );
  }

  Widget _toolButton(IconData icon, String tooltip, VoidCallback onPressed) {
    return IconButton(
      icon: Icon(icon, size: 17),
      tooltip: tooltip,
      onPressed: widget.enabled ? onPressed : null,
      visualDensity: VisualDensity.compact,
      padding: const EdgeInsets.all(6),
      constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
      color: AppColors.textMuted,
      splashRadius: 18,
    );
  }

  Widget _toggleButton(
    IconData icon,
    String tooltip,
    bool active,
    VoidCallback onPressed,
  ) {
    return IconButton(
      icon: Icon(icon, size: 17),
      tooltip: tooltip,
      onPressed: onPressed,
      visualDensity: VisualDensity.compact,
      padding: const EdgeInsets.all(6),
      constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
      color: active ? AppColors.accent : AppColors.textMuted,
      splashRadius: 18,
    );
  }

  Widget _emojiButton() {
    return MenuAnchor(
      controller: _emojiMenu,
      style: MenuStyle(
        backgroundColor: const WidgetStatePropertyAll(AppColors.surfaceRaised),
        side: const WidgetStatePropertyAll(BorderSide(color: AppColors.border)),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.sm),
          ),
        ),
        padding: const WidgetStatePropertyAll(EdgeInsets.zero),
      ),
      menuChildren: [
        _EmojiPicker(
          onPick: (emoji) {
            _insertText(emoji);
            _emojiMenu.close();
          },
        ),
      ],
      builder: (context, controller, _) => _toolButton(
        Icons.emoji_emotions_outlined,
        'Emoji',
        () => controller.isOpen ? controller.close() : controller.open(),
      ),
    );
  }

  Widget _keyboardHint() {
    final text = _editMode ? 'Edit mode · ⌃⏎ to exit' : '⏎ send · ⇧⏎ newline';
    return Text(
      text,
      style: AppFonts.mono(
        fontSize: 10.5,
        color: _editMode ? AppColors.accent : AppColors.textFaint,
      ),
    );
  }

  Widget _editor() {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 160),
      child: TextField(
        controller: _controller,
        focusNode: _fieldFocus,
        enabled: widget.enabled,
        minLines: 1,
        maxLines: null,
        keyboardType: TextInputType.multiline,
        textInputAction: TextInputAction.newline,
        style: const TextStyle(color: AppColors.text, fontSize: 14),
        decoration: const InputDecoration(hintText: 'Message…'),
      ),
    );
  }

  Widget _sendButton() {
    return SizedBox(
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
    );
  }

  Widget _preview() {
    final draft = _controller.text;
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: BoxDecoration(
        color: AppColors.bg,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'PREVIEW',
            style: AppFonts.mono(
              fontSize: 10,
              color: AppColors.textFaint,
              letterSpacing: 0.6,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 180),
            child: SingleChildScrollView(
              primary: false,
              child: draft.trim().isEmpty
                  ? const Text(
                      'Nothing to preview yet.',
                      style: TextStyle(
                        color: AppColors.textFaint,
                        fontSize: 13,
                        fontStyle: FontStyle.italic,
                      ),
                    )
                  : MarkdownText(draft),
            ),
          ),
        ],
      ),
    );
  }
}

/// The `/`-command suggestion strip shown above the field while the user types
/// a bare `/<prefix>`.
class _SuggestionStrip extends StatelessWidget {
  const _SuggestionStrip({required this.commands, required this.onPick});

  final List<SlashCommand> commands;
  final void Function(SlashCommand) onPick;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: AppColors.surfaceRaised,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final command in commands)
            InkWell(
              onTap: () => onPick(command),
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    Text(
                      command.display,
                      style: AppFonts.mono(
                        fontSize: 12.5,
                        color: AppColors.accent,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (command.argHint.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Text(
                        command.argHint,
                        style: AppFonts.mono(
                          fontSize: 12,
                          color: AppColors.textFaint,
                        ),
                      ),
                    ],
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        command.summary,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12.5,
                          color: AppColors.textMuted,
                        ),
                      ),
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

/// The emoji picker body shown inside the toolbar's [MenuAnchor]: curated
/// groups (see `lib/emoji.dart`) in a scrollable grid.
class _EmojiPicker extends StatelessWidget {
  const _EmojiPicker({required this.onPick});

  final void Function(String emoji) onPick;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 320,
      height: 260,
      child: SingleChildScrollView(
        primary: false,
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final group in kEmojiGroups) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(2, 6, 2, 4),
                child: Text(
                  group.label.toUpperCase(),
                  style: AppFonts.mono(
                    fontSize: 9.5,
                    color: AppColors.textFaint,
                    letterSpacing: 0.6,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              Wrap(
                children: [
                  for (final emoji in group.emoji)
                    InkWell(
                      onTap: () => onPick(emoji),
                      borderRadius: BorderRadius.circular(6),
                      child: Padding(
                        padding: const EdgeInsets.all(5),
                        child: Text(
                          emoji,
                          style: const TextStyle(fontSize: 20),
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
