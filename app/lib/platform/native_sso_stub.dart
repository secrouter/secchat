/// Web (and any non-io) fallback for [nativeSsoLogin]: there's no loopback
/// listener or system-browser launch here, and the browser cookie path handles
/// SSO instead, so this is a no-op that returns null. Kept as a stub (rather
/// than leaving the symbol undefined off io) so `lib/` analyzes and
/// `flutter test` runs everywhere — see `native_sso.dart`'s conditional export.
library;

Future<String?> nativeSsoLogin(Uri origin) async => null;
