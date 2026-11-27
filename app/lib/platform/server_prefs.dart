import 'package:shared_preferences/shared_preferences.dart';

/// Persists the user-chosen backend server origin across launches
/// (mobile/desktop only -- the web build always inherits the page origin, so
/// it never reads or writes this). Same best-effort `shared_preferences`
/// pattern as [ThemePrefs]: a server URL is a non-sensitive setting, and any
/// storage failure is treated as "no override" -- the app falls back to the
/// compile-time `SECCHAT_ORIGIN` default, never crashes.
class ServerPrefs {
  ServerPrefs._();

  static const String _key = 'secchat_server_origin';

  /// The saved origin, or `null` when none is stored, the read failed, or
  /// the stored value is not an http(s) URL -- callers keep the compile-time
  /// default in that case.
  static Future<Uri?> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null || raw.isEmpty) return null;
      final uri = Uri.tryParse(raw);
      final isHttp = uri != null && (uri.scheme == 'http' || uri.scheme == 'https');
      return isHttp ? uri : null;
    } catch (_) {
      return null;
    }
  }

  /// Saves the override, or clears it when [origin] is `null` (back to the
  /// compile-time default).
  static Future<void> save(Uri? origin) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      if (origin == null) {
        await prefs.remove(_key);
      } else {
        await prefs.setString(_key, origin.toString());
      }
    } catch (_) {
      // Non-fatal: persistence is a convenience, not a requirement.
    }
  }
}
