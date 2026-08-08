/// Redirects the browser's top-level location to a URL -- the mechanism
/// behind the login screen's "Sign in with SecSSO" button
/// (`lib/screens/login.dart`).
///
/// Meaningful on web only, but conditionally exported so the (shared) call
/// site still compiles and analyzes on every platform this app targets --
/// see the "web now, desktop/mobile later" note in `pubspec.yaml`. Off web,
/// `redirectBrowserTo` resolves to a no-op stub rather than a missing
/// symbol, so callers don't need their own platform check.
library;

export 'browser_redirect_stub.dart'
    if (dart.library.js_interop) 'browser_redirect_web.dart';
