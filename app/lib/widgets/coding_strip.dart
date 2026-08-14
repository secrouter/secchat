import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../formatting.dart';
import '../models.dart';
import '../responsive.dart';
import '../theme.dart';
import 'badges.dart';

/// Header strip for coding-agent channels: the execute-gate control surface. The owner picks the
/// execution MODE from a dropdown — Plan mode (mutations gated), Execute once (one mutation), or
/// Continual execution (every mutation until revoked) — which POSTs grant-execute / revoke-execute.
/// The current mode shows as a live badge so it's always visible whether the agent may currently
/// make changes; the per-tool allow/deny chips render inline in the transcript (see message_list).
/// Non-owners see the mode but not the dropdown.
class CodingStrip extends StatefulWidget {
  const CodingStrip({
    super.key,
    required this.sessionId,
    required this.sessionEnded,
    required this.canGrant,
    required this.executeMode,
    required this.onSetMode,
  });

  final String sessionId;
  final bool sessionEnded;

  /// Whether the current user may change the execute mode. Only the agent's owner can (the backend
  /// gate enforces it too); everyone else sees the mode but not the control.
  final bool canGrant;

  /// The session's current execute mode, tracked live by the parent from grant + tool_decision
  /// events.
  final ExecuteMode executeMode;

  /// Apply a new mode: grant (once/continual) or revoke (plan). Returns the server verdict so the
  /// strip can flash a denied reason.
  final Future<GrantExecuteResult> Function(ExecuteMode) onSetMode;

  @override
  State<CodingStrip> createState() => _CodingStripState();
}

class _CodingStripState extends State<CodingStrip> {
  bool _busy = false;
  GrantExecuteResult? _flash;
  Timer? _flashTimer;
  // Mobile only: the details/controls are collapsed behind an expand toggle (the bar is too narrow
  // for the full row on a phone — see build()'s compact branch).
  bool _expanded = false;

  @override
  void dispose() {
    _flashTimer?.cancel();
    super.dispose();
  }

  Future<void> _setMode(ExecuteMode mode) async {
    if (mode == widget.executeMode || _busy) return;
    setState(() => _busy = true);
    GrantExecuteResult result;
    try {
      result = await widget.onSetMode(mode);
    } catch (error) {
      result = GrantExecuteResult(
        allow: false,
        reason: error is ApiException ? error.message : 'Failed to change execution mode.',
      );
    }
    if (!mounted) return;
    // Only flash a DENIAL — a successful change is already reflected by the badge updating.
    setState(() {
      _busy = false;
      _flash = result.allow ? null : result;
    });
    if (_flash != null) {
      _flashTimer?.cancel();
      _flashTimer = Timer(const Duration(milliseconds: 3200), () {
        if (mounted) setState(() => _flash = null);
      });
    }
  }

  static ({String label, Color color, Color bg, Color border}) _badgeFor(ExecuteMode m) =>
      switch (m) {
        // Grey — no execution (default, no tools).
        ExecuteMode.none => (
          label: 'No execution',
          color: AppColors.textFaint,
          bg: AppColors.surfaceAlt,
          border: AppColors.border,
        ),
        // Green — plan mode (read-only).
        ExecuteMode.plan => (
          label: 'Plan mode (read-only)',
          color: AppColors.ok,
          bg: AppColors.okBg,
          border: AppColors.okBorder,
        ),
        // Yellow — execute once.
        ExecuteMode.once => (
          label: 'Execute granted (once)',
          color: Color(0xFFE8D14D),
          bg: Color(0xFF2C2810),
          border: Color(0xFF7A6E20),
        ),
        // Orange — continual execution.
        ExecuteMode.continual => (
          label: 'Continual execution',
          color: Color(0xFFE8823D),
          bg: Color(0xFF2C1B10),
          border: Color(0xFF7A4420),
        ),
      };

