import 'package:flutter/material.dart';

import 'api.dart';
import 'models.dart';
import 'screens/chat.dart';
import 'screens/login.dart';
import 'theme.dart';

/// App root: an auth gate between [LoginScreen] and [ChatScreen], holding
/// the signed-in [ApiClient] + [Principal] in memory only (per the dev
/// sign-in note on [LoginScreen] -- nothing is persisted across reloads).
class SecChatApp extends StatefulWidget {
  const SecChatApp({super.key});

  @override
  State<SecChatApp> createState() => _SecChatAppState();
}

class _SecChatAppState extends State<SecChatApp> {
  ApiClient? _api;
  Principal? _principal;

  /// Synthesizes the dev token, then validates it with `GET /me` before
  /// committing to it -- so a typo'd username still gets caught (assuming
  /// the backend validates `sub` format) rather than silently landing in a
  /// broken chat screen.
  Future<String?> _handleSignIn(String username, bool isAdmin) async {
    final groups = isAdmin ? 'secchat-admins' : '';
    final token = 'dev.$username.$groups';
    final api = HttpApiClient(token: token);
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

  void _handleSignOut() {
    _api?.dispose();
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
      theme: buildSecChatTheme(),
      home: _buildHome(),
    );
  }

  Widget _buildHome() {
    final api = _api;
    final principal = _principal;
    if (api != null && principal != null) {
      return ChatScreen(
        api: api,
        principal: principal,
        onSignOut: _handleSignOut,
      );
    }
    return LoginScreen(onSignIn: _handleSignIn);
  }
}
