/// Wire models for the SecChat backend API, plus the small set of
/// UI-transcript types the chat screen builds from live WebSocket events.
///
/// Every `fromJson` is deliberately defensive about optional/missing fields
/// (the backend contract is a dev-stage spec, not a locked schema) but
/// deliberately strict about the fields each screen actually depends on.
library;

/// The three channel kinds the backend returns from `GET /channels`.
///
/// Note this does *not* distinguish an "assistant" agent channel from a
/// "coding" agent channel -- both come back as [ChannelKind.agent]. See the
/// `_agentKindByChannel` note in `lib/screens/chat.dart` for how the app
/// recovers that distinction for channels it creates itself.
enum ChannelKind {
  human,
  agent,
  dm;

  static ChannelKind fromWire(String? raw) => switch (raw) {
    'agent' => ChannelKind.agent,
    'dm' => ChannelKind.dm,
    _ => ChannelKind.human,
  };

  String get label => switch (this) {
    ChannelKind.human => 'Channel',
    ChannelKind.agent => 'Agent',
    ChannelKind.dm => 'DM',
  };
}

enum AuthorType {
  user,
  agent;

  static AuthorType fromWire(String? raw) =>
      raw == 'agent' ? AuthorType.agent : AuthorType.user;
}

/// The two agent kinds the backend accepts from `POST /agents`.
enum AgentKind {
  assistant,
  coding;

  static AgentKind fromWire(String? raw) =>
      raw == 'coding' ? AgentKind.coding : AgentKind.assistant;

  String get wireValue => switch (this) {
    AgentKind.assistant => 'assistant',
    AgentKind.coding => 'coding',
  };

  String get label => switch (this) {
    AgentKind.assistant => 'Assistant',
    AgentKind.coding => 'Coding',
  };
}

/// `GET /me` response -- the signed-in principal.
class Principal {
  const Principal({required this.sub, required this.groups});

  final String sub;
  final List<String> groups;

  bool get isAdmin => groups.contains('secchat-admins');

  factory Principal.fromJson(Map<String, dynamic> json) => Principal(
    sub: json['sub'] as String? ?? '',
    groups: (json['groups'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => e.toString())
        .toList(),
  );
}

/// A channel as returned by `GET /channels` / `POST /channels`.
///
/// [members] is populated by the backend ONLY for `dm` channels (the user subs
/// on both sides), since a DM has no fixed name — the client labels it with the
/// other participant. It's null/empty for every other channel kind.
class Channel {
  const Channel({
    required this.id,
    required this.kind,
    required this.name,
    this.members = const [],
  });

  final String id;
  final ChannelKind kind;
  final String name;
  final List<String> members;

  /// For a DM, the participant sub that isn't [me] (the person you're talking
  /// to); null for a non-DM or a malformed/self-only member list.
  String? peer(String me) {
    for (final sub in members) {
      if (sub != me) return sub;
    }
    return null;
  }

  factory Channel.fromJson(Map<String, dynamic> json) => Channel(
    id: json['id'] as String,
    kind: ChannelKind.fromWire(json['kind'] as String?),
    name: json['name'] as String? ?? '',
    members: (json['members'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => e.toString())
        .toList(),
  );
}

/// A directory entry (`GET /users`) — a real user seen via SSO, with their
/// group claims. Powers the DM picker and the roster.
class User {
  const User({
    required this.sub,
    this.email,
    this.displayName,
    this.groups = const [],
  });

  final String sub;
  final String? email;
  final String? displayName;
  final List<String> groups;

  /// A human label: the display name when present, else the sub.
  String get label =>
      (displayName != null && displayName!.isNotEmpty) ? displayName! : sub;

  factory User.fromJson(Map<String, dynamic> json) => User(
    sub: json['sub'] as String? ?? '',
    email: json['email'] as String?,
    displayName: json['displayName'] as String?,
    groups: (json['groups'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => e.toString())
        .toList(),
  );
}

/// A chat message. `content == null` means the row was redacted server-side
/// -- the UI must render that as an explicit "message redacted" notice
/// rather than an empty bubble.
class Message {
  const Message({
    required this.id,
    required this.seq,
    required this.authorRef,
    required this.authorType,
    required this.content,
    required this.createdAt,
    this.promptedBy,
    this.parentId,
    this.reactions = const [],
  });

