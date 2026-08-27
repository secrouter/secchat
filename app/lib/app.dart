import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'platform/browser_redirect.dart';
import 'platform/native_sso.dart';
import 'platform/session_store.dart';
import 'platform/theme_prefs.dart';
import 'screens/chat.dart';
import 'screens/login.dart';
import 'theme.dart';

/// Backend origin for builds with no page origin to inherit (desktop/mobile,
/// where `Uri.base` is a `file://` path, not the server). Set at build time:
///   flutter build macos --dart-define=SECCHAT_ORIGIN=https://secchat.sec.internal
/// Empty — the default, and always the case on web — makes every [HttpApiClient]
/// fall back to `Uri.base` (the same origin that served the app), preserving the
/// web behaviour exactly. Without this, a desktop build resolves `/auth/status`,
/// `/me`, and every API/agent call against `file://…` and they all fail — the
/// login screen degrades to the dev form and the assistant/agent pages 404.
const String _secchatOrigin = String.fromEnvironment('SECCHAT_ORIGIN');
Uri? get backendOrigin =>
    _secchatOrigin.isEmpty ? null : Uri.parse(_secchatOrigin);

/// App root: an auth gate between [LoginScreen] and [ChatScreen], holding
/// the signed-in [ApiClient] + [Principal] in memory only (nothing is
/// persisted across reloads -- a reload always re-runs the boot probe
/// below).
///
/// Two ways to land signed in:
///  - **Dev/bearer**: [LoginScreen]'s username form synthesizes a
///    `dev.<user>.<groups>` token, validated with `GET /me`.
///  - **SecSSO/session**: [LoginScreen]'s primary button navigates the whole
///    browser to `/auth/login`. The backend's OIDC round trip sets the
///    `secchat_session` httpOnly cookie and 302s back to `/`, which reloads
///    this app from scratch -- the boot sequence below then finds the live
///    session on its own `GET /me` probe and skips the login screen
///    entirely.
class SecChatApp extends StatefulWidget {
  const SecChatApp({super.key});

  @override
  State<SecChatApp> createState() => _SecChatAppState();
}

class _SecChatAppState extends State<SecChatApp> {
  ApiClient? _api;
  Principal? _principal;

  /// `true` until the boot-time `/auth/status` + `/me` probe (see [_boot])
  /// settles. A brief splash covers this instead of flashing the login
  /// screen for what's normally a sub-second round trip.
  bool _booting = true;

  /// Whether the backend reports SSO as configured. Threaded down to
  /// [LoginScreen] to decide whether the "Sign in with SecSSO" button
  /// renders at all. Defaults to (and falls back to, on any probe failure)
  /// `false`, which also covers the no-backend-reachable case -- the screen
  /// still degrades to the dev form rather than hanging or erroring.
  bool _ssoAvailable = false;

  /// `?auth_error=<reason>` from a just-completed, failed `/auth/callback`
  /// round trip, read once at boot. `null` in the common case (no error, or
  /// no query at all).
  String? _ssoError;

  /// Light/dark theme toggle. Defaults to dark (unchanged look for existing
  /// users) until the saved preference (if any) loads asynchronously in
  /// [initState] -- see [ThemePrefs].
  bool _isLightMode = false;

  @override
  void initState() {
    super.initState();
    unawaited(_boot());
    unawaited(_loadThemePref());
  }

  Future<void> _loadThemePref() async {
    final saved = await ThemePrefs.loadIsLightMode();
    if (saved == null || !mounted) return;
    setState(() => _isLightMode = saved);
  }

  void _toggleTheme() {
    final next = !_isLightMode;
    setState(() => _isLightMode = next);
    unawaited(ThemePrefs.saveIsLightMode(next));
  }

  /// Runs once at startup: checks whether SSO is configured, then probes
  /// `GET /me` in session (cookie) mode. A live `secchat_session` cookie
  /// (freshly set by a completed SecSSO round trip, or left over from an
  /// earlier one) makes the probe succeed and skips straight to
  /// [ChatScreen]; anything else (no cookie, expired session, SSO
  /// unconfigured, no backend reachable at all) falls through to
  /// [LoginScreen] instead of hanging or crashing.
  Future<void> _boot() async {
    final ssoError = Uri.base.queryParameters['auth_error'];
    // Restore a persisted desktop session first (secure storage), so a relaunch skips the SSO
    // login. On web there's no stored token — the browser's same-origin cookie carries the session
    // instead, so the cookie-mode probe below still works.
    final storedToken = await SessionStore.load();
    final probe = storedToken != null
        ? HttpApiClient(sessionToken: storedToken, origin: backendOrigin)
        : HttpApiClient(origin: backendOrigin); // session mode: no token, cookie only.

    var ssoAvailable = false;
    try {
      ssoAvailable = await probe.getAuthStatus();
    } catch (_) {
      // No backend reachable, or the route isn't wired up yet -- the login
      // screen should still render (dev form only), not hang or crash.
    }

    Principal? principal;
    try {
      principal = await probe.getMe();
    } catch (_) {
      // Not signed in via cookie -- expected outside the post-SSO-redirect
      // case, so this is not an error worth surfacing.
    }

    // A stored token that no longer authenticates (expired / revoked server-side) is stale — drop
    // it so we don't keep retrying it on every boot and land back here.
    if (principal == null && storedToken != null) {
      unawaited(SessionStore.clear());
    }

    // Discard the probe client unless it just became the live session
    // client below; otherwise its underlying http.Client would leak.
    if (principal == null) probe.dispose();

    if (!mounted) return;
    setState(() {
      _booting = false;
      _ssoAvailable = ssoAvailable;
      _ssoError = ssoError;
      if (principal != null) {
        _api = probe;
        _principal = principal;
      }
    });
  }

