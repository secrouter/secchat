import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/api.dart';
import 'package:secchat_app/widgets/ssh_key_dialog.dart';

import '../fakes/fake_api_client.dart';

void main() {
  Future<FakeApiClient> pumpDialog(WidgetTester tester, {required FakeApiClient api}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showSshKeyDialog(context, api: api),
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

  testWidgets('no key yet → Generate; generating shows the public key + fingerprint', (tester) async {
    final api = FakeApiClient()..sshEnabled = true; // no key set
    await pumpDialog(tester, api: api);

    expect(find.text('No key yet.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Generate'), findsOneWidget);
    // Nothing to revoke before a key exists.
    expect(find.text('Revoke'), findsNothing);

    await tester.tap(find.widgetWithText(FilledButton, 'Generate'));
    await tester.pumpAndSettle();

    // The generated PUBLIC key + fingerprint render; the private key is never shown.
    expect(find.textContaining('ssh-ed25519 AAAA'), findsOneWidget);
    expect(find.textContaining('SHA256:'), findsOneWidget);
    expect(find.textContaining('PRIVATE'), findsNothing);
    // A key now exists ⇒ Regenerate + Revoke are offered.
    expect(find.widgetWithText(FilledButton, 'Regenerate'), findsOneWidget);
    expect(find.text('Revoke'), findsOneWidget);
  });

  testWidgets('an existing key loads on open and can be revoked', (tester) async {
    final api = FakeApiClient()
      ..sshEnabled = true
      ..sshKey = const SshKeyInfo(
        keyType: 'ssh-ed25519',
        publicKey: 'ssh-ed25519 AAAAEXISTING alice@example.mil',
        fingerprint: 'SHA256:existingfp',
        createdAt: '2026-01-01T00:00:00.000Z',
      );
    await pumpDialog(tester, api: api);

    expect(find.textContaining('AAAAEXISTING'), findsOneWidget);
    expect(find.text('Revoke'), findsOneWidget);

    await tester.tap(find.text('Revoke'));
    await tester.pumpAndSettle();

    expect(api.sshKey, isNull);
    expect(find.text('No key yet.'), findsOneWidget);
  });

  testWidgets('feature off (503) → explains it is not enabled, offers only Close', (tester) async {
    final api = FakeApiClient()..sshEnabled = false;
    await pumpDialog(tester, api: api);

    expect(find.textContaining('not enabled on this deployment'), findsOneWidget);
    expect(find.text('Generate'), findsNothing);
    expect(find.text('Close'), findsOneWidget);
  });
}
