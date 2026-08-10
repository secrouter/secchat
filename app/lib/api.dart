/// The backend API surface, expressed as an abstract [ApiClient] so widget
/// tests can inject an in-memory fake and never touch the network. The real
/// implementation, [HttpApiClient], talks to the SecChat backend that serves
/// this app (see class doc for the base-URL and WebSocket-scoping notes).
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'platform/browser_redirect.dart';
import 'platform/ws_connect.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';

/// Thrown by [HttpApiClient] for any non-2xx response. `message` prefers a
/// `reason`/`message` field from a JSON error body, falling back to the raw
/// response body or a generic "HTTP <code>" string.
class ApiException implements Exception {
  const ApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  /// The server refused a privileged action pending a fresh re-authentication
  /// (step-up). Callers can catch this, run [ApiClient.stepUp], and retry.
  bool get isStepUpRequired => statusCode == 403 && message == 'stepup_required';

  @override
  String toString() => 'ApiException($statusCode): $message';
}

abstract class ApiClient {
  /// The SecChat origin this client talks to — used to wire the bundled runner daemon (desktop).
  Uri get origin;

  /// The bearer token this client authenticates with, or null in cookie-session mode.
  String? get token;

  /// Mint a short-lived, owner-scoped runner token for the bundled daemon (`POST /auth/runner-token`)
  /// — the credential the daemon attaches with. Works in cookie mode (where there's no bearer) and
  /// is least-privilege for bearer users too. Null when the server hasn't configured runner tokens.
  Future<String?> mintRunnerToken();

  Future<Principal> getMe();

  Future<List<Channel>> getChannels();

  Future<Channel> createChannel(String name, {String? marking});

  /// Sets (or changes) a channel's classification level (`POST
  /// /channels/:id/marking`). Any member may set or raise it; only an admin may
  /// downgrade. Returns the updated channel; broadcasts a `channel_marking`
  /// event to every viewer.
  Future<Channel> setChannelMarking(String channelId, String marking);

  /// Establishes a step-up re-authentication proof (`POST /auth/stepup`) that is
  /// then presented automatically on subsequent privileged actions. Call this
  /// after catching [ApiException.isStepUpRequired], then retry the action.
  Future<void> stepUp();

  /// The user directory (`GET /users`): real users seen via SSO, with their
  /// group claims. Powers the DM picker + roster.
  Future<List<User>> getUsers();

  /// Opens — or reuses — a 1:1 DM channel with [userSub] (`POST /dm`). The
  /// backend is idempotent: the same pair always resolves to the same channel,
  /// so calling this for an existing DM just returns it.
  Future<Channel> createDm(String userSub);

  Future<List<Message>> getMessages(String channelId);

  /// A cursor page of a channel's messages: the most recent [limit] (ascending),
  /// or the page just before [before] (a seq) for scroll-back. The result carries
  /// `nextCursor` to fetch the next older page (null at the start of history).
  Future<MessagePage> getMessagePage(String channelId, {int? limit, int? before});

  /// Posts a message to a channel. A non-null [parentId] makes it a reply in
  /// that message's thread. [marking] is the requested per-message
  /// classification (ignored server-side when the channel is itself marked).
  Future<Message> postMessage(String channelId, String content, {String? parentId, String? marking, List<String>? attachmentIds});

  /// Upload a file to [channelId] (unclaimed until a message references it). Returns the attachment row.
  Future<Attachment> uploadAttachment(String channelId, {required List<int> bytes, required String filename, required String contentType, String? marking});

  /// Fetch an attachment's bytes (authenticated) — for image previews and downloads.
  Future<List<int>> downloadAttachment(String id);

  /// Feeds free-text input to a running coding-agent *session* (as opposed
  /// to [postMessage], which posts a chat message to a *channel*). A coding
  /// agent is driven by its runner, not chat history, so its reply never
  /// comes back as a return value here -- it streams back over the
  /// channel's WebSocket as `agent_output` / `tool_decision` events. 202
  /// Accepted is the expected response; callers should treat this as
  /// fire-and-forget beyond surfacing a thrown [ApiException].
  Future<void> sendInput(String sessionId, String text);

