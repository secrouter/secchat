import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'daemon_supervisor_api.dart';

/// Where the runner daemon's pi points its model calls, wired at build time. SECROUTER_ORIGIN is
/// empty by default — set it when the deployment's gateway (SecRouter) is reachable, or pi has no
/// endpoint and a coding session just sits idle. The model defaults to `secllm/balanced` (the
/// tool-capable Gemma 4 26B — `secllm/fast`, a 3B, does NOT reliably emit tool calls); override at
/// build to pin a different model or `auto` (router-chosen):
///   --dart-define=SECROUTER_ORIGIN=https://secrouter.sec.internal
///   --dart-define=SECCHAT_PI_MODEL=secllm/balanced
const String _secrouterOrigin = String.fromEnvironment('SECROUTER_ORIGIN');
const String _piModel =
    String.fromEnvironment('SECCHAT_PI_MODEL', defaultValue: 'secllm/balanced');

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

/// A durable directory for pi's per-agent session + workspace storage, so a coding agent resumes
/// its conversation and files across app restarts. Under Application Support on macOS (survives),
/// `~/.secchat/pi` elsewhere.
String _piStateDir() {
  final home = Platform.environment['HOME'] ?? '';
  return Platform.isMacOS
      ? '$home/Library/Application Support/SecChat/pi'
      : '$home/.secchat/pi';
}

/// The suite CA (SecCert root) bundled at `Contents/Resources/seccert-root.pem`, or null when not
/// bundled (dev runs / other platforms — pi then relies on its own trust store). See
/// scripts/bundle-macos-runnerd.sh, which copies it in alongside the runnerd payload.
String? _bundledCaPath() {
  if (!Platform.isMacOS) return null;
  try {
    final contents = File(Platform.resolvedExecutable).parent.parent.path; // …/Contents
    final ca = File('$contents/Resources/seccert-root.pem');
    if (ca.existsSync()) return ca.path;
  } catch (_) {
    // fall through
  }
  return null;
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

Future<DaemonProcess> _spawnReal(String executable, List<String> args, Map<String, String> environment) async {
  final proc = await Process.start(executable, args, environment: environment);
  // The runner daemon's stdout/stderr (and pi's, via SECCHAT_PI_DEBUG) is otherwise discarded.
  // Tee it to ~/Library/Logs/SecChat/runnerd.log so a coding session that dies can be diagnosed.
  final sink = _daemonLog();
  if (sink != null) {
    void tee(Stream<List<int>> s, String tag) {
      s
          .transform(systemEncoding.decoder)
          .transform(const LineSplitter())
          .listen((line) => sink.writeln('[$tag] $line'), onError: (_) {});
    }
    tee(proc.stdout, 'out');
    tee(proc.stderr, 'err');
  }
  return _RealDaemonProcess(proc);
}

IOSink? _cachedDaemonLog;
bool _daemonLogTried = false;

/// Append-mode log sink at ~/Library/Logs/SecChat/runnerd.log (macOS) / $HOME/.secchat (else),
/// opened once. Null if it can't be created (the daemon still runs; just unlogged). The daemon is
/// long-lived so the sink never closes on its own — a periodic flush pushes buffered lines to disk
/// so the log is actually readable while a session is live.
IOSink? _daemonLog() {
  if (_daemonLogTried) return _cachedDaemonLog;
  _daemonLogTried = true;
  try {
    final home = Platform.environment['HOME'];
    if (home == null) return null;
    final dir = Directory(Platform.isMacOS ? '$home/Library/Logs/SecChat' : '$home/.secchat');
    dir.createSync(recursive: true);
    final sink = File('${dir.path}/runnerd.log').openWrite(mode: FileMode.append);
    // The daemon is long-lived so the sink never closes on its own; a periodic flush pushes
    // buffered lines to disk so the log is readable while a session runs.
    Timer.periodic(const Duration(seconds: 2), (_) {
      try {
        sink.flush();
      } catch (_) {/* ignore */}
    });
    _cachedDaemonLog = sink;
  } catch (_) {
    _cachedDaemonLog = null;
  }
  return _cachedDaemonLog;
}

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
        // pi must actually reach the gateway for a coding session to do anything, so opt out of
        // pi's offline lockdown (see pi-runner's PI_OFFLINE) — the gateway is the one allowed
        // egress.
        'SECCHAT_PI_ALLOW_EGRESS': '1',
        // Log pi's spawn args + raw stdout/stderr through the daemon (captured to the runner log
        // below) — so a coding session that misbehaves can actually be diagnosed.
        'SECCHAT_PI_DEBUG': '1',
        // Durable per-agent session + workspace storage so a coding session RESUMES across app
        // restarts (pi `--session-id`/`--session-dir`) instead of starting cold. Under Application
        // Support so it survives, unlike a tmp dir.
        'SECCHAT_PI_STATE_DIR': _piStateDir(),
        // …and it verifies the gateway's TLS against the suite CA (SecCert). pi is its own Node
        // process that doesn't consult the macOS keychain, so hand it the CA bundled in the app.
        if (_bundledCaPath() case final ca?) 'NODE_EXTRA_CA_CERTS': ca,
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
