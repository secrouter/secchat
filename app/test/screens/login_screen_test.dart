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

  testWidgets('SecSSO button is hidden when ssoAvailable is false (the '
      'default) and no auth_error is present', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(onSignIn: (username, isAdmin) async => null),
      ),
    );
    await tester.pump();

    expect(find.text('Sign in with SecSSO'), findsNothing);
    // The dev form must still work on its own -- SSO unconfigured/unreachable
    // is exactly the case it has to degrade gracefully for.
    expect(find.widgetWithText(ElevatedButton, 'Sign in'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('SecSSO button renders above a demoted developer sign-in '
      'section when ssoAvailable is true', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          ssoAvailable: true,
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Sign in with SecSSO'), findsOneWidget);
    expect(find.text('DEVELOPER SIGN-IN'), findsOneWidget);
    // The dev form is still present, just demoted below the divider.
    expect(find.widgetWithText(ElevatedButton, 'Sign in'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('a non-null ssoError renders the SecSSO section (and its '
      'error banner) even when ssoAvailable is false', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          ssoError: 'state_mismatch',
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Sign in with SecSSO'), findsOneWidget);
    expect(
      find.text('Sign-in with SecSSO failed: state mismatch.'),
      findsOneWidget,
    );
  });

  testWidgets('tapping the SecSSO button does not throw', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          ssoAvailable: true,
        ),
      ),
    );
    await tester.pump();

    // On the test VM target this resolves to the non-web stub (a no-op), so
    // this just proves the button is wired up and doesn't crash the widget
    // tree -- the real browser navigation is covered by `flutter build web`
    // + a manual smoke test, per the platform shim's own design.
    await tester.tap(find.text('Sign in with SecSSO'));
    await tester.pump();
  });
}
