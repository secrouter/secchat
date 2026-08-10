/// Web WebSocket connect. The browser attaches same-origin cookies (including
/// the httpOnly `secchat_session`) to the upgrade automatically, so `headers`
/// is accepted for a uniform signature but ignored — the browser WebSocket API
/// exposes no way to set them anyway.
library;

import 'package:web_socket_channel/web_socket_channel.dart';

WebSocketChannel wsConnect(Uri uri, {Map<String, String>? headers}) =>
    WebSocketChannel.connect(uri);
