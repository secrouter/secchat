import 'models.dart';

/// The @mention handle for a user — a whitespace-free token derived from what people SEE. Mirrors
/// the backend's `mentionHandle` in src/mentions/parse.ts EXACTLY: the display name first ("Alice
/// Ng" → "aliceng"), else the email local-part (alice@x.mil → "alice"), else the raw sub; lowercased
/// and reduced to `[a-z0-9._-]` (spaces removed). The composer inserts this and the server matches
/// it, so a picked "@Alice Ng" round-trips. Keep the two in lockstep.
String mentionHandle(User user) {
  final display = user.displayName;
  final email = user.email;
  final base = (display != null && display.trim().isNotEmpty)
      ? display
      : (email != null && email.contains('@'))
          ? email.split('@').first
          : user.sub;
  return base.toLowerCase().replaceAll(RegExp(r'[^a-z0-9._-]'), '');
}

/// Members whose handle or display name matches the partial `@`-query the user is typing (without
/// the leading `@`), ranked prefix-first then substring, excluding `selfSub`. Case-insensitive.
/// Powers the composer's mention autocomplete.
List<User> matchMentionCandidates(Iterable<User> users, String query, {String? selfSub}) {
  final q = query.toLowerCase();
  final prefix = <User>[];
  final other = <User>[];
  for (final u in users) {
    if (u.sub == selfSub) continue;
    final handle = mentionHandle(u);
    final label = u.label.toLowerCase();
    if (handle.startsWith(q) || label.startsWith(q)) {
      prefix.add(u);
    } else if (q.isNotEmpty && (handle.contains(q) || label.contains(q))) {
      other.add(u);
    }
  }
  return [...prefix, ...other];
}
