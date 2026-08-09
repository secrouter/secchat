import 'package:web/web.dart' as web;

/// Opens [url] in a new browser tab.
///
/// `noopener,noreferrer` keeps the new tab from getting a handle back to
/// this window via `window.opener` -- standard hygiene for a link whose
/// target comes from message content rather than a hardcoded, trusted URL.
void openLinkUrl(String url) {
  web.window.open(url, '_blank', 'noopener,noreferrer');
}
