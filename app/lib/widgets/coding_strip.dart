import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import 'badges.dart';

/// Header strip shown only for coding-agent channels: the execute-gate
/// control surface. "Grant execute (once)" calls
/// `POST /sessions/:id/grant-execute` and flashes the allow/deny reason for
/// a few seconds -- the actual `tool_decision` allow/deny chips as the
/// agent uses that grant are rendered inline in the transcript instead (see
/// `lib/widgets/message_list.dart`).
class CodingStrip extends StatefulWidget {
  const CodingStrip({
    super.key,
    required this.sessionId,
    required this.sessionEnded,
    required this.onGrantExecute,
  });

  final String sessionId;
  final bool sessionEnded;
  final Future<GrantExecuteResult> Function() onGrantExecute;

  @override
  State<CodingStrip> createState() => _CodingStripState();
}

class _CodingStripState extends State<CodingStrip> {
  bool _granting = false;
  GrantExecuteResult? _flash;
  Timer? _flashTimer;

  @override
  void dispose() {
    _flashTimer?.cancel();
    super.dispose();
  }

  Future<void> _handleGrant() async {
    setState(() => _granting = true);
    GrantExecuteResult result;
    try {
      result = await widget.onGrantExecute();
    } catch (error) {
      result = GrantExecuteResult(
        allow: false,
        reason: error is ApiException ? error.message : 'Execution denied.',
      );
    }
    if (!mounted) return;
    setState(() {
      _granting = false;
      _flash = result;
    });
    _flashTimer?.cancel();
    _flashTimer = Timer(const Duration(milliseconds: 3200), () {
      if (mounted) setState(() => _flash = null);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 10),
          decoration: const BoxDecoration(
            color: AppColors.warnBg,
            border: Border(bottom: BorderSide(color: AppColors.warnBorder)),
          ),
          child: Row(
            children: [
              const Icon(Icons.terminal, size: 16, color: AppColors.warn),
              const SizedBox(width: 10),
              const Text(
                'Coding agent session',
                style: TextStyle(
                  color: AppColors.textMuted,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                shortId(widget.sessionId),
                style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint),
              ),
              const Spacer(),
              if (widget.sessionEnded)
                const PillBadge('Ended')
              else
                ElevatedButton.icon(
                  onPressed: _granting ? null : _handleGrant,
                  style: AppButtonStyles.warn,
                  icon: _granting
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: AppColors.onWarn,
                          ),
                        )
                      : const Icon(Icons.bolt, size: 16),
                  label: const Text('Grant execute (once)'),
                ),
            ],
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: _flash == null
              ? const SizedBox(width: double.infinity)
              : _FlashBanner(result: _flash!),
        ),
      ],
    );
  }
}

class _FlashBanner extends StatelessWidget {
  const _FlashBanner({required this.result});

  final GrantExecuteResult result;

  @override
  Widget build(BuildContext context) {
    final allow = result.allow;
    final reason = result.reason.isNotEmpty
        ? result.reason
        : (allow ? 'Execution granted.' : 'Execution denied.');
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 10),
      decoration: BoxDecoration(
        color: allow ? AppColors.okBg : AppColors.badBg,
        border: Border(
          bottom: BorderSide(
            color: allow ? AppColors.okBorder : AppColors.badBorder,
          ),
        ),
      ),
      child: Row(
        children: [
          Icon(
            allow ? Icons.check_circle : Icons.block,
            size: 15,
            color: allow ? AppColors.ok : AppColors.bad,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              reason,
              style: TextStyle(
                color: allow ? AppColors.ok : AppColors.bad,
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
