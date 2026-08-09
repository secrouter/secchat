/// Small, dependency-free formatting helpers (no `intl` -- the pubspec
/// deliberately pins only `http` + `web_socket_channel`).
library;

/// Formats a [DateTime] as a local `HH:mm` clock time.
String formatClockTime(DateTime dt) {
  final local = dt.toLocal();
  final h = local.hour.toString().padLeft(2, '0');
  final m = local.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

/// Formats a [DateTime] as a local `YYYY-MM-DD HH:mm` stamp — unambiguous and
/// assessor-legible, for places that can span days (e.g. edit history).
String formatTimestamp(DateTime dt) {
  final local = dt.toLocal();
  final y = local.year.toString().padLeft(4, '0');
  final mo = local.month.toString().padLeft(2, '0');
  final d = local.day.toString().padLeft(2, '0');
  return '$y-$mo-$d ${formatClockTime(dt)}';
}

/// Truncates an id/hash to a short, glanceable prefix for mono-styled UI
/// chrome (channel ids, session ids).
String shortId(String id, {int length = 10}) =>
    id.length <= length ? id : id.substring(0, length);

/// Up to two uppercase initials for an avatar, derived from a ref like
/// `dev.alice` or `alice.smith` -- splits on common separators and falls
/// back to the first two characters, or `?` for an empty ref.
String initialsFor(String ref) {
  final parts = ref
      .split(RegExp(r'[.\-_@\s]+'))
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) {
    final p = parts.first;
    return p.length >= 2 ? p.substring(0, 2).toUpperCase() : p.toUpperCase();
  }
  return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
}
