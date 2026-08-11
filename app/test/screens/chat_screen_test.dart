import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/commands.dart';
import 'package:secchat_app/marking.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/platform/daemon_supervisor.dart';
import 'package:secchat_app/screens/chat.dart';
import 'package:secchat_app/widgets/composer.dart';
import 'package:secchat_app/widgets/marking_banner.dart';
import 'package:secchat_app/widgets/sidebar.dart';

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
  // ChatScreen spawns the bundled runner daemon on desktop — the test host IS desktop, so override
  // the factory with a no-op so widget tests never launch a real child process (which leaks pending
  // timers under the test binding).
  setUp(() => debugDaemonSupervisorFactory = () => NoopDaemonSupervisor());
  tearDownAll(() => debugDaemonSupervisorFactory = createDaemonSupervisor);

  testWidgets('on desktop, the daemon starts with a minted scoped runner token', (tester) async {
    tester.view.physicalSize = const Size(1400, 900); // the runner chip widens the top bar
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final sup = _RecordingSupervisor();
    debugDaemonSupervisorFactory = () => sup; // supported=true, records start()
    final fake = FakeApiClient(me: _principal, channels: const [])..runnerTokenToMint = 'rtok-123';

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(fake.mintRunnerTokenCalls, 1, reason: 'minted a scoped runner token');
    expect(sup.startedToken, 'rtok-123', reason: 'started the daemon with the scoped token, not the bearer');
    expect(sup.startedUrl, isNotNull);
  });

  testWidgets('when runner tokens are unconfigured, the daemon falls back to the bearer token', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final sup = _RecordingSupervisor();
    debugDaemonSupervisorFactory = () => sup;
    final fake = FakeApiClient(me: _principal, channels: const [])..runnerTokenToMint = null; // 503 / off

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(sup.startedToken, fake.token, reason: 'fell back to the bearer token');
  });

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
    'a peer typing shows the typing line, and editing emits our own typing signal',
    (tester) async {
      final fake = FakeApiClient(me: _principal, channels: [_channels[0]]);
      await tester.pumpWidget(
        MaterialApp(
          home: ChatScreen(api: fake, principal: _principal, onSignOut: () {}),
        ),
      );
      await pumpSettled(tester);

      // A peer typing in the open channel surfaces the ephemeral "…is typing" line.
      fake.emitWs(const WsTypingEvent(userSub: 'dev.bob', channelId: 'c1'));
      await pumpSettled(tester);
      expect(find.textContaining('is typing'), findsOneWidget);

      // Editing the composer emits our own (debounced) typing signal for this channel.
      await tester.enterText(find.byType(TextField), 'hi');
      await pumpSettled(tester);
      expect(fake.typingCalls, contains('c1'));
    },
  );

  testWidgets('an unsent draft persists across a channel switch', (tester) async {
    final fake = FakeApiClient(me: _principal, channels: _channels);
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // Type a draft in the auto-selected channel (c1 "general").
    await tester.enterText(find.byType(TextField), 'draft for general');
    await pumpSettled(tester);

    // Switch to the other channel — its composer is empty (a separate draft).
    await tester.tap(find.text('release-bot'));
    await pumpSettled(tester);
    expect(find.text('draft for general'), findsNothing);

    // Switch back — the draft is restored into the field.
    await tester.tap(find.text('general').first);
    await pumpSettled(tester);
    expect(find.text('draft for general'), findsOneWidget);
  });

  testWidgets('pinning a message from its ⋮ menu calls the API', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'dev.bob',
            authorType: AuthorType.user,
            content: 'pin this',
            createdAt: DateTime(2026, 1, 1),
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // pumpAndSettle so the popup-menu open animation finishes (the item is only hittable once laid
    // out); safe here — the typing pruner only setStates when there's stale typing, of which there
    // is none in this test.
    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    expect(find.text('Pin'), findsOneWidget);
    await tester.tap(find.text('Pin'));
    await tester.pumpAndSettle();

    expect(fake.pinCalls.any((c) => c.op == 'pin' && c.messageId == 'm1'), isTrue);
  });

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
    'entering text and tapping Send in a coding-agent channel posts a normal '
    'message (the backend forwards it to pi)',
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
      await tester.enterText(find.byType(TextField).first, 'infra-fixer');
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

      // A coding channel now goes through the SAME message path as any channel:
      // the client posts a normal message (the backend forwards it to pi and
      // persists pi's reply). No client-side session drive any more.
      expect(fake.postMessageCalls, hasLength(1));
      expect(fake.postMessageCalls.single.content, 'run the tests');
      expect(fake.sendInputCalls, isEmpty);

      // The posted message is appended from the POST response, so it shows.
      expect(find.text('run the tests'), findsOneWidget);
    },
  );

  testWidgets(
    '/pi in a coding-agent channel posts its text as a normal message (forwarded to pi)',
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
      await tester.enterText(find.byType(TextField).first, 'infra-fixer');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
      await pumpSettled(tester, times: 10);

      final composerField = find.descendant(
        of: find.byType(MessageComposer),
        matching: find.byType(TextField),
      );
      // A leading slash inside the pi passthrough is preserved -- this is how
      // you send pi its own slash command (e.g. /model) past the client's
      // command parser. It now posts as a normal message (the backend forwards
      // it to pi), rather than driving the session directly.
      await tester.enterText(composerField, '/pi /model list');
      await tester.pump();
      await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
      await pumpSettled(tester);

      expect(fake.postMessageCalls, hasLength(1));
      expect(fake.postMessageCalls.single.content, '/model list');
      expect(fake.sendInputCalls, isEmpty);
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

  testWidgets('New coding agent shows the launch-environment picker and creates on the chosen env', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final fake = FakeApiClient(me: _principal, channels: const []);
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    await tester.tap(find.text('New coding agent'));
    await pumpSettled(tester);

    // The picker lists both environments; the pool is flagged coming soon (default fake).
    expect(find.text('My desktop app'), findsOneWidget);
    expect(find.text('Online pool'), findsOneWidget);
    expect(find.text('Coming soon'), findsOneWidget);

    await tester.enterText(find.byType(TextField).first, 'infra-fixer');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
    await pumpSettled(tester, times: 10);

    expect(fake.createAgentCalls, hasLength(1));
    expect(fake.createAgentCalls.single.kind, AgentKind.coding);
    // Defaults to the first AVAILABLE environment (desktop; pool is coming soon).
    expect(fake.lastCreateAgentLaunchEnv, 'desktop');
  });

  testWidgets('New coding agent with no available environment cannot be created', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final fake = FakeApiClient(me: _principal, channels: const [])
      ..launchEnvironments = const [
        LaunchEnv(id: 'desktop', label: 'My desktop app', available: false, reason: 'not_connected', detail: 'Open the desktop app.'),
        LaunchEnv(id: 'pool', label: 'Online pool', available: false, reason: 'not_deployed', detail: 'Coming soon.'),
      ];
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    await tester.tap(find.text('New coding agent'));
    await pumpSettled(tester);

    await tester.enterText(find.byType(TextField).first, 'infra-fixer');
    await tester.pump();
    // Create is disabled (no environment available), so tapping it does nothing.
    await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
    await pumpSettled(tester);
    expect(fake.createAgentCalls, isEmpty);
  });

  testWidgets('New coding agent mounts a local folder as its workspace', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final fake = FakeApiClient(me: _principal, channels: const []);
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    await tester.tap(find.text('New coding agent'));
    await pumpSettled(tester);

    // Desktop is the default (only available) environment, so the local-folder field shows.
    expect(find.text('LOCAL FOLDER (OPTIONAL)'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'repo-bot'); // name
    await tester.enterText(find.byType(TextField).last, '/Users/me/project'); // workspace
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Create'));
    await pumpSettled(tester, times: 10);

    expect(fake.createAgentCalls, hasLength(1));
    expect(fake.lastCreateAgentWorkspace, '/Users/me/project');
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

  testWidgets('/invite matches a directory user by first name (fuzzy) and adds them', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]], // human channel 'c1', auto-selected
      users: const [
        User(sub: 'dev.alice', displayName: 'Alice Ng', groups: []),
        User(sub: 'austin-sub', displayName: 'Austin Probe', email: 'austin@x.mil', groups: []),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    final composer = find.descendant(
      of: find.byType(MessageComposer),
      matching: find.byType(TextField),
    );
    // A first name is enough now (was exact-match only, which silently found nothing).
    await tester.enterText(composer, '/invite Austin');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await pumpSettled(tester);

    final added = fake.memberCalls.where((c) => c.op == 'add').map((c) => c.ref);
    expect(added, contains('austin-sub'));
  });

  testWidgets('/invite resolves an @-handle (what autocomplete inserts) and adds the user', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]],
      users: const [
        User(sub: 'dev.alice', displayName: 'Alice Ng', groups: []),
        User(sub: 'austin-sub', displayName: 'Austin Probe', email: 'austin@x.mil', groups: []),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    final composer = find.descendant(
      of: find.byType(MessageComposer),
      matching: find.byType(TextField),
    );
    // "@austinprobe" is the mention handle for "Austin Probe" (spaces stripped) — the exact token
    // the composer inserts. It must resolve the same user /invite would by name.
    await tester.enterText(composer, '/invite @austinprobe');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await pumpSettled(tester);

    final added = fake.memberCalls.where((c) => c.op == 'add').map((c) => c.ref);
    expect(added, contains('austin-sub'));
  });

  testWidgets('a membership add for me pulls the new channel into the sidebar live', (tester) async {
    final fake = FakeApiClient(me: _principal, channels: [_channels[0]]); // c1 'general'
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);
    expect(find.text('incident-room'), findsNothing);

    // A new channel now exists server-side and I've been added to it → live membership event.
    fake.channels = [...fake.channels, const Channel(id: 'c9', kind: ChannelKind.human, name: 'incident-room')];
    fake.emitWs(const WsMembershipEvent(op: 'add', memberRef: 'dev.alice', role: 'member', channelId: 'c9'));
    await pumpSettled(tester);

    expect(find.text('incident-room'), findsWidgets); // appeared without a manual reload
  });

  testWidgets('sorting by unread orders channels with the most unread first', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final fake = FakeApiClient(
      me: _principal,
      channels: const [
        Channel(id: 'a', kind: ChannelKind.human, name: 'alpha'),
        Channel(id: 'z', kind: ChannelKind.human, name: 'zeta'),
      ],
    );
    fake.unreadByChannel['z'] = 5; // zeta has unread; alpha has none
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    Finder inRail(String name) =>
        find.descendant(of: find.byType(ChatSidebar), matching: find.text(name));

    // Default order is alphabetical: alpha above zeta.
    expect(tester.getTopLeft(inRail('alpha')).dy, lessThan(tester.getTopLeft(inRail('zeta')).dy));

    // Switch to unread order — zeta (5 unread) rises above alpha (0).
    await tester.tap(find.text('Unread'));
    await pumpSettled(tester);
    expect(tester.getTopLeft(inRail('zeta')).dy, lessThan(tester.getTopLeft(inRail('alpha')).dy));
  });

  testWidgets('a reaction chip renders and tapping it toggles the reaction via the API', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'bob',
            authorType: AuthorType.user,
            content: 'hi',
            createdAt: DateTime(2026, 1, 1, 9, 30),
            reactions: const [Reaction(messageId: 'm1', userSub: 'bob', emoji: '👍')],
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // The existing 👍 reaction renders as a chip.
    expect(find.text('👍'), findsOneWidget);
    await tester.tap(find.text('👍'));
    await pumpSettled(tester);

    // alice had not reacted with 👍, so tapping adds it.
    expect(fake.reactionCalls, hasLength(1));
    expect(fake.reactionCalls.single.messageId, 'm1');
    expect(fake.reactionCalls.single.emoji, '👍');
    expect(fake.reactionCalls.single.add, isTrue);
  });

  testWidgets('an agent message shows its prompted-by attribution', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'a1',
            seq: 1,
            authorRef: 'assistant-1',
            authorType: AuthorType.agent,
            content: 'here you go',
            createdAt: DateTime(2026, 1, 1, 9, 31),
            promptedBy: 'dev.alice',
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(find.textContaining('prompted by dev.alice'), findsOneWidget);
  });

  testWidgets('unread badges render for background channels; opening a channel marks it read', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: const [
        Channel(id: 'c1', kind: ChannelKind.human, name: 'general'),
        Channel(id: 'c2', kind: ChannelKind.human, name: 'random'),
      ],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm5',
            seq: 5,
            authorRef: 'bob',
            authorType: AuthorType.user,
            content: 'hey',
            createdAt: DateTime(2026, 1, 1),
          ),
        ],
      },
    );
    fake.unreadByChannel['c2'] = 3; // c2 is not opened → keeps its badge

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester, times: 12);

    // c1 auto-selected → marked read up to its latest seq (5).
    expect(fake.markReadCalls, contains((channelId: 'c1', seq: 5)));
    // c2 (background) shows its unread count.
    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('a live message on a BACKGROUND channel bumps its unread badge (global socket)', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: const [
        Channel(id: 'c1', kind: ChannelKind.human, name: 'general'),
        Channel(id: 'c2', kind: ChannelKind.human, name: 'random'),
      ],
      messagesByChannel: {
        'c1': [
          Message(id: 'm1', seq: 1, authorRef: 'bob', authorType: AuthorType.user, content: 'hi', createdAt: DateTime(2026, 1, 1)),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester, times: 12);

    // c2 starts with no unread.
    expect(find.text('2'), findsNothing);

    // Two messages arrive for the BACKGROUND channel c2 over the always-open global socket.
    for (var i = 0; i < 2; i++) {
      fake.emitWs(WsMessageEvent(
        Message(id: 'c2-m$i', seq: i + 1, authorRef: 'bob', authorType: AuthorType.user, content: 'ping', createdAt: DateTime(2026, 1, 2, 0, i)),
        channelId: 'c2',
      ));
    }
    await tester.pump();
    await tester.pump();

    // Its unread badge appears/updates live — without ever switching to c2.
    expect(find.text('2'), findsOneWidget);
    expect(fake.markReadCalls.any((c) => c.channelId == 'c2'), isFalse, reason: 'a background channel is never marked read');
  });

  testWidgets('top-bar search finds a message and opens its channel', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: const [
        Channel(id: 'c1', kind: ChannelKind.human, name: 'general'),
        Channel(id: 'c2', kind: ChannelKind.human, name: 'random'),
      ],
    );
    fake.searchResults = [
      SearchHit(
        channelId: 'c2',
        messageId: 'm9',
        authorRef: 'bob',
        content: 'the secret plan',
        createdAt: DateTime(2026, 1, 1),
      ),
    ];

    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    await tester.tap(find.byTooltip('Search messages'));
    await pumpSettled(tester, times: 8);

    final searchField = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    await tester.enterText(searchField, 'secret');
    await tester.tap(find.byTooltip('Search')); // the suffix run-search button
    await pumpSettled(tester, times: 8);

    expect(fake.searchCalls, contains('secret'));
    expect(find.textContaining('the secret plan'), findsOneWidget);

    // Tapping the hit opens its channel (c2 → "random" in the header).
    await tester.tap(find.textContaining('the secret plan'));
    await pumpSettled(tester, times: 10);
    expect(find.text('random'), findsWidgets);
  });

  testWidgets('replies fold into a thread: count shows, opening reveals the reply, replying posts with parentId', (tester) async {
    // A taller viewport so the thread's (lazily-built) reply is within the build
    // range once the classification banners frame the pane.
    tester.view.physicalSize = const Size(1000, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final fake = FakeApiClient(
      me: _principal,
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'p1',
            seq: 1,
            authorRef: 'bob',
            authorType: AuthorType.user,
            content: 'top level question',
            createdAt: DateTime(2026, 1, 1, 9, 30),
          ),
          Message(
            id: 'r1',
            seq: 2,
            authorRef: 'carol',
            authorType: AuthorType.user,
            content: 'an existing reply',
            createdAt: DateTime(2026, 1, 1, 9, 31),
            parentId: 'p1',
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // Main view: the top-level message shows with a reply count; the reply is
    // NOT rendered inline.
    expect(find.textContaining('top level question'), findsOneWidget);
    expect(find.textContaining('an existing reply'), findsNothing);
    expect(find.text('1 reply'), findsOneWidget);

    // Open the thread → the reply is now visible under a Thread header.
    await tester.tap(find.text('1 reply'));
    await pumpSettled(tester);
    expect(find.text('Thread'), findsOneWidget);
    expect(find.textContaining('an existing reply'), findsOneWidget);

    // Replying in the thread posts with the parent id.
    final threadComposer = find.descendant(
      of: find.byType(MessageComposer),
      matching: find.byType(TextField),
    );
    await tester.enterText(threadComposer, 'my threaded reply');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await pumpSettled(tester);

    expect(fake.postMessageCalls, hasLength(1));
    expect(fake.postMessageCalls.single.parentId, 'p1');
    expect(fake.postMessageCalls.single.content, 'my threaded reply');
  });

  testWidgets('the author can redact their own message via the menu + reason dialog', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'dev.alice',
            authorType: AuthorType.user,
            content: 'oops, CUI in the wrong place',
            createdAt: DateTime(2026, 1, 1, 9, 30),
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(find.textContaining('oops, CUI in the wrong place'), findsOneWidget);

    // Open the message overflow menu → Redact (pumpAndSettle so the menu/dialog
    // route transitions finish — no repeating animations in this test).
    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Redact…'));
    await tester.pumpAndSettle();

    // The confirm dialog requires a reason.
    expect(find.text('Redact message'), findsOneWidget);
    final reasonField = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    await tester.enterText(reasonField, 'CUI spillage — wrong channel');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Redact'));
    await tester.pumpAndSettle();

    expect(fake.redactCalls, hasLength(1));
    expect(fake.redactCalls.single.messageId, 'm1');
    expect(fake.redactCalls.single.reason, 'CUI spillage — wrong channel');
    // The message flips to the redacted tombstone.
    expect(find.text('message redacted'), findsOneWidget);
    expect(find.textContaining('oops, CUI'), findsNothing);
  });

  testWidgets('a non-author, non-admin user sees no redact affordance', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice — not an admin
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'bob',
            authorType: AuthorType.user,
            content: "bob's message",
            createdAt: DateTime(2026, 1, 1, 9, 30),
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(find.textContaining("bob's message"), findsOneWidget);
    // The actions menu exists for everyone (Copy text), but a non-author/non-admin
    // gets NO Redact… item in it.
    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    expect(find.text('Copy text'), findsOneWidget);
    expect(find.text('Redact…'), findsNothing);
  });

  testWidgets('the author edits their own message via the menu + edit dialog', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'dev.alice',
            authorType: AuthorType.user,
            content: 'the orignal, with a typo',
            createdAt: DateTime(2026, 1, 1, 9, 30),
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Edit…'));
    await tester.pumpAndSettle();

    // The edit dialog is pre-filled with the current text; change it and save.
    expect(find.text('Edit message'), findsOneWidget);
    final field = find.descendant(
      of: find.byType(AlertDialog),
      matching: find.byType(TextField),
    );
    await tester.enterText(field, 'the original, typo fixed');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Save changes'));
    await tester.pumpAndSettle();

    expect(fake.editCalls, hasLength(1));
    expect(fake.editCalls.single.messageId, 'm1');
    expect(fake.editCalls.single.content, 'the original, typo fixed');
    // The bubble now shows the new text + an "(edited)" marker.
    expect(find.textContaining('the original, typo fixed'), findsOneWidget);
    expect(find.textContaining('the orignal, with a typo'), findsNothing);
    expect(find.text('(edited)'), findsOneWidget);
  });

  testWidgets('a non-author sees no edit affordance', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'bob',
            authorType: AuthorType.user,
            content: "bob's message",
            createdAt: DateTime(2026, 1, 1, 9, 30),
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // The menu exists (Copy text is offered to everyone), but there's no Edit… item
    // on someone else's message (edit is author-only).
    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    expect(find.text('Copy text'), findsOneWidget);
    expect(find.text('Edit…'), findsNothing);
  });

  testWidgets('an edited message shows "(edited)" and View history opens the revision list', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'bob', // someone else's edited message — alice can still view history
            authorType: AuthorType.user,
            content: 'current text',
            createdAt: DateTime(2026, 1, 1, 9, 30),
            editedAt: DateTime(2026, 1, 1, 9, 45),
          ),
        ],
      },
    );
    fake.revisionsByMessage['m1'] = [
      MessageRevision(revision: 1, authorRef: 'bob', content: 'first text', at: DateTime(2026, 1, 1, 9, 30)),
      MessageRevision(revision: 2, authorRef: 'bob', content: 'current text', at: DateTime(2026, 1, 1, 9, 45)),
    ];
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(find.text('(edited)'), findsOneWidget);

    // Open history via the overflow menu (alice isn't the author, so no Edit item).
    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    expect(find.text('Edit…'), findsNothing);
    await tester.tap(find.text('View history'));
    await tester.pumpAndSettle();

    expect(find.text('Edit history'), findsOneWidget);
    expect(find.text('Original'), findsOneWidget);
    expect(find.text('Revision 2'), findsOneWidget);
    expect(find.textContaining('first text'), findsOneWidget);
  });

  testWidgets('a MARKED channel frames the view with banners and locks the composer to its level', (tester) async {
    tester.view.physicalSize = const Size(1000, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    final fake = FakeApiClient(
      me: _principal,
      channels: const [Channel(id: 'c1', kind: ChannelKind.human, name: 'cui-room', cuiMarking: 'CUI')],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'dev.alice',
            authorType: AuthorType.user,
            content: 'sensitive',
            createdAt: DateTime(2026, 1, 1, 9, 30),
            marking: 'CUI',
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // Top + bottom classification banners both read CUI.
    expect(find.widgetWithText(MarkingBanner, 'CUI'), findsNWidgets(2));

    // Posting takes the channel level (the channel is the portion), whatever the composer shows.
    await tester.enterText(find.byType(TextField), 'hello');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await pumpSettled(tester);
    expect(fake.postMessageCalls.single.marking, 'CUI');
  });

  testWidgets('an UNMARKED channel masks above-baseline content until revealed; baseline shows plainly', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: const [Channel(id: 'c1', kind: ChannelKind.human, name: 'general')],
      messagesByChannel: {
        'c1': [
          Message(id: 'm0', seq: 1, authorRef: 'bob', authorType: AuthorType.user, content: 'just a normal note', createdAt: DateTime(2026, 1, 1, 9, 29)),
          Message(id: 'm1', seq: 2, authorRef: 'bob', authorType: AuthorType.user, content: 'a proprietary secret', createdAt: DateTime(2026, 1, 1, 9, 30), marking: 'PROPRIETARY'),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // Baseline (UNMARKED) content shows in the open, with no marking chrome.
    expect(find.textContaining('just a normal note'), findsOneWidget);
    // The elevated message is framed by its marking (top + bottom) and MASKED until clicked.
    expect(find.widgetWithText(MarkingBanner, 'PROPRIETARY'), findsNWidgets(2));
    expect(find.textContaining('click to reveal'), findsOneWidget);
    expect(find.textContaining('a proprietary secret'), findsNothing, reason: 'content is hidden until revealed');

    // Click to reveal → the content appears.
    await tester.tap(find.textContaining('click to reveal'));
    await pumpSettled(tester);
    expect(find.textContaining('a proprietary secret'), findsOneWidget);

    // The header MARK… control opens the classification picker and calls the API.
    await tester.tap(find.text('MARK…'));
    await tester.pumpAndSettle();
    expect(find.text('Channel classification'), findsOneWidget);
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('CUI')));
    await tester.pumpAndSettle();
    // Select-then-confirm: the level is chosen, then "Set marking" applies it.
    await tester.tap(find.text('Set marking'));
    await tester.pumpAndSettle();

    expect(fake.setMarkingCalls.single.channelId, 'c1');
    expect(fake.setMarkingCalls.single.marking, 'CUI');
  });

  testWidgets('the channel-marking picker adds a CUI category and applies the composite banner', (tester) async {
    const catPrincipal = Principal(
      sub: 'dev.alice',
      groups: ['secchat-admins'],
      marking: MarkingPolicy(
        levels: ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
        defaultLevel: 'UNCLASSIFIED',
        categories: [MarkingCategory(code: 'SP-PRVCY', name: 'Privacy', level: 'CUI')],
      ),
    );
    final fake = FakeApiClient(
      me: catPrincipal,
      channels: const [Channel(id: 'c1', kind: ChannelKind.human, name: 'general')],
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: catPrincipal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    await tester.tap(find.text('MARK…'));
    await tester.pumpAndSettle();
    // Choose CUI → its categories appear; toggle Privacy on, then apply.
    await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('CUI')));
    await tester.pumpAndSettle();
    expect(find.text('SP-PRVCY'), findsOneWidget);
    await tester.tap(find.text('SP-PRVCY'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Set marking'));
    await tester.pumpAndSettle();

    expect(fake.setMarkingCalls.single.marking, 'CUI//SP-PRVCY');
  });

  testWidgets('a DLP-flagged message shows a spillage warning naming the rule', (tester) async {
    final fake = FakeApiClient(
      me: _principal,
      channels: const [Channel(id: 'c1', kind: ChannelKind.human, name: 'general')],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'bob',
            authorType: AuthorType.user,
            content: 'my ssn is redactable',
            createdAt: DateTime(2026, 1, 1, 9, 30),
            dlpFlags: const ['us-ssn'],
          ),
        ],
      },
    );
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    expect(find.textContaining('Possible data spillage'), findsOneWidget);
    expect(find.textContaining('us-ssn'), findsOneWidget);
  });

  testWidgets('a step-up-gated redaction re-authenticates and retries', (tester) async {
    final fake = FakeApiClient(
      me: _principal, // dev.alice — the author
      channels: [_channels[0]],
      messagesByChannel: {
        'c1': [
          Message(
            id: 'm1',
            seq: 1,
            authorRef: 'dev.alice',
            authorType: AuthorType.user,
            content: 'purge me',
            createdAt: DateTime(2026, 1, 1, 9, 30),
          ),
        ],
      },
    )..redactRequiresStepUp = true; // the deployment gates redaction on a fresh re-auth
    await tester.pumpWidget(
      MaterialApp(home: ChatScreen(api: fake, principal: _principal, onSignOut: () {})),
    );
    await pumpSettled(tester);

    // Open the menu → Redact… → supply a reason → Redact.
    await tester.tap(find.byTooltip('Message actions'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Redact…'));
    await tester.pumpAndSettle();
    await tester.enterText(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), 'spillage');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Redact'));
    await tester.pumpAndSettle();

    // The server demanded step-up → the re-auth dialog appears; confirm it.
    expect(find.text('Re-authentication required'), findsOneWidget);
    await tester.tap(find.widgetWithText(ElevatedButton, 'Re-authenticate'));
    await tester.pumpAndSettle();

    // We stepped up once and the redaction then went through (tombstone shows).
    expect(fake.stepUpCalls, 1);
    expect(fake.redactCalls, hasLength(1));
    expect(find.text('message redacted'), findsOneWidget);
  });
}

/// A DaemonSupervisor that reports itself as supported (like desktop) and records the start() args,
/// without launching any real process — lets a widget test assert on how the daemon was wired.
class _RecordingSupervisor implements DaemonSupervisor {
  final _state = ValueNotifier<RunnerDaemonState>(RunnerDaemonState.off);
  String? startedUrl;
  String? startedToken;

  @override
  ValueListenable<RunnerDaemonState> get state => _state;

  @override
  bool get supported => true;

  @override
  void start({required String secchatUrl, required String token}) {
    startedUrl = secchatUrl;
    startedToken = token;
  }

  @override
  Future<void> stop() async {}

  @override
  void dispose() => _state.dispose();
}
