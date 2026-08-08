import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/screens/chat.dart';

import '../fakes/fake_api_client.dart';

/// Pumps enough frames to flush the chained Futures `ChatScreen` awaits on
/// startup (getChannels -> auto-select -> getMessages -> subscribe).
/// Deliberately never uses `pumpAndSettle`: nothing here needs it, and it
/// would be unsafe once a widget with a repeating animation (e.g. the
/// "assistant is typing" caret) is in the tree.
Future<void> pumpSettled(WidgetTester tester, {int times = 6}) async {
  for (var i = 0; i < times; i++) {
    await tester.pump();
  }
}

const _principal = Principal(sub: 'dev.alice', groups: []);

const _channels = [
  Channel(id: 'c1', kind: ChannelKind.human, name: 'general'),
  Channel(id: 'c2', kind: ChannelKind.agent, name: 'release-bot'),
];

void main() {
  testWidgets(
    'ChatScreen renders channels and messages, including a redacted one as redacted text',
    (tester) async {
      final fake = FakeApiClient(
        me: _principal,
        channels: _channels,
        messagesByChannel: {
          'c1': [
            Message(
              id: 'm1',
              seq: 1,
              authorRef: 'dev.alice',
              authorType: AuthorType.user,
              content: 'hello there',
              createdAt: DateTime(2026, 1, 1, 9, 30),
            ),
            Message(
              id: 'm2',
              seq: 2,
              authorRef: 'dev.bob',
              authorType: AuthorType.user,
              content: null, // redacted
              createdAt: DateTime(2026, 1, 1, 9, 31),
            ),
          ],
        },
      );

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      // Both channels from the fake are in the sidebar. "general" is
      // auto-selected so it also shows in the channel header -- assert
      // "at least one" there and an exact single match for the
      // never-selected second channel.
      expect(find.text('general'), findsWidgets);
      expect(find.text('release-bot'), findsOneWidget);

      // The normal message renders its real content.
      expect(find.text('hello there'), findsOneWidget);

      // The redacted message renders an explicit notice, not an empty
      // bubble.
      expect(find.text('message redacted'), findsOneWidget);
    },
  );

  testWidgets(
    'entering text and tapping Send calls postMessage with that text',
    (tester) async {
      final fake = FakeApiClient(me: _principal, channels: [_channels[0]]);

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'hello from a test');
      await tester.pump();

      final sendButton = find.widgetWithText(ElevatedButton, 'Send');
      expect(sendButton, findsOneWidget);
      await tester.tap(sendButton);
      await pumpSettled(tester);

      expect(fake.postMessageCalls, hasLength(1));
      expect(fake.postMessageCalls.single.channelId, 'c1');
      expect(fake.postMessageCalls.single.content, 'hello from a test');

      // The sent message is appended straight from the response and shows
      // up in the transcript.
      expect(find.text('hello from a test'), findsOneWidget);
    },
  );
}
