/// Non-web fallback for `redirectBrowserTo`.
///
/// There is no browser location bar off the web, so this is a no-op. Kept
/// as a harmless stub (rather than leaving the symbol undefined off web) so
/// `lib/` analyzes and `flutter test` runs on any platform, not just web --
/// see `browser_redirect.dart` for the conditional export that picks this
/// file vs. `browser_redirect_web.dart`.
void redirectBrowserTo(String url) {}
