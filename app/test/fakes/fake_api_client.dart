import 'package:secchat_app/api.dart';
import 'package:secchat_app/models.dart';

/// In-memory [ApiClient] for widget tests -- no network, no WebSocket.
/// [subscribeChannel] returns an empty stream by default so tests never
/// depend on real timers or sockets to settle; construct with
/// [wsEventsByChannel] and call `.add(...)` on the returned controller if a
/// test needs to simulate a live event.
class FakeApiClient implements ApiClient {
  FakeApiClient({
    Principal? me,
    List<Channel>? channels,
    List<User>? users,
    Map<String, List<Message>>? messagesByChannel,
  }) : me = me ?? const Principal(sub: 'dev.tester', groups: []),
       channels = List.of(channels ?? const []),
       users = List.of(users ?? const []),
       _messagesByChannel = {
         for (final entry in (messagesByChannel ?? const {}).entries)
           entry.key: List.of(entry.value),
       };

  final Principal me;
  List<Channel> channels;
  List<User> users;
  final Map<String, List<Message>> _messagesByChannel;
  final Map<String, Channel> _dmByPeer = {};

  /// Every `postMessage` call, in order (`parentId` set for a threaded reply,
  /// `marking` set when a per-message classification was chosen).
  final List<({String channelId, String content, String? parentId, String? marking})> postMessageCalls = [];

  /// Every `createChannel` call's requested marking (null when unmarked), and
  /// every `setChannelMarking` call, in order.
  final List<String?> createChannelMarkings = [];
  final List<({String channelId, String marking})> setMarkingCalls = [];

  /// Every `sendInput` call, in order, as `(sessionId, text)`.
  final List<({String sessionId, String text})> sendInputCalls = [];

  /// Every `createAgent` call, in order.
  final List<({AgentKind kind, String name})> createAgentCalls = [];

  /// Every `createDm` call, in order, as the target user sub.
  final List<String> createDmCalls = [];

  /// Every `grantExecute` call, in order.
  final List<String> grantExecuteCalls = [];

  int getChannelsCallCount = 0;
  int getMessagesCallCount = 0;

  /// Override to control what `postMessage` returns, e.g. to simulate a
  /// server-assigned id/timestamp.
  Message Function(String channelId, String content)? postMessageResponder;

  /// Override to make any call throw, keyed by a description of the call
  /// (`'getChannels'`, `'getMessages'`, `'postMessage'`, `'createChannel'`,
  /// `'createAgent'`, `'grantExecute'`, `'sendInput'`).
  final Map<String, Object> failures = {};

  void _maybeThrow(String op) {
    final failure = failures[op];
    if (failure != null) throw failure;
  }

  @override
  Future<Principal> getMe() async => me;

  @override
  Future<List<Channel>> getChannels() async {
    getChannelsCallCount++;
    _maybeThrow('getChannels');
    return List.of(channels);
  }

  @override
  Future<Channel> createChannel(String name, {String? marking}) async {
    _maybeThrow('createChannel');
    createChannelMarkings.add(marking);
    final channel = Channel(
      id: 'ch-${channels.length + 1}',
      kind: ChannelKind.human,
      name: name,
      cuiMarking: marking,
    );
    channels = [...channels, channel];
    return channel;
  }

  @override
  Future<Channel> setChannelMarking(String channelId, String marking) async {
    _maybeThrow('setChannelMarking');
    setMarkingCalls.add((channelId: channelId, marking: marking));
    channels = [
      for (final c in channels) c.id == channelId ? c.withMarking(marking) : c,
    ];
    return channels.firstWhere((c) => c.id == channelId);
  }

  @override
  Future<List<Message>> getMessages(String channelId) async {
    getMessagesCallCount++;
    _maybeThrow('getMessages');
    return List.of(_messagesByChannel[channelId] ?? const []);
  }

  @override
  Future<MessagePage> getMessagePage(String channelId, {int? limit, int? before}) async {
    getMessagesCallCount++;
    _maybeThrow('getMessages');
    final seeded = List<Message>.of(_messagesByChannel[channelId] ?? const [])
      ..sort((a, b) => a.seq.compareTo(b.seq));
    var pool = seeded;
    if (before != null) pool = pool.where((m) => m.seq < before).toList();
    final page = (limit != null && pool.length > limit) ? pool.sublist(pool.length - limit) : pool;
    final oldestSeq = seeded.isEmpty ? null : seeded.first.seq;
    final hasOlder = page.isNotEmpty && oldestSeq != null && page.first.seq > oldestSeq;
    return MessagePage(messages: page, nextCursor: hasOlder ? page.first.seq : null);
  }

  @override
  Future<Message> postMessage(String channelId, String content, {String? parentId, String? marking}) async {
    _maybeThrow('postMessage');
    postMessageCalls.add((channelId: channelId, content: content, parentId: parentId, marking: marking));
    final existing = _messagesByChannel[channelId] ?? const [];
    final message =
        postMessageResponder?.call(channelId, content) ??
        Message(
          id: 'm-${postMessageCalls.length}',
          seq: existing.length + 1,
          authorRef: me.sub,
          authorType: AuthorType.user,
          content: content,
          createdAt: DateTime(2026, 1, 1),
          parentId: parentId,
          marking: marking ?? 'UNCLASSIFIED',
        );
    _messagesByChannel[channelId] = [...existing, message];
    return message;
  }

