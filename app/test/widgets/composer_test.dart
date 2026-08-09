import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/widgets/composer.dart';

/// Pumps a composer wired to a capturing `onSend`; returns the list that
/// records every sent message so a test can assert on send decisions.
Future<List<String>> _pumpComposer(WidgetTester tester) async {
  final sent = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: MessageComposer(onSend: (text, marking) async => sent.add(text)),
      ),
    ),
  );
  return sent;
}

String _fieldText(WidgetTester tester) =>
    tester.widget<EditableText>(find.byType(EditableText)).controller.text;

void main() {
  testWidgets('Enter sends', (tester) async {
    final sent = await _pumpComposer(tester);
    await tester.enterText(find.byType(TextField), 'ship it');
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(sent, ['ship it']);
  });

  testWidgets('Shift+Enter does not send', (tester) async {
    final sent = await _pumpComposer(tester);
    await tester.enterText(find.byType(TextField), 'line one');
    await tester.pump();

    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();

    expect(sent, isEmpty);
  });

  testWidgets('Ctrl+Enter toggles edit mode, and then Enter no longer sends',
      (tester) async {
    final sent = await _pumpComposer(tester);
    await tester.enterText(find.byType(TextField), 'draft');
    await tester.pump();

    // Default: the hint advertises Enter-to-send.
    expect(find.textContaining('send'), findsOneWidget);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump();

    // The toggle didn't send, and the indicator now shows edit mode.
    expect(sent, isEmpty);
    expect(find.textContaining('Edit mode'), findsOneWidget);

    // In edit mode a plain Enter is a newline, not a send.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(sent, isEmpty);
  });

  testWidgets('the Bold button wraps a placeholder at the cursor', (tester) async {
    await _pumpComposer(tester);
    await tester.tap(find.byTooltip('Bold'));
    await tester.pump();
    expect(_fieldText(tester), '**bold**');
  });

  testWidgets('the Link button inserts a markdown link skeleton', (tester) async {
    await _pumpComposer(tester);
    await tester.tap(find.byTooltip('Link'));
    await tester.pump();
    expect(_fieldText(tester), '[text](url)');
  });

  testWidgets('the Quote button prefixes the line', (tester) async {
    await _pumpComposer(tester);
    await tester.enterText(find.byType(TextField), 'to be quoted');
    await tester.pump();
    await tester.tap(find.byTooltip('Quote'));
    await tester.pump();
    expect(_fieldText(tester), '> to be quoted');
  });

  testWidgets('the preview toggle reveals a PREVIEW pane', (tester) async {
    await _pumpComposer(tester);
    expect(find.text('PREVIEW'), findsNothing);
    await tester.tap(find.byTooltip('Toggle preview'));
    await tester.pump();
    expect(find.text('PREVIEW'), findsOneWidget);
  });

  testWidgets('the emoji picker opens and inserts at the cursor', (tester) async {
    await _pumpComposer(tester);
    await tester.enterText(find.byType(TextField), 'nice ');
    await tester.pump();

    await tester.tap(find.byTooltip('Emoji'));
    await tester.pumpAndSettle();

    // The picker is open; pick the first smiley.
    expect(find.text('😀'), findsWidgets);
    await tester.tap(find.text('😀').first);
    await tester.pump();

    expect(_fieldText(tester), 'nice 😀');
  });

  testWidgets('a "/" shows the command suggestion strip', (tester) async {
    await _pumpComposer(tester);
    await tester.enterText(find.byType(TextField), '/');
    await tester.pump();
    // Every command's display token appears in the strip.
    expect(find.text('/pi'), findsOneWidget);
    expect(find.text('/help'), findsOneWidget);
  });
}
