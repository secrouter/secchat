import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/commands.dart';

void main() {
  group('parseSlashCommand', () {
    test('parses a known command with no args', () {
      final parsed = parseSlashCommand('/help');
      expect(parsed, isNotNull);
      expect(parsed!.command.name, 'help');
      expect(parsed.args, '');
    });

    test('parses a known command and keeps its args verbatim', () {
      final parsed = parseSlashCommand('/pi run the tests');
      expect(parsed!.command.name, 'pi');
      expect(parsed.args, 'run the tests');
    });

    test('keeps a leading slash in the args (pi passthrough of a pi command)', () {
      final parsed = parseSlashCommand('/pi /model');
      expect(parsed!.command.name, 'pi');
      expect(parsed.args, '/model'); // not swallowed as another command
    });

    test('is null for plain text', () {
      expect(parseSlashCommand('hello there'), isNull);
    });

    test('is null for a slash that is not a known command (e.g. a path)', () {
      expect(parseSlashCommand('/etc/hosts'), isNull);
      expect(parseSlashCommand('/deploy now'), isNull);
    });

    test('does not match a command that is only a prefix of the typed word', () {
      // "/helpme" is not "/help" — the whole first token must match.
      expect(parseSlashCommand('/helpme'), isNull);
    });

    test('a bare slash is not a command', () {
      expect(parseSlashCommand('/'), isNull);
    });
  });

  group('suggestCommands', () {
    test('offers everything for a bare slash', () {
      expect(suggestCommands('/').map((c) => c.name),
          containsAll(<String>['pi', 'help', 'shrug']));
    });

    test('filters by the typed prefix', () {
      expect(suggestCommands('/h').single.name, 'help');
      expect(suggestCommands('/sh').single.name, 'shrug');
    });

    test('stops suggesting once there is a space (args have begun)', () {
      expect(suggestCommands('/pi ls'), isEmpty);
    });

    test('offers nothing for non-slash text', () {
      expect(suggestCommands('hello'), isEmpty);
    });
  });
}