  /// Synthesizes the dev token, then validates it with `GET /me` before
  /// committing to it -- so a typo'd username still gets caught (assuming
  /// the backend validates `sub` format) rather than silently landing in a
  /// broken chat screen.
  Future<String?> _handleSignIn(String username, bool isAdmin) async {
    final groups = isAdmin ? 'secchat-admins' : '';
    final token = 'dev.$username.$groups';
    final api = HttpApiClient(token: token, origin: backendOrigin);
    try {
      final principal = await api.getMe();
      if (!mounted) return null;
      setState(() {
        _api = api;
        _principal = principal;
      });
      return null;
    } catch (error) {
      api.dispose();
      return error is ApiException ? error.message : 'Sign-in failed: $error';
    }
  }

  /// Desktop "Sign in with SecSSO": runs the native loopback flow (opens the
  /// system browser, captures the session token handed back to a local
  /// 127.0.0.1 listener — see `platform/native_sso.dart`), then validates it
  /// with `GET /me` in session-token mode before committing. Returns an error
  /// string to show on the login screen, or null on success (already swapped to
  /// chat). Only wired on desktop; web keeps the same-origin browser redirect.
  Future<String?> _handleSsoLogin() async {
    final token = await nativeSsoLogin(backendOrigin ?? Uri.base);
    if (token == null) return "SecSSO sign-in was cancelled or didn't complete.";
    final api = HttpApiClient(sessionToken: token, origin: backendOrigin);
    try {
      final principal = await api.getMe();
      // Persist the just-validated session so the next launch restores it (see _boot).
      await SessionStore.save(token);
      if (!mounted) return null;
      setState(() {
        _api = api;
        _principal = principal;
      });
      return null;
    } catch (error) {
      api.dispose();
      return error is ApiException ? error.message : 'Sign-in failed: $error';
    }
  }

  void _handleSignOut() {
    unawaited(_performSignOut());
  }

  /// Best-effort `POST /auth/logout` (clears the session cookie
  /// server-side; a harmless no-op round trip in dev/bearer mode), awaited
  /// *before* disposing the client -- so the request has actually gone out
  /// over the wire, rather than being cancelled mid-flight by closing the
  /// underlying `http.Client` immediately after firing it. Local sign-out
  /// (dropping the client, returning to [LoginScreen]) always proceeds
  /// regardless of whether the network call succeeds.
  Future<void> _performSignOut() async {
    // Drop the persisted session so a relaunch after sign-out returns to the login screen rather
    // than silently restoring the (now server-invalidated) session.
    await SessionStore.clear();
    final api = _api;
    String? logoutUrl;
    if (api is HttpApiClient) {
      try {
        logoutUrl = await api.logout().timeout(const Duration(seconds: 5));
      } catch (_) {
        // Sign out locally regardless -- SSO unconfigured, backend
        // unreachable, already logged out, etc. are all fine to ignore.
      }
    }
    api?.dispose();
    // Web: complete an OIDC RP-initiated logout by navigating the top-level browser to the IdP
    // end_session URL the BFF returned, so Authentik's SSO session is terminated too -- otherwise
    // "Sign out" only drops SecChat's cookie and the next login silently re-authenticates. No-op on
    // desktop (redirectBrowserTo's stub): no shared browser session there, so the local sign-out
    // below is sufficient.
    if (logoutUrl != null && logoutUrl.isNotEmpty) {
      redirectBrowserTo(logoutUrl);
      return;
    }
    if (!mounted) return;
    setState(() {
      _api = null;
      _principal = null;
    });
  }

  @override
  void dispose() {
    _api?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SecChat',
      debugShowCheckedModeBanner: false,
      theme: buildSecChatTheme(_isLightMode ? Brightness.light : Brightness.dark),
      home: _buildHome(),
    );
  }

  Widget _buildHome() {
    // Not `const`: [_BootSplash] reads [AppColors] getters, which are no
    // longer compile-time constants now that the palette is switchable.
    if (_booting) return _BootSplash();
    final api = _api;
    final principal = _principal;
    if (api != null && principal != null) {
      return ChatScreen(
        api: api,
        principal: principal,
        onSignOut: _handleSignOut,
        isLightMode: _isLightMode,
        onToggleTheme: _toggleTheme,
      );
    }
    return LoginScreen(
      onSignIn: _handleSignIn,
      // Web has a real browser + cookie: leave onSsoLogin null so the button
      // does a same-origin redirect to /auth/login. Desktop has neither, so it
      // gets the native loopback flow instead.
      onSsoLogin: kIsWeb ? null : _handleSsoLogin,
      ssoAvailable: _ssoAvailable,
      ssoError: _ssoError,
    );
  }
}

/// Covers the brief `/auth/status` + `GET /me` round trip at startup, so a
/// reload that's actually signed in via cookie doesn't flash the login
/// screen first.
class _BootSplash extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Center(
        child: SizedBox(
          width: 22,
          height: 22,
          child: CircularProgressIndicator(
            strokeWidth: 2.4,
            color: AppColors.accent,
          ),
        ),
      ),
    );
  }
}
