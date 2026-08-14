import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/screens/admin.dart';
import 'package:secchat_app/widgets/app_topbar.dart';
import 'package:secchat_app/widgets/webhooks_dialog.dart';

import '../fakes/fake_api_client.dart';

void main() {
  group('AdminScreen', () {
    testWidgets('renders the chain badge, summary counts, and audit action', (tester) async {
      // Tall + wide surface so the lazily-built ListView materialises every panel (the audit table
      // sits below a default 800x600 test viewport) and the 900px audit table has room.
      tester.view.physicalSize = const Size(1400, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final api = FakeApiClient();
      api.adminOverview = AdminOverview(
        generatedAt: '2026-08-12T00:00:00.000Z',
        channels: const [AdminChannel(id: 'c1', kind: 'human', name: 'eng', cuiMarking: null, createdAt: '2026-08-01T00:00:00.000Z')],
        agents: const [],
        sessions: const [],
        audit: const [
          AuditEvent(seq: 1, at: '2026-08-11T00:00:00.000Z', actor: 'alice', actAs: null, action: 'channel.create', target: 'c1', detail: null),
        ],
        messagesChainOk: true,
        auditChainOk: true,
      );

      await tester.pumpWidget(MaterialApp(home: AdminScreen(api: api)));
      await tester.pumpAndSettle();

      expect(find.text('Chains intact'), findsOneWidget);
      expect(find.text('CHANNELS'), findsWidgets); // summary card + panel title (labels are upper-cased)
      expect(find.text('eng'), findsOneWidget);
      expect(find.text('channel.create'), findsOneWidget);
    });

    testWidgets('a broken chain shows the alarm state', (tester) async {
      final api = FakeApiClient();
      api.adminOverview = const AdminOverview(
        generatedAt: '',
        channels: [],
        agents: [],
        sessions: [],
        audit: [],
        messagesChainOk: false,
        auditChainOk: true,
      );

      await tester.pumpWidget(MaterialApp(home: AdminScreen(api: api)));
      await tester.pumpAndSettle();

      expect(find.text('CHAIN BROKEN'), findsOneWidget);
    });

    testWidgets('renders the agent-pool panel with limits + live sessions', (tester) async {
      tester.view.physicalSize = const Size(1400, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final api = FakeApiClient();
      api.adminOverview = const AdminOverview(
        generatedAt: '', channels: [], agents: [], sessions: [], audit: [],
        messagesChainOk: true, auditChainOk: true,
      );
      api.poolStatus = const PoolStatus(
        configured: true,
        namespace: 'secchat-pool',
        image: 'reg/secchat-runnerd:1',
        limits: PoolLimits(maxPods: 20, maxPerOwner: 3, ttlSeconds: 3600, attachTimeoutMs: 120000),
        live: 1,
        sessions: [PoolSessionInfo(sessionId: 's1', ownerSub: 'alice', podName: 'secchat-pool-s1', attached: true, ageMs: 65000)],
      );

      await tester.pumpWidget(MaterialApp(home: AdminScreen(api: api)));
      await tester.pumpAndSettle();

      expect(find.text('AGENT POOL'), findsOneWidget); // panel title (upper-cased)
      expect(find.text('1 / 20'), findsOneWidget); // live / max pods card
      expect(find.text('alice'), findsOneWidget); // the live session's owner
      expect(find.text('secchat-pool-s1'), findsOneWidget);
    });

    testWidgets('agent-pool panel shows the not-configured note when no pool is wired', (tester) async {
      final api = FakeApiClient();
      api.adminOverview = const AdminOverview(
        generatedAt: '', channels: [], agents: [], sessions: [], audit: [],
        messagesChainOk: true, auditChainOk: true,
      );
      // poolStatus left null ⇒ the fake returns PoolStatus(configured: false).
      await tester.pumpWidget(MaterialApp(home: AdminScreen(api: api)));
      await tester.pumpAndSettle();

      expect(find.textContaining('No Kubernetes agent pool is configured'), findsOneWidget);
    });

    testWidgets('lists git SSH keys and revokes one after confirmation', (tester) async {
      tester.view.physicalSize = const Size(1400, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final api = FakeApiClient();
      api.adminOverview = const AdminOverview(
        generatedAt: '', channels: [], agents: [], sessions: [], audit: [],
        messagesChainOk: true, auditChainOk: true,
      );
      api.adminSshKeys = const AdminSshKeys(enabled: true, keys: [
        AdminSshKey(sub: 'alice', displayName: 'Alice Ng', keyType: 'ssh-ed25519', publicKey: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:alicefp', createdAt: '2026-08-01T00:00:00.000Z'),
      ]);

      await tester.pumpWidget(MaterialApp(home: AdminScreen(api: api)));
      await tester.pumpAndSettle();

      expect(find.text('GIT SSH KEYS'), findsOneWidget); // panel title (upper-cased)
      expect(find.text('SHA256:alicefp'), findsOneWidget);

      // Revoke → confirm dialog → confirm → the API is called for that sub.
      await tester.ensureVisible(find.text('Revoke'));
      await tester.tap(find.text('Revoke'));
      await tester.pumpAndSettle();
      expect(find.text('Revoke git SSH key?'), findsOneWidget); // the confirm dialog
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Revoke')));
      await tester.pumpAndSettle();
      expect(api.revokedSshKeys, ['alice']);
    });

    testWidgets('git SSH keys panel shows the not-enabled note when the feature is off', (tester) async {
      final api = FakeApiClient();
      api.adminOverview = const AdminOverview(
        generatedAt: '', channels: [], agents: [], sessions: [], audit: [],
        messagesChainOk: true, auditChainOk: true,
      );
      api.adminSshKeys = const AdminSshKeys(enabled: false); // no keys, feature off
      await tester.pumpWidget(MaterialApp(home: AdminScreen(api: api)));
      await tester.pumpAndSettle();

      expect(find.textContaining("Git SSH identities aren't enabled"), findsOneWidget);
    });
  });

  group('webhooks dialog', () {
    const channel = Channel(id: 'c1', kind: ChannelKind.human, name: 'eng');

    Future<FakeApiClient> pump(WidgetTester tester) async {
      final api = FakeApiClient();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showWebhooksDialog(context, api: api, channel: channel),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return api;
    }

    testWidgets('empty state, then creating a webhook shows its URL', (tester) async {
      final api = await pump(tester);
      expect(find.text('No webhooks yet.'), findsOneWidget);

      await tester.tap(find.text('New webhook'));
      await tester.pumpAndSettle();

      expect(api.webhookCalls.where((c) => c.op == 'create').length, 1);
      expect(find.textContaining('/hooks/'), findsOneWidget); // the post URL is rendered
    });

    testWidgets('revoking a webhook confirms then deletes it', (tester) async {
      final api = FakeApiClient();
      api.webhooksByChannel['c1'] = [
        Webhook(id: 'wh-1', channelId: 'c1', token: 'secret', createdBy: 'alice', createdAt: '2026-08-01T00:00:00.000Z'),
      ];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showWebhooksDialog(context, api: api, channel: channel),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.textContaining('/hooks/secret'), findsOneWidget);

      await tester.tap(find.byTooltip('Revoke'));
      await tester.pumpAndSettle();
      // Confirmation dialog -> confirm.
      await tester.tap(find.text('Revoke').last);
      await tester.pumpAndSettle();

      expect(api.webhookCalls.where((c) => c.op == 'delete').length, 1);
      expect(find.text('No webhooks yet.'), findsOneWidget);
    });
  });

  group('global webhooks dialog', () {
    const channels = [
      Channel(id: 'c1', kind: ChannelKind.human, name: 'eng'),
      Channel(id: 'c2', kind: ChannelKind.human, name: 'ops'),
    ];

    testWidgets('groups webhooks by channel and can create into a chosen channel', (tester) async {
      final api = FakeApiClient();
      api.channelNamesById.addAll({'c1': 'eng', 'c2': 'ops'});
      api.webhooksByChannel['c1'] = [
        Webhook(id: 'wh-1', channelId: 'c1', token: 'ta', createdBy: 'alice', createdAt: ''),
      ];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showGlobalWebhooksDialog(context, api: api, channels: channels),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      // The existing webhook shows under its channel-name header.
      expect(find.text('eng'), findsWidgets);
      expect(find.textContaining('/hooks/ta'), findsOneWidget);

      // Create mints into the currently-selected channel (defaults to the first, c1).
      await tester.tap(find.text('New'));
      await tester.pumpAndSettle();
      expect(api.webhookCalls.where((c) => c.op == 'create' && c.channelId == 'c1').length, 1);
    });
  });

  group('top-bar menu', () {
    AppTopBar bar(Principal p) => AppTopBar(
      principal: p,
      status: ConnStatus.connected,
      onSignOut: () {},
      onSshKeys: () {},
      onWebhooks: () {},
      onAdmin: () {},
    );

    Future<void> openMenu(WidgetTester tester, Principal p) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: bar(p))));
      await tester.tap(find.byTooltip('Menu'));
      await tester.pumpAndSettle();
    }

    testWidgets('an admin sees SSH, Webhooks, and Admin console', (tester) async {
      await openMenu(tester, const Principal(sub: 'u', groups: ['secchat-admins']));
      expect(find.text('Git SSH key'), findsOneWidget);
      expect(find.text('Webhooks'), findsOneWidget);
      expect(find.text('Admin console'), findsOneWidget);
    });

    testWidgets('a non-admin sees SSH + Webhooks but not Admin console', (tester) async {
      await openMenu(tester, const Principal(sub: 'u', groups: ['eng']));
      expect(find.text('Git SSH key'), findsOneWidget);
      expect(find.text('Webhooks'), findsOneWidget);
      expect(find.text('Admin console'), findsNothing);
    });
  });

  group('outbound webhooks (Outgoing tab)', () {
    const channel = Channel(id: 'c1', kind: ChannelKind.human, name: 'eng');

    Future<FakeApiClient> openOutgoing(WidgetTester tester, {FakeApiClient? withApi}) async {
      final api = withApi ?? FakeApiClient();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showWebhooksDialog(context, api: api, channel: channel),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Outgoing')); // switch to the outbound tab
      await tester.pumpAndSettle();
      return api;
    }

    testWidgets('empty state, then creating an outbound webhook mints a subscription', (tester) async {
      final api = await openOutgoing(tester);
      expect(find.text('No outbound webhooks yet.'), findsOneWidget);

      await tester.tap(find.text('New outbound webhook'));
      await tester.pumpAndSettle();
      // The create form: enter a URL and submit (message.created is checked by default).
      await tester.enterText(find.byType(TextField), 'https://receiver.test/hook');
      await tester.tap(find.text('Create'));
      await tester.pumpAndSettle();

      final creates = api.outboundCalls.where((c) => c.op == 'create').toList();
      expect(creates.length, 1);
      expect(api.outboundByChannel['c1']!.single.events, ['message.created']);
      expect(find.textContaining('https://receiver.test/hook'), findsOneWidget);
    });

    testWidgets('a test delivery calls the API and a revoke deletes it', (tester) async {
      final api = FakeApiClient();
      api.outboundByChannel['c1'] = [
        const OutboundWebhook(
          id: 'owh-1',
          channelId: 'c1',
          url: 'https://receiver.test/hook',
          secret: 'shhh',
          events: ['message.created'],
          includeContent: false,
          active: true,
          createdBy: 'alice',
          createdAt: '',
        ),
      ];
      await openOutgoing(tester, withApi: api);
      expect(find.textContaining('https://receiver.test/hook'), findsOneWidget);

      await tester.tap(find.byTooltip('Send test delivery'));
      await tester.pumpAndSettle();
      expect(api.outboundCalls.where((c) => c.op == 'test').length, 1);

      await tester.tap(find.byTooltip('Revoke'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Revoke').last); // confirm
      await tester.pumpAndSettle();
      expect(api.outboundCalls.where((c) => c.op == 'delete').length, 1);
      expect(find.text('No outbound webhooks yet.'), findsOneWidget);
    });
  });
}
