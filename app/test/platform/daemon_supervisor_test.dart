@TestOn('vm') // the desktop supervisor uses dart:io Process
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/platform/daemon_supervisor_api.dart';
import 'package:secchat_app/platform/daemon_supervisor_io.dart';

class _FakeProcess implements DaemonProcess {
  final _exit = Completer<int>();
  bool killed = false;
  @override
  Future<int> get exitCode => _exit.future;
  @override
  void kill() {
    killed = true;
    if (!_exit.isCompleted) _exit.complete(-9);
  }

  void crash() {
    if (!_exit.isCompleted) _exit.complete(1);
  }
}

void main() {
  test('start spawns with the SecChat env and goes running; stop kills it and goes off', () async {
    final procs = <_FakeProcess>[];
    Map<String, String>? capturedEnv;
    final sup = createDaemonSupervisor(
      executable: 'runnerd',
      launcher: (exe, args, env) async {
        capturedEnv = env;
        final p = _FakeProcess();
        procs.add(p);
        return p;
      },
    );

    sup.start(secchatUrl: 'https://chat.example', token: 'tok-1');
    await Future<void>.delayed(Duration.zero);
    expect(sup.state.value, RunnerDaemonState.running);
    expect(capturedEnv?['SECCHAT_URL'], 'https://chat.example');
    expect(capturedEnv?['SECCHAT_RUNNER_TOKEN'], 'tok-1');

    await sup.stop();
    expect(sup.state.value, RunnerDaemonState.off);
    expect(procs.single.killed, isTrue);
    sup.dispose();
  });

  test('a launch failure (e.g. binary not bundled) is an error with no process', () async {
    final sup = createDaemonSupervisor(
      executable: 'missing',
      launcher: (_, __, ___) async => throw ProcessException('missing', const []),
    );
    sup.start(secchatUrl: 'https://chat.example', token: 'tok');
    await Future<void>.delayed(Duration.zero);
    expect(sup.state.value, RunnerDaemonState.error);
    await sup.stop();
    sup.dispose();
  });

  test('an unexpected crash flips to error; stop then cancels the supervised restart', () async {
    var launches = 0;
    late _FakeProcess current;
    final sup = createDaemonSupervisor(
      executable: 'runnerd',
      launcher: (_, __, ___) async {
        launches++;
        current = _FakeProcess();
        return current;
      },
    );
    sup.start(secchatUrl: 'u', token: 't');
    await Future<void>.delayed(Duration.zero);
    expect(launches, 1);

    current.crash();
    await Future<void>.delayed(Duration.zero);
    expect(sup.state.value, RunnerDaemonState.error);

    // stop() cancels the pending 3s restart timer — no second launch happens.
    await sup.stop();
    expect(sup.state.value, RunnerDaemonState.off);
    expect(launches, 1);
    sup.dispose();
  });

  test('an empty token is a no-op (nothing spawned)', () async {
    var launches = 0;
    final sup = createDaemonSupervisor(launcher: (_, __, ___) async { launches++; return _FakeProcess(); });
    sup.start(secchatUrl: 'u', token: '');
    await Future<void>.delayed(Duration.zero);
    expect(launches, 0);
    expect(sup.state.value, RunnerDaemonState.off);
    sup.dispose();
  });
}
