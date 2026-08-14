import 'dart:async';
import 'dart:convert';

import 'package:secchat_app/api.dart';
import 'package:secchat_app/models.dart';

/// In-memory [ApiClient] for widget tests -- no network, no WebSocket.
/// [subscribeChannel] returns an empty stream by default so tests never
/// depend on real timers or sockets to settle; construct with
/// [wsEventsByChannel] and call `.add(...)` on the returned controller if a
/// test needs to simulate a live event.
class FakeApiClient implements ApiClient {
  @override
  Uri get origin => Uri.parse('http://127.0.0.1:47010');

  @override
  String? get token => 'dev.alice.eng';

  /// A minted runner token to return (null ⇒ feature off); records mint calls.
  String? runnerTokenToMint;
  int mintRunnerTokenCalls = 0;

  @override
  Future<String?> mintRunnerToken() async {
    mintRunnerTokenCalls++;
    return runnerTokenToMint;
  }

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

  /// Git SSH identity fake state. `sshEnabled=false` makes [getSshKey] throw a 503
  /// (feature-off), matching the real server; otherwise it returns [sshKey].
  SshKeyInfo? sshKey;
  bool sshEnabled = true;

  @override
  Future<SshKeyInfo?> getSshKey() async {
    if (!sshEnabled) throw const ApiException(503, 'ssh_keys_unavailable');
    return sshKey;
  }

  @override
  Future<SshKeyInfo> generateSshKey() async {
    sshKey = const SshKeyInfo(
      keyType: 'ssh-ed25519',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAFAKEKEY test@example',
      fingerprint: 'SHA256:fakefingerprintvalue',
      createdAt: '2026-01-01T00:00:00.000Z',
    );
    return sshKey!;
  }

  @override
  Future<void> deleteSshKey() async {
    sshKey = null;
  }

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

  /// Attachment ids passed to the most recent postMessage (for A1b assertions).
  List<String>? lastPostAttachmentIds;

