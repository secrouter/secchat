import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists the desktop SSO session token in the OS keychain so a relaunch restores the session
/// instead of re-running SSO. macOS/Linux use the login keychain / secret service (the app is NOT
/// sandboxed, so no keychain-sharing entitlement is needed); web keeps its same-origin cookie, so
/// there's nothing to store there and [load] returns null.
///
/// Best-effort throughout: any storage error is swallowed and treated as "no saved session" — the
/// worst case is the user signs in again, never a crash. Note: an ad-hoc-signed dev build changes
/// its code signature each rebuild, which invalidates the keychain item, so persistence survives a
/// normal app *restart* but not a *rebuild* (expected in development).
class SessionStore {
  SessionStore._();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();
  static const String _key = 'secchat_session_token';

  static Future<void> save(String token) async {
    try {
      await _storage.write(key: _key, value: token);
    } catch (_) {
      // Non-fatal: persistence is a convenience, not a requirement.
    }
  }

  static Future<String?> load() async {
    try {
      final token = await _storage.read(key: _key);
      return (token != null && token.isNotEmpty) ? token : null;
    } catch (_) {
      return null;
    }
  }

  static Future<void> clear() async {
    try {
      await _storage.delete(key: _key);
    } catch (_) {
      // Non-fatal.
    }
  }
}
