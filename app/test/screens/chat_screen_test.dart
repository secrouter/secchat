import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/commands.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/screens/chat.dart';
import 'package:secchat_app/widgets/composer.dart';

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

      // A human channel is never runner-driven: sendInput must not fire.
      expect(fake.sendInputCalls, isEmpty);
    },
  );

  testWidgets(
    'a pre-existing agent channel with no locally-known session still calls postMessage',
    (tester) async {
      // c2 ("release-bot") is a bare `kind: agent` channel from
      // `getChannels`, exactly like one this client didn't create itself --
      // so its AgentKind/session are unknown locally and it must fall back
      // to postMessage just like a human channel (see the
      // `_agentKindByChannel` doc comment in chat.dart). Made the only
      // channel in this fake so it's auto-selected on load: switching
      // channels mid-test isn't needed to prove this and only adds noise.
      final fake = FakeApiClient(me: _principal, channels: [_channels[1]]);

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      final composerField = find.descendant(
        of: find.byType(MessageComposer),
        matching: find.byType(TextField),
      );
      expect(composerField, findsOneWidget);
      await tester.enterText(composerField, 'status?');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
      await pumpSettled(tester);

      expect(fake.postMessageCalls, hasLength(1));
      expect(fake.postMessageCalls.single.channelId, 'c2');
      expect(fake.postMessageCalls.single.content, 'status?');
      expect(fake.sendInputCalls, isEmpty);
    },
  );

  testWidgets(
    'entering text and tapping Send in an assistant channel calls postMessage, not sendInput',
    (tester) async {
      final fake = FakeApiClient(me: _principal, channels: const []);

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      // Drive the real "New assistant" flow so the channel is locally
      // tagged AgentKind.assistant exactly as it would be in the app.
      // Tapped by text, not `widgetWithText(ElevatedButton, ...)`: this
      // sidebar action button is built via `ElevatedButton.icon(...)` with
      // a non-null icon, which Flutter's Material library implements as
      // the private `_ElevatedButtonWithIcon` subclass -- `find.byType`
      // matches by exact runtimeType, not `is`-subtype, so it would never
      // match plain `ElevatedButton`.
      await tester.tap(find.text('New assistant'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'release-helper');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
      await pumpSettled(tester, times: 10);

      expect(fake.createAgentCalls, hasLength(1));
      expect(fake.createAgentCalls.single.kind, AgentKind.assistant);

      final composerField = find.descendant(
        of: find.byType(MessageComposer),
        matching: find.byType(TextField),
      );
      expect(composerField, findsOneWidget);
      await tester.enterText(composerField, 'summarize the thread');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
      await pumpSettled(tester);

      expect(fake.postMessageCalls, hasLength(1));
      expect(fake.postMessageCalls.single.content, 'summarize the thread');
      expect(fake.sendInputCalls, isEmpty);
    },
  );

  testWidgets(
    'entering text and tapping Send in a coding-agent channel with a known '
    'session calls sendInput, not postMessage',
    (tester) async {
      // CodingStrip's header row (session label + short id + the
      // grant-execute button) needs more width than the default 800x600
      // test surface leaves for the main content area beside the sidebar;
      // an ordinary desktop window is comfortably wider than that. This is
      // a test-surface sizing concern only, not a change to app behavior.
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final fake = FakeApiClient(me: _principal, channels: const []);

      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      // Drive the real "New coding agent" flow so the channel is locally
      // tagged AgentKind.coding *and* has a known session id, exactly as it
      // would after `POST /agents` returns `{agent, channel, session}`.
      // Tapped by text -- see the "New assistant" test above for why
      // `widgetWithText(ElevatedButton, ...)` doesn't match this button.
      await tester.tap(find.text('New coding agent'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'infra-fixer');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
      await pumpSettled(tester, times: 10);

      expect(fake.createAgentCalls, hasLength(1));
      expect(fake.createAgentCalls.single.kind, AgentKind.coding);

      // The execute-gate strip is up for the new session, proving the
      // coding-agent surface (grant-execute control) is live.
      expect(find.text('Grant execute (once)'), findsOneWidget);

      final composerField = find.descendant(
        of: find.byType(MessageComposer),
        matching: find.byType(TextField),
      );
      expect(composerField, findsOneWidget);
      await tester.enterText(composerField, 'run the tests');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
      await pumpSettled(tester);

      expect(fake.sendInputCalls, hasLength(1));
      expect(fake.sendInputCalls.single.sessionId, 'session-1');
      expect(fake.sendInputCalls.single.text, 'run the tests');
      expect(fake.postMessageCalls, isEmpty);

      // The user's own line is still visible locally even though it never
      // went through postMessage.
      expect(find.text('run the tests'), findsOneWidget);
    },
  );

  testWidgets(
    '/pi in a coding-agent channel passes its text straight through to sendInput',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final fake = FakeApiClient(me: _principal, channels: const []);
      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      await tester.tap(find.text('New coding agent'));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'infra-fixer');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
      await pumpSettled(tester, times: 10);

      final composerField = find.descendant(
        of: find.byType(MessageComposer),
        matching: find.byType(TextField),
      );
      // A leading slash inside the pi passthrough is preserved -- this is how
      // you send pi its own slash command (e.g. /model) past the client's
      // command parser.
      await tester.enterText(composerField, '/pi /model list');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
      await pumpSettled(tester);

      expect(fake.sendInputCalls, hasLength(1));
      expect(fake.sendInputCalls.single.sessionId, 'session-1');
      expect(fake.sendInputCalls.single.text, '/model list');
      expect(fake.postMessageCalls, isEmpty);
    },
  );

  testWidgets(
    '/pi in a non-coding channel neither sends input nor posts a message',
    (tester) async {
      final fake = FakeApiClient(me: _principal, channels: [_channels[0]]);
      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      await tester.enterText(find.byType(TextField), '/pi do something');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
      await pumpSettled(tester);

      // Nothing is sent anywhere (no pi session to pass through to), and the
      // user is told why.
      expect(fake.sendInputCalls, isEmpty);
      expect(fake.postMessageCalls, isEmpty);
      expect(find.textContaining('/pi works only'), findsOneWidget);
    },
  );

  testWidgets('/help opens the slash-command help dialog', (tester) async {
    final fake = FakeApiClient(me: _principal, channels: [_channels[0]]);
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
      ),
    );
    await pumpSettled(tester);

    await tester.enterText(find.byType(TextField), '/help');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await pumpSettled(tester);

    expect(find.text('Slash commands'), findsOneWidget);
    expect(fake.postMessageCalls, isEmpty);
  });

  testWidgets('/shrug sends the shrug as an ordinary message', (tester) async {
    final fake = FakeApiClient(me: _principal, channels: [_channels[0]]);
    await tester.pumpWidget(
      MaterialApp(
        home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
      ),
    );
    await pumpSettled(tester);

    await tester.enterText(find.byType(TextField), '/shrug');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await pumpSettled(tester);

    expect(fake.postMessageCalls, hasLength(1));
    expect(fake.postMessageCalls.single.content, kShrug);
  });

  testWidgets(
    'New direct message picks a directory user (excluding self) and opens a DM labeled with their name',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final fake = FakeApiClient(
        me: _principal, // sub: 'dev.alice'
        channels: const [],
        users: const [
          User(sub: 'dev.alice', displayName: 'Alice Ng', groups: ['eng']),
          User(sub: 'bob', displayName: 'Bob Reyes', groups: ['eng', 'security']),
        ],
      );
      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      await tester.tap(find.text('New direct message'));
      await pumpSettled(tester, times: 8);

      // The picker offers other people, not yourself.
      expect(find.text('Bob Reyes'), findsOneWidget);
      expect(find.text('Alice Ng'), findsNothing);

      await tester.tap(find.text('Bob Reyes'));
      await pumpSettled(tester, times: 10);

      // It opened a DM with bob via createDm...
      expect(fake.createDmCalls, ['bob']);
      // ...which shows in the sidebar's DIRECT MESSAGES section labeled with the
      // peer's real display name (resolved from the directory), and in the header.
      expect(find.text('DIRECT MESSAGES'), findsOneWidget);
      expect(find.text('Bob Reyes'), findsWidgets);
    },
  );
}
