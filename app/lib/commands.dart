/// Client-side slash commands for the composer.
///
/// A message whose first token is `/<name>` where `<name>` is a command in
/// [kSlashCommands] is interpreted as a command rather than sent verbatim.
/// Anything else — including a leading `/` that does NOT match a known command
/// (a path like `/etc/hosts`, or an unknown `/deploy`) — is treated as ordinary
/// text and sent normally. That keeps the feature additive: the only inputs it
/// changes are ones that spell an actual command.
///
/// The heavy dispatch (talking to a pi session, opening the help dialog) lives
/// in the chat screen, which has the channel/session context; this module is
/// deliberately pure so it can be unit-tested without a widget tree.
library;

/// One slash command the composer knows about.
class SlashCommand {
  const SlashCommand({
    required this.name,
    required this.argHint,
    required this.summary,
  });

  /// The command word, without the leading slash (e.g. `pi`).
  final String name;

  /// A short usage hint for the argument(s), shown in the suggestion strip and
  /// the help dialog (e.g. `<message>`). Empty when the command takes none.
  final String argHint;

  /// One-line description for `/help` and the suggestion strip.
  final String summary;

  /// The command as typed, with its leading slash (e.g. `/pi`).
  String get display => '/$name';
}

/// The registry, in the order they appear in the suggestion strip and `/help`.
const List<SlashCommand> kSlashCommands = <SlashCommand>[
  SlashCommand(
    name: 'pi',
    argHint: '<message>',
    summary: "Pass input straight through to this channel's coding agent (pi).",
  ),
  SlashCommand(
    name: 'help',
    argHint: '',
    summary: 'List the available slash commands.',
  ),
  SlashCommand(
    name: 'shrug',
    argHint: '[message]',
    summary: r'Append ¯\_(ツ)_/¯ to your message.',
  ),
];

/// The literal shrug, factored out so the command handler and any test agree.
const String kShrug = r'¯\_(ツ)_/¯';

/// A parsed slash command: the matched [command] plus its [args] — everything
/// after the command token with exactly one separating space removed. `args`
/// is otherwise untouched (not trimmed), so a `/pi` passthrough preserves the
/// user's exact text, including a leading slash (`/pi /model` → args `/model`).
class ParsedCommand {
  const ParsedCommand(this.command, this.args);

  final SlashCommand command;
  final String args;
}

/// The command named [name] (without slash), or null if there is no such one.
SlashCommand? lookupCommand(String name) {
  for (final command in kSlashCommands) {
    if (command.name == name) return command;
  }
  return null;
}

/// Parses [raw] as a slash command, or returns null if it isn't one. A match
/// requires a leading `/`, then a known command name, then either end-of-string
/// or a space — so `/help`, `/pi ls`, and `/shrug` match, while `/etc/passwd`,
/// `/helpme`, and plain text do not.
ParsedCommand? parseSlashCommand(String raw) {
  if (!raw.startsWith('/')) return null;
  final rest = raw.substring(1);
  final spaceIndex = rest.indexOf(' ');
  final name = spaceIndex < 0 ? rest : rest.substring(0, spaceIndex);
  if (name.isEmpty) return null;
  final command = lookupCommand(name);
  if (command == null) return null;
  final args = spaceIndex < 0 ? '' : rest.substring(spaceIndex + 1);
  return ParsedCommand(command, args);
}

/// Commands to offer while the user is typing a bare `/<prefix>` (for the
/// suggestion strip). Empty once the text contains a space — by then the user
/// has committed to a command and moved on to its arguments — or when the text
/// isn't a slash token at all.
List<SlashCommand> suggestCommands(String text) {
  if (!text.startsWith('/')) return const <SlashCommand>[];
  final rest = text.substring(1);
  if (rest.contains(' ')) return const <SlashCommand>[];
  final prefix = rest.toLowerCase();
  return <SlashCommand>[
    for (final command in kSlashCommands)
      if (command.name.startsWith(prefix)) command,
  ];
}