  final String id;
  final int seq;
  final String authorRef;
  final AuthorType authorType;
  final String? content;
  final DateTime createdAt;

  /// For an agent message, the human whose prompt triggered this turn — shown
  /// as an attribution line (decision #2: an agent acts as its owner's delegate).
  final String? promptedBy;
  final String? parentId;

  /// Reactions on this message, attached by the message-history endpoint.
  final List<Reaction> reactions;

  bool get isRedacted => content == null;

  /// A copy with [reactions] replaced — used to apply live reaction events /
  /// optimistic toggles without mutating the original row.
  Message withReactions(List<Reaction> reactions) => Message(
    id: id,
    seq: seq,
    authorRef: authorRef,
    authorType: authorType,
    content: content,
    createdAt: createdAt,
    promptedBy: promptedBy,
    parentId: parentId,
    reactions: reactions,
  );

  factory Message.fromJson(Map<String, dynamic> json) => Message(
    id: json['id'] as String,
    seq: (json['seq'] as num?)?.toInt() ?? 0,
    authorRef: json['authorRef'] as String? ?? '',
    authorType: AuthorType.fromWire(json['authorType'] as String?),
    content: json['content'] as String?,
    createdAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.now(),
    promptedBy: json['promptedBy'] as String?,
    parentId: json['parentId'] as String?,
    reactions: (json['reactions'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => Reaction.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

/// One emoji reaction a user placed on a message.
class Reaction {
  const Reaction({
    required this.messageId,
    required this.userSub,
    required this.emoji,
  });

  final String messageId;
  final String userSub;
  final String emoji;

  factory Reaction.fromJson(Map<String, dynamic> json) => Reaction(
    messageId: json['messageId'] as String? ?? '',
    userSub: json['userSub'] as String? ?? '',
    emoji: json['emoji'] as String? ?? '',
  );
}

/// An agent as embedded in a `POST /agents` response.
class Agent {
  const Agent({required this.id, required this.kind, required this.name});

  final String id;
  final AgentKind kind;
  final String name;

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
    id: json['id'] as String,
    kind: AgentKind.fromWire(json['kind'] as String?),
    name: json['name'] as String? ?? '',
  );
}

/// A coding-agent session handle. Only `id` is used client-side (as the
/// path segment for `POST /sessions/:id/grant-execute`).
class AgentSession {
  const AgentSession({required this.id});

  final String id;

  factory AgentSession.fromJson(Map<String, dynamic> json) =>
      AgentSession(id: json['id'] as String);
}

/// `POST /agents` response: the new agent, its channel, and -- for coding
/// agents -- the session that gates tool execution.
class CreateAgentResult {
  const CreateAgentResult({
    required this.agent,
    required this.channel,
    this.session,
  });

  final Agent agent;
  final Channel channel;
  final AgentSession? session;

  factory CreateAgentResult.fromJson(Map<String, dynamic> json) =>
      CreateAgentResult(
        agent: Agent.fromJson(json['agent'] as Map<String, dynamic>),
        channel: Channel.fromJson(json['channel'] as Map<String, dynamic>),
        session: json['session'] != null
            ? AgentSession.fromJson(json['session'] as Map<String, dynamic>)
            : null,
      );
}

/// `POST /sessions/:id/grant-execute` response (200 case; a 403 is thrown
/// as an [ApiException] by the client instead).
class GrantExecuteResult {
  const GrantExecuteResult({required this.allow, required this.reason});

  final bool allow;
  final String reason;

  factory GrantExecuteResult.fromJson(Map<String, dynamic> json) =>
      GrantExecuteResult(
        allow: json['allow'] as bool? ?? false,
        reason: json['reason'] as String? ?? '',
      );
}

// ── Live WebSocket events ───────────────────────────────────────────────
//
// Sealed so every switch over an event in the UI is exhaustive at compile
// time -- adding a new event type here is a compile error everywhere it
// isn't yet handled, not a silent no-op at runtime.

sealed class WsEvent {
  const WsEvent();
}

final class WsMessageEvent extends WsEvent {
  const WsMessageEvent(this.message);
  final Message message;
}

final class WsAssistantDeltaEvent extends WsEvent {
  const WsAssistantDeltaEvent({required this.agentId, required this.delta});
  final String agentId;
  final String delta;
}

final class WsAgentOutputEvent extends WsEvent {
  const WsAgentOutputEvent({required this.sessionId, required this.text});
  final String sessionId;
  final String text;
}

final class WsToolDecisionEvent extends WsEvent {
  const WsToolDecisionEvent({
    required this.tool,
    required this.allow,
    this.reason,
  });
  final String tool;
  final bool allow;
  final String? reason;
}

final class WsSessionEndedEvent extends WsEvent {
  const WsSessionEndedEvent();
}

/// A reaction was added/removed on a message in the subscribed channel — lets
/// every viewer's chips update live.
final class WsReactionEvent extends WsEvent {
  const WsReactionEvent({
    required this.op,
    required this.messageId,
    required this.emoji,
    required this.userSub,
  });
  final String op; // 'add' | 'remove'
  final String messageId;
  final String emoji;
  final String userSub;
}

/// An assistant turn failed (model/egress error) — surfaced as an error tile
/// instead of being silently dropped.
final class WsAssistantErrorEvent extends WsEvent {
  const WsAssistantErrorEvent({required this.agentId, required this.error});
  final String agentId;
  final String error;
}

/// Parses one decoded WebSocket JSON frame. Returns `null` for an event
/// `type` this client doesn't know about, so the server can grow the
/// protocol without breaking older clients.
WsEvent? parseWsEvent(Map<String, dynamic> json) {
  switch (json['type']) {
    case 'message':
      final raw = json['message'];
      if (raw is! Map<String, dynamic>) return null;
      return WsMessageEvent(Message.fromJson(raw));
    case 'assistant_delta':
      return WsAssistantDeltaEvent(
        agentId: json['agentId'] as String? ?? '',
        delta: json['delta'] as String? ?? '',
      );
    case 'agent_output':
      return WsAgentOutputEvent(
        sessionId: json['sessionId'] as String? ?? '',
        text: json['text'] as String? ?? '',
      );
    case 'tool_decision':
      return WsToolDecisionEvent(
        tool: json['tool'] as String? ?? 'tool',
        allow: json['allow'] as bool? ?? false,
        reason: json['reason'] as String?,
      );
    case 'session_ended':
      return const WsSessionEndedEvent();
    case 'reaction':
      return WsReactionEvent(
        op: json['op'] as String? ?? 'add',
        messageId: json['messageId'] as String? ?? '',
        emoji: json['emoji'] as String? ?? '',
        userSub: json['userSub'] as String? ?? '',
      );
    case 'assistant_error':
      return WsAssistantErrorEvent(
        agentId: json['agentId'] as String? ?? '',
        error: json['error'] as String? ?? 'assistant error',
      );
    default:
      return null;
  }
}

// ── Transcript entries ──────────────────────────────────────────────────
//
// What the message list actually renders: persisted messages interleaved
// with ephemeral runner output / tool-decision / system entries that never
// come from the REST history endpoint, only from the live socket.

sealed class TranscriptEntry {
  const TranscriptEntry();
}

final class MessageEntry extends TranscriptEntry {
  const MessageEntry(this.message);
  final Message message;
}

final class AgentOutputEntry extends TranscriptEntry {
  const AgentOutputEntry({required this.sessionId, required this.text});
  final String sessionId;
  final String text;
}

final class ToolDecisionEntry extends TranscriptEntry {
  const ToolDecisionEntry({
    required this.tool,
    required this.allow,
    this.reason,
  });
  final String tool;
  final bool allow;
  final String? reason;
}

/// A failed assistant turn (from a `assistant_error` WS event) — rendered as an
/// error tile so the failure is visible instead of silently dropped.
final class ErrorEntry extends TranscriptEntry {
  const ErrorEntry(this.text);
  final String text;
}

final class SystemEntry extends TranscriptEntry {
  const SystemEntry(this.text);
  final String text;
}
