import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/mentions_panel.dart';

void main() {
  Mention mk(String id, String channelId, {String? content}) => Mention(
        id: id,
        messageId: 'm-$id',
        channelId: channelId,
        mentionedSub: 'me',
        authorSub: 'alice',
        createdAt: DateTime(2026, 1, 1),
        seq: 1,
        content: content,
      );

  testWidgets('lists mentions and returns the tapped one (to jump to its channel)', (tester) async {
    Mention? chosen;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                chosen = await showMentionsInbox(
                  context,
                  mentions: [mk('1', 'c-eng', content: 'ping @me here'), mk('2', 'c-ops', content: 'and here')],
                  channelLabel: (id) => id == 'c-eng' ? '#eng' : '#ops',
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // Both mentions render with channel label + content snippet.
    expect(find.text('#eng'), findsOneWidget);
    expect(find.text('ping @me here'), findsOneWidget);
    expect(find.text('and here'), findsOneWidget);

    // Tapping a row resolves the inbox to that mention.
    await tester.tap(find.text('ping @me here'));
    await tester.pumpAndSettle();
    expect(chosen?.id, '1');
    expect(chosen?.channelId, 'c-eng');
  });

  testWidgets('a redacted mention shows an unavailable placeholder', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showMentionsInbox(
                context,
                mentions: [mk('1', 'c-eng', content: null)],
                channelLabel: (_) => '#eng',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Message unavailable'), findsOneWidget);
  });
}
