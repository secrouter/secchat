import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../commands.dart';
import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/app_topbar.dart';
import '../widgets/badges.dart';
import '../widgets/coding_strip.dart';
import '../widgets/composer.dart';
import '../widgets/empty_state.dart';
import '../widgets/message_list.dart';
import '../widgets/new_item_dialog.dart';
import '../widgets/redact_dialog.dart';
import '../widgets/search_panel.dart';
import '../widgets/sidebar.dart';
import '../widgets/user_picker.dart';

/// The main chat surface: sidebar + selected channel's transcript +
/// composer, backed by [api]. Everything here goes through the [ApiClient]
/// abstraction so this screen (and its tests) never know whether they're
/// talking to the real backend or an in-memory fake.
class ChatScreen extends StatefulWidget {
  const ChatScreen({
    super.key,
    required this.api,
    required this.principal,
    required this.onSignOut,
  });

  final ApiClient api;
  final Principal principal;
  final VoidCallback onSignOut;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  List<Channel> _channels = [];
  bool _loadingChannels = true;
  String? _channelsError;

  Channel? _selected;
  bool _loadingMessages = false;
  String? _messagesError;
  final Map<String, List<TranscriptEntry>> _transcripts = {};

  TypingState? _typing;
  ConnStatus _connStatus = ConnStatus.idle;
  StreamSubscription<WsEvent>? _wsSub;

  // `GET /channels` only ever reports `kind: "agent"`, never distinguishing
  // an assistant channel from a coding-agent one, and never carries a
  // session id. Both come back from `POST /agents` when *this* client
  // creates the agent, so we remember them locally for channels created in
  // this session. A coding-agent channel from *before* this session (or
  // opened by someone else) will render like a plain agent channel, with no
  // execute-gate strip -- there is no API to recover that after the fact.
  final Map<String, AgentKind> _agentKindByChannel = {};
  final Map<String, String> _sessionIdByChannel = {};
  final Set<String> _endedSessionIds = {};
  int _localEchoSeq = 0;

  // The seen-users directory (sub -> user), for DM peer names + the DM picker.
  Map<String, User> _usersBySub = {};

  // Per-channel unread counts, shown as sidebar badges. Refreshed on load and
  // channel switch; the active channel is kept read as messages arrive. (Live
  // unread for BACKGROUND channels would need a global socket — a follow-up;
  // the client subscribes only to the open channel today.)
  final Map<String, int> _unreadByChannel = {};

  // The id of the message whose thread is open (the transcript is replaced by
  // the thread view), or null for the normal channel view. Cleared on switch.
  String? _threadParentId;

  @override
  void initState() {
    super.initState();
    _loadChannels();
    _loadUsers();
  }

  Future<void> _loadUsers() async {
    try {
      final users = await widget.api.getUsers();
      if (!mounted) return;
      setState(() => _usersBySub = {for (final u in users) u.sub: u});
    } catch (_) {
      // The directory is non-critical to the main chat view: on failure, DMs
      // fall back to showing the peer's sub and the picker is simply empty.
    }
  }

  @override
  void dispose() {
    _wsSub?.cancel();
    super.dispose();
  }