  /// (Re)attach a coding-agent channel to a live runner session and return its
  /// id. Idempotent: returns the already-running session if one is live, else
  /// spawns a fresh one. A reloaded client (whose in-memory session handle was
  /// lost) calls this before driving the agent with [sendInput].
  Future<AgentSession> ensureSession(String channelId);

  /// Add / remove an emoji reaction on a message. Fire-and-forget beyond a
  /// thrown [ApiException]: the change is reflected in message history and
  /// streamed to every viewer as a `reaction` WS event.
  Future<void> addReaction(String messageId, String emoji);
  Future<void> removeReaction(String messageId, String emoji);

  /// Unread count for a channel (messages with seq beyond the caller's
  /// last-read marker).
  Future<int> getUnread(String channelId);

  /// Mark [channelId] read up to [seq] — the latest message seq the caller
  /// has seen.
  Future<void> markRead(String channelId, int seq);

  /// Permission-scoped full-text message search (`GET /search`): only messages
  /// in channels the caller belongs to, newest first.
  Future<List<SearchHit>> search(String query);

  /// The caller's @mentions inbox across all channels (newest first), plus the
  /// unseen badge count. [unseenOnly] limits the list to not-yet-seen mentions.
  Future<({List<Mention> mentions, int unseen})> getMentions({bool unseenOnly, int? limit});

  /// Mark the caller's mentions seen — all of them, or just [ids]; returns the
  /// new unseen count so the badge can refresh in one round-trip.
  Future<int> markMentionsSeen({List<String>? ids});

  /// A channel's members (enriched with display labels). Any member may read it.
  Future<List<ChannelMember>> getMembers(String channelId);

  /// Add a member, or change an existing member's role (idempotent upsert).
  /// Owner-or-admin only server-side; throws on a last-owner demotion (409).
  Future<void> addMember(String channelId, String userSub, {String role});

  /// Remove a member. Owner-or-admin only; throws on removing the last owner (409).
  Future<void> removeMember(String channelId, String memberRef);

  /// A channel's pinned messages (newest pin first), enriched with content. Any member may read it.
  Future<List<PinnedMessage>> getPins(String channelId);

  /// Pin / unpin a message (any member). Reflected live via a `pin` WS event.
  Future<void> pinMessage(String messageId);
  Future<void> unpinMessage(String messageId);

  /// Redacts a message — a governed content purge (author or admin). [reason]
  /// is required (the audit record). The change is reflected live via a
  /// `redaction` WS event.
  Future<void> redactMessage(String messageId, String reason);

  /// Edits a message's text (author only) — a tracked revision, not an in-place
  /// rewrite. History is preserved and the change is audited; every viewer sees
  /// the new text + an "(edited)" marker live via a `message_edit` WS event.
  Future<void> editMessage(String messageId, String content);

  /// The full version history of a message (original + every edit), newest
  /// revision last. Content is null on every revision once the message is
  /// redacted.
  Future<List<MessageRevision>> revisions(String messageId);

  Future<CreateAgentResult> createAgent({
    required AgentKind kind,
    required String name,
  });

  /// The models the gateway offers (`GET /models`), for the header's model
  /// picker. Empty when no gateway is wired.
  Future<List<ModelInfo>> listModels();

  /// Switch an assistant's model live (`PATCH /agents/:id`). `model` is any id
  /// from [listModels], including `auto` (router-chosen). Owner-only server-side.
  Future<void> setAgentModel(String agentId, String model);

  /// Archive (or, with `archived: false`, restore) a channel — a soft-hide for
  /// the sidebar (`POST /channels/:id/archive`).
  Future<void> archiveChannel(String channelId, {bool archived = true});

  Future<GrantExecuteResult> grantExecute(
    String sessionId, {
    String scope = 'once',
  });

