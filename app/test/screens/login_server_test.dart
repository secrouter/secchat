import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/screens/login.dart';

void main() {
  testWidgets('server row renders the origin and is hidden without onSetServer', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          onSetServer: (url) async => null,
          serverLabel: 'https://secchat.sec.internal',
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Server: https://secchat.sec.internal'), findsOneWidget);
    expect(find.text('Change'), findsOneWidget);

    await tester.pumpWidget(
      MaterialApp(home: LoginScreen(onSignIn: (username, isAdmin) async => null)),
    );
    await tester.pump();
    expect(find.textContaining('Server:'), findsNothing);
  });

  testWidgets('Change-server dialog saves the edited URL and survives teardown', (
    tester,
  ) async {
    // Regression: the dialog's TextEditingController used to be disposed by
    // the caller right after showDialog returned, while the closing route's
    // exit animation still rendered the TextField -- tripping the framework's
    // `_dependents.isEmpty` assertion. Pumping the animation out after Save
    // reproduces that crash if it regresses.
    String? saved;
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          onSetServer: (url) async {
            saved = url;
            return null;
          },
          serverLabel: 'https://secchat.sec.internal',
        ),
      ),
    );
    await tester.pump();

    await tester.ensureVisible(find.text('Change'));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    expect(find.text('Server'), findsOneWidget);

    await tester.enterText(
      find.byType(TextField).last,
      'https://demo.secchat.example',
    );
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle(); // runs the dialog's exit animation to completion

    expect(saved, 'https://demo.secchat.example');
    expect(tester.takeException(), isNull);
  });

  testWidgets('cancelling the dialog saves nothing', (tester) async {
    var called = false;
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          onSetServer: (url) async {
            called = true;
            return null;
          },
          serverLabel: 'https://secchat.sec.internal',
        ),
      ),
    );
    await tester.pump();

    await tester.ensureVisible(find.text('Change'));
    await tester.tap(find.text('Change'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(called, isFalse);
    expect(tester.takeException(), isNull);
  });
}
