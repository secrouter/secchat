/// The app version shown next to the wordmark (see [BrandMark]).
///
/// Read from a `--dart-define=SECCHAT_VERSION=…` build define (the same
/// build-time convention the app already uses for SECCHAT_ORIGIN etc.), so CI
/// can stamp the real release; falls back to a sane default for local/dev
/// builds. Kept in its own tiny file so it's the single source of truth.
const String kAppVersion = String.fromEnvironment(
  'SECCHAT_VERSION',
  defaultValue: '0.1.0',
);
