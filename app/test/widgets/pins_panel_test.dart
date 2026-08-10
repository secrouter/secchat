import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/pins_panel.dart';

import '../fakes/fake_api_client.dart';

void main() {
  PinnedMessage p(String id, {String? content}) => PinnedMessage(
        messageId: id,
        channelId: 'c1',
        pinnedBy: 'alice',
        seq: 1,
        authorRef: 'bob',
        content: content,
      );

  testWidgets('lists pinned messages and unpinning calls the API + reloads', (tester) async {
    final api = FakeApiClient();
    api.pinsByChannel['c1'] = [p('m1', content: 'keep this handy'), p('m2', content: 'and this')];

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showPinsPanel(context, api: api, channelId: 'c1', labelForSub: (s) => s),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.text('keep this handy'), findsOneWidget);
    expect(find.text('and this'), findsOneWidget);

    // Unpin the first — the API is called and the row disappears on reload.
    await tester.tap(find.byTooltip('Unpin').first);
    await tester.pumpAndSettle();
    expect(api.pinCalls.any((c) => c.op == 'unpin' && c.messageId == 'm1'), isTrue);
    expect(find.text('keep this handy'), findsNothing);
    expect(find.text('and this'), findsOneWidget);
  });

  testWidgets('a redacted pinned message shows an unavailable placeholder', (tester) async {
    final api = FakeApiClient();
    api.pinsByChannel['c1'] = [p('m1', content: null)];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showPinsPanel(context, api: api, channelId: 'c1', labelForSub: (s) => s),
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
