/// Native (desktop) SSO login via a loopback redirect (RFC 8252).
///
/// A native app can't receive the backend's httpOnly `secchat_session` cookie
/// the way a browser does, so instead: the app starts a `127.0.0.1:<port>`
/// listener, opens the system browser at `<origin>/auth/login?native_port=…`,
/// the backend runs the whole OIDC dance in that browser and finally redirects
/// to the loopback with the freshly minted session token (see the native branch
/// in the backend's `src/auth/bff.ts`). [nativeSsoLogin] returns that token (to
/// be used via `HttpApiClient(sessionToken: …)`), or null if the user cancelled
/// / it timed out / anything didn't line up.
///
/// Web has a real browser location bar and gets the cookie for free, so there
/// the stub returns null and the app keeps using the `redirectBrowserTo`
/// (cookie) path instead — mirroring `browser_redirect.dart`'s split.
library;

export 'native_sso_stub.dart' if (dart.library.io) 'native_sso_io.dart';
