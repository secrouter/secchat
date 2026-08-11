import 'dart:async';

import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../clipboard_guard.dart';
import '../commands.dart';
import '../marking.dart';
import '../mentions.dart';
import '../models.dart';
import '../platform/file_transfer.dart';
import '../theme.dart';
import 'emoji_picker.dart';
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
  const MessageComposer({
    super.key,
    required this.onSend,
    this.onAttach,
    this.onDropUpload,
    this.enabled = true,
    this.markingLevels = const [],
    this.markingCategories = const [],
    this.markingPolicy,
    this.clipboardGuard,
    this.channelMarking,
    this.initialMarking = 'UNCLASSIFIED',
    this.mentionUsers = const [],
    this.onTyping,
    this.initialText = '',
    this.onDraftChanged,
  });

  /// Invoked with the trimmed message text, its marking, and the ids of any
  /// staged attachments. May throw -- the composer surfaces that as a [SnackBar]
  /// and leaves the text in place so the user can retry. Slash commands are
  /// passed through verbatim; the chat screen interprets them.
  final Future<void> Function(String text, String marking, List<String> attachmentIds) onSend;

  /// Picks + uploads files, returning the created attachments to STAGE for the
  /// next send. Null ⇒ no attach affordance (e.g. coding-agent channels).
  final Future<List<Attachment>> Function()? onAttach;

  /// Uploads already-obtained [files] (from a desktop drag-and-drop) and returns
  /// the created attachments to STAGE. Null ⇒ drag-and-drop disabled (e.g. web,
  /// or a channel that doesn't take attachments).
  final Future<List<Attachment>> Function(List<PickedFile> files)? onDropUpload;

  final bool enabled;

  /// The deployment's marking ladder (for the per-message classification picker).
  /// Empty ⇒ no picker is shown.
  final List<String> markingLevels;

  /// The deployment's enabled CUI categories (optional caveats). When the selected
  /// per-message level has categories, they're offered as a multi-select; the sent
  /// marking is the canonical banner `LEVEL//CAT1/CAT2`. Empty ⇒ no category chips.
  final List<MarkingCategory> markingCategories;

  /// The full marking policy — used by the clipboard guard for level+category
  /// dominance. Falls back to [MarkingPolicy.fallback] when absent.
  final MarkingPolicy? markingPolicy;

  /// Tracks in-app copy provenance so a higher-marked copy can't be pasted into
  /// a lower-marked destination (spillage block), and pasting elevated content
  /// into an unmarked channel raises the composer's marking to match. Absent ⇒
  /// paste is not guarded (native paste).
  final ClipboardGuard? clipboardGuard;

  /// When non-null, the channel is itself marked at this level: the picker is
  /// LOCKED to it (the channel is the portion — every message takes this level).
  final String? channelMarking;

  /// The per-message level pre-selected when the channel is unmarked (the policy
  /// default — fail-safe).
  final String initialMarking;

  /// Candidates for `@`-mention autocomplete — typically the channel's members (or the roster)
  /// MINUS the current user. Empty ⇒ no autocomplete (typing `@` is just text). The inserted token
  /// is `@<mentionHandle>` (derived from the display name), which the server resolves on post.
  final List<User> mentionUsers;

  /// Called as the user edits a non-empty draft, so the screen can emit a (debounced) typing signal.
  /// Null ⇒ no typing indicator wired.
  final VoidCallback? onTyping;

  /// The draft to seed the field with (a per-channel draft the screen persisted). Applied once in
  /// initState — give the composer a per-channel Key so a channel switch re-seeds it.
  final String initialText;

  /// Called with the current draft text on every edit, so the screen can persist it per channel
  /// (survives a channel switch). Null ⇒ drafts aren't persisted.
  final ValueChanged<String>? onDraftChanged;

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

  /// The chosen per-message level (used only when the channel is unmarked).
  late String _marking = widget.initialMarking;

  /// The chosen per-message category codes (only those legal at [_marking] are
  /// sent). Cleared whenever the level changes.
  final Set<String> _categories = {};

  /// Files uploaded and STAGED for the next send (their ids ride along with the
  /// message); cleared on send. [_attaching] guards the picker while it's open.
  final List<Attachment> _pending = [];
  bool _attaching = false;

  /// Shell-style recall: the messages this composer has sent (oldest → newest).
  /// [_histPos] points into it; `_histPos == _sentHistory.length` means "at the
  /// live input" (not browsing). Up from an EMPTY field pulls in the last sent
  /// message; further Up/Down then walk the history. [_applyingHistory] guards
  /// the text listener so a recall doesn't reset the position as if the user
  /// typed.
  final List<String> _sentHistory = [];
  int _histPos = 0;
  bool _applyingHistory = false;

  /// The categories the deployment offers for the currently-selected level.
  List<MarkingCategory> get _availableCategories =>
      widget.markingCategories.where((c) => c.level == _marking.toUpperCase()).toList();

  /// The classification actually sent: the channel's marking when it's marked
  /// (the channel is the portion), else the per-message level plus any selected
  /// categories, in canonical banner form (`CUI//SP-EXPT/SP-PRVCY`).
  String get _effectiveMarking {
    if (widget.channelMarking != null) return widget.channelMarking!;
    final codes = _availableCategories.map((c) => c.code).where(_categories.contains).toList()..sort();
    return codes.isEmpty ? _marking : '$_marking//${codes.join('/')}';
  }

  @override
  void initState() {
    super.initState();
    _fieldFocus = FocusNode(onKeyEvent: _onKeyEvent);
    // Seed a persisted per-channel draft BEFORE wiring the listener, so restoring it doesn't count
    // as typing or re-save.
    if (widget.initialText.isNotEmpty) _controller.text = widget.initialText;
    _controller.addListener(_onTextChanged);
  }

  @override
  void didUpdateWidget(covariant MessageComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Reset the per-message choice when the channel (its marked-ness or default)
    // changes, so a prior channel's selection never leaks across a switch.
    if (oldWidget.channelMarking != widget.channelMarking ||
        oldWidget.initialMarking != widget.initialMarking) {
      _marking = widget.initialMarking;
      _categories.clear();
    }
  }

  @override
  void dispose() {
    _controller.removeListener(_onTextChanged);
    _controller.dispose();
    _fieldFocus.dispose();
    super.dispose();
  }

  void _onTextChanged() {
    // A genuine edit (not a history recall) means the user is typing here-and-now: leave history
    // browsing and return to the live input.
    if (!_applyingHistory) _histPos = _sentHistory.length;
    // A non-empty edit means the user is typing — let the screen emit a (debounced) signal.
    if (_controller.text.trim().isNotEmpty) widget.onTyping?.call();
    widget.onDraftChanged?.call(_controller.text); // persist the per-channel draft
    setState(() {});
  }

  /// Puts [text] in the field (from history), caret at the end, WITHOUT counting as a user edit.
  void _setFromHistory(String text) {
    _applyingHistory = true;
    _controller.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _applyingHistory = false;
  }

  /// Up/Down history recall. Returns true when it consumed the key. Up only starts from an EMPTY,
  /// non-browsing field (so Up still moves the caret in a multi-line draft); once browsing, Up/Down
  /// walk older/newer, and Down past the newest returns to an empty live input.
  bool _recallHistory({required bool older}) {
    final atLive = _histPos >= _sentHistory.length;
    if (older) {
      if (atLive) {
        if (_controller.text.isNotEmpty || _sentHistory.isEmpty) return false;
        _histPos = _sentHistory.length - 1;
      } else if (_histPos > 0) {
        _histPos--;
      } else {
        return true; // already at the oldest — consume, don't move
      }
      _setFromHistory(_sentHistory[_histPos]);
      return true;
    }
    // newer
    if (atLive) return false;
    _histPos++;
    _setFromHistory(_histPos >= _sentHistory.length ? '' : _sentHistory[_histPos]);
    return true;
  }

  bool get _canSend =>
      widget.enabled && !_sending && (_controller.text.trim().isNotEmpty || _pending.isNotEmpty);

  // ── Keyboard ──────────────────────────────────────────────────────────

  /// Handled at the field's own focus node so it runs before the field's
  /// default newline insertion: returning [KeyEventResult.handled] consumes
  /// the Enter (we send / toggle instead), while [KeyEventResult.ignored]
  /// lets the field insert a newline as usual.
  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    final key = event.logicalKey;
    final keys = HardwareKeyboard.instance;
    final ctrl = keys.isControlPressed || keys.isMetaPressed;

    // Guarded paste: intercept Ctrl/Cmd+V so a higher-marked in-app copy can't be
    // pasted into a lower-marked destination, and so pasting elevated content
    // raises the composer's marking to match (see ClipboardGuard).
    if (ctrl && key == LogicalKeyboardKey.keyV && widget.clipboardGuard != null) {
      unawaited(_guardedPaste());
      return KeyEventResult.handled;
    }

    // Up/Down recall previously-sent messages (shell-style). Up only fires from an empty field; once
    // browsing, both walk the history. Ignored otherwise, so normal caret movement still works.
    if (key == LogicalKeyboardKey.arrowUp || key == LogicalKeyboardKey.arrowDown) {
      final consumed = _recallHistory(older: key == LogicalKeyboardKey.arrowUp);
      return consumed ? KeyEventResult.handled : KeyEventResult.ignored;
    }

    // Tab accepts the top autocomplete suggestion: a `@`-mention (username) if the caret is in one,
    // else a `/`-command. With no suggestion showing, Tab falls through to normal focus traversal.
    if (key == LogicalKeyboardKey.tab && !keys.isShiftPressed) {
      final mentions = _mentionMatches;
      if (mentions.isNotEmpty) {
        _applyMention(mentions.first);
        return KeyEventResult.handled;
      }
      final commands = suggestCommands(_controller.text);
      if (commands.isNotEmpty) {
        _applySuggestion(commands.first);
        return KeyEventResult.handled;
      }
      return KeyEventResult.ignored;
    }

    final isEnter = key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter;
    if (!isEnter) return KeyEventResult.ignored;

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
    if ((text.isEmpty && _pending.isEmpty) || _sending || !widget.enabled) return;
    // Record the sent text for Up-arrow recall (skip a pure-attachment send, and don't stack an
    // immediate duplicate). Reset the browse position to the live input.
    if (text.isNotEmpty && (_sentHistory.isEmpty || _sentHistory.last != text)) {
      _sentHistory.add(text);
    }
    _histPos = _sentHistory.length;
    final attachmentIds = _pending.map((a) => a.id).toList();
    final staged = List<Attachment>.of(_pending);
    setState(() {
      _sending = true;
      _pending.clear();
    });
    _controller.clear();
    try {
      await widget.onSend(text, _effectiveMarking, attachmentIds);
    } catch (error) {
      if (!mounted) return;
      _controller.text = text;
      setState(() => _pending.addAll(staged)); // restore the staged files so the user can retry
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not send: $error')),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Opens the file picker (via [MessageComposer.onAttach]), uploads, and STAGES the
  /// returned attachments for the next send.
  Future<void> _attach() async {
    if (widget.onAttach == null || _attaching) return;
    setState(() => _attaching = true);
    try {
      final added = await widget.onAttach!();
      if (mounted && added.isNotEmpty) setState(() => _pending.addAll(added));
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Upload failed: $error')));
      }
    } finally {
      if (mounted) setState(() => _attaching = false);
    }
  }

  /// Whether a desktop drag is currently hovering the composer (drives the highlight).
  bool _dragOver = false;

  /// Reads dropped files' bytes, uploads them (via [MessageComposer.onDropUpload]), and STAGES the
  /// results — the drag-and-drop counterpart to [_attach].
  Future<void> _handleDrop(List<DropItem> items) async {
    if (widget.onDropUpload == null || _attaching) return;
    final files = items.whereType<DropItemFile>().toList(); // ignore dropped directories
    if (files.isEmpty) return;
    setState(() => _attaching = true);
    try {
      final picked = <PickedFile>[];
      for (final item in files) {
        final bytes = await item.readAsBytes();
        picked.add(PickedFile(
          filename: item.name,
          contentType: (item.mimeType?.isNotEmpty ?? false) ? item.mimeType! : _inferContentType(item.name),
          bytes: bytes,
        ));
      }
      final added = await widget.onDropUpload!(picked);
      if (mounted && added.isNotEmpty) setState(() => _pending.addAll(added));
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Upload failed: $error')));
      }
    } finally {
      if (mounted) setState(() => _attaching = false);
    }
  }

  /// Best-effort MIME from a filename extension (desktop drops often carry no mimeType). Text types
  /// matter most: the backend's DLP only scans textual content.
  static String _inferContentType(String filename) {
    final dot = filename.lastIndexOf('.');
    switch (dot < 0 ? '' : filename.substring(dot + 1).toLowerCase()) {
      case 'txt':
      case 'log':
      case 'md':
        return 'text/plain';
      case 'json':
        return 'application/json';
      case 'csv':
        return 'text/csv';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'pdf':
        return 'application/pdf';
      default:
        return 'application/octet-stream';
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

  /// Reads the clipboard and, for tracked in-app marked content, either BLOCKS a
  /// paste the destination can't hold, RAISES the composer's marking to match, or
  /// inserts normally. Only invoked when a [ClipboardGuard] is wired.
  Future<void> _guardedPaste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text ?? '';
    if (text.isEmpty || !mounted) return;
    final decision = widget.clipboardGuard!.decidePaste(
      pastedText: text,
      channelMarking: widget.channelMarking,
      destinationMarking: _effectiveMarking,
      policy: widget.markingPolicy ?? MarkingPolicy.fallback,
    );
    switch (decision.action) {
      case PasteGuardAction.allow:
        _insertText(text);
      case PasteGuardAction.raise:
        _applyMarking(decision.targetMarking!);
        _insertText(text);
        _notify('Marking raised to ${decision.targetMarking} to match pasted content');
      case PasteGuardAction.block:
        _notify(
          '${decision.sourceMarking} content can’t be pasted into this ${widget.channelMarking} channel',
          isError: true,
        );
    }
  }

  /// Sets the per-message level + categories from a canonical marking string
  /// (used when a paste propagates its source marking into an unmarked channel).
  void _applyMarking(String marking) {
    setState(() {
      _marking = markingLevelOf(marking);
      _categories
        ..clear()
        ..addAll(markingCategoriesOf(marking));
    });
  }

  void _notify(String message, {bool isError = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), backgroundColor: isError ? AppColors.bad : null),
    );
  }

  // ── @-mention autocomplete ────────────────────────────────────────────

  /// The `@`-token the caret is currently inside, if any: the `@` must sit at a word boundary and
  /// everything from it to the (collapsed) caret must be handle characters (no whitespace). Returns
  /// the `@`'s offset and the partial query after it, or null when the caret isn't in a mention.
  ({int start, String query})? _activeMention() {
    if (widget.mentionUsers.isEmpty) return null;
    final sel = _controller.selection;
    if (!sel.isValid || !sel.isCollapsed) return null;
    final caret = sel.baseOffset;
    final text = _controller.text;
    if (caret < 0 || caret > text.length) return null;
    final handleChar = RegExp(r'[a-zA-Z0-9._-]');
    for (var i = caret - 1; i >= 0; i--) {
      final c = text[i];
      if (c == '@') {
        // A mention '@' starts the line or follows whitespace / an opening bracket (never an email).
        if (i == 0 || RegExp(r'[\s([{<]').hasMatch(text[i - 1])) {
          return (start: i, query: text.substring(i + 1, caret));
        }
        return null;
      }
      if (!handleChar.hasMatch(c)) return null; // hit whitespace/other ⇒ not in a mention
    }
    return null;
  }

  /// The mention candidates for the active `@`-query (capped for the strip).
  List<User> get _mentionMatches {
    final active = _activeMention();
    if (active == null) return const [];
    return matchMentionCandidates(widget.mentionUsers, active.query).take(6).toList();
  }

  /// Replaces the active `@partial` with `@<handle> ` (handle derived from the display name) and
  /// moves the caret past it, ready for the next word.
  void _applyMention(User user) {
    final active = _activeMention();
    if (active == null) return;
    final caret = _controller.selection.baseOffset;
    final replacement = '@${mentionHandle(user)} ';
    _controller.value = TextEditingValue(
      text: _controller.text.replaceRange(active.start, caret, replacement),
      selection: TextSelection.collapsed(offset: active.start + replacement.length),
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
    final mentionMatches = _mentionMatches;
    final body = Container(
      padding: const EdgeInsets.fromLTRB(18, 10, 18, 14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border(
          top: BorderSide(color: _dragOver ? AppColors.accent : AppColors.border, width: _dragOver ? 2 : 1),
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (mentionMatches.isNotEmpty) _MentionStrip(
            users: mentionMatches,
            onPick: _applyMention,
          ),
          if (suggestions.isNotEmpty) _SuggestionStrip(
            commands: suggestions,
            onPick: _applySuggestion,
          ),
          _toolbar(),
          _categoryBar(),
          if (_pending.isNotEmpty) _pendingBar(),
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

    // Desktop drag-and-drop: drop files onto the composer to upload + stage them. Disabled when
    // there's no uploader (web uses the attach dialog; coding channels take no attachments).
    if (widget.onDropUpload == null) return body;
    return DropTarget(
      onDragEntered: (_) => setState(() => _dragOver = true),
      onDragExited: (_) => setState(() => _dragOver = false),
      onDragDone: (details) {
        setState(() => _dragOver = false);
        unawaited(_handleDrop(details.files));
      },
      child: Stack(
        children: [
          body,
          if (_dragOver)
            Positioned.fill(
              child: IgnorePointer(
                child: Container(
                  color: AppColors.accentSoft,
                  alignment: Alignment.center,
                  child: const Text(
                    'Drop files to attach',
                    style: TextStyle(color: AppColors.accent, fontSize: 14, fontWeight: FontWeight.w700),
                  ),
                ),
              ),
            ),
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
              if (widget.markingLevels.isNotEmpty) _portionButton(),
              if (widget.onAttach != null) _attachButton(),
              _emojiButton(),
            ],
          ),
        ),
        if (widget.markingLevels.isNotEmpty) ...[
          _markingSelector(),
          const SizedBox(width: 6),
        ],
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

  /// The standard CUI portion abbreviation for a level — "(U)" for UNCLASSIFIED,
  /// the level name otherwise (what the server parses to derive the overall marking).
  String _portionToken(String level) => level.toUpperCase() == 'UNCLASSIFIED' ? 'U' : level.toUpperCase();

  /// Inserts an inline CUI PORTION marking at the start of the current line — e.g.
  /// "(CUI) " — so an individual portion of the message can carry its own level.
  Widget _portionButton() {
    return PopupMenuButton<String>(
      tooltip: 'Mark this line (portion marking)',
      padding: EdgeInsets.zero,
      color: AppColors.surfaceRaised,
      position: PopupMenuPosition.under,
      icon: const Icon(Icons.label_important_outline, size: 17, color: AppColors.textMuted),
      onSelected: (level) => _linePrefix('(${_portionToken(level)}) '),
      itemBuilder: (_) => [
        for (final l in widget.markingLevels)
          PopupMenuItem<String>(
            value: l,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: markingStyle(l).bg, borderRadius: BorderRadius.circular(3)),
              child: Text(
                '(${_portionToken(l)})',
                style: AppFonts.mono(fontSize: 11, color: markingStyle(l).fg).copyWith(fontWeight: FontWeight.w700),
              ),
            ),
          ),
      ],
    );
  }

  /// The per-message classification control. When the channel is marked it's a
  /// locked chip at the channel level (the channel is the portion); otherwise a
  /// menu over the ladder, defaulting to the fail-safe floor.
  Widget _markingSelector() {
    final eff = _effectiveMarking;
    final level = markingLevelOf(eff);
    // Baseline (the default/floor) is displayed muted as "UNMARKED" — its marking is suppressed
    // everywhere; only an above-baseline choice gets the solid classification color. A categorized
    // marking (e.g. CUI//SP-PRVCY) shows its full banner string.
    final isBaseline = eff == widget.initialMarking;
    final style = isBaseline ? (bg: AppColors.surfaceRaised, fg: AppColors.textMuted) : markingStyle(level);
    final label = isBaseline ? 'UNMARKED' : eff.toUpperCase();
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: style.bg,
        borderRadius: BorderRadius.circular(4),
        border: isBaseline ? Border.all(color: AppColors.border) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: AppFonts.mono(fontSize: 10.5, color: style.fg).copyWith(fontWeight: FontWeight.w700),
          ),
          Icon(
            widget.channelMarking != null ? Icons.lock_outline : Icons.arrow_drop_down,
            size: 13,
            color: style.fg,
          ),
        ],
      ),
    );
    if (widget.channelMarking != null) {
      return Tooltip(message: 'Channel is marked $eff — every message inherits it', child: chip);
    }
    return PopupMenuButton<String>(
      tooltip: 'Message classification',
      padding: EdgeInsets.zero,
      color: AppColors.surfaceRaised,
      position: PopupMenuPosition.under,
      onSelected: (m) => setState(() {
        _marking = m;
        _categories.clear();
      }),
      itemBuilder: (_) => [
        for (final l in widget.markingLevels)
          PopupMenuItem<String>(
            value: l,
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(color: markingStyle(l).bg, borderRadius: BorderRadius.circular(3)),
                  child: Text(
                    l.toUpperCase(),
                    style: AppFonts.mono(fontSize: 10, color: markingStyle(l).fg).copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                if (l == _marking) ...[
                  const Spacer(),
                  const Icon(Icons.check, size: 15, color: AppColors.accent),
                ],
              ],
            ),
          ),
      ],
      child: chip,
    );
  }

  /// A compact multi-select of the CUI categories available for the currently-
  /// selected level (only when the channel is unmarked and the level has any).
  /// Toggling a chip adds/removes its caveat from the sent marking.
  Widget _categoryBar() {
    final available = _availableCategories;
    if (available.isEmpty || widget.channelMarking != null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Text(
            'CATEGORIES',
            style: AppFonts.mono(fontSize: 9, color: AppColors.textFaint)
                .copyWith(fontWeight: FontWeight.w700, letterSpacing: 0.6),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [for (final c in available) _categoryChip(c)],
            ),
          ),
        ],
      ),
    );
  }

  Widget _categoryChip(MarkingCategory category) {
    final on = _categories.contains(category.code);
    final markStyle = markingStyle(_marking);
    return Tooltip(
      message: category.name,
      child: InkWell(
        borderRadius: BorderRadius.circular(3),
        onTap: () => setState(() => on ? _categories.remove(category.code) : _categories.add(category.code)),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
          decoration: BoxDecoration(
            color: on ? markStyle.bg : AppColors.surfaceRaised,
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: on ? markStyle.bg : AppColors.border),
          ),
          child: Text(
            category.code,
            style: AppFonts.mono(fontSize: 10, color: on ? markStyle.fg : AppColors.textMuted)
                .copyWith(fontWeight: FontWeight.w700),
          ),
        ),
      ),
    );
  }

  /// The attach-file affordance (spinner while the picker/upload is in flight).
  Widget _attachButton() {
    return IconButton(
      icon: _attaching
          ? const SizedBox(
              width: 16, height: 16,
              child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.textMuted),
            )
          : const Icon(Icons.attach_file, size: 17),
      tooltip: 'Attach file',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      color: AppColors.textMuted,
      onPressed: _attaching ? null : _attach,
    );
  }

  /// Chips for files STAGED to send with the next message (each removable).
  Widget _pendingBar() {
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final a in _pending)
            Chip(
              avatar: const Icon(Icons.insert_drive_file_outlined, size: 14),
              label: Text(a.filename, style: const TextStyle(fontSize: 11)),
              onDeleted: () => setState(() => _pending.remove(a)),
              deleteIcon: const Icon(Icons.close, size: 14),
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
              visualDensity: VisualDensity.compact,
              backgroundColor: AppColors.surfaceRaised,
            ),
        ],
      ),
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
        EmojiPickerBody(
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

/// The `@`-mention autocomplete strip shown above the field while the caret is inside an `@`-token.
/// Lists matching members by display name + handle; picking inserts `@<handle>`.
class _MentionStrip extends StatelessWidget {
  const _MentionStrip({required this.users, required this.onPick});

  final List<User> users;
  final void Function(User) onPick;

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
          for (final user in users)
            InkWell(
              onTap: () => onPick(user),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                child: Row(
                  children: [
                    const Icon(Icons.alternate_email, size: 14, color: AppColors.accent),
                    const SizedBox(width: 8),
                    Text(
                      user.label,
                      style: const TextStyle(
                        fontSize: 13,
                        color: AppColors.text,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '@${mentionHandle(user)}',
                      style: AppFonts.mono(fontSize: 11.5, color: AppColors.textFaint),
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

// The emoji picker body moved to `lib/widgets/emoji_picker.dart` (EmojiPickerBody)
// so message reactions can reuse it too.
