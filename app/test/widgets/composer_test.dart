import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/clipboard_guard.dart';
import 'package:secchat_app/marking.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/composer.dart';

/// Pumps a composer wired to a capturing `onSend`; returns the list that
/// records every sent message so a test can assert on send decisions.
Future<List<String>> _pumpComposer(WidgetTester tester) async {
  final sent = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: MessageComposer(onSend: (text, marking, _) async => sent.add(text)),
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

  testWidgets('the portion-mark button inserts a CUI portion token at the line start', (tester) async {
    // A wider surface so the toolbar (with the marking controls) doesn't overflow the test viewport.
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, _) async {},
            markingLevels: const ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
          ),
        ),
      ),
    );
    await tester.enterText(find.byType(TextField), 'the controlled part');
    await tester.pump();

    // Open the portion-marking menu → pick (CUI) → the line is prefixed with "(CUI) ".
    await tester.tap(find.byTooltip('Mark this line (portion marking)'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('(CUI)'));
    await tester.pumpAndSettle();

    expect(_fieldText(tester), '(CUI) the controlled part');
  });

  testWidgets('selecting a level and toggling a category sends the composite banner marking', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    String? sentMarking;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, _) async => sentMarking = marking,
            markingLevels: const ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
            markingCategories: const [
              MarkingCategory(code: 'SP-PRVCY', name: 'Privacy', level: 'CUI'),
              MarkingCategory(code: 'SP-EXPT', name: 'Export Controlled', level: 'CUI'),
            ],
          ),
        ),
      ),
    );

    // No category chips at the baseline level (categories attach to CUI).
    expect(find.text('SP-PRVCY'), findsNothing);

    // Raise the per-message level to CUI via the marking selector.
    await tester.tap(find.byTooltip('Message classification'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('CUI').last);
    await tester.pumpAndSettle();

    // The CUI categories now appear; toggle Privacy on.
    expect(find.text('SP-PRVCY'), findsOneWidget);
    await tester.tap(find.text('SP-PRVCY'));
    await tester.pump();

    // Compose + send → the marking is the canonical banner (level//category).
    await tester.enterText(find.byType(TextField), 'pii here');
    await tester.pump();
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await tester.pump();

    expect(sentMarking, 'CUI//SP-PRVCY');
  });

  testWidgets('attaching a file stages a removable chip, and sending forwards its id', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    var attachCalls = 0;
    List<String>? sentIds;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, ids) async => sentIds = ids,
            // Simulate a pick+upload that stages one attachment.
            onAttach: () async {
              attachCalls++;
              return const [
                Attachment(
                  id: 'att-1',
                  filename: 'report.pdf',
                  contentType: 'application/pdf',
                  byteSize: 2048,
                  marking: 'UNCLASSIFIED',
                ),
              ];
            },
          ),
        ),
      ),
    );

    // No staged chip until a file is attached.
    expect(find.text('report.pdf'), findsNothing);

    // Attach → the pending chip appears, and the picker/upload ran once.
    await tester.tap(find.byTooltip('Attach file'));
    await tester.pumpAndSettle();
    expect(attachCalls, 1);
    expect(find.text('report.pdf'), findsOneWidget);

    // A staged attachment alone (no text) is enough to enable Send; its id rides along.
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await tester.pump();
    expect(sentIds, ['att-1']);

    // After the send the staged chip is cleared.
    await tester.pump();
    expect(find.text('report.pdf'), findsNothing);
  });

  testWidgets('a staged attachment can be removed before sending', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, ids) async {},
            onAttach: () async => const [
              Attachment(
                id: 'att-9',
                filename: 'notes.txt',
                contentType: 'text/plain',
                byteSize: 12,
                marking: 'UNCLASSIFIED',
              ),
            ],
          ),
        ),
      ),
    );

    await tester.tap(find.byTooltip('Attach file'));
    await tester.pumpAndSettle();
    expect(find.text('notes.txt'), findsOneWidget);

    // The chip's delete affordance unstages it.
    await tester.tap(find.byIcon(Icons.close));
    await tester.pump();
    expect(find.text('notes.txt'), findsNothing);
  });

  testWidgets('onTyping fires while editing a non-empty draft (for the typing indicator)', (tester) async {
    var typingCount = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, _) async {},
            onTyping: () => typingCount++,
          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'drafting a message');
    await tester.pump();
    expect(typingCount, greaterThan(0));

    // Clearing to empty does NOT signal typing (nothing to type about).
    final before = typingCount;
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    expect(typingCount, before);
  });

  testWidgets('@-autocomplete: typing @ lists members and picking inserts the handle', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    String? sent;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, _) async => sent = text,
            mentionUsers: const [
              User(sub: 'alice', email: 'alice@x.mil', displayName: 'Alice Ng'),
              User(sub: 'bob', email: 'bob@x.mil', displayName: 'Bob Reyes'),
            ],
          ),
        ),
      ),
    );

    await tester.enterText(find.byType(TextField), 'hey @al');
    await tester.pump();

    // The mention strip shows the matching member by display name + handle; the non-match is absent.
    expect(find.text('Alice Ng'), findsOneWidget);
    expect(find.text('@aliceng'), findsOneWidget);
    expect(find.text('Bob Reyes'), findsNothing);

    // Picking replaces the "@al" partial with "@aliceng " (handle derived from the display name).
    await tester.tap(find.text('Alice Ng'));
    await tester.pump();
    expect(_fieldText(tester), 'hey @aliceng ');

    // Sending forwards the composed text (trimmed) carrying the handle the server resolves.
    await tester.tap(find.widgetWithText(ElevatedButton, 'Send'));
    await tester.pump();
    expect(sent, 'hey @aliceng');
  });

  testWidgets('Ctrl+V of higher-marked in-app content into a marked channel is blocked', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    // Make the (mocked) platform clipboard answer getData with the copied text.
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async => call.method == 'Clipboard.getData' ? <String, dynamic>{'text': 'cui secret'} : null,
    );
    addTearDown(() =>
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

    final guard = ClipboardGuard();
    await guard.recordCopy('cui secret', 'CUI'); // an in-app copy of CUI content

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MessageComposer(
            onSend: (text, marking, _) async {},
            markingLevels: const ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
            markingPolicy: const MarkingPolicy(
              levels: ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
              defaultLevel: 'UNCLASSIFIED',
            ),
            clipboardGuard: guard,
            channelMarking: 'PROPRIETARY', // a marked channel with a PROPRIETARY ceiling
          ),
        ),
      ),
    );

    await tester.tap(find.byType(TextField));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pump(); // key handler kicks the async guarded paste
    await tester.pump(); // getData resolves → decision
    await tester.pump(const Duration(milliseconds: 400)); // SnackBar slides in

    // The paste was refused (nothing inserted) and a spillage warning is shown.
    expect(_fieldText(tester), '');
    expect(find.textContaining('pasted into this'), findsOneWidget);

    // Let the SnackBar auto-dismiss so no timer is left pending at teardown.
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
  });
}