  @override
  Future<Message> postMessage(String channelId, String content, {String? parentId, String? marking, List<String>? attachmentIds}) async {
    _maybeThrow('postMessage');
    postMessageCalls.add((channelId: channelId, content: content, parentId: parentId, marking: marking));
    lastPostAttachmentIds = attachmentIds;
    final existing = _messagesByChannel[channelId] ?? const [];
    final files = (attachmentIds ?? const <String>[]).map((id) => _attachments[id]).whereType<Attachment>().toList();
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
          attachments: files,
        );
    _messagesByChannel[channelId] = [...existing, message];
    return message;
  }

  final Map<String, Attachment> _attachments = {};
  final List<({String channelId, String filename, String? marking})> uploadCalls = [];

  @override
  Future<Attachment> uploadAttachment(String channelId, {required List<int> bytes, required String filename, required String contentType, String? marking}) async {
    _maybeThrow('uploadAttachment');
    uploadCalls.add((channelId: channelId, filename: filename, marking: marking));
    final att = Attachment(
      id: 'att-${_attachments.length + 1}',
      filename: filename,
      contentType: contentType,
      byteSize: bytes.length,
      marking: marking ?? 'UNCLASSIFIED',
    );
    _attachments[att.id] = att;
    return att;
  }

  @override
  Future<List<int>> downloadAttachment(String id) async {
    _maybeThrow('downloadAttachment');
    return utf8.encode('bytes-for-$id');
  }

  @override
  Future<void> sendInput(String sessionId, String text) async {
    _maybeThrow('sendInput');
    sendInputCalls.add((sessionId: sessionId, text: text));
  }

  /// Every `ensureSession` call, in order (the channel id passed).
  final List<String> ensureSessionCalls = [];

  @override
  Future<AgentSession> ensureSession(String channelId) async {
    _maybeThrow('ensureSession');
    ensureSessionCalls.add(channelId);
    return AgentSession(id: 'session-for-$channelId');
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

  /// Seed the mentions inbox a test should see; `unseenMentions` drives the badge.
  List<Mention> mentions = [];
  int unseenMentions = 0;

  /// Every `markMentionsSeen` call's `ids` arg (null = "all"), in order.
  final List<List<String>?> markMentionsSeenCalls = [];

  @override
  Future<({List<Mention> mentions, int unseen})> getMentions({bool unseenOnly = false, int? limit}) async {
    _maybeThrow('getMentions');
    final list = unseenOnly ? mentions.where((m) => m.seenAt == null).toList() : List.of(mentions);
    return (mentions: list, unseen: unseenMentions);
  }

  @override
  Future<int> markMentionsSeen({List<String>? ids}) async {
    _maybeThrow('markMentionsSeen');
    markMentionsSeenCalls.add(ids);
    unseenMentions = 0;
    return 0;
  }

  /// Every channelId passed to sendTyping, in order.
  final List<String> typingCalls = [];

  /// Subs a test should report as online from getPresence.
  List<String> presenceOnline = [];

  @override
  void sendTyping(String channelId) => typingCalls.add(channelId);

  @override
  Future<List<String>> getPresence() async {
    _maybeThrow('getPresence');
    return List.of(presenceOnline);
  }

  /// Members per channel a test should see; the membership calls mutate these so a reload reflects them.
  final Map<String, List<ChannelMember>> membersByChannel = {};

  /// Every membership mutation, in order (op ∈ add/role/remove).
  final List<({String op, String channelId, String ref, String? role})> memberCalls = [];

  @override
  Future<List<ChannelMember>> getMembers(String channelId) async {
    _maybeThrow('getMembers');
    return List.of(membersByChannel[channelId] ?? const []);
  }

  @override
  Future<void> addMember(String channelId, String userSub, {String role = 'member'}) async {
    _maybeThrow('addMember');
    memberCalls.add((op: 'add', channelId: channelId, ref: userSub, role: role));
    final list = membersByChannel.putIfAbsent(channelId, () => []);
    list.removeWhere((m) => m.memberRef == userSub);
    list.add(ChannelMember(memberRef: userSub, memberType: 'user', role: role, displayName: userSub));
  }

  @override
  Future<void> removeMember(String channelId, String memberRef) async {
    _maybeThrow('removeMember');
    memberCalls.add((op: 'remove', channelId: channelId, ref: memberRef, role: null));
    membersByChannel[channelId]?.removeWhere((m) => m.memberRef == memberRef);
  }

  /// Pinned messages per channel a test should see; the pin calls mutate these.
  final Map<String, List<PinnedMessage>> pinsByChannel = {};

  /// Every pin/unpin call, in order.
  final List<({String op, String messageId})> pinCalls = [];

  @override
  Future<List<PinnedMessage>> getPins(String channelId) async {
    _maybeThrow('getPins');
    return List.of(pinsByChannel[channelId] ?? const []);
  }

  /// Admin overview a test should see from [getAdminOverview]; null ⇒ an empty snapshot.
  AdminOverview? adminOverview;

  @override
  Future<AdminOverview> getAdminOverview() async {
    _maybeThrow('getAdminOverview');
    return adminOverview ??
        const AdminOverview(
          generatedAt: '',
          channels: [],
          agents: [],
          sessions: [],
          audit: [],
          messagesChainOk: true,
          auditChainOk: true,
        );
  }

  /// Pool status a test should see from [getPoolStatus]; null ⇒ "no pool configured".
  PoolStatus? poolStatus;

  @override
  Future<PoolStatus> getPoolStatus() async {
    _maybeThrow('getPoolStatus');
    return poolStatus ?? const PoolStatus(configured: false);
  }

  /// Inbound webhooks per channel; the webhook calls mutate these.
  final Map<String, List<Webhook>> webhooksByChannel = {};

  /// Every webhook mutation, in order.
  final List<({String op, String channelId, String? webhookId})> webhookCalls = [];
  int _nextWebhookId = 1;

  @override
  Future<List<Webhook>> listWebhooks(String channelId) async {
    _maybeThrow('listWebhooks');
    return List.of(webhooksByChannel[channelId] ?? const []);
  }

  /// Channel display names for the global webhook view's [Webhook.channelName] annotation.
  final Map<String, String> channelNamesById = {};

  @override
  Future<List<Webhook>> listAllWebhooks() async {
    _maybeThrow('listAllWebhooks');
    return [
      for (final entry in webhooksByChannel.entries)
        for (final w in entry.value)
          Webhook(
            id: w.id,
            channelId: w.channelId,
            token: w.token,
            createdBy: w.createdBy,
            createdAt: w.createdAt,
            channelName: channelNamesById[entry.key] ?? entry.key,
          ),
    ];
  }

  @override
  Future<Webhook> createWebhook(String channelId) async {
    _maybeThrow('createWebhook');
    final wh = Webhook(
      id: 'wh-${_nextWebhookId++}',
      channelId: channelId,
      token: 'tok-${DateTime.now().microsecondsSinceEpoch}',
      createdBy: me.sub,
      createdAt: DateTime.now().toUtc().toIso8601String(),
    );
    webhooksByChannel.putIfAbsent(channelId, () => []).insert(0, wh);
    webhookCalls.add((op: 'create', channelId: channelId, webhookId: wh.id));
    return wh;
  }

  @override
  Future<void> deleteWebhook(String channelId, String webhookId) async {
    _maybeThrow('deleteWebhook');
    webhookCalls.add((op: 'delete', channelId: channelId, webhookId: webhookId));
    webhooksByChannel[channelId]?.removeWhere((w) => w.id == webhookId);
  }

  /// Outbound webhooks per channel; the outbound calls mutate these.
  final Map<String, List<OutboundWebhook>> outboundByChannel = {};

  /// Every outbound mutation, in order.
  final List<({String op, String channelId, String? id})> outboundCalls = [];
  int _nextOutboundId = 1;

  /// Status the fake test-delivery returns.
  int outboundTestStatus = 200;

  @override
  Future<List<OutboundWebhook>> listOutboundWebhooks(String channelId) async {
    _maybeThrow('listOutboundWebhooks');
    return List.of(outboundByChannel[channelId] ?? const []);
  }

  @override
  Future<List<OutboundWebhook>> listAllOutboundWebhooks() async {
    _maybeThrow('listAllOutboundWebhooks');
    return [
      for (final entry in outboundByChannel.entries)
        for (final w in entry.value)
          OutboundWebhook(
            id: w.id,
            channelId: w.channelId,
            url: w.url,
            secret: w.secret,
            events: w.events,
            includeContent: w.includeContent,
            active: w.active,
            createdBy: w.createdBy,
            createdAt: w.createdAt,
            lastStatus: w.lastStatus,
            channelName: channelNamesById[entry.key] ?? entry.key,
          ),
    ];
  }

  @override
  Future<OutboundWebhook> createOutboundWebhook(
    String channelId, {
    required String url,
    required List<String> events,
    bool includeContent = false,
  }) async {
    _maybeThrow('createOutboundWebhook');
    final wh = OutboundWebhook(
      id: 'owh-${_nextOutboundId++}',
      channelId: channelId,
      url: url,
      secret: 'sec-${DateTime.now().microsecondsSinceEpoch}',
      events: events,
      includeContent: includeContent,
      active: true,
      createdBy: me.sub,
      createdAt: DateTime.now().toUtc().toIso8601String(),
    );
    outboundByChannel.putIfAbsent(channelId, () => []).insert(0, wh);
    outboundCalls.add((op: 'create', channelId: channelId, id: wh.id));
    return wh;
  }

  @override
  Future<void> deleteOutboundWebhook(String channelId, String id) async {
    _maybeThrow('deleteOutboundWebhook');
    outboundCalls.add((op: 'delete', channelId: channelId, id: id));
    outboundByChannel[channelId]?.removeWhere((w) => w.id == id);
  }

  @override
  Future<OutboundTestResult> testOutboundWebhook(String channelId, String id) async {
    _maybeThrow('testOutboundWebhook');
    outboundCalls.add((op: 'test', channelId: channelId, id: id));
    return OutboundTestResult(status: outboundTestStatus);
  }

  @override
  Future<void> pinMessage(String messageId) async {
    _maybeThrow('pinMessage');
    pinCalls.add((op: 'pin', messageId: messageId));
  }

  @override
  Future<void> unpinMessage(String messageId) async {
    _maybeThrow('unpinMessage');
    pinCalls.add((op: 'unpin', messageId: messageId));
    for (final list in pinsByChannel.values) {
      list.removeWhere((p) => p.messageId == messageId);
    }
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

  /// Launch environments returned by [getLaunchEnvironments] (default: desktop
  /// available, pool coming soon). Override to drive the picker in tests.
  List<LaunchEnv> launchEnvironments = const [
    LaunchEnv(id: 'desktop', label: 'My desktop app', available: true, reason: 'connected', detail: 'Runs on your connected desktop app.'),
    LaunchEnv(id: 'pool', label: 'Online pool', available: false, reason: 'not_deployed', detail: 'Coming soon.'),
  ];

  @override
  Future<List<LaunchEnv>> getLaunchEnvironments() async {
    _maybeThrow('getLaunchEnvironments');
    return List.of(launchEnvironments);
  }

  /// The `launchEnv` / `workspace` passed to the most recent [createAgent], if any.
  String? lastCreateAgentLaunchEnv;
  String? lastCreateAgentWorkspace;

  @override
  Future<CreateAgentResult> createAgent({
    required AgentKind kind,
    required String name,
    String? launchEnv,
    String? workspace,
  }) async {
    _maybeThrow('createAgent');
    lastCreateAgentLaunchEnv = launchEnv;
    lastCreateAgentWorkspace = workspace;
    createAgentCalls.add((kind: kind, name: name));
    final index = channels.length + 1;
    // The creator owns the agent, so the channel comes back owned (mirrors the real
    // POST /agents, which enriches its channel the same way GET /channels does).
    final channel = Channel(
      id: 'agent-ch-$index',
      kind: ChannelKind.agent,
      name: name,
      agentKind: kind,
      agentId: 'agent-$index',
      owned: true,
    );
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

  /// Models [listModels] returns (default empty). Set to drive the picker.
  List<ModelInfo> models = const [];

  /// Every `setAgentModel` call, in order, as `(agentId, model)`.
  final List<({String agentId, String model})> setAgentModelCalls = [];

  @override
  Future<List<ModelInfo>> listModels() async {
    _maybeThrow('listModels');
    return List.of(models);
  }

  @override
  Future<void> setAgentModel(String agentId, String model) async {
    _maybeThrow('setAgentModel');
    setAgentModelCalls.add((agentId: agentId, model: model));
  }

  /// Every `archiveChannel` call, in order, as `(channelId, archived)`.
  final List<({String channelId, bool archived})> archiveChannelCalls = [];

  @override
  Future<void> archiveChannel(String channelId, {bool archived = true}) async {
    _maybeThrow('archiveChannel');
    archiveChannelCalls.add((channelId: channelId, archived: archived));
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

  /// Every `revokeExecute` call, in order.
  final List<String> revokeExecuteCalls = [];

  @override
  Future<GrantExecuteResult> revokeExecute(String sessionId) async {
    _maybeThrow('revokeExecute');
    revokeExecuteCalls.add(sessionId);
    return const GrantExecuteResult(allow: true, reason: 'revoked for test');
  }

  @override
  Stream<WsEvent> subscribeChannel(String channelId) => const Stream.empty();

  /// A controllable global event stream: tests push events with [emitWs] and the
  /// ChatScreen (subscribed via [subscribeAll]) routes them by `channelId`.
  final _wsController = StreamController<WsEvent>.broadcast();

  /// Emit a WS event to the subscribed ChatScreen (routed by its `channelId`).
  void emitWs(WsEvent event) => _wsController.add(event);

  @override
  Stream<WsEvent> subscribeAll() => _wsController.stream;

  @override
  void dispose() {
    unawaited(_wsController.close());
  }
}
