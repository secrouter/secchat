/// A `WebSocketChannel.connect` that can also attach request headers (namely a
/// `Cookie: secchat_session=…` for native/desktop session mode — see
/// `api.dart`'s `_openSocket`).
///
/// The cross-platform `WebSocketChannel.connect` takes no headers; only the io
/// implementation (`IOWebSocketChannel.connect`) does. So this is
/// conditionally exported: the io build honours `headers`; the web build
/// ignores them (the browser already attaches same-origin cookies to the
/// upgrade), mirroring the `browser_redirect.dart` split.
library;

export 'ws_connect_html.dart' if (dart.library.io) 'ws_connect_io.dart';
