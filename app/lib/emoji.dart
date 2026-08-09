/// A small, curated emoji set for the composer's picker.
///
/// Deliberately in-house rather than a package: the suite pins its dependency
/// surface tightly (see the client's pubspec), a full Unicode emoji library is
/// large and updates on its own cadence, and a chat composer only needs a
/// useful common set — not every code point. Grouped into a few categories so
/// the picker can show section headers; extend the lists freely.
library;

/// One labelled group of emoji in the picker.
class EmojiGroup {
  const EmojiGroup(this.label, this.emoji);

  final String label;
  final List<String> emoji;
}

const List<EmojiGroup> kEmojiGroups = <EmojiGroup>[
  EmojiGroup('Smileys', <String>[
    '😀', '😄', '😁', '😆', '😅', '😂', '🙂', '🙃', '😉', '😊',
    '😍', '😘', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏',
    '😒', '😔', '😴', '😌', '😇', '🤔', '🤗', '🤐', '😬', '🙄',
    '😮', '😯', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '😱',
  ]),
  EmojiGroup('Gestures', <String>[
    '👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤙', '👋', '🙌',
    '👏', '🙏', '💪', '🫡', '🫶', '👀', '🧠', '🫥', '🤝', '✍️',
  ]),
  EmojiGroup('Objects', <String>[
    '🔥', '✨', '⭐', '⚡', '💡', '🚀', '🛠️', '🔧', '🔒', '🔑',
    '📦', '📎', '📌', '📝', '📊', '📈', '📉', '⏰', '🧪', '🧵',
    '💻', '🖥️', '⌨️', '🐛', '🧹', '♻️', '🗑️', '⚙️', '🔍', '🧭',
  ]),
  EmojiGroup('Symbols', <String>[
    '✅', '☑️', '✔️', '❌', '⛔', '⚠️', '❓', '❗', '➕', '➖',
    '💯', '🎉', '🎊', '🎯', '❤️', '🧡', '💛', '💚', '💙', '💜',
  ]),
];

/// Every emoji, flattened — handy for tests and search.
List<String> get kAllEmoji =>
    <String>[for (final group in kEmojiGroups) ...group.emoji];
