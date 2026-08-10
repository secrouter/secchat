import 'package:flutter/material.dart';

import '../api.dart';
import '../models.dart';
import '../theme.dart';
import 'user_picker.dart';

/// Opens the channel members panel: view the roster, and — for an owner or a platform admin —
/// add people, change roles, and remove members. Self-contained: it loads members from [api] and
/// manages its own state. [roster] feeds the add-people picker; [isAdmin] is the caller's platform
/// admin status (owners are detected from the loaded roster).
Future<void> showMembersPanel(
  BuildContext context, {
  required ApiClient api,
  required Channel channel,
  required String currentUserSub,
  required bool isAdmin,
  required List<User> roster,
  Set<String> onlineSubs = const {},
}) {
  return showDialog<void>(
    context: context,
    builder: (_) => _MembersDialog(
      api: api,
      channel: channel,
      currentUserSub: currentUserSub,
      isAdmin: isAdmin,
      roster: roster,
      onlineSubs: onlineSubs,
    ),
  );
}

class _MembersDialog extends StatefulWidget {
  const _MembersDialog({
    required this.api,
    required this.channel,
    required this.currentUserSub,
    required this.isAdmin,
    required this.roster,
    required this.onlineSubs,
  });

  final ApiClient api;
  final Channel channel;
  final String currentUserSub;
  final bool isAdmin;
  final List<User> roster;
  final Set<String> onlineSubs;

  @override
  State<_MembersDialog> createState() => _MembersDialogState();
}

class _MembersDialogState extends State<_MembersDialog> {
  List<ChannelMember>? _members;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final members = await widget.api.getMembers(widget.channel.id);
      if (!mounted) return;
      setState(() {
        _members = members;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : e.toString());
    }
  }

  /// Owner-or-admin — the client mirror of the server's `canManageMembers` (the server still
  /// enforces; this only decides whether to SHOW the controls).
  bool get _canManage {
    if (widget.isAdmin) return true;
    final me = _members?.where((m) => m.memberRef == widget.currentUserSub);
    return me != null && me.isNotEmpty && me.first.isOwner;
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e is ApiException ? e.message : e.toString())),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _addPeople() async {
    final present = {for (final m in _members ?? const <ChannelMember>[]) m.memberRef};
    final candidates = widget.roster.where((u) => !present.contains(u.sub)).toList();
    final picked = await showUserPicker(context, candidates);
    if (picked == null) return;
    await _run(() => widget.api.addMember(widget.channel.id, picked.sub));
  }

  @override
  Widget build(BuildContext context) {
    final members = _members;
    final canManage = _canManage;
    return Dialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480, maxHeight: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(18, 16, 12, 10),
              child: Row(
                children: [
                  const Icon(Icons.group_outlined, size: 18, color: AppColors.accent),
                  const SizedBox(width: 8),
                  Text(
                    'Members${members != null ? ' · ${members.length}' : ''}',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.text),
                  ),
                  const Spacer(),
                  if (canManage)
                    TextButton.icon(
                      onPressed: _busy ? null : _addPeople,
                      icon: const Icon(Icons.person_add_alt, size: 16),
                      label: const Text('Add people'),
                    ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close, size: 18),
                    color: AppColors.textMuted,
                    tooltip: 'Close',
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: AppColors.border),
            Flexible(child: _body(members, canManage)),
          ],
        ),
      ),
    );
  }

  Widget _body(List<ChannelMember>? members, bool canManage) {
    if (_error != null) {
      return Padding(
        padding: const EdgeInsets.all(24),
        child: Center(child: Text(_error!, style: const TextStyle(color: AppColors.bad))),
      );
    }
    if (members == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
      );
    }
    return ListView.separated(
      shrinkWrap: true,
      padding: const EdgeInsets.symmetric(vertical: 6),
      itemCount: members.length,
      separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.border),
      itemBuilder: (context, i) => _MemberRow(
        member: members[i],
        isSelf: members[i].memberRef == widget.currentUserSub,
        online: !members[i].isAgent && widget.onlineSubs.contains(members[i].memberRef),
        canManage: canManage && !_busy,
        onMakeOwner: () => _run(() => widget.api.addMember(widget.channel.id, members[i].memberRef, role: 'owner')),
        onMakeMember: () => _run(() => widget.api.addMember(widget.channel.id, members[i].memberRef, role: 'member')),
        onRemove: () => _run(() => widget.api.removeMember(widget.channel.id, members[i].memberRef)),
      ),
    );
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({
    required this.member,
    required this.isSelf,
    required this.online,
    required this.canManage,
    required this.onMakeOwner,
    required this.onMakeMember,
    required this.onRemove,
  });

  final ChannelMember member;
  final bool isSelf;
  final bool online;
  final bool canManage;
  final VoidCallback onMakeOwner;
  final VoidCallback onMakeMember;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
      child: Row(
        children: [
          Stack(
            clipBehavior: Clip.none,
            children: [
              Icon(member.isAgent ? Icons.smart_toy_outlined : Icons.person_outline, size: 18, color: AppColors.textMuted),
              if (online)
                Positioned(
                  right: -1,
                  bottom: -1,
                  child: Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: AppColors.ok,
                      shape: BoxShape.circle,
                      border: Border.all(color: AppColors.surface, width: 1.5),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${member.label}${isSelf ? ' (you)' : ''}',
                  style: const TextStyle(fontSize: 13.5, color: AppColors.text, fontWeight: FontWeight.w600),
                ),
                if (member.email != null && member.email!.isNotEmpty)
                  Text(member.email!, style: AppFonts.mono(fontSize: 10.5, color: AppColors.textFaint)),
              ],
            ),
          ),
          if (member.isOwner)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(
                color: AppColors.accentSoft,
                borderRadius: BorderRadius.circular(3),
                border: Border.all(color: AppColors.accentBorder),
              ),
              child: Text('OWNER', style: AppFonts.mono(fontSize: 9.5, color: AppColors.accent).copyWith(fontWeight: FontWeight.w700)),
            ),
          if (canManage) ...[
            const SizedBox(width: 4),
            PopupMenuButton<String>(
              tooltip: 'Manage member',
              icon: const Icon(Icons.more_vert, size: 16, color: AppColors.textMuted),
              color: AppColors.surfaceRaised,
              onSelected: (v) {
                switch (v) {
                  case 'owner':
                    onMakeOwner();
                  case 'member':
                    onMakeMember();
                  case 'remove':
                    onRemove();
                }
              },
              itemBuilder: (_) => [
                if (!member.isOwner) const PopupMenuItem(value: 'owner', child: Text('Make owner')),
                if (member.isOwner) const PopupMenuItem(value: 'member', child: Text('Make member')),
                const PopupMenuItem(value: 'remove', child: Text('Remove from channel')),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
