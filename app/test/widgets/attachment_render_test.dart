import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/models.dart';
import 'package:secchat_app/widgets/message_list.dart';

void main() {
  testWidgets('a message with attachments renders a file card (name + size + marking) and downloads', (tester) async {
    Attachment? downloaded;
    final msg = Message(
      id: 'm1',
      seq: 1,
      authorRef: 'bob',
      authorType: AuthorType.user,
      content: 'here is the file',
      createdAt: DateTime(2026, 1, 1),
      attachments: const [
        Attachment(id: 'a1', filename: 'report.pdf', contentType: 'application/pdf', byteSize: 2048, marking: 'CUI'),
      ],
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 600,
            child: MessageList(
              entries: [MessageEntry(msg)],
              currentUserSub: 'alice',
              onDownloadAttachment: (a) => downloaded = a,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // The file card shows the name, a human size, and its (above-baseline) marking chip.
    expect(find.text('report.pdf'), findsOneWidget);
    expect(find.text('2.0 KB'), findsOneWidget);
    expect(find.text('CUI'), findsOneWidget);

    // Tapping the download affordance requests the bytes.
    await tester.tap(find.byTooltip('Download'));
    await tester.pump();
    expect(downloaded?.id, 'a1');
  });
}
