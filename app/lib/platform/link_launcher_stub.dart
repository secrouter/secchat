/// Non-web fallback for `openLinkUrl`.
///
/// There is no browser tab to open off the web, so this is a no-op. Kept as
/// a harmless stub (rather than leaving the symbol undefined off web) so
/// `lib/` analyzes and `flutter test` runs on any platform, not just web --
/// see `link_launcher.dart` for the conditional export that picks this file
/// vs. `link_launcher_web.dart`.
void openLinkUrl(String url) {}
