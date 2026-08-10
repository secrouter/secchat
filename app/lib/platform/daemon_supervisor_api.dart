import 'package:flutter/foundation.dart';

/// The state of the bundled runner daemon child process the desktop app supervises.
enum RunnerDaemonState {
  /// Not started (or cleanly stopped), or not a desktop platform.
  off,

  /// Spawning / connecting.
  starting,

  /// The daemon process is running (attached to SecChat once it authenticates).
  running,

  /// The daemon couldn't start or exited unexpectedly.
  error,
}

/// Supervises the bundled runner daemon: on desktop it spawns the daemon as a child process wired to
/// the signed-in user's SecChat + token, keeps it alive, and reports [state]; on web it's a no-op
/// (there's no local process — a web user relies on a standalone/remote daemon). One instance per
/// app; call [start] after login and [dispose] on logout/exit.
abstract class DaemonSupervisor {
  /// The live daemon state, for a status indicator (ValueListenableBuilder).
  ValueListenable<RunnerDaemonState> get state;

  /// Whether this platform actually runs a local daemon (true on desktop, false on web/mobile).
  bool get supported;

  /// Start (idempotent) the daemon for [secchatUrl] as the user holding [token]. No-op if
  /// unsupported or already running, or if [token] is empty.
  void start({required String secchatUrl, required String token});

  /// Stop the daemon (no auto-restart) and reset to [RunnerDaemonState.off].
  Future<void> stop();

  /// Stop and release resources.
  void dispose();
}

/// A do-nothing supervisor (web build, and widget tests) — never spawns a process, stays [off].
class NoopDaemonSupervisor implements DaemonSupervisor {
  final _state = ValueNotifier<RunnerDaemonState>(RunnerDaemonState.off);

  @override
  ValueListenable<RunnerDaemonState> get state => _state;

  @override
  bool get supported => false;

  @override
  void start({required String secchatUrl, required String token}) {}

  @override
  Future<void> stop() async {}

  @override
  void dispose() => _state.dispose();
}