  @override
  Widget build(BuildContext context) {
    final badge = _badgeFor(widget.executeMode);
    final compact = isCompact(context);

    // The live mode badge — always visible whether the agent may currently make changes.
    final Widget modeBadge =
        PillBadge(badge.label, color: badge.color, background: badge.bg, borderColor: badge.border);
    // The mode-change control (or its ended / owner-only stand-ins).
    final Widget control = widget.sessionEnded
        ? const PillBadge('Ended')
        : widget.canGrant
            ? _ModeDropdown(mode: widget.executeMode, busy: _busy, onSelected: _setMode)
            : const Text(
                'Only the owner can change execution mode',
                style: TextStyle(color: AppColors.textFaint, fontSize: 12),
              );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: EdgeInsets.symmetric(horizontal: compact ? 14 : 22, vertical: 10),
          decoration: const BoxDecoration(
            color: AppColors.warnBg,
            border: Border(bottom: BorderSide(color: AppColors.warnBorder)),
          ),
          // Mobile: a tight always-visible header (icon + live mode badge + expand toggle) with the
          // session label / id / mode control collapsed into an expandable panel, so the bar never
          // overflows a narrow screen. Wide: the full single row.
          child: compact
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.terminal, size: 16, color: AppColors.warn),
                        const SizedBox(width: 10),
                        Expanded(child: Align(alignment: Alignment.centerLeft, child: modeBadge)),
                        IconButton(
                          onPressed: () => setState(() => _expanded = !_expanded),
                          icon: Icon(_expanded ? Icons.expand_less : Icons.expand_more),
                          iconSize: 20,
                          color: AppColors.warn,
                          visualDensity: VisualDensity.compact,
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                          tooltip: _expanded ? 'Hide details' : 'Show execution controls',
                        ),
                      ],
                    ),
                    AnimatedSize(
                      duration: const Duration(milliseconds: 160),
                      curve: Curves.easeOut,
                      alignment: Alignment.topCenter,
                      child: _expanded
                          ? Padding(
                              padding: const EdgeInsets.only(top: 10),
                              child: Wrap(
                                spacing: 10,
                                runSpacing: 8,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  const Text(
                                    'Coding agent session',
                                    style: TextStyle(
                                        color: AppColors.textMuted, fontSize: 12, fontWeight: FontWeight.w600),
                                  ),
                                  Text(shortId(widget.sessionId),
                                      style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint)),
                                  control,
                                ],
                              ),
                            )
                          : const SizedBox(width: double.infinity),
                    ),
                  ],
                )
              : Row(
                  children: [
                    const Icon(Icons.terminal, size: 16, color: AppColors.warn),
                    const SizedBox(width: 10),
                    const Text(
                      'Coding agent session',
                      style: TextStyle(color: AppColors.textMuted, fontSize: 12, fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(width: 10),
                    Text(shortId(widget.sessionId), style: AppFonts.mono(fontSize: 11, color: AppColors.textFaint)),
                    const SizedBox(width: 10),
                    modeBadge,
                    const Spacer(),
                    control,
                  ],
                ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: _flash == null ? const SizedBox(width: double.infinity) : _FlashBanner(result: _flash!),
        ),
      ],
    );
  }
}

/// The execution-mode dropdown. Kept compact and dark-themed to sit in the strip's header row.
class _ModeDropdown extends StatelessWidget {
  const _ModeDropdown({required this.mode, required this.busy, required this.onSelected});

  final ExecuteMode mode;
  final bool busy;
  final Future<void> Function(ExecuteMode) onSelected;

  static String _label(ExecuteMode m) => switch (m) {
    ExecuteMode.none => 'No execution',
    ExecuteMode.plan => 'Plan mode',
    ExecuteMode.once => 'Execute once',
    ExecuteMode.continual => 'Continual execution',
  };

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.warnBorder),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<ExecuteMode>(
          value: mode,
          isDense: true,
          icon: busy
              ? const SizedBox(
                  width: 12, height: 12,
                  child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.warn),
                )
              : const Icon(Icons.arrow_drop_down, color: AppColors.warn),
          dropdownColor: AppColors.surface,
          borderRadius: BorderRadius.circular(AppRadius.sm),
          style: const TextStyle(color: AppColors.text, fontSize: 12.5, fontWeight: FontWeight.w600),
          onChanged: busy ? null : (m) { if (m != null) onSelected(m); },
          items: [
            for (final m in ExecuteMode.values)
              DropdownMenuItem(value: m, child: Text(_label(m))),
          ],
        ),
      ),
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
        border: Border(bottom: BorderSide(color: allow ? AppColors.okBorder : AppColors.badBorder)),
      ),
      child: Row(
        children: [
          Icon(allow ? Icons.check_circle : Icons.block, size: 15, color: allow ? AppColors.ok : AppColors.bad),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              reason,
              style: TextStyle(color: allow ? AppColors.ok : AppColors.bad, fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
