import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/app_topbar.dart';

void main() {
  const principal = Principal(sub: 'alice', groups: []);

  Widget host({required bool isLightMode, required VoidCallback onToggleTheme}) => MaterialApp(
    home: Scaffold(
      body: AppTopBar(
        principal: principal,
        status: ConnStatus.connected,
        onSignOut: () {},
        onToggleTheme: onToggleTheme,
        isLightMode: isLightMode,
      ),
    ),
  );

  testWidgets('overflow menu shows "Light mode" while dark, and invokes the callback on tap', (tester) async {
    var toggled = false;
    await tester.pumpWidget(host(isLightMode: false, onToggleTheme: () => toggled = true));

    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    expect(find.text('Light mode'), findsOneWidget);
    expect(find.text('Dark mode'), findsNothing);

    await tester.tap(find.text('Light mode'));
    await tester.pumpAndSettle();

    expect(toggled, isTrue);
  });

  testWidgets('overflow menu shows "Dark mode" while light', (tester) async {
    await tester.pumpWidget(host(isLightMode: true, onToggleTheme: () {}));

    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    expect(find.text('Dark mode'), findsOneWidget);
    expect(find.text('Light mode'), findsNothing);
  });

  testWidgets('the theme toggle item is absent when onToggleTheme is null', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: AppTopBar(principal: principal, status: ConnStatus.connected, onSignOut: () {}),
        ),
      ),
    );

    // No menu icon at all: with no onSshKeys/onWebhooks/onAdmin/onToggleTheme, _AppMenu renders
    // SizedBox.shrink() rather than an empty menu button.
    expect(find.byIcon(Icons.menu), findsNothing);
  });
}
