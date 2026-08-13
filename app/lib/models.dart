/// Wire models for the SecChat backend API, plus the small set of
/// UI-transcript types the chat screen builds from live WebSocket events.
///
/// Every `fromJson` is deliberately defensive about optional/missing fields
/// (the backend contract is a dev-stage spec, not a locked schema) but
/// deliberately strict about the fields each screen actually depends on.
library;

import 'marking.dart';

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
  const Principal({
    required this.sub,
    required this.groups,
    this.displayName,
    this.email,
    this.marking = MarkingPolicy.fallback,
    this.serverIsAdmin,
  });

  final String sub;
  final List<String> groups;

  /// Server-authoritative admin flag from `GET /me` (`isAdmin`) — whether this user is in the
  /// deployment's configured admin group, computed by the backend so the client needn't know the
  /// group's name. Null only against an older server that doesn't send it (then [isAdmin] falls
  /// back to the historical `secchat-admins` group check).
  final bool? serverIsAdmin;

  /// The signed-in user's display name (`GET /me`'s `name` claim). Null when the
  /// IdP didn't supply one — the [label] then falls back to the sub.
  final String? displayName;

  /// The signed-in user's email (`GET /me`), when the IdP supplied it.
  final String? email;

  /// The deployment's classification-marking ladder (from `GET /me`) — drives
  /// the banners, the composer's marking picker, and local rank comparisons.
  final MarkingPolicy marking;

  bool get isAdmin => serverIsAdmin ?? groups.contains('secchat-admins');

  /// A human label for the top bar etc.: the display name, else the email, else
  /// the raw sub (an opaque hash under sub_mode: hashed_user_id).
  String get label => (displayName != null && displayName!.isNotEmpty)
      ? displayName!
      : (email != null && email!.isNotEmpty)
      ? email!
      : sub;

  factory Principal.fromJson(Map<String, dynamic> json) => Principal(
    sub: json['sub'] as String? ?? '',
    groups: (json['groups'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => e.toString())
        .toList(),
    displayName: json['displayName'] as String?,
    email: json['email'] as String?,
    marking: json['marking'] is Map<String, dynamic>
        ? MarkingPolicy.fromJson(json['marking'] as Map<String, dynamic>)
        : MarkingPolicy.fallback,
    serverIsAdmin: json['isAdmin'] as bool?,
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
    this.cuiMarking,
    this.agentKind,
    this.agentId,
    this.agentModel,
    this.sessionId,
    this.owned = false,
    this.archived = false,
  });

  final String id;
  final ChannelKind kind;
  final String name;
  final List<String> members;

  /// For an agent channel (`kind == ChannelKind.agent`), which kind of agent it
  /// hosts — assistant vs coding. `GET /channels` reports this so a client that
  /// reloaded (or didn't create the agent) can still render the right channel
  /// type instead of defaulting every agent channel to assistant. Null for
  /// non-agent channels (and older backends that don't send it).
  final AgentKind? agentKind;

  /// For an agent channel, the backing agent's id — so the header's model picker
  /// can `PATCH /agents/:id` to switch its model. Null for non-agent channels.
  final String? agentId;

  /// For an agent channel, the agent's current model id (e.g. `secllm/fast`, or
  /// `auto` for router-chosen). Drives the header picker's current selection.
  /// Null ⇒ unset (the deployment default applies).
  final String? agentModel;

  /// For a coding-agent channel, the id of its currently-live runner session, as
  /// recovered by `GET /channels`. A reloaded client uses this to route input
  /// straight back to the running agent (`POST /sessions/:id/input`) instead of
  /// posting a plain message that never reaches pi. Null ⇒ no live session (the
  /// client calls `POST /channels/:id/session` to (re)start one on demand).
  final String? sessionId;

  /// Whether the caller owns this agent (created it). Only the owner may switch a
  /// coding agent from plan mode to edit mode (grant execute). The backend gate
  /// enforces this too; this just hides the control for everyone else.
  final bool owned;

  /// Archived channels are hidden from the sidebar by default (a soft-hide for
  /// decluttering). Toggled via `POST /channels/:id/archive`.
  final bool archived;

  /// The channel's classification level, when marked. When set, the channel IS
  /// the portion — every message inherits it — and the composer locks its
  /// marking picker to this level. Null ⇒ unmarked (per-message marking).
  final String? cuiMarking;

  bool get isMarked => cuiMarking != null && cuiMarking!.isNotEmpty;

  Channel withMarking(String? marking) => Channel(
    id: id,
    kind: kind,
    name: name,
    members: members,
    cuiMarking: marking,
    agentKind: agentKind,
    agentId: agentId,
    agentModel: agentModel,
    sessionId: sessionId,
    owned: owned,
    archived: archived,
  );

  /// A copy with a new [agentModel] — used after the header picker switches the
  /// model (PATCH /agents/:id) so the channel reflects it without a full reload.
  Channel withAgentModel(String? model) => Channel(
    id: id,
    kind: kind,
    name: name,
    members: members,
    cuiMarking: cuiMarking,
    agentKind: agentKind,
    agentId: agentId,
    agentModel: model,
    sessionId: sessionId,
    owned: owned,
    archived: archived,
  );

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
    cuiMarking: json['cuiMarking'] as String?,
    agentKind: json['agentKind'] == null
        ? null
        : AgentKind.fromWire(json['agentKind'] as String?),
    agentId: json['agentId'] as String?,
    agentModel: json['agentModel'] as String?,
    sessionId: json['sessionId'] as String?,
    owned: json['owned'] as bool? ?? false,
    archived: json['archived'] as bool? ?? false,
  );

  /// A copy with a new [archived] state — used after the sidebar toggles it so
  /// the list updates without a full reload.
  Channel withArchived(bool value) => Channel(
    id: id,
    kind: kind,
    name: name,
    members: members,
    cuiMarking: cuiMarking,
    agentKind: agentKind,
    agentId: agentId,
    agentModel: agentModel,
    sessionId: sessionId,
    owned: owned,
    archived: value,
  );
}

