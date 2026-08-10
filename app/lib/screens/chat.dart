import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../commands.dart';
import '../formatting.dart';
import '../clipboard_guard.dart';
import '../marking.dart';
import '../platform/file_transfer.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/app_topbar.dart';
import '../widgets/badges.dart';
import '../widgets/coding_strip.dart';
import '../widgets/composer.dart';
import '../widgets/edit_dialog.dart';
import '../widgets/empty_state.dart';
import '../widgets/history_dialog.dart';
import '../widgets/marking_banner.dart';
import '../widgets/marking_picker.dart';
import '../widgets/message_list.dart';
import '../widgets/new_item_dialog.dart';
import '../widgets/redact_dialog.dart';
import '../platform/daemon_supervisor.dart';
import '../widgets/members_panel.dart';
import '../widgets/mentions_panel.dart';
import '../widgets/pins_panel.dart';
import '../widgets/search_panel.dart';
import '../widgets/sidebar.dart';
import '../widgets/step_up_dialog.dart';
import '../widgets/user_picker.dart';

/// Test seam: how [ChatScreen] obtains its runner-daemon supervisor. Widget tests override this with
/// a no-op so they never spawn a real child process (which would leak pending timers under the test
/// binding). Production keeps the real desktop / no-op web factory.
@visibleForTesting
DaemonSupervisor Function() debugDaemonSupervisorFactory = createDaemonSupervisor;

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

  /// Initial page size + per-channel "load older" cursor (the seq to fetch before,
  /// or null once the start of history is reached / the channel fit in one page).
  static const int _pageSize = 50;
  final Map<String, int?> _cursors = {};
  bool _loadingOlder = false;

  TypingState? _typing;
  ConnStatus _connStatus = ConnStatus.idle;
  StreamSubscription<WsEvent>? _wsSub;
  Timer? _wsReconnect;

  // `GET /channels` only ever reports `kind: "agent"`, never distinguishing
  // an assistant channel from a coding-agent one, and never carries a
  // session id. Both come back from `POST /agents` when *this* client
  // creates the agent, so we remember them locally for channels created in
  // this session. A coding-agent channel from *before* this session (or
  // opened by someone else) will render like a plain agent channel, with no
  // execute-gate strip -- there is no API to recover that after the fact.
  final Map<String, AgentKind> _agentKindByChannel = {};
  final Map<String, String> _sessionIdByChannel = {};

  // Models the gateway offers (GET /models) — populates the assistant header's
  // model picker. Loaded once at boot; empty (or a failed load) just hides the
  // picker, leaving the deployment default in effect.
  List<ModelInfo> _models = const [];

  // Whether the sidebar reveals archived channels (off by default — archiving is
  // the declutter path for heavy testing).
  bool _showArchived = false;
  final Set<String> _endedSessionIds = {};

  // The seen-users directory (sub -> user), for DM peer names + the DM picker.
  Map<String, User> _usersBySub = {};

  // Per-channel unread counts, shown as sidebar badges. Refreshed on load and
  // channel switch; the active channel is kept read as messages arrive. (Live
  // unread for BACKGROUND channels would need a global socket — a follow-up;
  // the client subscribes only to the open channel today.)
  final Map<String, int> _unreadByChannel = {};

  // The caller's @mentions inbox: recent mentions (newest first) + the unseen badge count. Loaded
  // once on start and kept live via the per-user `mention` WS event.
  List<Mention> _mentions = [];
  int _unseenMentions = 0;

  /// The roster minus the current user — the `@`-mention autocomplete candidates for the composer.
  /// (Server-side, a mention only fires for an actual channel member, so an over-broad suggestion
  /// list is harmless.)
  List<User> get _mentionUsers =>
      _usersBySub.values.where((u) => u.sub != widget.principal.sub).toList();

  // Presence: the subs currently online (seeded from /presence, kept live by `presence` events).
  Set<String> _onlineSubs = {};

  // Ephemeral human-typing state: channelId → (sub → last time they were seen typing). A single
  // periodic pruner ([_typingPrune]) drops stale entries so "X is typing…" fades on its own.
  final Map<String, Map<String, DateTime>> _typingByChannel = {};
  Timer? _typingPrune;
  DateTime? _lastTypingSent; // debounces our OWN outbound typing signal

  // Unsent per-channel drafts — preserved across channel switches (the composer is keyed per channel
  // and re-seeds from here). Cleared on a successful send.
  final Map<String, String> _draftsByChannel = {};

  // The pinned message ids of the OPEN channel (drives the ⋮ Pin/Unpin toggle + a pin indicator).
  // Loaded on channel open, kept live by `pin` events.
  Set<String> _pinnedIds = {};

  /// Subs actively typing in [channelId] right now (within the freshness window), excluding self.
  List<String> _typersIn(String channelId) {
    final now = DateTime.now();
    final perSub = _typingByChannel[channelId];
    if (perSub == null) return const [];
    return [
      for (final e in perSub.entries)
        if (e.key != widget.principal.sub && now.difference(e.value) < _typingTtl) e.key,
    ];
  }

  static const _typingTtl = Duration(seconds: 5);

  /// A human label for a sub (directory display name, else the raw sub).
  String _labelForSub(String sub) => _usersBySub[sub]?.label ?? sub;

  // The id of the message whose thread is open (the transcript is replaced by
  // the thread view), or null for the normal channel view. Cleared on switch.
  String? _threadParentId;

  // The bundled runner daemon (desktop only): spawns pi on THIS machine wired to the signed-in user,
  // so coding agents route to it. No-op on web (a web user relies on a standalone/remote daemon).
  final DaemonSupervisor _daemon = debugDaemonSupervisorFactory();

  @override
  void initState() {
    super.initState();
    _subscribeAll(); // one long-lived socket for ALL the user's channels (background unread + live events)
    // Start the bundled runner daemon on desktop.
    if (_daemon.supported) unawaited(_startDaemon());
    _loadChannels();
    _loadUsers();
    _loadMentions();
    _loadPresence();
    _loadModels();
    // Prune stale typing entries a couple times per TTL so "X is typing…" fades without new events.
    _typingPrune = Timer.periodic(const Duration(seconds: 2), (_) {
      if (!mounted) return;
      final now = DateTime.now();
      var changed = false;
      for (final perSub in _typingByChannel.values) {
        perSub.removeWhere((_, at) {
          final stale = now.difference(at) >= _typingTtl;
          if (stale) changed = true;
          return stale;
        });
      }
      if (changed) setState(() {});
    });
  }

  Future<void> _loadPresence() async {
    try {
      final online = await widget.api.getPresence();
      if (!mounted) return;
      setState(() => _onlineSubs = online.toSet());
    } catch (_) {
      // Non-critical: presence dots just stay off until the live events arrive.
    }
  }

  Future<void> _loadModels() async {
    try {
      final models = await widget.api.listModels();
      if (!mounted) return;
      setState(() => _models = models);
    } catch (_) {
      // Non-critical: no gateway / list failed → the header picker just stays
      // hidden and the deployment default model applies.
    }
  }

  /// Archive or restore a channel from the sidebar, updating the local list
  /// optimistically so it hides/reappears immediately.
  Future<void> _archiveChannel(Channel channel, bool archived) async {
    setState(() {
      _channels = [
        for (final c in _channels) c.id == channel.id ? c.withArchived(archived) : c,
      ];
      if (_selected?.id == channel.id) _selected = _selected!.withArchived(archived);
    });
    try {
      await widget.api.archiveChannel(channel.id, archived: archived);
    } catch (error) {
      // Roll back on failure.
      if (!mounted) return;
      setState(() {
        _channels = [
          for (final c in _channels) c.id == channel.id ? c.withArchived(!archived) : c,
        ];
        if (_selected?.id == channel.id) _selected = _selected!.withArchived(!archived);
      });
      _showError(error);
    }
  }

  /// Switch an assistant channel's model (header picker → PATCH /agents/:id),
  /// then reflect it locally so the header updates without a reload.
  Future<void> _setAgentModel(Channel channel, String model) async {
    final agentId = channel.agentId;
    if (agentId == null || model == channel.agentModel) return;
    try {
      await widget.api.setAgentModel(agentId, model);
      if (!mounted) return;
      setState(() {
        _channels = [
          for (final c in _channels)
            c.id == channel.id ? c.withAgentModel(model) : c,
        ];
        if (_selected?.id == channel.id) {
          _selected = _selected!.withAgentModel(model);
        }
      });
    } catch (error) {
      _showError(error);
    }
  }

  /// Mint a scoped runner token and start the bundled daemon with it. The scoped token works in
  /// cookie-session mode (no bearer) and is least-privilege for bearer users; if the server hasn't
  /// configured runner tokens, fall back to a bearer token when one exists.
  Future<void> _startDaemon() async {
    final token = (await widget.api.mintRunnerToken()) ?? widget.api.token ?? '';
    if (!mounted || token.isEmpty) return;
    _daemon.start(secchatUrl: widget.api.origin.toString(), token: token);
  }

  Future<void> _loadMentions() async {
    try {
      final inbox = await widget.api.getMentions();
      if (!mounted) return;
      setState(() {
        _mentions = inbox.mentions;
        _unseenMentions = inbox.unseen;
      });
    } catch (_) {
      // Non-critical: on failure the mentions badge just stays at 0.
    }
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
    _typingPrune?.cancel();
    _wsReconnect?.cancel();
    _daemon.dispose();
    _wsSub?.cancel();
    super.dispose();
  }

  Future<void> _loadChannels() async {
    try {
      final channels = await widget.api.getChannels();
      if (!mounted) return;
      // Recover each agent channel's kind from the server (GET /channels now
      // reports it) so a reloaded client renders coding vs assistant correctly,
      // rather than defaulting every agent channel to assistant. Locally-created
      // agents already populated this from POST /agents; this fills the rest.
      for (final c in channels) {
        if (c.agentKind != null) {
          _agentKindByChannel[c.id] = c.agentKind!;
        }
        // Recover a coding channel's live session id so the coding strip (grant
        // execute) shows for a reloaded client. Message delivery to pi is handled
        // server-side now; this is just for the session-scoped UI. Absent ⇒ no live
        // session; `_ensureCodingSession` (on select) starts one on demand.
        if (c.sessionId != null) {
          _sessionIdByChannel[c.id] = c.sessionId!;
        }
      }
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
    // The global socket (subscribeAll) stays open across switches — no per-channel teardown.
    final cached = _transcripts[channel.id];
    setState(() {
      _selected = channel;
      _typing = null;
      _threadParentId = null;
      _connStatus = ConnStatus.idle;
      _messagesError = null;
      _loadingMessages = cached == null;
      _pinnedIds = {}; // reset; reloaded for the newly-open channel below
    });
    unawaited(_loadPins(channel.id));

    if (cached == null) {
      try {
        final page = await widget.api.getMessagePage(channel.id, limit: _pageSize);
        if (!mounted || _selected?.id != channel.id) return;
        setState(() {
          _transcripts[channel.id] = page.messages.map<TranscriptEntry>(MessageEntry.new).toList();
          _cursors[channel.id] = page.nextCursor;
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
    // Viewing a channel marks it read up to its latest message; then refresh the
    // other channels' unread counts. (Events arrive on the always-open global socket.)
    unawaited(_markChannelRead(channel.id).then((_) => _loadUnread()));

    // A coding channel needs a live runner session to receive input. If we don't
    // already have one (fresh reload, or the prior session died with the daemon),
    // (re)attach on open so both the composer's routing and the coding strip work.
    unawaited(_ensureCodingSession(channel));
  }

  /// Ensures [channel] (when a coding-agent channel) has a live session id in
  /// [_sessionIdByChannel], (re)starting one via the API if needed. Best-effort:
  /// a failure just leaves the channel without a session (the composer falls back
  /// to posting a plain message, and the coding strip stays hidden).
  Future<void> _ensureCodingSession(Channel channel) async {
    if (_agentKindByChannel[channel.id] != AgentKind.coding) return;
    if (_sessionIdByChannel[channel.id] != null) return;
    try {
      final session = await widget.api.ensureSession(channel.id);
      if (!mounted) return;
      setState(() => _sessionIdByChannel[channel.id] = session.id);
    } catch (_) {
      // Non-fatal — leave the channel session-less; sending falls back to a plain post.
    }
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

  /// Loads the next OLDER page for [channelId] and PREPENDS it. Guarded so overlapping
  /// scroll triggers coalesce; a null cursor (start of history) is a no-op.
  Future<void> _loadOlder(String channelId) async {
    final cursor = _cursors[channelId];
    if (_loadingOlder || cursor == null) return;
    setState(() => _loadingOlder = true);
    try {
      final page = await widget.api.getMessagePage(channelId, limit: _pageSize, before: cursor);
      if (!mounted) return;
      setState(() {
        final older = page.messages.map<TranscriptEntry>(MessageEntry.new).toList();
        _transcripts[channelId] = [...older, ...?_transcripts[channelId]];
        _cursors[channelId] = page.nextCursor;
        _loadingOlder = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loadingOlder = false);
    }
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

  /// Emit a typing signal for [channelId], debounced to at most one every 2.5s (the server relays
  /// each; peers hold "typing" for the 5s TTL, so this keeps it alive without spamming the socket).
  void _emitTyping(String channelId) {
    final now = DateTime.now();
    if (_lastTypingSent != null && now.difference(_lastTypingSent!) < const Duration(milliseconds: 2500)) {
      return;
    }
    _lastTypingSent = now;
    widget.api.sendTyping(channelId);
  }

  Future<void> _loadPins(String channelId) async {
    try {
      final pins = await widget.api.getPins(channelId);
      if (!mounted || _selected?.id != channelId) return;
      setState(() => _pinnedIds = pins.map((p) => p.messageId).toSet());
    } catch (_) {
      // Non-critical: pins just stay unknown until the next open/refresh.
    }
  }

  /// Pin or unpin [message] (optimistic; the server broadcast keeps every viewer in sync).
  Future<void> _togglePin(Message message) async {
    if (_selected == null) return;
    final wasPinned = _pinnedIds.contains(message.id);
    setState(() => wasPinned ? _pinnedIds.remove(message.id) : _pinnedIds.add(message.id));
    try {
      if (wasPinned) {
        await widget.api.unpinMessage(message.id);
      } else {
        await widget.api.pinMessage(message.id);
      }
    } catch (error) {
      if (!mounted) return;
      setState(() => wasPinned ? _pinnedIds.add(message.id) : _pinnedIds.remove(message.id)); // rollback
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_describe(error))));
    }
  }

  Future<void> _openPins(Channel channel) async {
    // Self-contained: the panel loads + unpins via the API; the `pin` WS event keeps _pinnedIds in
    // sync here, so no explicit refresh on close is needed.
    await showPinsPanel(
      context,
      api: widget.api,
      channelId: channel.id,
      labelForSub: _labelForSub,
    );
  }

  Future<void> _openMembers(Channel channel) async {
    await showMembersPanel(
      context,
      api: widget.api,
      channel: channel,
      currentUserSub: widget.principal.sub,
      isAdmin: widget.principal.isAdmin,
      roster: _usersBySub.values.toList(),
      onlineSubs: _onlineSubs,
    );
  }

  Future<void> _openMentions() async {
    // Opening the inbox clears the unseen badge (locally now, server best-effort).
    if (_unseenMentions > 0) {
      setState(() => _unseenMentions = 0);
      unawaited(widget.api.markMentionsSeen().catchError((_) => 0));
    }
    final chosen = await showMentionsInbox(
      context,
      mentions: _mentions,
      channelLabel: (channelId) {
        for (final channel in _channels) {
          if (channel.id == channelId) return _channelTitle(channel);
        }
        return channelId;
      },
    );
    if (chosen == null || !mounted) return;
    for (final channel in _channels) {
      if (channel.id == chosen.channelId) {
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
      final page = await widget.api.getMessagePage(channel.id, limit: _pageSize);
      if (!mounted || _selected?.id != channel.id) return;
      setState(() {
        _transcripts[channel.id] = page.messages.map<TranscriptEntry>(MessageEntry.new).toList();
        _cursors[channel.id] = page.nextCursor;
        _loadingMessages = false;
      });
      if (_wsSub == null) _subscribeAll(); // re-establish the socket if it had dropped
    } catch (error) {
      if (!mounted || _selected?.id != channel.id) return;
      setState(() {
        _messagesError = _describe(error);
        _loadingMessages = false;
      });
    }
  }

  /// Opens the single long-lived socket delivering events for ALL the user's channels; each event
  /// carries its `channelId`, routed in [_handleEvent]. Reconnects if it had dropped.
  void _subscribeAll() {
    _wsReconnect?.cancel();
    _wsSub?.cancel();
    setState(() => _connStatus = ConnStatus.connecting);
    _wsSub = widget.api.subscribeAll().listen(
      _handleEvent,
      onError: (Object _) => _scheduleWsReconnect(),
      onDone: _scheduleWsReconnect,
    );
  }

  /// The global socket dropped (network blip, server restart). Without this the app would go silent
  /// until the user next selected a channel; instead retry on a short delay so live events (new
  /// messages, agent output) resume on their own.
  void _scheduleWsReconnect() {
    _wsSub = null;
    if (!mounted) return;
    setState(() => _connStatus = ConnStatus.down);
    _wsReconnect?.cancel();
    _wsReconnect = Timer(const Duration(seconds: 3), () {
      if (mounted && _wsSub == null) _subscribeAll();
    });
  }

  void _handleEvent(WsEvent event) {
    if (!mounted) return;
    final channelId = event.channelId;
    final isOpen = _selected?.id == channelId;
    setState(() {
      _connStatus = ConnStatus.connected;
      switch (event) {
        case WsMessageEvent(:final message):
          // Append to the OPEN channel, or to a background channel we've already loaded (so switching
          // back is current); never seed an unloaded channel here (that would skip its history load).
          if (isOpen || _transcripts.containsKey(channelId)) {
            _appendMessageUnlessDuplicate(channelId, message);
          }
          if (isOpen) {
            _typing = null;
            unawaited(_markChannelRead(channelId)); // viewing it → advance the read marker
          } else {
            // A BACKGROUND channel got a new message → bump its unread badge live.
            _unreadByChannel[channelId] = (_unreadByChannel[channelId] ?? 0) + 1;
          }
        // Content/social updates apply to any channel's cached transcript (no-op if unloaded), so a
        // background channel stays consistent when re-opened; they don't change unread.
        case WsReactionEvent(:final op, :final messageId, :final emoji, :final userSub):
          _applyReaction(channelId, messageId, emoji, userSub, add: op == 'add');
        case WsRedactionEvent(:final messageId):
          _applyRedaction(channelId, messageId);
        case WsMessageEditEvent(:final messageId, :final content, :final editedAt):
          _applyEdit(channelId, messageId, content, editedAt);
        case WsChannelMarkingEvent(:final marking):
          _applyChannelMarking(channelId, marking);
        case WsMentionEvent(:final mention):
          // The server only delivers a `mention` to the mentioned user, so any that arrives is one
          // of MINE — light the badge and prepend it to the inbox (de-duped by id).
          _mentions = [mention, ..._mentions.where((m) => m.id != mention.id)];
          _unseenMentions++;
        case WsTypingEvent(:final userSub):
          // Record the peer's typing time; the periodic pruner clears it after the TTL. (Our own
          // echoed typing is ignored at render time via _typersIn.)
          (_typingByChannel[channelId] ??= {})[userSub] = DateTime.now();
        case WsPresenceEvent(:final userSub, :final online):
          if (online) {
            _onlineSubs.add(userSub);
          } else {
            _onlineSubs.remove(userSub);
          }
        case WsPinEvent(:final op, :final messageId):
          // Keep the OPEN channel's pin set current (drives the ⋮ toggle + the inline indicator).
          if (isOpen) {
            if (op == 'pin') {
              _pinnedIds.add(messageId);
            } else {
              _pinnedIds.remove(messageId);
            }
          }
        // Agent-stream / typing events drive the OPEN channel's ephemeral UI only.
        case WsAssistantDeltaEvent(:final agentId, :final delta):
          if (isOpen) {
            _typing = _typing?.agentId == agentId
                ? TypingState(agentId, _typing!.text + delta)
                : TypingState(agentId, delta);
          }
        case WsAgentOutputEvent(:final sessionId, :final text):
          if (isOpen) _append(channelId, AgentOutputEntry(sessionId: sessionId, text: text));
        case WsToolDecisionEvent(:final tool, :final allow, :final reason):
          if (isOpen) _append(channelId, ToolDecisionEntry(tool: tool, allow: allow, reason: reason));
        case WsSessionEndedEvent():
          if (isOpen) {
            final sessionId = _sessionIdByChannel[channelId];
            if (sessionId != null) _endedSessionIds.add(sessionId);
            _append(channelId, const SystemEntry('Session ended'));
          }
        case WsAssistantErrorEvent(:final error):
          if (isOpen) {
            _typing = null;
            _append(channelId, ErrorEntry(error));
          }
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

  /// Runs [action]; if the server demands a fresh re-authentication (step-up),
  /// asks the user to re-authenticate, mints a proof, and retries once. Returns
  /// true iff the action ultimately ran. Non-step-up errors propagate.
  Future<bool> _withStepUp(Future<void> Function() action, {String? label}) async {
    try {
      await action();
      return true;
    } on ApiException catch (e) {
      if (!e.isStepUpRequired || !mounted) rethrow;
      final ok = await showStepUpDialog(context, action: label);
      if (ok != true || !mounted) return false;
      await widget.api.stepUp();
      try {
        await action(); // retry — bearer mode now presents the fresh proof
        return true;
      } on ApiException catch (retry) {
        // In cookie/SSO mode stepUp() navigated to an interactive re-auth (the page is unloading),
        // so the retry can still report stepup_required — that's expected, not an error to surface.
        if (retry.isStepUpRequired) return false;
        rethrow;
      }
    }
  }

  /// Redacts [message] after confirmation — a governed content purge. Steps up
  /// re-auth if the deployment gates redaction on it. The live `redaction` echo
  /// is idempotent; a failure surfaces an error.
  Future<void> _redactMessage(Message message) async {
    final channel = _selected;
    if (channel == null) return;
    final reason = await showRedactDialog(context);
    if (reason == null || !mounted) return;
    try {
      final done = await _withStepUp(() => widget.api.redactMessage(message.id, reason), label: 'redact a message');
      if (done && mounted) setState(() => _applyRedaction(channel.id, message.id));
    } catch (error) {
      _showError(error);
    }
  }

  /// Swaps a message's text to [content] and stamps [editedAt] in the
  /// transcript (so it renders the new text + an "(edited)" marker). Redacted
  /// messages are left alone. Idempotent — a live echo of an optimistic local
  /// edit re-applies the same text harmlessly. Must be called inside setState.
  void _applyEdit(String channelId, String messageId, String content, DateTime editedAt) {
    final existing = _transcripts[channelId];
    if (existing == null) return;
    var changed = false;
    final updated = existing.map((entry) {
      if (entry is MessageEntry &&
          entry.message.id == messageId &&
          !entry.message.isRedacted) {
        changed = true;
        return MessageEntry(entry.message.withEdit(content, editedAt));
      }
      return entry;
    }).toList();
    if (changed) _transcripts[channelId] = updated;
  }

  /// Edits [message] (author only) via a dialog. The new text is applied
  /// optimistically; the live `message_edit` echo reconciles the exact server
  /// timestamp. A failure surfaces an error.
  Future<void> _editMessage(Message message) async {
    final channel = _selected;
    if (channel == null || message.content == null) return;
    final next = await showEditDialog(context, message.content!);
    if (next == null || !mounted) return;
    try {
      await widget.api.editMessage(message.id, next);
      if (!mounted) return;
      setState(() => _applyEdit(channel.id, message.id, next, DateTime.now()));
    } catch (error) {
      _showError(error);
    }
  }

  /// Loads and shows [message]'s full version history (original + every edit).
  Future<void> _openHistory(Message message) async {
    try {
      final revisions = await widget.api.revisions(message.id);
      if (!mounted) return;
      await showHistoryDialog(context, revisions);
    } catch (error) {
      _showError(error);
    }
  }

  /// Replaces the channel's marking in [_channels] (and [_selected]) — used by
  /// the live `channel_marking` event and the optimistic set. Must be inside setState.
  void _applyChannelMarking(String channelId, String marking) {
    _channels = [
      for (final c in _channels) c.id == channelId ? c.withMarking(marking) : c,
    ];
    if (_selected?.id == channelId) _selected = _selected!.withMarking(marking);
  }

  /// Sets/changes the selected channel's classification level via a picker. The
  /// server enforces the set/raise-vs-downgrade authz; a refusal surfaces an error.
  Future<void> _markChannel(Channel channel) async {
    final policy = widget.principal.marking;
    final next = await showMarkingPicker(
      context,
      levels: policy.levels,
      current: channel.cuiMarking,
      // Only an admin may pick a level below the channel's current one (server-enforced too).
      allowDowngrade: widget.principal.isAdmin,
      policy: policy,
    );
    if (next == null || !mounted || next == channel.cuiMarking) return;
    try {
      // A downgrade may be step-up-gated; retry with a fresh proof if so.
      final done = await _withStepUp(
        () => widget.api.setChannelMarking(channel.id, next),
        label: 'change a classification',
      );
      if (done && mounted) setState(() => _applyChannelMarking(channel.id, next));
    } catch (error) {
      _showError(error);
    }
  }

  /// The classification for the channel's top/bottom banners, or null when none should show.
  /// A banner appears ONLY when the channel is itself marked ABOVE the baseline (the channel is the
  /// portion). An unmarked channel shows no banner — its elevated messages are marked per-message
  /// (and masked); a channel explicitly at baseline shows nothing (baseline display is suppressed).
  String? _bannerMarking(Channel channel) {
    if (channel.isMarked && widget.principal.marking.isElevated(channel.cuiMarking!)) {
      return channel.cuiMarking;
    }
    return null;
  }

  /// Message ids the viewer has revealed this session (above-baseline content is masked until
  /// clicked). Ephemeral — cleared on sign-out; re-hidden if the list is rebuilt fresh.
  final Set<String> _revealedMessageIds = {};

  void _toggleReveal(Message message) {
    setState(() {
      if (!_revealedMessageIds.remove(message.id)) _revealedMessageIds.add(message.id);
    });
  }

  /// Tracks the classification provenance of in-app copies so a paste into a
  /// lower-marked destination is guarded (the composer enforces the decision; the
  /// server still enforces the channel ceiling on post).
  final _clipboardGuard = ClipboardGuard();

  /// Downloads an attachment's bytes (authenticated) and saves them (browser download on web).
  Future<void> _downloadAttachment(Attachment attachment) async {
    try {
      final bytes = await widget.api.downloadAttachment(attachment.id);
      if (!mounted) return;
      saveBytes(attachment.filename, attachment.contentType, bytes);
    } catch (error) {
      if (mounted) _showError(error);
    }
  }

  /// Copies a message's text and records its marking as the clipboard provenance.
  void _copyMessage(Message message) {
    final text = message.content ?? '';
    if (text.isEmpty) return;
    unawaited(_clipboardGuard.recordCopy(text, message.marking));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Copied ${message.marking} text')),
      );
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

  /// Whether [channelId] is a coding-agent channel. Coding channels disable
  /// attachments and threads (a linear pi conversation), and `/pi` only works
  /// in one.
  bool _isCodingChannel(String channelId) =>
      _agentKindByChannel[channelId] == AgentKind.coding;

  Future<void> _handleSend(String text, String marking, List<String> attachmentIds) async {
    final channel = _selected;
    if (channel == null) return;
    // A leading "/<known-command>" is a slash command; everything else
    // (including a "/" that doesn't spell a command) is ordinary text.
    final command = parseSlashCommand(text);
    if (command != null) {
      await _runCommand(channel, command, marking);
      return;
    }
    // Every channel — coding-agent channels included — posts through the same message path. The
    // backend forwards a coding channel's messages to pi (with a "who posted it" header) and
    // persists pi's reply, so there's no separate client-side session-drive path any more.
    await _sendPlain(channel, text, marking, attachmentIds);
  }

  /// Picks + uploads files for [channel] (at the channel's marking when it's marked), returning the
  /// created attachments to stage. Used by the composer's attach affordance.
  Future<List<Attachment>> _attachFiles(Channel channel) async {
    final picked = await pickFiles();
    if (picked.isEmpty) return const [];
    final marking = channel.isMarked ? channel.cuiMarking : null;
    final uploaded = <Attachment>[];
    for (final f in picked) {
      uploaded.add(await widget.api.uploadAttachment(
        channel.id,
        bytes: f.bytes,
        filename: f.filename,
        contentType: f.contentType,
        marking: marking,
      ));
    }
    return uploaded;
  }

  /// Sends ordinary (non-command) text as a chat message at classification
  /// [marking]. A coding-agent channel is no different here: the message is
  /// posted like any other, and the BACKEND forwards it to the agent's pi
  /// session (with a "who posted it" header) and persists pi's reply — so the
  /// whole exchange flows through the same message infrastructure.
  Future<void> _sendPlain(Channel channel, String text, String marking, List<String> attachmentIds) async {
    // Append straight from the POST response rather than waiting for a WS
    // echo (some backends don't echo the sender's own message back to
    // them); `_appendMessageUnlessDuplicate` dedupes by id in case the
    // socket *does* also deliver it.
    final message = await widget.api.postMessage(channel.id, text, marking: marking, attachmentIds: attachmentIds);
    if (!mounted) return;
    setState(() => _appendMessageUnlessDuplicate(channel.id, message));
  }

  /// Posts a threaded reply to [parentId] at classification [marking].
  Future<void> _sendReply(Channel channel, String parentId, String text, String marking, List<String> attachmentIds) async {
    final message = await widget.api.postMessage(channel.id, text, parentId: parentId, marking: marking, attachmentIds: attachmentIds);
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
  Future<void> _runCommand(Channel channel, ParsedCommand command, String marking) async {
    switch (command.command.name) {
      case 'help':
        _showCommandHelp();
      case 'invite':
        await _inviteToChannel(channel, command.args.trim());
      case 'shrug':
        final base = command.args.trim();
        await _sendPlain(channel, base.isEmpty ? kShrug : '$base $kShrug', marking, const []);
      case 'pi':
        final input = command.args;
        if (input.trim().isEmpty) {
          _showError(
            'Usage: /pi <message> — passes input to this channel’s coding agent.',
          );
          return;
        }
        if (_agentKindByChannel[channel.id] != AgentKind.coding) {
          _showError('/pi works only in a coding-agent channel.');
          return;
        }
        // Every message in a coding channel already goes to pi; `/pi` is now just an explicit way
        // to post one. It flows through the normal message path (backend forwards it to pi).
        await _sendPlain(channel, input, marking, const []);
    }
  }

  /// `/invite <name-or-email>` — resolve the query against the seen-users directory and add that
  /// user to the current channel. Team channels AND agent/assistant channels are collaborative —
  /// multiple people can share one agent — so both accept invites; only a DM (whose pair is fixed)
  /// does not. A user who has never signed in isn't in the directory yet, so can't be found.
  Future<void> _inviteToChannel(Channel channel, String query) async {
    if (query.isEmpty) {
      _showError('Usage: /invite <name-or-email>');
      return;
    }
    if (channel.kind == ChannelKind.dm) {
      _showError("/invite doesn't work in a direct message — its two participants are fixed.");
      return;
    }
    final q = query.toLowerCase();
    final matches = _usersBySub.values
        .where((u) =>
            u.sub == query ||
            (u.email != null && u.email!.toLowerCase() == q) ||
            (u.displayName != null && u.displayName!.toLowerCase() == q))
        .toList();
    if (matches.isEmpty) {
      _showError('No user matching "$query" — they may need to sign in once first.');
      return;
    }
    if (matches.length > 1) {
      _showError('"$query" matches ${matches.length} users — try their email to disambiguate.');
      return;
    }
    final user = matches.first;
    try {
      await widget.api.addMember(channel.id, user.sub);
      if (!mounted) return;
      final where = channel.name.isEmpty ? 'this channel' : '#${channel.name}';
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Invited ${user.label} to $where')),
      );
    } catch (error) {
      _showError(error);
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
            onMentions: _openMentions,
            mentionCount: _unseenMentions,
            runnerState: _daemon.supported ? _daemon.state : null,
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
                  onlineSubs: _onlineSubs,
                  onSelect: _selectChannel,
                  onNewChannel: _handleNewChannel,
                  onNewDm: _handleNewDm,
                  onNewAssistant: () => _handleNewAgent(AgentKind.assistant),
                  onNewCodingAgent: () => _handleNewAgent(AgentKind.coding),
                  onArchive: _archiveChannel,
                  showArchived: _showArchived,
                  onToggleShowArchived: () =>
                      setState(() => _showArchived = !_showArchived),
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
        canGrant: selected.owned,
        onGrantExecute: () => widget.api.grantExecute(sessionId),
      );
    }

    // An open thread replaces the transcript + composer with a focused view.
    final threadParent = _threadParentId == null
        ? null
        : _messageById(selected.id, _threadParentId!);

    final policy = widget.principal.marking;
    // A banner appears only for a channel marked above baseline (the channel is the portion);
    // otherwise none (an unmarked/baseline channel is clutter-free — elevated messages self-mark).
    final bannerLevel = _bannerMarking(selected);

    return Column(
      children: [
        _ChannelHeader(
          channel: selected,
          title: _channelTitle(selected),
          agentKind: _agentKindByChannel[selected.id],
          models: _models,
          currentModel: selected.agentModel,
          onModelChanged: (model) => _setAgentModel(selected, model),
          onMarkChannel: () => _markChannel(selected),
          // Membership is fixed for a DM (a 1:1 pair); every other channel gets the panel.
          onMembers: selected.kind == ChannelKind.dm ? null : () => _openMembers(selected),
          onPins: () => _openPins(selected),
        ),
        // Classification banners frame the whole channel view, top and bottom (DoDI 5200.48).
        if (bannerLevel != null) MarkingBanner(level: bannerLevel),
        if (codingStrip != null && threadParent == null) codingStrip,
        if (threadParent != null)
          Expanded(child: _buildThread(selected, threadParent))
        else ...[
          Expanded(child: _buildTranscript(selected)),
          _TypingLine(labels: _typersIn(selected.id).map(_labelForSub).toList()),
          MessageComposer(
            // Keyed per channel so switching re-creates the composer, seeding its own channel's draft.
            key: ValueKey('composer-${selected.id}'),
            onSend: _handleSend,
            // Attach files on chat channels; coding-agent channels are a linear pi conversation (no attach).
            onAttach: _isCodingChannel(selected.id) ? null : () => _attachFiles(selected),
            onTyping: () => _emitTyping(selected.id),
            initialText: _draftsByChannel[selected.id] ?? '',
            onDraftChanged: (text) => _draftsByChannel[selected.id] = text,
            markingLevels: policy.levels,
            markingCategories: policy.categories,
            markingPolicy: policy,
            clipboardGuard: _clipboardGuard,
            channelMarking: selected.isMarked ? selected.cuiMarking : null,
            initialMarking: policy.defaultLevel,
            mentionUsers: _mentionUsers,
          ),
        ],
        if (bannerLevel != null) MarkingBanner(level: bannerLevel),
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
    // Threads are a chat-channel affordance; a coding-agent channel is a linear
    // pi conversation, so no threading there.
    final canThread = !_isCodingChannel(selected.id);
    return MessageList(
      entries: topLevel,
      typing: _typing,
      currentUserSub: widget.principal.sub,
      labelForSub: _labelForSub,
      onToggleReaction: _toggleReaction,
      replyCounts: replyCounts,
      onOpenThread: canThread ? _openThread : null,
      isAdmin: widget.principal.isAdmin,
      // Coding-channel messages are local echoes (no server id) — not redactable.
      onRedact: canThread ? _redactMessage : null,
      onEdit: canThread ? _editMessage : null,
      onViewHistory: canThread ? _openHistory : null,
      onCopy: _copyMessage,
      onDownloadAttachment: _downloadAttachment,
      // Pinning: coding-channel local echoes have no server id, so only real channels can pin.
      onTogglePin: canThread ? _togglePin : null,
      pinnedIds: _pinnedIds,
      // Older-history paging: a cursor means there's more to load above.
      hasMore: _cursors[selected.id] != null,
      loadingOlder: _loadingOlder,
      onLoadOlder: () => _loadOlder(selected.id),
      // Per-message marking + mask-until-revealed only when the channel isn't itself the portion.
      showMarking: !selected.isMarked,
      markingPolicy: widget.principal.marking,
      revealedIds: _revealedMessageIds,
      onToggleReveal: _toggleReveal,
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
            labelForSub: _labelForSub,
            onToggleReaction: _toggleReaction,
            isAdmin: widget.principal.isAdmin,
            onRedact: _redactMessage,
            onEdit: _editMessage,
            onViewHistory: _openHistory,
            onCopy: _copyMessage,
            onDownloadAttachment: _downloadAttachment,
            showMarking: !channel.isMarked,
            markingPolicy: widget.principal.marking,
            revealedIds: _revealedMessageIds,
            onToggleReveal: _toggleReveal,
            // one level deep — no nested thread affordance inside a thread
          ),
        ),
        MessageComposer(
          onSend: (text, marking, attachmentIds) => _sendReply(channel, parent.id, text, marking, attachmentIds),
          onAttach: () => _attachFiles(channel),
          markingLevels: widget.principal.marking.levels,
          markingCategories: widget.principal.marking.categories,
          markingPolicy: widget.principal.marking,
          clipboardGuard: _clipboardGuard,
          channelMarking: channel.isMarked ? channel.cuiMarking : null,
          initialMarking: widget.principal.marking.defaultLevel,
          mentionUsers: _mentionUsers,
        ),
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

/// The ephemeral "X is typing…" line shown just above the composer (empty when nobody's typing).
class _TypingLine extends StatelessWidget {
  const _TypingLine({required this.labels});

  final List<String> labels;

  @override
  Widget build(BuildContext context) {
    if (labels.isEmpty) return const SizedBox.shrink();
    final text = switch (labels.length) {
      1 => '${labels.first} is typing…',
      2 => '${labels[0]} and ${labels[1]} are typing…',
      _ => 'Several people are typing…',
    };
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 2, 22, 4),
      alignment: Alignment.centerLeft,
      child: Text(text, style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint)),
    );
  }
}

class _ChannelHeader extends StatelessWidget {
  const _ChannelHeader({
    required this.channel,
    required this.title,
    required this.agentKind,
    this.models = const [],
    this.currentModel,
    this.onModelChanged,
    this.onMarkChannel,
    this.onMembers,
    this.onPins,
  });

  final Channel channel;
  final String title;
  final AgentKind? agentKind;

  /// Models the gateway offers (`GET /models`) — populates the assistant model
  /// picker. Empty ⇒ the picker isn't shown.
  final List<ModelInfo> models;

  /// The assistant's current model id (`channel.agentModel`), or null for the
  /// deployment default. Selected in the picker.
  final String? currentModel;

  /// Switch the assistant's model (→ `PATCH /agents/:id`). Null ⇒ no picker (a
  /// non-assistant channel, or models not loaded).
  final ValueChanged<String>? onModelChanged;

  /// Opens the channel-classification picker (set/raise for members, downgrade
  /// for admins). Null disables the control.
  final VoidCallback? onMarkChannel;

  /// Opens the members panel (view roster; owners/admins manage). Null hides it
  /// (e.g. DMs — a fixed 1:1 pair).
  final VoidCallback? onMembers;

  /// Opens the pinned-messages panel. Null hides the control.
  final VoidCallback? onPins;

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
          if (agentKind == AgentKind.assistant &&
              onModelChanged != null &&
              models.isNotEmpty) ...[
            const SizedBox(width: 12),
            _ModelPicker(
              models: models,
              current: currentModel,
              onChanged: onModelChanged!,
            ),
          ],
          const Spacer(),
          if (onPins != null) ...[
            IconButton(
              onPressed: onPins,
              icon: const Icon(Icons.push_pin_outlined, size: 16),
              tooltip: 'Pinned messages',
              color: AppColors.textMuted,
              visualDensity: VisualDensity.compact,
            ),
            const SizedBox(width: 4),
          ],
          if (onMembers != null) ...[
            IconButton(
              onPressed: onMembers,
              icon: const Icon(Icons.group_outlined, size: 17),
              tooltip: 'Members',
              color: AppColors.textMuted,
              visualDensity: VisualDensity.compact,
            ),
            const SizedBox(width: 4),
          ],
          if (onMarkChannel != null) ...[
            _ChannelMarkingButton(channel: channel, onTap: onMarkChannel!),
            const SizedBox(width: 10),
          ],
          Text(
            shortId(channel.id),
            style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint),
          ),
        ],
      ),
    );
  }
}

/// The assistant channel's model selector (header). Lists what the gateway
/// offers (`GET /models`), including `auto` for router-chosen routing; picking
/// one PATCHes the agent's model live. If the current model isn't in the
/// offered list (an unknown/stale id, or the deployment default when null), it's
/// added so the dropdown always has a valid selection to show.
class _ModelPicker extends StatelessWidget {
  const _ModelPicker({
    required this.models,
    required this.current,
    required this.onChanged,
  });

  final List<ModelInfo> models;
  final String? current;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final ids = <String>[for (final m in models) m.id];
    // The effective selection: the current model, or "auto" if unset (router-
    // chosen is the natural default). Ensure it's present as an option.
    final selected = current ?? 'auto';
    if (!ids.contains(selected)) ids.insert(0, selected);

    String labelFor(String id) {
      for (final m in models) {
        if (m.id == id) return m.label;
      }
      return id == 'auto' ? 'Auto (router picks)' : id;
    }

    return Tooltip(
      message: 'Model for this assistant',
      child: DropdownButton<String>(
        value: selected,
        isDense: true,
        underline: const SizedBox.shrink(),
        borderRadius: BorderRadius.circular(8),
        dropdownColor: AppColors.surface,
        icon: const Icon(Icons.expand_more, size: 16, color: AppColors.textMuted),
        style: AppFonts.mono(fontSize: 12, color: AppColors.text),
        items: [
          for (final id in ids)
            DropdownMenuItem<String>(
              value: id,
              child: Text(labelFor(id)),
            ),
        ],
        onChanged: (id) {
          if (id != null && id != current) onChanged(id);
        },
      ),
    );
  }
}

/// The channel-classification control in the header: shows the channel's level
/// (or "MARK…" when unmarked) and opens the picker on tap.
class _ChannelMarkingButton extends StatelessWidget {
  const _ChannelMarkingButton({required this.channel, required this.onTap});

  final Channel channel;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final marked = channel.isMarked;
    final style = marked ? markingStyle(channel.cuiMarking!) : (bg: AppColors.surfaceRaised, fg: AppColors.textMuted);
    return Tooltip(
      message: marked ? 'Channel classification — tap to change' : 'Mark this channel',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(4),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
          decoration: BoxDecoration(
            color: style.bg,
            borderRadius: BorderRadius.circular(4),
            border: marked ? null : Border.all(color: AppColors.border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.shield_outlined, size: 13, color: style.fg),
              const SizedBox(width: 5),
              Text(
                marked ? channel.cuiMarking!.toUpperCase() : 'MARK…',
                style: AppFonts.mono(fontSize: 10.5, color: style.fg).copyWith(fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
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
