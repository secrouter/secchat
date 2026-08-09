import 'package:flutter/material.dart';

import '../formatting.dart';
import '../models.dart';
import '../theme.dart';

/// Shows the directory as a searchable picker and resolves to the chosen
/// [User], or null if dismissed. Used to start a DM. [users] should already
/// exclude the signed-in user (you don't DM yourself).
Future<User?> showUserPicker(BuildContext context, List<User> users) {
  return showDialog<User>(
    context: context,
    builder: (_) => _UserPickerDialog(users: users),
  );
}

class _UserPickerDialog extends StatefulWidget {
  const _UserPickerDialog({required this.users});

  final List<User> users;

  @override
  State<_UserPickerDialog> createState() => _UserPickerDialogState();
}

class _UserPickerDialogState extends State<_UserPickerDialog> {
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  List<User> get _filtered {
    final query = _search.text.trim().toLowerCase();
    if (query.isEmpty) return widget.users;
    return widget.users
        .where(
          (u) =>
              u.label.toLowerCase().contains(query) ||
              u.sub.toLowerCase().contains(query) ||
              (u.email?.toLowerCase().contains(query) ?? false) ||
              u.groups.any((g) => g.toLowerCase().contains(query)),
        )
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filtered;
    return AlertDialog(
      backgroundColor: AppColors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        side: const BorderSide(color: AppColors.border),
      ),
      title: const Text(
        'New direct message',
        style: TextStyle(
          color: AppColors.text,
          fontSize: 16,
          fontWeight: FontWeight.w700,
        ),
      ),
      content: SizedBox(
        width: 420,
        height: 430,
        child: Column(
          children: [
            TextField(
              controller: _search,
              autofocus: true,
              style: const TextStyle(color: AppColors.text, fontSize: 14),
              decoration: const InputDecoration(
                hintText: 'Search people or groups…',
                prefixIcon: Icon(Icons.search, size: 18, color: AppColors.textFaint),
              ),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: widget.users.isEmpty
                  ? const _Empty(
                      'No one else has signed in yet. The directory fills as '
                      'people sign in via SSO.',
                    )
                  : filtered.isEmpty
                  ? const _Empty('No people match that search.')
                  : ListView.builder(
                      primary: false,
                      itemCount: filtered.length,
                      itemBuilder: (_, i) => _UserRow(
                        user: filtered[i],
                        onTap: () => Navigator.of(context).pop(filtered[i]),
                      ),
                    ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

class _UserRow extends StatelessWidget {
  const _UserRow({required this.user, required this.onTap});

  final User user;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.sm),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
          child: Row(
            children: [
              Container(
                width: 32,
                height: 32,
                alignment: Alignment.center,
                decoration: const BoxDecoration(
                  color: AppColors.surfaceRaised,
                  shape: BoxShape.circle,
                ),
                child: Text(
                  initialsFor(user.label),
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                    color: AppColors.accent,
                  ),
                ),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      user.label,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: AppColors.text,
                      ),
                    ),
                    if (user.groups.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          user.groups.join(' · '),
                          overflow: TextOverflow.ellipsis,
                          style: AppFonts.mono(
                            fontSize: 10.5,
                            color: AppColors.textFaint,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              const Icon(Icons.alternate_email, size: 15, color: AppColors.textFaint),
            ],
          ),
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: const TextStyle(
            color: AppColors.textFaint,
            fontSize: 13,
            fontStyle: FontStyle.italic,
          ),
        ),
      ),
    );
  }
}
