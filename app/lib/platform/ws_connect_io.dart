/// Desktop/mobile (`dart:io`) WebSocket connect that forwards request headers —
/// used to attach the `Cookie: secchat_session=…` for native session mode,
/// which the io socket has no cookie jar to send on its own.
library;

import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

WebSocketChannel wsConnect(Uri uri, {Map<String, String>? headers}) =>
    IOWebSocketChannel.connect(uri, headers: headers);