  Future<void> _loadChannels() async {
    try {
      final channels = await widget.api.getChannels();
      if (!mounted) return;
      setState(() {
        _channels = channels;
        _loadingChannels = false;
      });
      if (_selected == null && channels.isNotEmpty) {
        await _selectChannel(channels.first);
      }
      await _loadUnread();
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _channelsError = _describe(error);
        _loadingChannels = false;
      });
    }
  }

  Future<void> _selectChannel(Channel channel) async {
    if (_selected?.id == channel.id) return;
    await _wsSub?.cancel();
    _wsSub = null;
    if (!mounted) return; // could have been disposed during the await

    final cached = _transcripts[channel.id];
    setState(() {
      _selected = channel;
      _typing = null;
      _threadParentId = null;
      _connStatus = ConnStatus.idle;
      _messagesError = null;
      _loadingMessages = cached == null;
    });

    if (cached == null) {
      try {
        final messages = await widget.api.getMessages(channel.id);
        if (!mounted || _selected?.id != channel.id) return;
        setState(() {
          _transcripts[channel.id] = messages.map<TranscriptEntry>(MessageEntry.new).toList();
          _loadingMessages = false;
        });
      } catch (error) {
        if (!mounted || _selected?.id != channel.id) return;
        setState(() {
          _messagesError = _describe(error);
          _loadingMessages = false;
        });
        return;
      }
    }
    _subscribe(channel.id);
    // Viewing a channel marks it read up to its latest message; then refresh the
    // other channels' unread counts.
    unawaited(_markChannelRead(channel.id).then((_) => _loadUnread()));
  }

  /// Fetches unread counts for every channel into [_unreadByChannel]. Failures
  /// per channel are ignored (an absent count renders as no badge).
  Future<void> _loadUnread() async {
    final counts = <String, int>{};
    for (final channel in List<Channel>.of(_channels)) {
      try {
        counts[channel.id] = await widget.api.getUnread(channel.id);
      } catch (_) {
        // ignore — non-critical
      }
    }
    if (!mounted) return;
    setState(() => counts.forEach((id, count) => _unreadByChannel[id] = count));
  }

  /// Marks [channelId] read up to the highest message seq currently loaded and
  /// zeroes its badge. No-op (badge zeroed) when nothing is loaded yet.
  Future<void> _markChannelRead(String channelId) async {
    var maxSeq = 0;
    for (final entry in _transcripts[channelId] ?? const <TranscriptEntry>[]) {
      if (entry is MessageEntry && entry.message.seq > maxSeq) {
        maxSeq = entry.message.seq;
      }
    }
    if (maxSeq > 0) {
      try {
        await widget.api.markRead(channelId, maxSeq);
      } catch (_) {
        // ignore — non-critical
      }
    }
    if (!mounted) return;
    setState(() => _unreadByChannel[channelId] = 0);
  }

  Future<void> _openSearch() async {
    final hit = await showMessageSearch(
      context,
      api: widget.api,
      channelLabel: (channelId) {
        for (final channel in _channels) {
          if (channel.id == channelId) return _channelTitle(channel);
        }
        return channelId;
      },
    );
    if (hit == null || !mounted) return;
    for (final channel in _channels) {
      if (channel.id == hit.channelId) {
        await _selectChannel(channel);
        return;
      }
    }
  }

  Future<void> _retryMessages(Channel channel) async {
    setState(() {
      _messagesError = null;
      _loadingMessages = true;
    });
    try {
      final messages = await widget.api.getMessages(channel.id);
      if (!mounted || _selected?.id != channel.id) return;
      setState(() {
        _transcripts[channel.id] = messages.map<TranscriptEntry>(MessageEntry.new).toList();
        _loadingMessages = false;
      });
      _subscribe(channel.id);
    } catch (error) {
      if (!mounted || _selected?.id != channel.id) return;
      setState(() {
        _messagesError = _describe(error);
        _loadingMessages = false;
      });
    }
  }

  void _subscribe(String channelId) {
    setState(() => _connStatus = ConnStatus.connecting);
    _wsSub = widget.api
        .subscribeChannel(channelId)
        .listen(
          (event) => _handleEvent(channelId, event),
          onError: (Object _) {
            if (mounted && _selected?.id == channelId) {
              setState(() => _connStatus = ConnStatus.down);
            }
          },
          onDone: () {
            if (mounted && _selected?.id == channelId) {
              setState(() => _connStatus = ConnStatus.down);
            }
          },
        );
  }

  void _handleEvent(String channelId, WsEvent event) {
    if (!mounted || _selected?.id != channelId) return;
    setState(() {
      _connStatus = ConnStatus.connected;
      switch (event) {
        case WsMessageEvent(:final message):
          _typing = null;
          _appendMessageUnlessDuplicate(channelId, message);
          // You're viewing this channel (events only fire for the open one), so
          // advance the read marker to include the new message.
          unawaited(_markChannelRead(channelId));
        case WsAssistantDeltaEvent(:final agentId, :final delta):
          _typing = _typing?.agentId == agentId
              ? TypingState(agentId, _typing!.text + delta)
              : TypingState(agentId, delta);
        case WsAgentOutputEvent(:final sessionId, :final text):
          _append(channelId, AgentOutputEntry(sessionId: sessionId, text: text));
        case WsToolDecisionEvent(:final tool, :final allow, :final reason):
          _append(channelId, ToolDecisionEntry(tool: tool, allow: allow, reason: reason));
        case WsSessionEndedEvent():
          final sessionId = _sessionIdByChannel[channelId];
          if (sessionId != null) _endedSessionIds.add(sessionId);
          _append(channelId, const SystemEntry('Session ended'));
        case WsReactionEvent(:final op, :final messageId, :final emoji, :final userSub):
          _applyReaction(channelId, messageId, emoji, userSub, add: op == 'add');
        case WsAssistantErrorEvent(:final error):
          _typing = null;
          _append(channelId, ErrorEntry(error));
        case WsRedactionEvent(:final messageId):
          _applyRedaction(channelId, messageId);
      }
    });
  }

  /// Flips a message to its redacted tombstone in the transcript. Idempotent
  /// (a message already redacted is left as-is). Must be called inside setState.
  void _applyRedaction(String channelId, String messageId) {
    final existing = _transcripts[channelId];
    if (existing == null) return;
    var changed = false;
    final updated = existing.map((entry) {
      if (entry is MessageEntry &&
          entry.message.id == messageId &&
          !entry.message.isRedacted) {
        changed = true;
        return MessageEntry(entry.message.redactedCopy());
      }
      return entry;
    }).toList();
    if (changed) _transcripts[channelId] = updated;
  }

  /// Redacts [message] after confirmation — a governed content purge. The live
  /// `redaction` echo is idempotent; a failure surfaces an error.
  Future<void> _redactMessage(Message message) async {
    final channel = _selected;
    if (channel == null) return;
    final reason = await showRedactDialog(context);
    if (reason == null || !mounted) return;
    try {
      await widget.api.redactMessage(message.id, reason);
      if (!mounted) return;
      setState(() => _applyRedaction(channel.id, message.id));
    } catch (error) {
      _showError(error);
    }
  }

  /// Applies a reaction add/remove to the matching message in the transcript.
  /// Idempotent — adding a reaction already present (or removing an absent one)
  /// is a no-op — so a live event echoing an optimistic local toggle is safe.
  /// Must be called inside `setState`.
  void _applyReaction(
    String channelId,
    String messageId,
    String emoji,
    String userSub, {
    required bool add,
  }) {
    final existing = _transcripts[channelId];
    if (existing == null) return;
    var changed = false;
    final updated = existing.map((entry) {
      if (entry is! MessageEntry || entry.message.id != messageId) return entry;
      final reactions = [...entry.message.reactions];
      final index = reactions.indexWhere(
        (r) => r.userSub == userSub && r.emoji == emoji,
      );
      if (add) {
        if (index >= 0) return entry;
        reactions.add(Reaction(messageId: messageId, userSub: userSub, emoji: emoji));
      } else {
        if (index < 0) return entry;
        reactions.removeAt(index);
      }
      changed = true;
      return MessageEntry(entry.message.withReactions(reactions));
    }).toList();
    if (changed) _transcripts[channelId] = updated;
  }

  /// Toggles the current user's [emoji] reaction on [message], optimistically,
  /// then calls the API; a live `reaction` echo is idempotent, and a failure
  /// reverts the optimistic change.
  Future<void> _toggleReaction(Message message, String emoji) async {
    final channel = _selected;
    if (channel == null) return;
    final me = widget.principal.sub;
    final had = message.reactions.any((r) => r.userSub == me && r.emoji == emoji);
    setState(() => _applyReaction(channel.id, message.id, emoji, me, add: !had));
    try {
      if (had) {
        await widget.api.removeReaction(message.id, emoji);
      } else {
        await widget.api.addReaction(message.id, emoji);
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => _applyReaction(channel.id, message.id, emoji, me, add: had));
      _showError(error);
    }
  }

  /// Replaces `_transcripts[channelId]` with a new list (never mutates the
  /// old one in place) so [MessageList]'s `didUpdateWidget` sees a real
  /// change and auto-scrolls.
  void _append(String channelId, TranscriptEntry entry) {
    final existing = _transcripts[channelId] ?? const [];
    _transcripts[channelId] = [...existing, entry];
  }

  void _appendMessageUnlessDuplicate(String channelId, Message message) {
    final existing = _transcripts[channelId] ?? const [];
    final alreadyPresent = existing.any(
      (e) => e is MessageEntry && e.message.id == message.id,
    );
    if (alreadyPresent) return;
    _transcripts[channelId] = [...existing, MessageEntry(message)];
  }

  /// The session to drive with `sendInput` for [channelId], or `null` if
  /// this channel should go through `postMessage` instead -- i.e. it isn't
  /// a coding-agent channel, or it is one but its session id isn't known
  /// locally (see the `_agentKindByChannel` doc above: that happens for a
  /// coding-agent channel from before this session, which degrades to
  /// looking like a plain agent channel).
  String? _codingSessionIdFor(String channelId) =>
      _agentKindByChannel[channelId] == AgentKind.coding
          ? _sessionIdByChannel[channelId]
          : null;

  Future<void> _handleSend(String text) async {
    final channel = _selected;
    if (channel == null) return;
    // A leading "/<known-command>" is a slash command; everything else
    // (including a "/" that doesn't spell a command) is ordinary text.
    final command = parseSlashCommand(text);
    if (command != null) {
      await _runCommand(channel, command);
      return;
    }
    await _sendPlain(channel, text);
  }

  /// Sends ordinary (non-command) text: to the coding-agent session when this
  /// channel has one, otherwise as a chat message.
  Future<void> _sendPlain(Channel channel, String text) async {
    final sessionId = _codingSessionIdFor(channel.id);
    if (sessionId != null) {
      // A coding agent is driven by its runner, not chat history: input
      // goes to the session, and the agent's reply streams back as
      // `agent_output` / `tool_decision` WS events (handled in
      // `_handleEvent`), never as a `message`. There's no response body to
      // append here, so echo the user's own line locally -- otherwise it
      // would simply vanish from the transcript.
      await widget.api.sendInput(sessionId, text);
      if (!mounted) return;
      setState(() => _append(channel.id, MessageEntry(_localEcho(text))));
      return;
    }
    // Append straight from the POST response rather than waiting for a WS
    // echo (some backends don't echo the sender's own message back to
    // them); `_appendMessageUnlessDuplicate` dedupes by id in case the
    // socket *does* also deliver it.
    final message = await widget.api.postMessage(channel.id, text);
    if (!mounted) return;
    setState(() => _appendMessageUnlessDuplicate(channel.id, message));
  }

  /// Posts a threaded reply to [parentId] and appends it locally.
  Future<void> _sendReply(Channel channel, String parentId, String text) async {
    final message = await widget.api.postMessage(channel.id, text, parentId: parentId);
    if (!mounted) return;
    setState(() => _appendMessageUnlessDuplicate(channel.id, message));
  }

  void _openThread(Message message) =>
      setState(() => _threadParentId = message.id);

  void _closeThread() => setState(() => _threadParentId = null);

  /// The message with [id] in [channelId]'s loaded transcript, or null.
  Message? _messageById(String channelId, String id) {
    for (final entry in _transcripts[channelId] ?? const <TranscriptEntry>[]) {
      if (entry is MessageEntry && entry.message.id == id) return entry.message;
    }
    return null;
  }

  /// Dispatches a parsed slash command. `/pi` is the pi passthrough: its text
  /// goes straight to this channel's coding-agent *session*, so it only works
  /// where such a session exists (there is nothing to pass through to
  /// otherwise -- the "technical issue" the feature degrades on). `/shrug`
  /// appends the shrug and sends via the normal path; `/help` opens a dialog.
  Future<void> _runCommand(Channel channel, ParsedCommand command) async {
    switch (command.command.name) {
      case 'help':
        _showCommandHelp();
      case 'shrug':
        final base = command.args.trim();
        await _sendPlain(channel, base.isEmpty ? kShrug : '$base $kShrug');
      case 'pi':
        final input = command.args;
        if (input.trim().isEmpty) {
          _showError(
            'Usage: /pi <message> — passes input to this channel’s coding agent.',
          );
          return;
        }
        final sessionId = _codingSessionIdFor(channel.id);
        if (sessionId == null) {
          _showError(
            '/pi works only in a coding-agent channel with an active session.',
          );
          return;
        }
        await widget.api.sendInput(sessionId, input);
        if (!mounted) return;
        setState(() => _append(channel.id, MessageEntry(_localEcho('/pi $input'))));
    }
  }

  void _showCommandHelp() {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppColors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.lg),
          side: const BorderSide(color: AppColors.border),
        ),
        title: const Text(
          'Slash commands',
          style: TextStyle(
            color: AppColors.text,
            fontSize: 16,
            fontWeight: FontWeight.w700,
          ),
        ),
        content: SizedBox(
          width: 440,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final command in kSlashCommands)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            command.display,
                            style: AppFonts.mono(
                              fontSize: 13,
                              color: AppColors.accent,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          if (command.argHint.isNotEmpty) ...[
                            const SizedBox(width: 6),
                            Text(
                              command.argHint,
                              style: AppFonts.mono(
                                fontSize: 12.5,
                                color: AppColors.textFaint,
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        command.summary,
                        style: const TextStyle(
                          fontSize: 13,
                          color: AppColors.textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  /// A locally-synthesized "sent" message for text handed to `sendInput`,
  /// which -- unlike `postMessage` -- has no server response to render
  /// instead. The `local-` id prefix keeps it out of the way of real
  /// message ids (server ids are never expected to collide with it), so it
  /// can't be mistaken for a duplicate by `_appendMessageUnlessDuplicate`
  /// elsewhere.
  Message _localEcho(String text) => Message(
    id: 'local-${_localEchoSeq++}',
    seq: 0,
    authorRef: widget.principal.sub,
    authorType: AuthorType.user,
    content: text,
    createdAt: DateTime.now(),
  );

  Future<void> _handleNewChannel() async {
    final name = await showNewItemDialog(
      context,
      title: 'New channel',
      description: 'Create a channel for team discussion.',
      hint: 'e.g. incident-room',
    );
    if (name == null || !mounted) return;
    try {
      final channel = await widget.api.createChannel(name);
      if (!mounted) return;
      setState(() => _channels = [..._channels, channel]);
      await _selectChannel(channel);
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _handleNewDm() async {
    // Refresh the directory first so it reflects anyone who signed in since load.
    await _loadUsers();
    if (!mounted) return;
    final candidates =
        _usersBySub.values.where((u) => u.sub != widget.principal.sub).toList()
          ..sort((a, b) => a.label.toLowerCase().compareTo(b.label.toLowerCase()));
    final picked = await showUserPicker(context, candidates);
    if (picked == null || !mounted) return;
    try {
      // Idempotent server-side: an existing DM with this person comes back as-is.
      final channel = await widget.api.createDm(picked.sub);
      if (!mounted) return;
      setState(() {
        if (!_channels.any((c) => c.id == channel.id)) {
          _channels = [..._channels, channel];
        }
      });
      await _selectChannel(channel);
    } catch (error) {
      _showError(error);
    }
  }

  /// The header/title for [channel]: a DM shows the other participant's name
  /// (from the directory), everything else shows its channel name.
  String _channelTitle(Channel channel) {
    if (channel.kind == ChannelKind.dm) {
      final peer = channel.peer(widget.principal.sub);
      if (peer != null) return _usersBySub[peer]?.label ?? peer;
      return channel.name.isEmpty ? 'Direct message' : channel.name;
    }
    return channel.name.isEmpty ? '(unnamed)' : channel.name;
  }

  Future<void> _handleNewAgent(AgentKind kind) async {
    final isCoding = kind == AgentKind.coding;
    final name = await showNewItemDialog(
      context,
      title: isCoding ? 'New coding agent' : 'New assistant',
      description: isCoding
          ? 'Starts a coding session; tool execution is gated behind an '
                'explicit grant.'
          : 'Starts a conversational assistant in its own channel.',
      hint: 'e.g. release-helper',
    );
    if (name == null || !mounted) return;
    try {
      final result = await widget.api.createAgent(kind: kind, name: name);
      if (!mounted) return;
      setState(() {
        _agentKindByChannel[result.channel.id] = kind;
        final session = result.session;
        if (session != null) _sessionIdByChannel[result.channel.id] = session.id;
        _channels = [..._channels, result.channel];
      });
      await _selectChannel(result.channel);
    } catch (error) {
      _showError(error);
    }
  }

  void _showError(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(_describe(error))));
  }

  String _describe(Object error) =>
      error is ApiException ? error.message : error.toString();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Column(
        children: [
          AppTopBar(
            principal: widget.principal,
            status: _connStatus,
            onSignOut: widget.onSignOut,
            onSearch: _openSearch,
          ),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ChatSidebar(
                  channels: _channels,
                  selectedChannelId: _selected?.id,
                  loading: _loadingChannels,
                  errorText: _channelsError,
                  agentKindByChannel: _agentKindByChannel,
                  currentUserSub: widget.principal.sub,
                  usersBySub: _usersBySub,
                  unreadByChannel: _unreadByChannel,
                  onSelect: _selectChannel,
                  onNewChannel: _handleNewChannel,
                  onNewDm: _handleNewDm,
                  onNewAssistant: () => _handleNewAgent(AgentKind.assistant),
                  onNewCodingAgent: () => _handleNewAgent(AgentKind.coding),
                ),
                Expanded(child: _buildMain()),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMain() {
    final selected = _selected;
    if (selected == null) {
      return const EmptyState(
        icon: Icons.forum_outlined,
        title: 'Select a channel to start chatting',
        subtitle:
            'Or create a new channel, assistant, or coding agent from the '
            'sidebar.',
      );
    }

    Widget? codingStrip;
    final sessionId = _sessionIdByChannel[selected.id];
    if (_agentKindByChannel[selected.id] == AgentKind.coding && sessionId != null) {
      codingStrip = CodingStrip(
        key: ValueKey(selected.id),
        sessionId: sessionId,
        sessionEnded: _endedSessionIds.contains(sessionId),
        onGrantExecute: () => widget.api.grantExecute(sessionId),
      );
    }

    // An open thread replaces the transcript + composer with a focused view.
    final threadParent = _threadParentId == null
        ? null
        : _messageById(selected.id, _threadParentId!);

    return Column(
      children: [
        _ChannelHeader(
          channel: selected,
          title: _channelTitle(selected),
          agentKind: _agentKindByChannel[selected.id],
        ),
        if (codingStrip != null && threadParent == null) codingStrip,
        if (threadParent != null)
          Expanded(child: _buildThread(selected, threadParent))
        else ...[
          Expanded(child: _buildTranscript(selected)),
          MessageComposer(onSend: _handleSend),
        ],
      ],
    );
  }

  Widget _buildTranscript(Channel selected) {
    if (_loadingMessages) {
      return const Center(
        child: CircularProgressIndicator(color: AppColors.accent),
      );
    }
    if (_messagesError != null) {
      return _InlineError(
        text: _messagesError!,
        onRetry: () => _retryMessages(selected),
      );
    }
    // The main view shows only top-level messages; replies fold into their
    // parent's thread, indicated by a per-parent reply count.
    final all = _transcripts[selected.id] ?? const <TranscriptEntry>[];
    final topLevel = <TranscriptEntry>[];
    final replyCounts = <String, int>{};
    for (final entry in all) {
      if (entry is MessageEntry && entry.message.parentId != null) {
        replyCounts.update(entry.message.parentId!, (n) => n + 1, ifAbsent: () => 1);
      } else {
        topLevel.add(entry);
      }
    }
    // Threads are a chat-channel affordance; coding-agent channels are
    // runner-driven, so no threading there.
    final canThread = _codingSessionIdFor(selected.id) == null;
    return MessageList(
      entries: topLevel,
      typing: _typing,
      currentUserSub: widget.principal.sub,
      onToggleReaction: _toggleReaction,
      replyCounts: replyCounts,
      onOpenThread: canThread ? _openThread : null,
      isAdmin: widget.principal.isAdmin,
      // Coding-channel messages are local echoes (no server id) — not redactable.
      onRedact: canThread ? _redactMessage : null,
    );
  }

  /// The focused thread view: a back header, the parent + its replies, and a
  /// reply composer that posts into the thread.
  Widget _buildThread(Channel channel, Message parent) {
    final replies = <Message>[];
    for (final entry in _transcripts[channel.id] ?? const <TranscriptEntry>[]) {
      if (entry is MessageEntry && entry.message.parentId == parent.id) {
        replies.add(entry.message);
      }
    }
    replies.sort((a, b) => a.seq.compareTo(b.seq));
    return Column(
      children: [
        _ThreadHeader(replyCount: replies.length, onClose: _closeThread),
        Expanded(
          child: MessageList(
            entries: [MessageEntry(parent), ...replies.map(MessageEntry.new)],
            currentUserSub: widget.principal.sub,
            onToggleReaction: _toggleReaction,
            isAdmin: widget.principal.isAdmin,
            onRedact: _redactMessage,
            // one level deep — no nested thread affordance inside a thread
          ),
        ),
        MessageComposer(onSend: (text) => _sendReply(channel, parent.id, text)),
      ],
    );
  }
}

class _ThreadHeader extends StatelessWidget {
  const _ThreadHeader({required this.replyCount, required this.onClose});

  final int replyCount;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          IconButton(
            onPressed: onClose,
            icon: const Icon(Icons.arrow_back, size: 18),
            tooltip: 'Back to channel',
            color: AppColors.textMuted,
            visualDensity: VisualDensity.compact,
          ),
          const SizedBox(width: 4),
          const Text(
            'Thread',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: AppColors.text,
            ),
          ),
          const SizedBox(width: 10),
          Text(
            replyCount == 0
                ? 'no replies yet'
                : '$replyCount ${replyCount == 1 ? 'reply' : 'replies'}',
            style: AppFonts.mono(fontSize: 11.5, color: AppColors.textFaint),
          ),
        ],
      ),
    );
  }
}

class _ChannelHeader extends StatelessWidget {
  const _ChannelHeader({
    required this.channel,
    required this.title,
    required this.agentKind,
  });

  final Channel channel;
  final String title;
  final AgentKind? agentKind;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 14),
      decoration: const BoxDecoration(
        color: AppColors.surface,
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: Row(
        children: [
          Icon(
            iconForChannel(channel.kind, agentKind),
            size: 17,
            color: AppColors.textMuted,
          ),
          const SizedBox(width: 10),
          Flexible(
            child: Text(
              title,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: AppColors.text,
              ),
            ),
          ),
          const SizedBox(width: 10),
          ChannelKindBadge(kind: channel.kind, agentKind: agentKind),
          const Spacer(),
          Text(
            shortId(channel.id),
            style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint),
          ),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.text, required this.onRetry});

  final String text;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: AppColors.bad, size: 28),
            const SizedBox(height: 10),
            Text(
              text,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.bad, fontSize: 13),
            ),
            const SizedBox(height: 14),
            OutlinedButton(
              onPressed: onRetry,
              style: AppButtonStyles.ghost,
              child: const Text('Retry'),
            ),
          ],
        ),
      ),
    );
  }
}