/// A model the gateway offers (`GET /models` → SecRouter's `/v1/models`), for
/// the chat window's model picker. [id] is what gets sent as the agent's model
/// (e.g. `secllm/fast`, or `auto` for router-chosen).
class ModelInfo {
  const ModelInfo({required this.id, this.ownedBy});

  final String id;
  final String? ownedBy;

  /// A friendly label: `auto` reads as router-chosen; everything else shows its
  /// id (which already namespaces the provider, e.g. `secllm/fast`).
  String get label => id == 'auto' ? 'Auto (router picks)' : id;

  factory ModelInfo.fromJson(Map<String, dynamic> json) => ModelInfo(
    id: json['id'] as String,
    ownedBy: json['ownedBy'] as String?,
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
/// A file attached to a message (metadata only — bytes are fetched lazily from
/// `GET /attachments/:id`). Carries its own classification [marking].
class Attachment {
  const Attachment({
    required this.id,
    required this.filename,
    required this.contentType,
    required this.byteSize,
    required this.marking,
    this.messageId,
  });

  final String id;
  final String? messageId;
  final String filename;
  final String contentType;
  final int byteSize;
  final String marking;

  bool get isImage => contentType.startsWith('image/');

  factory Attachment.fromJson(Map<String, dynamic> json) => Attachment(
    id: json['id'] as String,
    messageId: json['messageId'] as String?,
    filename: (json['filename'] ?? 'file').toString(),
    contentType: (json['contentType'] ?? 'application/octet-stream').toString(),
    byteSize: (json['byteSize'] as num?)?.toInt() ?? 0,
    marking: (json['marking'] ?? 'UNCLASSIFIED').toString(),
  );
}

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
    this.editedAt,
    this.marking = 'UNCLASSIFIED',
    this.dlpFlags = const [],
    this.reactions = const [],
    this.attachments = const [],
    this.displayName,
  });

  final String id;
  final int seq;
  final String authorRef;
  final AuthorType authorType;
  final String? content;
  final DateTime createdAt;

  /// The author's display name, when the server enriches it — set for agent
  /// messages (the agent's name) by both the history endpoint and the live
  /// `message` broadcast, so the byline shows a name instead of the opaque
  /// agent id. Null for ordinary user messages (resolved via the directory).
  final String? displayName;

  /// The message's effective classification level (server-stamped, chain-bound).
  /// Shown as a per-message chip when the channel is unmarked; in a marked
  /// channel it equals the channel level and the banner carries it instead.
  final String marking;

  /// DLP rule names this message's content tripped (from `flag`-mode scanning),
  /// delivered live on the message — drives a warning indicator. Empty normally;
  /// the durable record is the audit trail (not persisted on the message row).
  final List<String> dlpFlags;

  /// For an agent message, the human whose prompt triggered this turn — shown
  /// as an attribution line (decision #2: an agent acts as its owner's delegate).
  final String? promptedBy;
  final String? parentId;

  /// Set once the author has revised this message — drives the "(edited)"
  /// marker and the "view history" affordance. The original content hash (and
  /// thus the server-side chain) is untouched; edits are tracked out-of-band.
  final DateTime? editedAt;

  /// Reactions on this message, attached by the message-history endpoint.
  final List<Reaction> reactions;

  /// Files attached to this message (metadata only), from the history endpoint /
  /// the live `message` event. Empty for most messages.
  final List<Attachment> attachments;

  bool get isRedacted => content == null;
  bool get isEdited => editedAt != null;

  /// A copy with the content purged (redacted) — everything else preserved, so
  /// the row renders as the "message redacted" tombstone.
  Message redactedCopy() => Message(
    id: id,
    seq: seq,
    authorRef: authorRef,
    authorType: authorType,
    content: null,
    createdAt: createdAt,
    promptedBy: promptedBy,
    parentId: parentId,
    editedAt: editedAt,
    marking: marking,
    dlpFlags: dlpFlags,
    reactions: reactions,
    attachments: const [], // redacted → files are purged server-side; drop them from the tombstone
    displayName: displayName,
  );

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
    editedAt: editedAt,
    marking: marking,
    dlpFlags: dlpFlags,
    reactions: reactions,
    attachments: attachments,
    displayName: displayName,
  );

  /// A copy with new [content] and an [editedAt] stamp — applies an edit (live
  /// event or optimistic) without mutating the original row.
  Message withEdit(String content, DateTime editedAt) => Message(
    id: id,
    seq: seq,
    authorRef: authorRef,
    authorType: authorType,
    content: content,
    createdAt: createdAt,
    promptedBy: promptedBy,
    parentId: parentId,
    editedAt: editedAt,
    marking: marking,
    dlpFlags: dlpFlags,
    reactions: reactions,
    attachments: attachments,
    displayName: displayName,
  );

  factory Message.fromJson(Map<String, dynamic> json) => Message(
    id: json['id'] as String,
    seq: (json['seq'] as num?)?.toInt() ?? 0,
    authorRef: json['authorRef'] as String? ?? '',
    authorType: AuthorType.fromWire(json['authorType'] as String?),
    content: json['content'] as String?,
    displayName: json['displayName'] as String?,
    createdAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.now(),
    promptedBy: json['promptedBy'] as String?,
    parentId: json['parentId'] as String?,
    editedAt: DateTime.tryParse(json['editedAt'] as String? ?? ''),
    marking: json['marking'] as String? ?? 'UNCLASSIFIED',
    dlpFlags: (json['dlpFlags'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => e.toString())
        .toList(),
    reactions: (json['reactions'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => Reaction.fromJson(e as Map<String, dynamic>))
        .toList(),
    attachments: (json['attachments'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => Attachment.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

/// One version of a message's text, from `GET /messages/:id/revisions`.
/// Revision 1 is the original; `content` is null once the message is redacted.
class MessageRevision {
  const MessageRevision({
    required this.revision,
    required this.authorRef,
    required this.content,
    required this.at,
  });

  final int revision;
  final String authorRef;
  final String? content;
  final DateTime at;

  factory MessageRevision.fromJson(Map<String, dynamic> json) => MessageRevision(
    revision: (json['revision'] as num?)?.toInt() ?? 0,
    authorRef: json['authorRef'] as String? ?? '',
    content: json['content'] as String?,
    at: DateTime.tryParse(json['at'] as String? ?? '') ?? DateTime.now(),
  );
}

/// A page of a channel's messages. [messages] is ascending by seq; [nextCursor]
/// is the seq to pass as `before` to fetch the next OLDER page, or null when the
/// start of history has been reached.
class MessagePage {
  const MessagePage({required this.messages, this.nextCursor});

  final List<Message> messages;
  final int? nextCursor;
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

/// One hit from `GET /search` — a message the caller can see whose content
/// matched, carrying its [channelId] so the UI can jump to that channel.
class SearchHit {
  const SearchHit({
    required this.channelId,
    required this.messageId,
    required this.authorRef,
    required this.content,
    required this.createdAt,
  });

  final String channelId;
  final String messageId;
  final String authorRef;
  final String content;
  final DateTime createdAt;

  factory SearchHit.fromJson(Map<String, dynamic> json) => SearchHit(
    channelId: json['channelId'] as String? ?? '',
    messageId: json['id'] as String? ?? '',
    authorRef: json['authorRef'] as String? ?? '',
    content: json['content'] as String? ?? '',
    createdAt:
        DateTime.tryParse(json['createdAt'] as String? ?? '') ?? DateTime.now(),
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

/// A launch environment for a coding agent (`GET /runner/environments`) — WHERE
/// its pi session runs: the user's connected desktop app, or the (not-yet-
/// deployed) online pool. The New-Coding-Agent picker shows these and disables
/// the ones that aren't [available].
class LaunchEnv {
  const LaunchEnv({
    required this.id,
    required this.label,
    required this.available,
    required this.reason,
    required this.detail,
  });

  final String id; // 'desktop' | 'pool'
  final String label;
  final bool available;
  final String reason; // 'connected' | 'not_connected' | 'available' | 'not_deployed'
  final String detail; // human sentence for the picker / block message

  factory LaunchEnv.fromJson(Map<String, dynamic> json) => LaunchEnv(
    id: json['id'] as String? ?? '',
    label: json['label'] as String? ?? (json['id'] as String? ?? ''),
    available: json['available'] as bool? ?? false,
    reason: json['reason'] as String? ?? '',
    detail: json['detail'] as String? ?? '',
  );
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
/// The coding agent's execute-gate mode, chosen from the coding strip's dropdown.
/// `none` (default) = no tools run at all — the agent plans in text only. `plan` = read-only tools
/// (ls/read/grep) but no side effects. `once` = read-only plus one mutating call, then back to
/// `none`. `continual` = read-only plus every mutation until revoked (an `always` grant).
enum ExecuteMode { none, plan, once, continual }

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

/// A pinned message, enriched for the pinned-messages panel with its content/seq/author. `content`
/// is null when the message has been redacted (the pin survives as a tombstone).
class PinnedMessage {
  const PinnedMessage({
    required this.messageId,
    required this.channelId,
    required this.pinnedBy,
    required this.seq,
    required this.authorRef,
    this.content,
  });

  final String messageId;
  final String channelId;
  final String pinnedBy;
  final int seq;
  final String authorRef;
  final String? content;

  factory PinnedMessage.fromJson(Map<String, dynamic> json) => PinnedMessage(
    messageId: json['messageId'] as String? ?? '',
    channelId: json['channelId'] as String? ?? '',
    pinnedBy: json['pinnedBy'] as String? ?? '',
    seq: (json['seq'] as num?)?.toInt() ?? 0,
    authorRef: json['authorRef'] as String? ?? '',
    content: json['content'] as String?,
  );
}

/// One member of a channel, as returned enriched by `GET /channels/:id/members`: the raw membership
/// (ref + type + role) plus a display label resolved server-side (the user's directory name, or an
/// agent's name) so the roster renders without a second lookup.
class ChannelMember {
  const ChannelMember({
    required this.memberRef,
    required this.memberType,
    required this.role,
    this.displayName,
    this.email,
    this.agentKind,
  });

  final String memberRef;
  final String memberType; // 'user' | 'agent'
  final String role; // 'owner' | 'member'
  final String? displayName;
  final String? email;
  final String? agentKind;

  bool get isOwner => role == 'owner';
  bool get isAgent => memberType == 'agent';

  /// A human label: the enriched display name, else the raw ref.
  String get label => (displayName != null && displayName!.isNotEmpty) ? displayName! : memberRef;

  factory ChannelMember.fromJson(Map<String, dynamic> json) => ChannelMember(
    memberRef: json['memberRef'] as String? ?? '',
    memberType: json['memberType'] as String? ?? 'user',
    role: json['role'] as String? ?? 'member',
    displayName: json['displayName'] as String?,
    email: json['email'] as String?,
    agentKind: json['agentKind'] as String?,
  );
}

/// A record that the current user was @-mentioned, enriched for the inbox with the triggering
/// message's content, seq, and channel name. `content` is null when that message has since been
/// redacted (the row still shows who mentioned you, where, and when).
class Mention {
  const Mention({
    required this.id,
    required this.messageId,
    required this.channelId,
    required this.mentionedSub,
    required this.authorSub,
    required this.createdAt,
    this.seq = 0,
    this.content,
    this.channelName,
    this.seenAt,
  });

  final String id;
  final String messageId;
  final String channelId;
  final String mentionedSub;
  final String authorSub;
  final DateTime createdAt;
  final int seq;
  final String? content;
  final String? channelName;
  final DateTime? seenAt;

  factory Mention.fromJson(Map<String, dynamic> json) => Mention(
    id: json['id'] as String? ?? '',
    messageId: json['messageId'] as String? ?? '',
    channelId: json['channelId'] as String? ?? '',
    mentionedSub: json['mentionedSub'] as String? ?? '',
    authorSub: json['authorSub'] as String? ?? '',
    createdAt: DateTime.tryParse(json['createdAt'] as String? ?? '') ??
        DateTime.fromMillisecondsSinceEpoch(0),
    seq: (json['seq'] as num?)?.toInt() ?? 0,
    content: json['content'] as String?,
    channelName: json['channelName'] as String?,
    seenAt: json['seenAt'] != null ? DateTime.tryParse(json['seenAt'] as String) : null,
  );
}

sealed class WsEvent {
  const WsEvent({required this.channelId});

  /// The channel this event belongs to — stamped into every frame by the hub, so a single global
  /// (subscribeAll) socket can route any event to the right channel without a per-channel connection.
  final String channelId;
}

final class WsMessageEvent extends WsEvent {
  const WsMessageEvent(this.message, {required super.channelId});
  final Message message;
}

final class WsAssistantDeltaEvent extends WsEvent {
  const WsAssistantDeltaEvent({required this.agentId, required this.delta, required super.channelId});
  final String agentId;
  final String delta;
}

final class WsAgentOutputEvent extends WsEvent {
  const WsAgentOutputEvent({required this.sessionId, required this.text, required super.channelId});
  final String sessionId;
  final String text;
}

final class WsToolDecisionEvent extends WsEvent {
  const WsToolDecisionEvent({
    required this.tool,
    required this.allow,
    this.reason,
    required super.channelId,
  });
  final String tool;
  final bool allow;
  final String? reason;
}

final class WsSessionEndedEvent extends WsEvent {
  const WsSessionEndedEvent({required super.channelId});
}

/// A reaction was added/removed on a message — lets every viewer's chips update live.
final class WsReactionEvent extends WsEvent {
  const WsReactionEvent({
    required this.op,
    required this.messageId,
    required this.emoji,
    required this.userSub,
    required super.channelId,
  });
  final String op; // 'add' | 'remove'
  final String messageId;
  final String emoji;
  final String userSub;
}

/// An assistant turn failed (model/egress error) — surfaced as an error tile
/// instead of being silently dropped.
final class WsAssistantErrorEvent extends WsEvent {
  const WsAssistantErrorEvent({required this.agentId, required this.error, required super.channelId});
  final String agentId;
  final String error;
}

/// A message was redacted (content purged) — every viewer flips it to the
/// "message redacted" tombstone live.
final class WsRedactionEvent extends WsEvent {
  const WsRedactionEvent({required this.messageId, required this.by, required super.channelId});
  final String messageId;
  final String by;
}

/// A message was edited — every viewer swaps in the new text and shows the
/// "(edited)" marker live.
final class WsMessageEditEvent extends WsEvent {
  const WsMessageEditEvent({
    required this.messageId,
    required this.content,
    required this.editedAt,
    required this.by,
    required super.channelId,
  });
  final String messageId;
  final String content;
  final DateTime editedAt;
  final String by;
}

/// The current user was @-mentioned somewhere — drives the live mention badge (and can jump to the
/// message). Delivered per-user (independent of which channel is open), but still carries channelId.
final class WsMentionEvent extends WsEvent {
  const WsMentionEvent({required this.mention, required super.channelId});
  final Mention mention;
}

/// A human is typing in a channel (ephemeral — never persisted). Drives the "X is typing…" line.
final class WsTypingEvent extends WsEvent {
  const WsTypingEvent({required this.userSub, required super.channelId});
  final String userSub;
}

/// A user's online/offline transition, fanned to every channel they belong to — drives presence dots.
final class WsPresenceEvent extends WsEvent {
  const WsPresenceEvent({required this.userSub, required this.online, required super.channelId});
  final String userSub;
  final bool online;
}

/// A message was pinned/unpinned in a channel — every viewer updates the pin indicator + panel live.
final class WsPinEvent extends WsEvent {
  const WsPinEvent({required this.op, required this.messageId, required super.channelId});
  final String op; // 'pin' | 'unpin'
  final String messageId;
}

/// A channel's classification level was set/changed — every viewer updates the
/// banner (and the composer's marking lock) live.
final class WsChannelMarkingEvent extends WsEvent {
  const WsChannelMarkingEvent({
    required this.marking,
    required this.by,
    required super.channelId,
  });
  final String marking;
  final String by;
}

/// A membership change on a channel — someone was added/removed or had their
/// role changed. Delivered both to the channel and (for the affected user) to
/// their per-user socket, so a client can pull a newly-joined channel into the
/// sidebar live, or drop one it was removed from.
final class WsMembershipEvent extends WsEvent {
  const WsMembershipEvent({
    required this.op,
    required this.memberRef,
    required this.role,
    required super.channelId,
  });
  final String op; // 'add' | 'remove' | 'role'
  final String memberRef;
  final String role;
}

/// Parses one decoded WebSocket JSON frame. Returns `null` for an event
/// `type` this client doesn't know about, so the server can grow the
/// protocol without breaking older clients. Every frame carries a top-level
/// `channelId` (stamped by the hub) — the routing key for the global socket.
WsEvent? parseWsEvent(Map<String, dynamic> json) {
  final channelId = json['channelId'] as String? ?? '';
  switch (json['type']) {
    case 'message':
      final raw = json['message'];
      if (raw is! Map<String, dynamic>) return null;
      return WsMessageEvent(Message.fromJson(raw), channelId: channelId);
    case 'assistant_delta':
      return WsAssistantDeltaEvent(
        agentId: json['agentId'] as String? ?? '',
        delta: json['delta'] as String? ?? '',
        channelId: channelId,
      );
    case 'agent_output':
      return WsAgentOutputEvent(
        sessionId: json['sessionId'] as String? ?? '',
        text: json['text'] as String? ?? '',
        channelId: channelId,
      );
    case 'tool_decision':
      return WsToolDecisionEvent(
        tool: json['tool'] as String? ?? 'tool',
        allow: json['allow'] as bool? ?? false,
        reason: json['reason'] as String?,
        channelId: channelId,
      );
    case 'session_ended':
      return WsSessionEndedEvent(channelId: channelId);
    case 'reaction':
      return WsReactionEvent(
        op: json['op'] as String? ?? 'add',
        messageId: json['messageId'] as String? ?? '',
        emoji: json['emoji'] as String? ?? '',
        userSub: json['userSub'] as String? ?? '',
        channelId: channelId,
      );
    case 'assistant_error':
      return WsAssistantErrorEvent(
        agentId: json['agentId'] as String? ?? '',
        error: json['error'] as String? ?? 'assistant error',
        channelId: channelId,
      );
    case 'redaction':
      return WsRedactionEvent(
        messageId: json['messageId'] as String? ?? '',
        by: json['by'] as String? ?? '',
        channelId: channelId,
      );
    case 'message_edit':
      return WsMessageEditEvent(
        messageId: json['messageId'] as String? ?? '',
        content: json['content'] as String? ?? '',
        editedAt:
            DateTime.tryParse(json['editedAt'] as String? ?? '') ??
            DateTime.now(),
        by: json['by'] as String? ?? '',
        channelId: channelId,
      );
    case 'channel_marking':
      return WsChannelMarkingEvent(
        marking: json['marking'] as String? ?? '',
        by: json['by'] as String? ?? '',
        channelId: channelId,
      );
    case 'mention':
      final raw = json['mention'];
      if (raw is! Map<String, dynamic>) return null;
      return WsMentionEvent(mention: Mention.fromJson(raw), channelId: channelId);
    case 'typing':
      return WsTypingEvent(userSub: json['userSub'] as String? ?? '', channelId: channelId);
    case 'presence':
      return WsPresenceEvent(
        userSub: json['userSub'] as String? ?? '',
        online: json['online'] as bool? ?? false,
        channelId: channelId,
      );
    case 'pin':
      return WsPinEvent(
        op: json['op'] as String? ?? 'pin',
        messageId: json['messageId'] as String? ?? '',
        channelId: channelId,
      );
    case 'membership':
      return WsMembershipEvent(
        op: json['op'] as String? ?? 'add',
        memberRef: json['memberRef'] as String? ?? '',
        role: json['role'] as String? ?? 'member',
        channelId: channelId,
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

// ── Inbound webhooks ───────────────────────────────────────────────────────────────────────

/// One inbound webhook for a channel (`GET/POST /channels/:id/webhooks`). The [token] IS the
/// credential — an external system POSTs `{ "text": "..." }` to [postUrl] to drop a message into
/// the channel as a bot author. Treat the token like a secret.
class Webhook {
  const Webhook({
    required this.id,
    required this.channelId,
    required this.token,
    required this.createdBy,
    required this.createdAt,
    this.channelName,
  });

  final String id;
  final String channelId;
  final String token;
  final String createdBy;
  final String createdAt;

  /// The owning channel's display name — only set by the global `GET /webhooks` view (null for the
  /// per-channel list, where the channel is already the context).
  final String? channelName;

  factory Webhook.fromJson(Map<String, dynamic> json) => Webhook(
    id: json['id'] as String,
    channelId: json['channelId'] as String,
    token: json['token'] as String,
    createdBy: (json['createdBy'] as String?) ?? '',
    createdAt: (json['createdAt'] as String?) ?? '',
    channelName: json['channelName'] as String?,
  );

  /// The full inbound URL an external system POSTs to, e.g. `https://host/hooks/<token>`.
  Uri postUrl(Uri origin) => origin.replace(path: '/hooks/$token');
}

// ── Outbound webhooks ──────────────────────────────────────────────────────────────────────

/// The events an outbound webhook can subscribe to — mirrors the backend's `OutboundEvent` union.
const List<String> kOutboundEvents = ['message.created', 'message.redacted', 'channel.marked'];

/// One outbound webhook subscription (`GET/POST /channels/:id/outbound-webhooks`). SecChat POSTs a
/// signed JSON payload to [url] when a subscribed event fires. [secret] signs deliveries; [events]
/// is which it wants; [includeContent] gates whether message content (not just metadata) is sent.
/// The `last*` fields report the most recent delivery for observability.
class OutboundWebhook {
  const OutboundWebhook({
    required this.id,
    required this.channelId,
    required this.url,
    required this.secret,
    required this.events,
    required this.includeContent,
    required this.active,
    required this.createdBy,
    required this.createdAt,
    this.lastStatus,
    this.lastError,
    this.lastDeliveryAt,
    this.channelName,
  });

  final String id;
  final String channelId;
  final String url;
  final String secret;
  final List<String> events;
  final bool includeContent;
  final bool active;
  final String createdBy;
  final String createdAt;
  final int? lastStatus;
  final String? lastError;
  final String? lastDeliveryAt;

  /// The owning channel's display name — only set by the global `GET /outbound-webhooks` view.
  final String? channelName;

  factory OutboundWebhook.fromJson(Map<String, dynamic> json) => OutboundWebhook(
    id: json['id'] as String,
    channelId: json['channelId'] as String,
    url: (json['url'] as String?) ?? '',
    secret: (json['secret'] as String?) ?? '',
    events: ((json['events'] as List<dynamic>?) ?? const []).map((e) => e.toString()).toList(),
    includeContent: (json['includeContent'] as bool?) ?? false,
    active: (json['active'] as bool?) ?? true,
    createdBy: (json['createdBy'] as String?) ?? '',
    createdAt: (json['createdAt'] as String?) ?? '',
    lastStatus: (json['lastStatus'] as num?)?.toInt(),
    lastError: json['lastError'] as String?,
    lastDeliveryAt: json['lastDeliveryAt'] as String?,
    channelName: json['channelName'] as String?,
  );
}

/// The result of a test delivery (`POST …/outbound-webhooks/:id/test`).
class OutboundTestResult {
  const OutboundTestResult({required this.status, this.error});
  final int status;
  final String? error;
  bool get ok => status >= 200 && status < 400;
  factory OutboundTestResult.fromJson(Map<String, dynamic> json) => OutboundTestResult(
    status: (json['status'] as num?)?.toInt() ?? 0,
    error: json['error'] as String?,
  );
}

// ── Admin / audit-review console (GET /admin/api/overview) ─────────────────────────────────

/// A read-only snapshot for the native admin console — the JSON the server-rendered `/admin` page
/// is built from, rendered natively here so it rides the app's authenticated client. Admin-only
/// (the backend gates it on the `secchat-admins` group; see [Principal.isAdmin]).
class AdminOverview {
  const AdminOverview({
    required this.generatedAt,
    required this.channels,
    required this.agents,
    required this.sessions,
    required this.audit,
    required this.messagesChainOk,
    required this.auditChainOk,
  });

  final String generatedAt;
  final List<AdminChannel> channels;
  final List<AdminAgent> agents;
  final List<AdminSession> sessions;
  final List<AuditEvent> audit;
  final bool messagesChainOk;
  final bool auditChainOk;

  /// Both tamper-evident chains verified end-to-end — the console's headline health signal.
  bool get chainsOk => messagesChainOk && auditChainOk;

  factory AdminOverview.fromJson(Map<String, dynamic> json) {
    List<T> list<T>(String key, T Function(Map<String, dynamic>) of) =>
        ((json[key] as List<dynamic>?) ?? const [])
            .map((e) => of(e as Map<String, dynamic>))
            .toList(growable: false);
    final chains = (json['chains'] as Map<String, dynamic>?) ?? const {};
    return AdminOverview(
      generatedAt: (json['generatedAt'] as String?) ?? '',
      channels: list('channels', AdminChannel.fromJson),
      agents: list('agents', AdminAgent.fromJson),
      sessions: list('sessions', AdminSession.fromJson),
      audit: list('audit', AuditEvent.fromJson),
      messagesChainOk: (chains['messagesOk'] as bool?) ?? false,
      auditChainOk: (chains['auditOk'] as bool?) ?? false,
    );
  }
}

class AdminChannel {
  const AdminChannel({
    required this.id,
    required this.kind,
    required this.name,
    required this.cuiMarking,
    required this.createdAt,
  });

  final String id;
  final String kind;
  final String? name;
  final String? cuiMarking;
  final String createdAt;

  factory AdminChannel.fromJson(Map<String, dynamic> json) => AdminChannel(
    id: json['id'] as String,
    kind: (json['kind'] as String?) ?? 'human',
    name: json['name'] as String?,
    cuiMarking: json['cuiMarking'] as String?,
    createdAt: (json['createdAt'] as String?) ?? '',
  );
}

class AdminAgent {
  const AdminAgent({
    required this.id,
    required this.kind,
    required this.name,
    required this.ownerSub,
    required this.model,
  });

  final String id;
  final String kind;
  final String? name;
  final String ownerSub;
  final String? model;

  factory AdminAgent.fromJson(Map<String, dynamic> json) => AdminAgent(
    id: json['id'] as String,
    kind: (json['kind'] as String?) ?? '',
    name: json['name'] as String?,
    ownerSub: (json['ownerSub'] as String?) ?? '',
    model: json['model'] as String?,
  );
}

class AdminSession {
  const AdminSession({
    required this.id,
    required this.agentId,
    required this.status,
    required this.hostType,
    required this.runnerId,
    required this.leaseExpiresAt,
  });

  final String id;
  final String agentId;
  final String status;
  final String hostType;
  final String? runnerId;
  final String leaseExpiresAt;

  factory AdminSession.fromJson(Map<String, dynamic> json) => AdminSession(
    id: json['id'] as String,
    agentId: (json['agentId'] as String?) ?? '',
    status: (json['status'] as String?) ?? '',
    hostType: (json['hostType'] as String?) ?? '',
    runnerId: json['runnerId'] as String?,
    leaseExpiresAt: (json['leaseExpiresAt'] as String?) ?? '',
  );
}

/// One link in the tamper-evident audit chain (`AuditEvent` in the backend types).
class AuditEvent {
  const AuditEvent({
    required this.seq,
    required this.at,
    required this.actor,
    required this.actAs,
    required this.action,
    required this.target,
    required this.detail,
  });

  final int seq;
  final String at;
  final String actor;
  final String? actAs;
  final String action;
  final String? target;
  final String? detail;

  factory AuditEvent.fromJson(Map<String, dynamic> json) => AuditEvent(
    seq: (json['seq'] as num?)?.toInt() ?? 0,
    at: (json['at'] as String?) ?? '',
    actor: (json['actor'] as String?) ?? '',
    actAs: json['actAs'] as String?,
    action: (json['action'] as String?) ?? '',
    target: json['target'] as String?,
    detail: json['detail'] as String?,
  );
}
