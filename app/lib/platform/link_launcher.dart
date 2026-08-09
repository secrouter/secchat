/// Opens a URL tapped inside rendered message content in a new browser tab
/// -- the mechanism behind link taps in [MarkdownText]
/// (`lib/widgets/markdown_text.dart`).
///
/// Meaningful on web only, but conditionally exported so the (shared) call
/// site still compiles and analyzes on every platform this app targets --
/// see the "web now, desktop/mobile later" note in `pubspec.yaml`. Off web,
/// `openLinkUrl` resolves to a no-op stub rather than a missing symbol, so
/// callers don't need their own platform check.
///
/// Deliberately opens a *new* tab rather than reusing
/// `browser_redirect.dart`'s top-level navigation -- a link inside a chat
/// message should never navigate the user out of the app the way SecSSO
/// login's full-page redirect is meant to.
library;

export 'link_launcher_stub.dart'
    if (dart.library.js_interop) 'link_launcher_web.dart';
