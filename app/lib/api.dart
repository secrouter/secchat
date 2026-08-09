/// The backend API surface, expressed as an abstract [ApiClient] so widget
/// tests can inject an in-memory fake and never touch the network. The real
/// implementation, [HttpApiClient], talks to the SecChat backend that serves
/// this app (see class doc for the base-URL and WebSocket-scoping notes).
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
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

  /// Posts a message to a channel. A non-null [parentId] makes it a reply in
  /// that message's thread. [marking] is the requested per-message
  /// classification (ignored server-side when the channel is itself marked).
  Future<Message> postMessage(String channelId, String content, {String? parentId, String? marking});

  /// Feeds free-text input to a running coding-agent *session* (as opposed
  /// to [postMessage], which posts a chat message to a *channel*). A coding
  /// agent is driven by its runner, not chat history, so its reply never
  /// comes back as a return value here -- it streams back over the
  /// channel's WebSocket as `agent_output` / `tool_decision` events. 202
  /// Accepted is the expected response; callers should treat this as
  /// fire-and-forget beyond surfacing a thrown [ApiException].
  Future<void> sendInput(String sessionId, String text);

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
  HttpApiClient({this.token, Uri? origin}) : origin = origin ?? Uri.base;

  /// The bearer token, or `null` for session (cookie) mode. See the class
  /// doc for what each mode sends on the wire.
  final String? token;
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
      if (_stepUpToken != null) 'X-Sec-StepUp': _stepUpToken!,
      'Content-Type': 'application/json',
    };
  }

  Uri _uri(String path) => origin.replace(path: path);

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
  Future<Message> postMessage(String channelId, String content, {String? parentId, String? marking}) async =>
      Message.fromJson(
        await _post('/channels/$channelId/messages', {
          'content': content,
          if (parentId != null) 'parentId': parentId,
          if (marking != null) 'marking': marking,
        }) as Map<String, dynamic>,
      );

  @override
  Future<void> sendInput(String sessionId, String text) async {
    await _post('/sessions/$sessionId/input', {'text': text});
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
  Future<GrantExecuteResult> grantExecute(
    String sessionId, {
    String scope = 'once',
  }) async => GrantExecuteResult.fromJson(
    await _post('/sessions/$sessionId/grant-execute', {'scope': scope})
        as Map<String, dynamic>,
  );

  @override
  Stream<WsEvent> subscribeChannel(String channelId) {
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
    final socket = WebSocketChannel.connect(wsUri);
    _sockets.add(socket);

    late final StreamController<WsEvent> controller;
    controller = StreamController<WsEvent>(
      onCancel: () {
        _sockets.remove(socket);
        unawaited(socket.sink.close());
      },
    );

    socket.ready
        .then((_) {
          socket.sink.add(
            jsonEncode({'type': 'subscribe', 'channelId': channelId}),
          );
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
