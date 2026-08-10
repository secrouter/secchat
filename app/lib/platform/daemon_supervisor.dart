// Cross-platform entry for the bundled runner-daemon supervisor. Desktop (`dart:io`) spawns +
// supervises the daemon child process (daemon_supervisor_io.dart); web falls back to a no-op
// (daemon_supervisor_stub.dart). Shared types live in daemon_supervisor_api.dart.
//
//   createDaemonSupervisor()  →  DaemonSupervisor  (desktop: real; web: no-op)

export 'daemon_supervisor_api.dart';
export 'daemon_supervisor_stub.dart' if (dart.library.io) 'daemon_supervisor_io.dart';
