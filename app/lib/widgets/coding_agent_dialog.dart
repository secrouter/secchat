import 'package:flutter/material.dart';

import '../models.dart';
import '../responsive.dart';
import '../theme.dart';

/// The New-Coding-Agent prompt: a name, a launch-environment choice (WHERE the
/// agent's pi session runs — the user's desktop app, or the online pool once it's
/// deployed), and — for the desktop — an optional local folder to mount as the
/// agent's workspace (e.g. a repo). Unavailable environments are shown but
/// disabled, with the reason. Returns the chosen name + environment id + optional
/// workspace path, or `null` if cancelled.
Future<({String name, String launchEnv, String? workspace, String? model, bool reasoning, List<String> analysis, bool analysisEgress})?> showCodingAgentDialog(
  BuildContext context, {
  required List<LaunchEnv> environments,
  required List<String> models,
  List<String> analyzers = const [],
}) {
  return showDialog<({String name, String launchEnv, String? workspace, String? model, bool reasoning, List<String> analysis, bool analysisEgress})>(
    context: context,
    barrierColor: AppColors.overlay,
    builder: (dialogContext) => _CodingAgentDialog(environments: environments, models: models, analyzers: analyzers),
  );
}

class _CodingAgentDialog extends StatefulWidget {
  const _CodingAgentDialog({required this.environments, required this.models, required this.analyzers});

  final List<LaunchEnv> environments;
  final List<String> models;

  /// Analysis sidecar names the pool offers (empty = feature off / pool off).
  final List<String> analyzers;

  @override
  State<_CodingAgentDialog> createState() => _CodingAgentDialogState();
}

class _CodingAgentDialogState extends State<_CodingAgentDialog> {
  final _controller = TextEditingController();
  final _workspaceController = TextEditingController();
  String? _selectedEnv;
  String? _selectedModel;
  bool _reasoning = false;
  final Set<String> _analysis = {};
  bool _analysisEgress = false; // internet access for the pod — DEFAULT OFF

  @override
  void initState() {
    super.initState();
    // Default to the first available environment (if any).
    _selectedEnv = widget.environments
        .cast<LaunchEnv?>()
        .firstWhere((e) => e!.available, orElse: () => null)
        ?.id;
    // Default to the first offered model (null when the list is empty ⇒ the server-side default).
    _selectedModel = widget.models.isNotEmpty ? widget.models.first : null;
  }

  @override
  void dispose() {
    _controller.dispose();
    _workspaceController.dispose();
    super.dispose();
  }

  bool get _canCreate =>
      _controller.text.trim().isNotEmpty && _selectedEnv != null;

  // A mounted folder only makes sense on the desktop (a local path on the pool would be invalid).
  bool get _showWorkspace => _selectedEnv == 'desktop';