  @override
  Future<void> sendInput(String sessionId, String text) async {
    _maybeThrow('sendInput');
    sendInputCalls.add((sessionId: sessionId, text: text));
  }

  /// Every reaction call, in order (`add: false` for a remove).
  final List<({String messageId, String emoji, bool add})> reactionCalls = [];

  @override
  Future<void> addReaction(String messageId, String emoji) async {
    _maybeThrow('addReaction');
    reactionCalls.add((messageId: messageId, emoji: emoji, add: true));
  }

  @override
  Future<void> removeReaction(String messageId, String emoji) async {
    _maybeThrow('removeReaction');
    reactionCalls.add((messageId: messageId, emoji: emoji, add: false));
  }

  /// Per-channel unread counts reported by [getUnread]; tests set these directly.
  final Map<String, int> unreadByChannel = {};

  /// Every `markRead` call, in order.
  final List<({String channelId, int seq})> markReadCalls = [];

  /// Results [search] returns; the queries it was called with.
  List<SearchHit> searchResults = const [];
  final List<String> searchCalls = [];

  @override
  Future<int> getUnread(String channelId) async {
    _maybeThrow('getUnread');
    return unreadByChannel[channelId] ?? 0;
  }

  @override
  Future<void> markRead(String channelId, int seq) async {
    _maybeThrow('markRead');
    markReadCalls.add((channelId: channelId, seq: seq));
    unreadByChannel[channelId] = 0;
  }

  @override
  Future<List<SearchHit>> search(String query) async {
    _maybeThrow('search');
    searchCalls.add(query);
    return List.of(searchResults);
  }

  /// Every `redactMessage` call, in order.
  final List<({String messageId, String reason})> redactCalls = [];

  /// When true, `redactMessage` throws `stepup_required` until [stepUp] is
  /// called — simulating a deployment that gates redaction on a fresh re-auth.
  bool redactRequiresStepUp = false;
  int stepUpCalls = 0;
  bool _steppedUp = false;

  @override
  Future<void> stepUp() async {
    _maybeThrow('stepUp');
    stepUpCalls++;
    _steppedUp = true;
  }

  @override
  Future<void> redactMessage(String messageId, String reason) async {
    _maybeThrow('redactMessage');
    if (redactRequiresStepUp && !_steppedUp) {
      throw const ApiException(403, 'stepup_required');
    }
    redactCalls.add((messageId: messageId, reason: reason));
  }

  /// Every `editMessage` call, in order.
  final List<({String messageId, String content})> editCalls = [];

  @override
  Future<void> editMessage(String messageId, String content) async {
    _maybeThrow('editMessage');
    editCalls.add((messageId: messageId, content: content));
  }

  /// Canned revision history returned by [revisions], keyed by message id.
  final Map<String, List<MessageRevision>> revisionsByMessage = {};

  @override
  Future<List<MessageRevision>> revisions(String messageId) async {
    _maybeThrow('revisions');
    return List.of(revisionsByMessage[messageId] ?? const []);
  }

  @override
  Future<List<User>> getUsers() async {
    _maybeThrow('getUsers');
    return List.of(users);
  }

  @override
  Future<Channel> createDm(String userSub) async {
    _maybeThrow('createDm');
    createDmCalls.add(userSub);
    // Idempotent, like the real backend: the same peer always resolves to the
    // same channel.
    final existing = _dmByPeer[userSub];
    if (existing != null) return existing;
    final channel = Channel(
      id: 'dm-${_dmByPeer.length + 1}',
      kind: ChannelKind.dm,
      name: '',
      members: [me.sub, userSub],
    );
    _dmByPeer[userSub] = channel;
    channels = [...channels, channel];
    return channel;
  }

  @override
  Future<CreateAgentResult> createAgent({
    required AgentKind kind,
    required String name,
  }) async {
    _maybeThrow('createAgent');
    createAgentCalls.add((kind: kind, name: name));
    final index = channels.length + 1;
    final channel = Channel(id: 'agent-ch-$index', kind: ChannelKind.agent, name: name);
    final agent = Agent(id: 'agent-$index', kind: kind, name: name);
    channels = [...channels, channel];
    return CreateAgentResult(
      agent: agent,
      channel: channel,
      session: kind == AgentKind.coding
          ? AgentSession(id: 'session-$index')
          : null,
    );
  }

  @override
  Future<GrantExecuteResult> grantExecute(
    String sessionId, {
    String scope = 'once',
  }) async {
    _maybeThrow('grantExecute');
    grantExecuteCalls.add(sessionId);
    return const GrantExecuteResult(allow: true, reason: 'granted for test');
  }

  @override
  Stream<WsEvent> subscribeChannel(String channelId) => const Stream.empty();

  @override
  void dispose() {}
}