  /// Opens a fresh WebSocket connection scoped to one channel: connects,
  /// sends `{"type":"subscribe","channelId":channelId}`, and yields parsed
  /// [WsEvent]s from then on. Cancelling the returned subscription closes
  /// the underlying socket. Call again (a new connection each time) when the
  /// user switches channels.
  Stream<WsEvent> subscribeChannel(String channelId);

  /// A single long-lived socket delivering events for ALL the user's channels
  /// (each carries its `channelId`), so background channels update unread live.
  Stream<WsEvent> subscribeAll();

  /// Emit an ephemeral "I'm typing" signal for [channelId] over the live socket (best-effort; a
  /// no-op if the socket isn't open). Debounce calls at the call site.
  void sendTyping(String channelId);

  /// The subs currently online (`GET /presence`) — seeds the presence set on load; live changes
  /// arrive as `presence` WS events.
  Future<List<String>> getPresence();

  /// Releases any resources (HTTP client, any still-open sockets). Owned by
  /// whoever constructed this client -- typically the app root, on sign-out.
  void dispose();
}

/// Real [ApiClient] backed by `package:http` + `package:web_socket_channel`.
///
/// The backend serves this Flutter app at the same origin it exposes the
/// API on, so [origin] defaults to `Uri.base` and every request path is
/// resolved against it.
///
/// Two auth modes, chosen by whether [token] is supplied:
///  - **Bearer/dev** (`token` non-null): every request carries
///    `Authorization: Bearer $token`, and the WebSocket URL carries
///    `?token=`. Used for the dev sign-in form's synthesized
///    `dev.<user>.<groups>` tokens (and would equally work for a real
///    programmatic bearer JWT).
///  - **Session/cookie** (`token` null): no `Authorization` header anywhere.
///    The same-origin httpOnly `secchat_session` cookie -- set server-side
///    by the `/auth/login` -> SecSSO -> `/auth/callback` round trip -- is
///    the credential instead, and the browser attaches it automatically to
///    same-origin requests *and* the WebSocket upgrade (`package:http`'s
///    `BrowserClient` sends `fetch` with `credentials: 'same-origin'` by
///    default, which already includes cookies for same-origin calls; no
///    `withCredentials`/CORS dance needed since this client never talks
///    cross-origin). See [getAuthStatus] and [logout] for the two calls
///    that only make sense in this mode.
///
/// The four live event types (`message`, `assistant_delta`, `agent_output`,
/// `tool_decision`) and `session_ended` carry an `agentId` or `sessionId`
/// but never a `channelId`. This client treats a socket as scoped entirely
/// to the channel it subscribed to -- i.e. everything received on a given
/// connection belongs to that channel -- since that's the only
/// interpretation consistent with "one connect+subscribe per opened
/// channel" and the events' own shapes.
class HttpApiClient implements ApiClient {
  HttpApiClient({this.token, this.sessionToken, Uri? origin}) : origin = origin ?? Uri.base;

  /// The bearer token, or `null` for session (cookie) mode. See the class
  /// doc for what each mode sends on the wire.
  @override
  final String? token;

  /// The SecChat session token from a NATIVE (desktop) SSO login — see
  /// `platform/native_sso.dart`. On the web the `secchat_session` cookie is
  /// httpOnly and rides same-origin requests automatically; a desktop app can't
  /// read that cookie, so it captures the token via the loopback handoff and
  /// this client re-attaches it as a `Cookie: secchat_session=…` header it sets
  /// itself (on both HTTP requests and the WebSocket upgrade). Null on web and in
  /// bearer/dev mode.
  final String? sessionToken;
  @override
  final Uri origin;

  final http.Client _http = http.Client();
  final List<WebSocketChannel> _sockets = <WebSocketChannel>[];

  /// The current step-up re-auth proof (from [stepUp]); presented on every
  /// request so a privileged action that requires freshness is satisfied.
  String? _stepUpToken;

  Map<String, String> get _headers {
    final token = this.token;
    return <String, String>{
      if (token != null) 'Authorization': 'Bearer $token',
      if (sessionToken != null) 'Cookie': 'secchat_session=$sessionToken',
      if (_stepUpToken != null) 'X-Sec-StepUp': _stepUpToken!,
      'Content-Type': 'application/json',
    };
  }