  void _submit() {
    final name = _controller.text.trim();
    if (name.isEmpty || _selectedEnv == null) return;
    final ws = _showWorkspace ? _workspaceController.text.trim() : '';
    final pool = _selectedEnv == 'pool';
    Navigator.of(context).pop((
      name: name,
      launchEnv: _selectedEnv!,
      workspace: ws.isEmpty ? null : ws,
      model: _selectedModel,
      reasoning: _reasoning,
      analysis: pool ? _analysis.toList() : const <String>[],
      analysisEgress: pool && _analysisEgress,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final anyAvailable = widget.environments.any((e) => e.available);
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(24),
      child: Container(
        width: dialogWidth(context, 400),
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(AppRadius.lg),
          boxShadow: const [
            BoxShadow(color: Color(0x80000000), blurRadius: 64, offset: Offset(0, 24)),
          ],
        ),
        // Scrollable body: this dialog is tall (name + model + reasoning + environments + workspace)
        // and the name field autofocuses, so on a phone the soft keyboard halves the available
        // height — without a scroll view the Column overflows (RenderFlex) instead of scrolling.
        child: SingleChildScrollView(
          child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'New coding agent',
              style: TextStyle(color: AppColors.text, fontSize: 16, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'Starts a coding session; tool execution is gated behind an explicit grant.',
              style: TextStyle(color: AppColors.textMuted, fontSize: 12.5, height: 1.4),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _controller,
              autofocus: true,
              style: const TextStyle(color: AppColors.text, fontSize: 14),
              decoration: const InputDecoration(hintText: 'e.g. release-helper'),
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _submit(),
            ),
            if (widget.models.isNotEmpty) ...[
              const SizedBox(height: 16),
              const Text(
                'MODEL',
                style: TextStyle(color: AppColors.textFaint, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.6),
              ),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                initialValue: _selectedModel,
                isExpanded: true,
                dropdownColor: AppColors.surface,
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                items: [
                  for (final m in widget.models)
                    DropdownMenuItem(value: m, child: Text(m, overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => setState(() => _selectedModel = v),
              ),
            ],
            const SizedBox(height: 10),
            Row(
              children: [
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Reasoning', style: TextStyle(color: AppColors.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                      Text('Let the model think step by step before answering.', style: TextStyle(color: AppColors.textMuted, fontSize: 11.5)),
                    ],
                  ),
                ),
                Switch(
                  value: _reasoning,
                  activeThumbColor: AppColors.accent,
                  onChanged: (v) => setState(() => _reasoning = v),
                ),
              ],
            ),
            const SizedBox(height: 18),
            const Text(
              'LAUNCH ENVIRONMENT',
              style: TextStyle(
                color: AppColors.textFaint,
                fontSize: 11,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.6,
              ),
            ),
            const SizedBox(height: 8),
            for (final env in widget.environments) _EnvOption(
              env: env,
              selected: _selectedEnv == env.id,
              onSelect: env.available ? () => setState(() => _selectedEnv = env.id) : null,
            ),
            if (_selectedEnv == 'pool' && widget.analyzers.isNotEmpty) ...[
              const SizedBox(height: 14),
              const Text(
                'ANALYSIS TOOLS',
                style: TextStyle(color: AppColors.textFaint, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.6),
              ),
              const SizedBox(height: 2),
              const Text(
                'Extra tooling containers attached to the agent, sharing its workspace.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 11.5, height: 1.35),
              ),
              for (final a in widget.analyzers)
                CheckboxListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  activeColor: AppColors.accent,
                  title: Text(a, style: const TextStyle(color: AppColors.text, fontSize: 13)),
                  value: _analysis.contains(a),
                  onChanged: (v) => setState(() => v == true ? _analysis.add(a) : _analysis.remove(a)),
                ),
            ],
            if (_selectedEnv == 'pool') ...[
              const SizedBox(height: 6),
              Row(
                children: [
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Internet access', style: TextStyle(color: AppColors.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                        Text('Off by default: the agent reaches only git and SecChat.', style: TextStyle(color: AppColors.textMuted, fontSize: 11.5)),
                      ],
                    ),
                  ),
                  Switch(
                    value: _analysisEgress,
                    activeThumbColor: AppColors.warn, // opening egress is a posture change — warn tint
                    onChanged: (v) => setState(() => _analysisEgress = v),
                  ),
                ],
              ),
            ],
            if (_showWorkspace) ...[
              const SizedBox(height: 14),
              const Text(
                'LOCAL FOLDER (OPTIONAL)',
                style: TextStyle(
                  color: AppColors.textFaint,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.6,
                ),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _workspaceController,
                style: const TextStyle(color: AppColors.text, fontSize: 13),
                decoration: const InputDecoration(hintText: '~/project or /Users/you/project'),
              ),
              const SizedBox(height: 4),
              const Text(
                'An EXISTING folder on your Mac (~ and absolute paths work). The agent works there — '
                'reads freely; edits still need your grant. Blank = a private scratch workspace. The '
                'agent shows its actual workspace when it starts.',
                style: TextStyle(color: AppColors.textMuted, fontSize: 11.5, height: 1.35),
              ),
            ],
            if (!anyAvailable) ...[
              const SizedBox(height: 6),
              const Text(
                'No launch environment is available yet — connect your desktop app to run a coding agent.',
                style: TextStyle(color: AppColors.warn, fontSize: 12, height: 1.4),
              ),
            ],
            const SizedBox(height: 18),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(
                  onPressed: () => Navigator.of(context).pop(),
                  style: AppButtonStyles.ghost,
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 10),
                ElevatedButton(
                  onPressed: _canCreate ? _submit : null,
                  style: AppButtonStyles.primary,
                  child: const Text('Create'),
                ),
              ],
            ),
          ],
          ),
        ),
      ),
    );
  }
}

/// One selectable launch-environment row. A disabled ([onSelect] null) row is an
/// unavailable environment: greyed, not tappable, showing why in its detail.
class _EnvOption extends StatelessWidget {
  const _EnvOption({required this.env, required this.selected, required this.onSelect});

  final LaunchEnv env;
  final bool selected;
  final VoidCallback? onSelect;

  @override
  Widget build(BuildContext context) {
    final enabled = onSelect != null;
    final borderColor = selected ? AppColors.accent : AppColors.border;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Opacity(
        opacity: enabled ? 1 : 0.55,
        child: InkWell(
          onTap: onSelect,
          borderRadius: BorderRadius.circular(AppRadius.sm),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: selected ? AppColors.accentSoft : Colors.transparent,
              border: Border.all(color: borderColor),
              borderRadius: BorderRadius.circular(AppRadius.sm),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  selected ? Icons.radio_button_checked : Icons.radio_button_unchecked,
                  size: 18,
                  color: selected ? AppColors.accent : AppColors.textFaint,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            env.label,
                            style: const TextStyle(
                              color: AppColors.text,
                              fontSize: 13.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (!env.available) ...[
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                              decoration: BoxDecoration(
                                color: AppColors.surfaceAlt,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: Text(
                                env.reason == 'not_deployed' ? 'Coming soon' : 'Unavailable',
                                style: const TextStyle(color: AppColors.textFaint, fontSize: 10.5, fontWeight: FontWeight.w600),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        env.detail,
                        style: const TextStyle(color: AppColors.textMuted, fontSize: 12, height: 1.35),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
