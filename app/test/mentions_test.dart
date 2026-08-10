import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/mentions.dart';
import 'package:secchat_app/models.dart';

void main() {
  User u(String sub, {String? email, String? display}) =>
      User(sub: sub, email: email, displayName: display);

  group('mentionHandle mirrors the backend', () {
    test('display name drives the handle (spaces removed, lowercased)', () {
      expect(mentionHandle(u('u1', email: 'alice@x.mil', display: 'Alice Ng')), 'aliceng');
    });
    test('falls back to email local-part, then sub', () {
      expect(mentionHandle(u('u2', email: 'bob.reyes@x.mil')), 'bob.reyes');
      expect(mentionHandle(u('carol')), 'carol');
    });
  });

  group('matchMentionCandidates', () {
    final roster = [
      u('alice', email: 'alice@x.mil', display: 'Alice Ng'),
      u('bob', email: 'bob@x.mil', display: 'Bob Reyes'),
      u('carol', email: 'carol@x.mil', display: 'Carol Diaz'),
    ];

    test('prefix match on handle or display name', () {
      final m = matchMentionCandidates(roster, 'al');
      expect(m.first.sub, 'alice'); // "aliceng" / "Alice Ng" both prefix-match "al"
    });

    test('excludes self', () {
      final m = matchMentionCandidates(roster, '', selfSub: 'alice');
      expect(m.any((x) => x.sub == 'alice'), isFalse);
    });

    test('empty query lists everyone (minus self), prefix bucket', () {
      final m = matchMentionCandidates(roster, '');
      expect(m.length, 3);
    });
  });
}
