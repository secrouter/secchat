/// Desktop (`dart:io`) native SSO: loopback listener + system-browser launch.
/// See `native_sso.dart` for the why; the backend counterpart is the native
/// branch of `src/auth/bff.ts`.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// Runs the loopback SSO handshake and returns the captured session token, or
/// null on cancel/timeout/mismatch. Binds `127.0.0.1:0` (an OS-chosen free
/// port), opens the browser at `<origin>/auth/login?native_port=…&native_state=…`,
/// and waits (up to 5 min) for the backend's single loopback redirect carrying
/// `?session=…&state=…`. The `state` must echo back what we generated — a guard
/// against another local process hitting our listener.
Future<String?> nativeSsoLogin(Uri origin) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  try {
    final state = _randomState();
    final loginUrl = origin.replace(
      path: '/auth/login',
      queryParameters: <String, String>{
        'native_port': '${server.port}',
        'native_state': state,
      },
    );

    if (!await _openInBrowser(loginUrl)) return null;

    final completer = Completer<String?>();
    final sub = server.listen((HttpRequest req) async {
      final qp = req.uri.queryParameters;
      final session = qp['session'];
      final ok = session != null && session.isNotEmpty && qp['state'] == state;
      req.response
        ..statusCode = 200
        ..headers.contentType = ContentType.html
        ..write(_resultHtml(ok));
      await req.response.close();
      if (!completer.isCompleted) completer.complete(ok ? session : null);
    });

    final token = await completer.future
        .timeout(const Duration(minutes: 5), onTimeout: () => null);
    await sub.cancel();
    return token;
  } finally {
    await server.close(force: true);
  }
}

String _randomState() {
  final rng = Random.secure();
  final bytes = List<int>.generate(24, (_) => rng.nextInt(256));
  return base64Url.encode(bytes).replaceAll('=', '');
}

/// Opens [url] in the platform's default browser. Returns false if we don't know
/// how (unknown OS) or the launcher couldn't start — the caller then aborts
/// rather than hanging on a listener nothing will ever hit.
Future<bool> _openInBrowser(Uri url) async {
  final target = url.toString();
  try {
    if (Platform.isMacOS) {
      return (await Process.run('open', <String>[target])).exitCode == 0;
    }
    if (Platform.isLinux) {
      return (await Process.run('xdg-open', <String>[target])).exitCode == 0;
    }
    if (Platform.isWindows) {
      // Empty title arg so a quoted URL isn't parsed as the window title.
      return (await Process.run('cmd', <String>['/c', 'start', '', target]))
              .exitCode ==
          0;
    }
  } catch (_) {
    // Launcher missing/failed — fall through to false.
  }
  return false;
}

String _resultHtml(bool ok) {
  final msg = ok
      ? 'Signed in to SecChat. You can close this tab and return to the app.'
      : 'SecChat sign-in could not be completed. You can close this tab.';
  return '<!doctype html><meta charset="utf-8">'
      '<title>SecChat</title>'
      '<body style="font-family:system-ui;background:#0f1419;color:#e6e6e6;'
      'display:grid;place-items:center;height:100vh;margin:0">'
      '<p style="font-size:1rem">$msg</p></body>';
}
