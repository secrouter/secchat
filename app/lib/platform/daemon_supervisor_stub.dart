import 'daemon_supervisor_api.dart';

/// Web (and any non-`dart:io`) build: there is no local process to supervise, so everything is a
/// no-op and the state stays [RunnerDaemonState.off]. A web user drives coding agents through a
/// standalone/remote daemon instead.
DaemonSupervisor createDaemonSupervisor() => NoopDaemonSupervisor();
