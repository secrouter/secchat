import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../platform/daemon_supervisor.dart';
import '../theme.dart';

/// A compact status chip for the bundled runner daemon (desktop only) — shows whether the local
/// coding-agent runner is off / starting / running / errored, driven live by the supervisor's state.
class RunnerStatusChip extends StatelessWidget {
  const RunnerStatusChip({super.key, required this.state});

  final ValueListenable<RunnerDaemonState> state;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<RunnerDaemonState>(
      valueListenable: state,
      builder: (context, s, _) {
        final (Color color, String label) = switch (s) {
          RunnerDaemonState.off => (AppColors.textFaint, 'Runner off'),
          RunnerDaemonState.starting => (AppColors.warn, 'Runner…'),
          RunnerDaemonState.running => (AppColors.ok, 'Runner on'),
          RunnerDaemonState.error => (AppColors.bad, 'Runner error'),
        };
        return Tooltip(
          message: 'Local coding-agent runner daemon',
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: AppColors.surfaceAlt,
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(999),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
                const SizedBox(width: 7),
                Text(label, style: AppFonts.mono(fontSize: 10.5, color: AppColors.textMuted)),
              ],
            ),
          ),
        );
      },
    );
  }
}
