import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'daemon_supervisor_api.dart';

/// Where the runner daemon's pi points its model calls, wired at build time. Empty (the default)
/// leaves pi unconfigured — set these when the deployment's gateway (SecRouter) is reachable:
///   --dart-define=SECROUTER_ORIGIN=https://secrouter.sec.internal
///   --dart-define=SECCHAT_PI_MODEL=secllm/fast
const String _secrouterOrigin = String.fromEnvironment('SECROUTER_ORIGIN');
const String _piModel = String.fromEnvironment('SECCHAT_PI_MODEL');

/// A spawned daemon process — just the bits the supervisor needs, so a test can inject a fake.
abstract class DaemonProcess {
  Future<int> get exitCode;
  void kill();
}

/// Launches the daemon (real: `Process.start`). Injectable for testing the state machine.
typedef DaemonLauncher = Future<DaemonProcess> Function(String executable, List<String> args, Map<String, String> environment);

/// Desktop build: spawn + supervise the bundled runner daemon as a child process. The SecChat URL
/// + token are passed to it via the environment (the daemon reads SECCHAT_URL /
/// SECCHAT_RUNNER_TOKEN).
///
/// Resolution order for what to spawn (first that applies):
///  1. an explicit [executable] (tests inject a fake);
///  2. the runnerd EMBEDDED in the macOS .app — `Contents/Resources/runnerd/` holds a bundled
///     `node` + the dependency-free daemon sources (see scripts/bundle-macos-runnerd.sh). Spawning
///     a binary inside the app bundle is what the App Sandbox permits (an arbitrary system binary
///     is not), so the supervisor points straight at it: `node runnerd/daemon/main.ts`;
///  3. `SECCHAT_RUNNER_CMD` (dev override — e.g. point it at a system `node` + the bundle);
///  4. `secchat-runnerd` on PATH.
DaemonSupervisor createDaemonSupervisor({DaemonLauncher? launcher, String? executable, List<String> args = const []}) {
  final bundled = executable == null ? _bundledRunner() : null;
  return _ProcessSupervisor(
    launcher: launcher ?? _spawnReal,
    executable: executable ?? bundled?.executable,
    args: bundled != null ? bundled.args : args,
  );
}

/// The daemon's PATH with the common developer tool dirs (Homebrew, `~/.local/bin`, MacPorts)
/// prepended to whatever the app inherited — so a Finder-launched app can still find `pi`.
String _augmentedPath() {
  final home = Platform.environment['HOME'] ?? '';
  final inherited = Platform.environment['PATH'] ?? '';
  final extra = <String>[
    '/opt/homebrew/bin',
    '/usr/local/bin',
    if (home.isNotEmpty) '$home/.local/bin',
    '/opt/local/bin',
  ];
  return [...extra, if (inherited.isNotEmpty) inherited].join(':');
}

/// The runnerd embedded in the macOS .app bundle, or null (dev runs, other platforms, or a build
/// without the bundle — fall through to the env/PATH default). Derived from the running executable:
/// `…/SecChat.app/Contents/MacOS/<bin>` → `…/Contents/Resources/runnerd/`.
({String executable, List<String> args})? _bundledRunner() {
  if (!Platform.isMacOS) return null;
  try {
    final contents = File(Platform.resolvedExecutable).parent.parent.path; // …/Contents
    final node = File('$contents/Resources/runnerd/node');
    final entry = File('$contents/Resources/runnerd/daemon/main.ts');
    if (node.existsSync() && entry.existsSync()) {
      return (executable: node.path, args: <String>[entry.path]);
    }
  } catch (_) {
    // Any path/FS surprise → fall through to the env/PATH default.
  }
  return null;
}

Future<DaemonProcess> _spawnReal(String executable, List<String> args, Map<String, String> environment) async =>
    _RealDaemonProcess(await Process.start(executable, args, environment: environment));

class _RealDaemonProcess implements DaemonProcess {
  _RealDaemonProcess(this._p);
  final Process _p;
  @override
  Future<int> get exitCode => _p.exitCode;
  @override
  void kill() => _p.kill();
}

class _ProcessSupervisor implements DaemonSupervisor {
  _ProcessSupervisor({required this.launcher, String? executable, this.args = const []})
      : executable = executable ?? Platform.environment['SECCHAT_RUNNER_CMD'] ?? 'secchat-runnerd';

  final DaemonLauncher launcher;
  final String executable;
  final List<String> args;

  final _state = ValueNotifier<RunnerDaemonState>(RunnerDaemonState.off);
  DaemonProcess? _proc;
  bool _stopping = false;
  Timer? _retry;
  String? _url;
  String? _token;

  @override
  ValueListenable<RunnerDaemonState> get state => _state;

  @override
  bool get supported => Platform.isMacOS || Platform.isWindows || Platform.isLinux;

  @override
  void start({required String secchatUrl, required String token}) {
    if (!supported || token.isEmpty) return;
    if (_state.value == RunnerDaemonState.running || _state.value == RunnerDaemonState.starting) return;
    _url = secchatUrl;
    _token = token;
    _stopping = false;
    unawaited(_spawn());
  }

  Future<void> _spawn() async {
    _state.value = RunnerDaemonState.starting;
    try {
      final proc = await launcher(executable, args, {
        ...Platform.environment,
        'SECCHAT_URL': _url!,
        'SECCHAT_RUNNER_TOKEN': _token!,
        // The daemon shells out to the `pi` coding-agent CLI, but a GUI app launched from Finder
        // inherits a minimal PATH (/usr/bin:/bin:…) that omits where pi is usually installed. Prepend
        // the common tool dirs so the runner can find it. (SECCHAT_PI_RUNNER/PI_BIN still override.)
        if (Platform.isMacOS || Platform.isLinux) 'PATH': _augmentedPath(),
        // Point pi's model calls at the gateway. Without a base URL pi has no model endpoint, so a
        // coding session just sits idle until its lease lapses. Set at build time:
        //   --dart-define=SECROUTER_ORIGIN=https://secrouter.sec.internal
        //   --dart-define=SECCHAT_PI_MODEL=secllm/fast
        if (_secrouterOrigin.isNotEmpty) 'PI_BASE_URL': '$_secrouterOrigin/v1',
        if (_piModel.isNotEmpty) 'PI_MODEL': _piModel,
      });
      if (_stopping) {
        proc.kill();
        return;
      }
      _proc = proc;
      _state.value = RunnerDaemonState.running;
      // Supervise: an unexpected exit (the binary launched once, so it exists) triggers a restart.
      unawaited(proc.exitCode.then((_) {
        _proc = null;
        if (_stopping) {
          _state.value = RunnerDaemonState.off;
          return;
        }
        _state.value = RunnerDaemonState.error;
        _retry = Timer(const Duration(seconds: 3), () => unawaited(_spawn()));
      }));
    } catch (_) {
      // Couldn't launch at all (e.g. the binary isn't bundled yet) → error, and NO retry loop.
      _proc = null;
      _state.value = RunnerDaemonState.error;
    }
  }

  @override
  Future<void> stop() async {
    _stopping = true;
    _retry?.cancel();
    _proc?.kill();
    _proc = null;
    _state.value = RunnerDaemonState.off;
  }

  @override
  void dispose() {
    _stopping = true;
    _retry?.cancel();
    _proc?.kill();
    _state.dispose();
  }
}
