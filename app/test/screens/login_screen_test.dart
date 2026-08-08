import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/screens/login.dart';

void main() {
  testWidgets('LoginScreen renders the SecChat wordmark and Sign in button', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(onSignIn: (username, isAdmin) async => null),
      ),
    );
    await tester.pump();

    expect(find.text('SecChat'), findsOneWidget);
    expect(find.widgetWithText(ElevatedButton, 'Sign in'), findsOneWidget);
  });

  testWidgets('Sign in is disabled until a username is entered', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(onSignIn: (username, isAdmin) async => null),
      ),
    );
    await tester.pump();

    ElevatedButton buttonState() => tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Sign in'),
    );

    expect(buttonState().onPressed, isNull);

    await tester.enterText(find.byType(TextField), 'alice');
    await tester.pump();

    expect(buttonState().onPressed, isNotNull);
  });

  testWidgets('submitting calls onSignIn with the username and admin flag', (
    tester,
  ) async {
    String? seenUsername;
    bool? seenIsAdmin;

    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async {
            seenUsername = username;
            seenIsAdmin = isAdmin;
            return null;
          },
        ),
      ),
    );
    await tester.pump();

    await tester.enterText(find.byType(TextField), 'alice');
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Sign in'));
    await tester.pump();

    expect(seenUsername, 'alice');
    expect(seenIsAdmin, isTrue);
  });
}
