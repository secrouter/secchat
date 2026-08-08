import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
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
import '../widgets/sidebar.dart';

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

  @override
  void initState() {
    super.initState();
    _loadChannels();
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

    final cached = _transcripts[channel.id];
    setState(() {
      _selected = channel;
      _typing = null;
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
      }
    });
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

  Future<void> _handleSend(String text) async {
    final channel = _selected;
    if (channel == null) return;
    // Append straight from the POST response rather than waiting for a WS
    // echo (some backends don't echo the sender's own message back to
    // them); `_appendMessageUnlessDuplicate` dedupes by id in case the
    // socket *does* also deliver it.
    final message = await widget.api.postMessage(channel.id, text);
    if (!mounted) return;
    setState(() => _appendMessageUnlessDuplicate(channel.id, message));
  }

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
                  onSelect: _selectChannel,
                  onNewChannel: _handleNewChannel,
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

    return Column(
      children: [
        _ChannelHeader(
          channel: selected,
          agentKind: _agentKindByChannel[selected.id],
        ),
        if (codingStrip != null) codingStrip,
        Expanded(child: _buildTranscript(selected)),
        MessageComposer(onSend: _handleSend),
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
    return MessageList(
      entries: _transcripts[selected.id] ?? const [],
      typing: _typing,
      currentUserSub: widget.principal.sub,
    );
  }
}

class _ChannelHeader extends StatelessWidget {
  const _ChannelHeader({required this.channel, required this.agentKind});

  final Channel channel;
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
              channel.name.isEmpty ? '(unnamed)' : channel.name,
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
