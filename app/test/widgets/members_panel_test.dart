import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/members_panel.dart';

import '../fakes/fake_api_client.dart';

void main() {
  const channel = Channel(id: 'c1', kind: ChannelKind.human, name: 'eng');

  ChannelMember m(String ref, String role) =>
      ChannelMember(memberRef: ref, memberType: 'user', role: role, displayName: ref);

  Future<FakeApiClient> pumpPanel(
    WidgetTester tester, {
    required String currentUserSub,
    bool isAdmin = false,
  }) async {
    final api = FakeApiClient();
    api.membersByChannel['c1'] = [m('alice', 'owner'), m('bob', 'member')];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showMembersPanel(
                context,
                api: api,
                channel: channel,
                currentUserSub: currentUserSub,
                isAdmin: isAdmin,
                roster: const [
                  User(sub: 'alice', displayName: 'alice'),
                  User(sub: 'bob', displayName: 'bob'),
                  User(sub: 'carol', displayName: 'carol'),
                ],
              ),
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

  testWidgets('an owner sees the roster and can promote a member to owner', (tester) async {
    final api = await pumpPanel(tester, currentUserSub: 'alice');

    // Roster renders with names + an OWNER chip for alice.
    expect(find.text('alice (you)'), findsOneWidget);
    expect(find.text('bob'), findsOneWidget);
    expect(find.text('OWNER'), findsOneWidget);

    // Promote bob: open his ⋮ menu → Make owner → the API is called and the row reloads as OWNER.
    await tester.tap(find.byIcon(Icons.more_vert).last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Make owner'));
    await tester.pumpAndSettle();

    expect(api.memberCalls.any((c) => c.op == 'add' && c.ref == 'bob' && c.role == 'owner'), isTrue);
    expect(find.text('OWNER'), findsNWidgets(2)); // alice + bob now both owners
  });

  testWidgets('a plain member sees the roster read-only (no manage controls)', (tester) async {
    await pumpPanel(tester, currentUserSub: 'bob');

    expect(find.text('bob (you)'), findsOneWidget);
    // No per-member manage menu and no add-people control for a non-owner.
    expect(find.byIcon(Icons.more_vert), findsNothing);
    expect(find.text('Add people'), findsNothing);
  });
}
