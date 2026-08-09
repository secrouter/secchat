import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/message_list.dart';

Message _msg(String id, int seq, String content) => Message(
      id: id,
      seq: seq,
      authorRef: 'bob',
      authorType: AuthorType.user,
      content: content,
      createdAt: DateTime(2026, 1, 1, 9, seq),
    );

Widget _host({
  required List<TranscriptEntry> entries,
  required bool hasMore,
  required Future<void> Function() onLoadOlder,
}) =>
    MaterialApp(
      home: Scaffold(
        body: SizedBox(
          height: 600,
          child: MessageList(
            entries: entries,
            currentUserSub: 'alice',
            hasMore: hasMore,
            onLoadOlder: onLoadOlder,
          ),
        ),
      ),
    );

void main() {
  testWidgets('load-older: the control shows when hasMore, triggers onLoadOlder, and prepended history renders',
      (tester) async {
    var calls = 0;
    // A short first page (the tail); older history is available.
    var entries = <TranscriptEntry>[
      MessageEntry(_msg('m6', 6, 'newest page start')),
      MessageEntry(_msg('m7', 7, 'newest page end')),
    ];
    await tester.pumpWidget(_host(entries: entries, hasMore: true, onLoadOlder: () async => calls++));
    await tester.pump();

    // The "load earlier" affordance is offered while history remains.
    expect(find.text('Load earlier messages'), findsOneWidget);

    final before = calls;
    await tester.tap(find.text('Load earlier messages'));
    await tester.pump();
    expect(calls, greaterThan(before), reason: 'tapping the control requests the older page');

    // The parent prepends the older page and clears hasMore (start of history).
    entries = <TranscriptEntry>[
      MessageEntry(_msg('m1', 1, 'oldest history line')),
      MessageEntry(_msg('m2', 2, 'more history')),
      ...entries,
    ];
    await tester.pumpWidget(_host(entries: entries, hasMore: false, onLoadOlder: () async {}));
    await tester.pump();

    // Older history is now in the transcript; the control is gone.
    expect(find.textContaining('oldest history line'), findsOneWidget);
    expect(find.text('Load earlier messages'), findsNothing);
  });
}
