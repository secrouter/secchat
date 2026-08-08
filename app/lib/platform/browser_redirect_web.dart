import 'package:web/web.dart' as web;

/// Navigates the browser's top-level location to [url].
///
/// A full page navigation (not a `fetch`), matching how SecSSO login has to
/// work: the backend's `/auth/login` starts a server-side redirect chain
/// (SecSSO authorize -> `/auth/callback`, which sets the `secchat_session`
/// cookie -> back to `/`) that only makes sense as a top-level browser
/// navigation, never an XHR/fetch call.
///
/// [url] is typically path-absolute (e.g. `/auth/login`) rather than a full
/// `scheme://host/...` string -- setting `location.href` to a path-absolute
/// value already navigates same-origin, which is what every caller here
/// wants, so there's no need to spell the origin out.
void redirectBrowserTo(String url) {
  web.window.location.href = url;
}
