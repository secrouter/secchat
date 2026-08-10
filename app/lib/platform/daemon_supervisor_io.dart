import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'daemon_supervisor_api.dart';

/// A spawned daemon process — just the bits the supervisor needs, so a test can inject a fake.
abstract class DaemonProcess {
  Future<int> get exitCode;
  void kill();
}

/// Launches the daemon (real: `Process.start`). Injectable for testing the state machine.
typedef DaemonLauncher = Future<DaemonProcess> Function(String executable, List<String> args, Map<String, String> environment);

/// Desktop build: spawn + supervise the bundled runner daemon as a child process. [executable] +
/// [args] default to the bundled runner binary (`secchat-runnerd`, overridable via
/// `SECCHAT_RUNNER_CMD`); the SecChat URL + token are passed to it via the environment (the daemon
/// reads SECCHAT_URL / SECCHAT_RUNNER_TOKEN).
DaemonSupervisor createDaemonSupervisor({DaemonLauncher? launcher, String? executable, List<String> args = const []}) =>
    _ProcessSupervisor(launcher: launcher ?? _spawnReal, executable: executable, args: args);

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