  // Parse the path so a `?query` in it becomes a real query, not part of the
  // path. `origin.replace(path: '/x/messages?limit=50')` would percent-encode
  // the `?` to `%3F` and the request would 404 (the route never matches). Callers
  // like getMessagePage/search legitimately pass a query string here.
  Uri _uri(String path) {
    final ref = Uri.parse(path);
    return origin.replace(path: ref.path, query: ref.hasQuery ? ref.query : null);
  }

  dynamic _decode(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractErrorMessage(res));
    }
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  String _extractErrorMessage(http.Response res) {
    try {
      final parsed = jsonDecode(res.body);
      if (parsed is Map<String, dynamic>) {
        final reason = parsed['reason'] ?? parsed['message'] ?? parsed['error'];
        if (reason is String && reason.isNotEmpty) return reason;
      }
    } catch (_) {
      // Body wasn't JSON -- fall through to the raw text below.
    }
    return res.body.isNotEmpty ? res.body : 'HTTP ${res.statusCode}';
  }

  Future<dynamic> _get(String path) async {
    final res = await _http.get(_uri(path), headers: _headers);
    return _decode(res);
  }

  Future<dynamic> _post(String path, [Object? body]) async {
    final res = await _http.post(
      _uri(path),
      headers: _headers,
      body: body == null ? null : jsonEncode(body),
    );
    return _decode(res);
  }

  Future<dynamic> _delete(String path) async {
    final res = await _http.delete(_uri(path), headers: _headers);
    return _decode(res);
  }

  Future<dynamic> _patch(String path, [Object? body]) async {
    final res = await _http.patch(
      _uri(path),
      headers: _headers,
      body: body == null ? null : jsonEncode(body),
    );
    return _decode(res);
  }

  @override
  Future<Principal> getMe() async =>
      Principal.fromJson(await _get('/me') as Map<String, dynamic>);

  /// `GET /auth/status` -- `{"sso": bool}`, unauthenticated. Lets the login
  /// screen decide whether to render the "Sign in with SecSSO" button.
  /// Callers should treat a thrown [ApiException] (or any other failure --
  /// e.g. no backend reachable at all) the same as `sso: false`, so the
  /// screen still degrades to the dev form when this probe can't complete.
  Future<bool> getAuthStatus() async {
    final data = await _get('/auth/status') as Map<String, dynamic>;
    return data['sso'] as bool? ?? false;
  }

  /// `POST /auth/logout` -- clears the `secchat_session` cookie server-side;
  /// 204 on success. Harmless to call in bearer/dev mode too (there's no
  /// session cookie to clear there, so it's just a round trip); callers
  /// should treat failures as non-fatal and sign out of the client locally
  /// regardless.
  Future<void> logout() async {
    await _post('/auth/logout');
  }

  @override
  Future<List<Channel>> getChannels() async {
    final data = await _get('/channels') as List<dynamic>;
    return data
        .map((e) => Channel.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<Channel> createChannel(String name, {String? marking}) async => Channel.fromJson(
    await _post('/channels', {
      'name': name,
      if (marking != null) 'marking': marking,
    }) as Map<String, dynamic>,
  );

  @override
  Future<Channel> setChannelMarking(String channelId, String marking) async => Channel.fromJson(
    await _post('/channels/$channelId/marking', {'marking': marking}) as Map<String, dynamic>,
  );

  @override
  Future<void> stepUp() async {
    if (token == null) {
      // Cookie/SSO mode: a genuine FRESH proof requires an interactive OIDC re-auth (prompt=login).
      // Navigate to the server flow; it re-authenticates the user and returns to the app with the
      // httpOnly `secchat_stepup` cookie set, which the browser then sends automatically.
      final next = Uri.base.path.isEmpty ? '/' : Uri.base.path;
      redirectBrowserTo('/auth/stepup/start?next=${Uri.encodeQueryComponent(next)}');
      return;
    }
    // Bearer/dev mode: no interactive re-auth is possible, so mint a deliberate-re-affirmation token
    // and hold it for the X-Sec-StepUp header.
    final data = await _post('/auth/stepup') as Map<String, dynamic>;
    _stepUpToken = data['token'] as String?;
  }

  @override
  Future<List<User>> getUsers() async {
    final data = await _get('/users') as List<dynamic>;
    return data.map((e) => User.fromJson(e as Map<String, dynamic>)).toList();
  }

  @override
  Future<Channel> createDm(String userSub) async => Channel.fromJson(
    await _post('/dm', {'user': userSub}) as Map<String, dynamic>,
  );

  @override
  Future<List<Message>> getMessages(String channelId) async {
    final data = await _get('/channels/$channelId/messages') as List<dynamic>;
    return data
        .map((e) => Message.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<MessagePage> getMessagePage(String channelId, {int? limit, int? before}) async {
    final q = <String>[
      if (limit != null) 'limit=$limit',
      if (before != null) 'before=$before',
    ];
    final path = '/channels/$channelId/messages${q.isEmpty ? '' : '?${q.join('&')}'}';
    final data = await _get(path);
    // With `limit` the server returns {messages, nextCursor}; without it, a bare array (legacy).
    if (data is Map<String, dynamic>) {
      final list = (data['messages'] as List<dynamic>)
          .map((e) => Message.fromJson(e as Map<String, dynamic>))
          .toList();
      return MessagePage(messages: list, nextCursor: (data['nextCursor'] as num?)?.toInt());
    }
    final list = (data as List<dynamic>).map((e) => Message.fromJson(e as Map<String, dynamic>)).toList();
    return MessagePage(messages: list, nextCursor: null);
  }

  @override
  Future<Message> postMessage(String channelId, String content, {String? parentId, String? marking, List<String>? attachmentIds}) async =>
      Message.fromJson(
        await _post('/channels/$channelId/messages', {
          'content': content,
          if (parentId != null) 'parentId': parentId,
          if (marking != null) 'marking': marking,
          if (attachmentIds != null && attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
        }) as Map<String, dynamic>,
      );

  @override
  Future<Attachment> uploadAttachment(String channelId, {required List<int> bytes, required String filename, required String contentType, String? marking}) async {
    final uri = origin.replace(path: '/channels/$channelId/attachments', queryParameters: {
      'filename': filename,
      'contentType': contentType,
      if (marking != null) 'marking': marking,
    });
    final token = this.token;
    final res = await _http.post(uri, headers: {
      if (token != null) 'Authorization': 'Bearer $token',
      if (_stepUpToken != null) 'X-Sec-StepUp': _stepUpToken!,
      'Content-Type': contentType,
    }, body: bytes);
    return Attachment.fromJson(_decode(res) as Map<String, dynamic>);
  }

  @override
  Future<List<int>> downloadAttachment(String id) async {
    final token = this.token;
    final res = await _http.get(_uri('/attachments/$id'), headers: {
      if (token != null) 'Authorization': 'Bearer $token',
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw ApiException(res.statusCode, _extractErrorMessage(res));
    }
    return res.bodyBytes;
  }

  @override
  Future<void> sendInput(String sessionId, String text) async {
    await _post('/sessions/$sessionId/input', {'text': text});
  }

  @override
  Future<AgentSession> ensureSession(String channelId) async {
    final data = await _post('/channels/$channelId/session', const {});
    return AgentSession.fromJson(
      (data as Map<String, dynamic>)['session'] as Map<String, dynamic>,
    );
  }

  @override
  Future<void> addReaction(String messageId, String emoji) async {
    await _post('/messages/$messageId/reactions', {'emoji': emoji});
  }

  @override
  Future<void> removeReaction(String messageId, String emoji) async {
    await _delete('/messages/$messageId/reactions/${Uri.encodeComponent(emoji)}');
  }

  @override
  Future<int> getUnread(String channelId) async {
    final data = await _get('/channels/$channelId/unread') as Map<String, dynamic>;
    return (data['unread'] as num?)?.toInt() ?? 0;
  }

  @override
  Future<void> markRead(String channelId, int seq) async {
    await _post('/channels/$channelId/read', {'seq': seq});
  }

  @override
  Future<List<SearchHit>> search(String query) async {
    final data =
        await _get('/search?q=${Uri.encodeQueryComponent(query)}') as List<dynamic>;
    return data.map((e) => SearchHit.fromJson(e as Map<String, dynamic>)).toList();
  }

  @override
  Future<({List<Mention> mentions, int unseen})> getMentions({bool unseenOnly = false, int? limit}) async {
    final q = <String>[];
    if (unseenOnly) q.add('unseen=1');
    if (limit != null) q.add('limit=$limit');
    final path = q.isEmpty ? '/mentions' : '/mentions?${q.join('&')}';
    final data = await _get(path) as Map<String, dynamic>;
    final mentions = (data['mentions'] as List<dynamic>? ?? const [])
        .map((e) => Mention.fromJson(e as Map<String, dynamic>))
        .toList();
    return (mentions: mentions, unseen: (data['unseen'] as num?)?.toInt() ?? 0);
  }

  @override
  Future<int> markMentionsSeen({List<String>? ids}) async {
    final body = ids != null && ids.isNotEmpty ? {'ids': ids} : const <String, dynamic>{};
    final data = await _post('/mentions/seen', body) as Map<String, dynamic>;
    return (data['unseen'] as num?)?.toInt() ?? 0;
  }

  @override
  Future<List<ChannelMember>> getMembers(String channelId) async {
    final data = await _get('/channels/$channelId/members') as List<dynamic>;
    return data.map((e) => ChannelMember.fromJson(e as Map<String, dynamic>)).toList();
  }

  @override
  Future<void> addMember(String channelId, String userSub, {String role = 'member'}) async {
    await _post('/channels/$channelId/members', {'user': userSub, 'role': role});
  }

  @override
  Future<void> removeMember(String channelId, String memberRef) async {
    await _delete('/channels/$channelId/members/${Uri.encodeComponent(memberRef)}');
  }

  @override
  Future<String?> mintRunnerToken() async {
    try {
      final data = await _post('/auth/runner-token') as Map<String, dynamic>;
      return data['token'] as String?;
    } catch (_) {
      return null; // 503 (feature off) or any error → no scoped token; the caller falls back
    }
  }

  @override
  Future<List<PinnedMessage>> getPins(String channelId) async {
    final data = await _get('/channels/$channelId/pins') as List<dynamic>;
    return data.map((e) => PinnedMessage.fromJson(e as Map<String, dynamic>)).toList();
  }

  @override
  Future<void> pinMessage(String messageId) async {
    await _post('/messages/$messageId/pin');
  }

  @override
  Future<void> unpinMessage(String messageId) async {
    await _delete('/messages/$messageId/pin');
  }

  @override
  Future<void> redactMessage(String messageId, String reason) async {
    await _post('/messages/$messageId/redact', {'reason': reason});
  }

  @override
  Future<void> editMessage(String messageId, String content) async {
    await _post('/messages/$messageId/edit', {'content': content});
  }

  @override
  Future<List<MessageRevision>> revisions(String messageId) async {
    final data = await _get('/messages/$messageId/revisions') as Map<String, dynamic>;
    return (data['revisions'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => MessageRevision.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<CreateAgentResult> createAgent({
    required AgentKind kind,
    required String name,
  }) async => CreateAgentResult.fromJson(
    await _post('/agents', {'kind': kind.wireValue, 'name': name})
        as Map<String, dynamic>,
  );

  @override
  Future<List<ModelInfo>> listModels() async {
    final data = await _get('/models') as Map<String, dynamic>;
    return (data['data'] as List<dynamic>? ?? const <dynamic>[])
        .map((e) => ModelInfo.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<void> setAgentModel(String agentId, String model) async {
    await _patch('/agents/$agentId', {'model': model});
  }

  @override
  Future<void> archiveChannel(String channelId, {bool archived = true}) async {
    await _post('/channels/$channelId/archive', {'archived': archived});
  }

  @override
  Future<GrantExecuteResult> grantExecute(
    String sessionId, {
    String scope = 'once',
  }) async => GrantExecuteResult.fromJson(
    await _post('/sessions/$sessionId/grant-execute', {'scope': scope})
        as Map<String, dynamic>,
  );

  @override
  Stream<WsEvent> subscribeChannel(String channelId) =>
      _openSocket({'type': 'subscribe', 'channelId': channelId});

  @override
  Stream<WsEvent> subscribeAll() => _openSocket({'type': 'subscribeAll'});

  /// The long-lived subscribeAll socket, kept so [sendTyping] can push inbound frames over it.
  WebSocketChannel? _globalSocket;

  @override
  void sendTyping(String channelId) {
    try {
      _globalSocket?.sink.add(jsonEncode({'type': 'typing', 'channelId': channelId}));
    } catch (_) {
      // Best-effort: a closed/closing socket just drops the ephemeral signal.
    }
  }

  @override
  Future<List<String>> getPresence() async {
    final data = await _get('/presence') as Map<String, dynamic>;
    return (data['online'] as List<dynamic>? ?? const []).map((e) => e.toString()).toList();
  }

  /// Opens one authenticated WebSocket, sends [firstFrame] on ready (a per-channel
  /// `subscribe` or an all-channels `subscribeAll`), and streams parsed events.
  Stream<WsEvent> _openSocket(Map<String, dynamic> firstFrame) {
    final token = this.token;
    // Bearer/dev mode carries `?token=`; session mode relies entirely on
    // the cookie riding the WS upgrade, so the query is cleared outright
    // (rather than left as whatever `origin`/`Uri.base` happened to carry,
    // e.g. a stray `?auth_error=` from a just-completed SSO redirect).
    final wsUri = origin.replace(
      scheme: origin.scheme == 'https' ? 'wss' : 'ws',
      path: '/',
      queryParameters: token != null
          ? {'token': token}
          : const <String, String>{},
    );
    // Native session mode (desktop): the httpOnly session cookie can't ride the
    // upgrade on its own (no browser cookie jar), so attach it as a header — the
    // io WebSocket honours it; on web the browser already sends the cookie and
    // the header arg is ignored (see platform/ws_connect.dart).
    final socket = wsConnect(
      wsUri,
      headers: sessionToken != null
          ? {'Cookie': 'secchat_session=$sessionToken'}
          : null,
    );
    _sockets.add(socket);
    // The all-channels socket is the one typing frames ride out on — keep a handle to it.
    if (firstFrame['type'] == 'subscribeAll') _globalSocket = socket;

    late final StreamController<WsEvent> controller;
    controller = StreamController<WsEvent>(
      onCancel: () {
        _sockets.remove(socket);
        if (identical(_globalSocket, socket)) _globalSocket = null;
        unawaited(socket.sink.close());
      },
    );

    socket.ready
        .then((_) {
          socket.sink.add(jsonEncode(firstFrame));
        })
        .catchError((Object error, StackTrace stackTrace) {
          // Swallowed deliberately: a connection failure here also reaches
          // `socket.stream`'s onError/onDone below, which is what actually
          // reports it to `controller`. Without *some* handler on `.ready`,
          // its rejection would separately surface as its own unhandled
          // async error.
        });

    socket.stream.listen(
      (raw) {
        if (controller.isClosed || raw is! String) return;
        try {
          final decoded = jsonDecode(raw) as Map<String, dynamic>;
          final event = parseWsEvent(decoded);
          if (event != null) controller.add(event);
        } catch (error, stackTrace) {
          if (!controller.isClosed) controller.addError(error, stackTrace);
        }
      },
      onError: (Object error, StackTrace stackTrace) {
        if (!controller.isClosed) controller.addError(error, stackTrace);
      },
      onDone: () {
        if (!controller.isClosed) controller.close();
      },
    );

    return controller.stream;
  }

  @override
  void dispose() {
    for (final socket in _sockets) {
      unawaited(socket.sink.close());
    }
    _sockets.clear();
    _http.close();
  }
}
