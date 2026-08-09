import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/consent.dart';
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

  testWidgets('Sign in is disabled until a username is entered AND consent is acknowledged', (
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
    // Username alone isn't enough — the DoD consent banner must be acknowledged.
    expect(buttonState().onPressed, isNull);

    await tester.tap(find.text(kConsentAcknowledge));
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
    // Acknowledge the DoD consent banner (gates sign-in) and tick admin — tapping
    // each labeled checkbox's row by its label toggles it (two checkboxes now).
    // The card can overflow the test viewport, so scroll each target into view.
    await tester.ensureVisible(find.text(kConsentAcknowledge));
    await tester.tap(find.text(kConsentAcknowledge));
    await tester.ensureVisible(find.text('Sign in as admin (secchat-admins)'));
    await tester.tap(find.text('Sign in as admin (secchat-admins)'));
    await tester.pump();
    await tester.ensureVisible(find.widgetWithText(ElevatedButton, 'Sign in'));
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
    // + a manual smoke test, per the platform shim's own design. Consent must
    // be acknowledged first (it gates the SecSSO button too).
    await tester.ensureVisible(find.text(kConsentAcknowledge));
    await tester.tap(find.text(kConsentAcknowledge));
    await tester.pump();
    await tester.ensureVisible(find.text('Sign in with SecSSO'));
    await tester.tap(find.text('Sign in with SecSSO'));
    await tester.pump();
  });

  testWidgets('the DoD notice & consent banner shows and gates both sign-in paths', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: LoginScreen(
          onSignIn: (username, isAdmin) async => null,
          ssoAvailable: true,
        ),
      ),
    );
    await tester.pump();

    // The banner is displayed.
    expect(find.text(kConsentTitle), findsOneWidget);

    ElevatedButton devButton() => tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Sign in'),
    );
    // The SecSSO button is an ElevatedButton.icon, whose runtime type is a
    // private subclass — find.byType (exact-match) misses it, so match the
    // ElevatedButton *subtype* by predicate on the button's label ancestor.
    ElevatedButton ssoButton() => tester.widget<ElevatedButton>(
      find.ancestor(
        of: find.text('Sign in with SecSSO'),
        matching: find.byWidgetPredicate((w) => w is ElevatedButton),
      ),
    );

    // Both sign-in paths are disabled until consent is acknowledged.
    await tester.enterText(find.byType(TextField), 'alice');
    await tester.pump();
    expect(ssoButton().onPressed, isNull);
    expect(devButton().onPressed, isNull);

    await tester.ensureVisible(find.text(kConsentAcknowledge));
    await tester.tap(find.text(kConsentAcknowledge));
    await tester.pump();
    expect(ssoButton().onPressed, isNotNull);
    expect(devButton().onPressed, isNotNull);
  });
}
