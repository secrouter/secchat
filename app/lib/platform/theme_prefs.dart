import 'package:shared_preferences/shared_preferences.dart';

/// Persists the light/dark theme choice across launches. Uses
/// `shared_preferences` (works uniformly on web -- localStorage -- and
/// desktop, unlike [SessionStore]'s OS-keychain-backed secure storage,
/// which would be overkill for a non-sensitive UI setting).
///
/// Best-effort throughout: any storage error (web storage can throw, e.g. in
/// a private-browsing context that blocks it) is swallowed and treated as
/// "no saved preference" -- the app just falls back to the default (dark),
/// never crashes.
class ThemePrefs {
  ThemePrefs._();

  static const String _key = 'secchat_light_mode';

  /// Returns the saved preference, or `null` if none is stored yet (or the
  /// read failed) -- callers should keep their existing default in that
  /// case, which today is always dark.
  static Future<bool?> loadIsLightMode() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(_key);
    } catch (_) {
      return null;
    }
  }

  static Future<void> saveIsLightMode(bool isLight) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_key, isLight);
    } catch (_) {
      // Non-fatal: persistence is a convenience, not a requirement.
    }
  }
}
