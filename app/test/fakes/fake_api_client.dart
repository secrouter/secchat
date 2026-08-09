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

  /// Every `postMessage` call, in order, as `(channelId, content)`.
  final List<({String channelId, String content})> postMessageCalls = [];

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
  Future<Channel> createChannel(String name) async {
    _maybeThrow('createChannel');
    final channel = Channel(
      id: 'ch-${channels.length + 1}',
      kind: ChannelKind.human,
      name: name,
    );
    channels = [...channels, channel];
    return channel;
  }

  @override
  Future<List<Message>> getMessages(String channelId) async {
    getMessagesCallCount++;
    _maybeThrow('getMessages');
    return List.of(_messagesByChannel[channelId] ?? const []);
  }

  @override
  Future<Message> postMessage(String channelId, String content) async {
    _maybeThrow('postMessage');
    postMessageCalls.add((channelId: channelId, content: content));
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
        );
    _messagesByChannel[channelId] = [...existing, message];
    return message;
  }

  @override
  Future<void> sendInput(String sessionId, String text) async {
    _maybeThrow('sendInput');
    sendInputCalls.add((sessionId: sessionId, text: text));
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
