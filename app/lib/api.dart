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

  @override
  String toString() => 'ApiException($statusCode): $message';
}

abstract class ApiClient {
  Future<Principal> getMe();

  Future<List<Channel>> getChannels();

  Future<Channel> createChannel(String name);

  Future<List<Message>> getMessages(String channelId);

  Future<Message> postMessage(String channelId, String content);

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
/// The four live event types (`message`, `assistant_delta`, `agent_output`,
/// `tool_decision`) and `session_ended` carry an `agentId` or `sessionId`
/// but never a `channelId`. This client treats a socket as scoped entirely
/// to the channel it subscribed to -- i.e. everything received on a given
/// connection belongs to that channel -- since that's the only
/// interpretation consistent with "one connect+subscribe per opened
/// channel" and the events' own shapes.
class HttpApiClient implements ApiClient {
  HttpApiClient({required this.token, Uri? origin})
    : origin = origin ?? Uri.base;

  final String token;
  final Uri origin;

  final http.Client _http = http.Client();
  final List<WebSocketChannel> _sockets = <WebSocketChannel>[];

  Map<String, String> get _headers => <String, String>{
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json',
  };

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

  @override
  Future<Principal> getMe() async =>
      Principal.fromJson(await _get('/me') as Map<String, dynamic>);

  @override
  Future<List<Channel>> getChannels() async {
    final data = await _get('/channels') as List<dynamic>;
    return data
        .map((e) => Channel.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<Channel> createChannel(String name) async => Channel.fromJson(
    await _post('/channels', {'name': name}) as Map<String, dynamic>,
  );

  @override
  Future<List<Message>> getMessages(String channelId) async {
    final data = await _get('/channels/$channelId/messages') as List<dynamic>;
    return data
        .map((e) => Message.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  @override
  Future<Message> postMessage(String channelId, String content) async =>
      Message.fromJson(
        await _post('/channels/$channelId/messages', {'content': content})
            as Map<String, dynamic>,
      );

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
    final wsUri = origin.replace(
      scheme: origin.scheme == 'https' ? 'wss' : 'ws',
      path: '/',
      queryParameters: {'token': token},
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
